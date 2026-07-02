'use strict';

const express = require('express');
const compression = require('compression');
const path = require('path');
const { createClient } = require('redis');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const app = express();
app.use(compression());
app.use(express.json({ limit: '6mb' }));

/** @type {import('redis').RedisClientType | null} */
let redisClient = null;
/** @type {Map<string, string>} */
const memoryStore = new Map();
let useMemory = true;

function scopePrefix(shared) {
  return shared === true || shared === 'true' ? 'shared' : 'personal';
}

function toRedisKey(key, shared) {
  return `storage:${scopePrefix(shared)}:${key}`;
}

function withFamily(url) {
  if (!url || url.includes('family=')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'family=0';
}

function redisUrlFromEnv() {
  if (process.env.REDIS_URL) return withFamily(process.env.REDIS_URL);
  const host = process.env.REDISHOST;
  const port = process.env.REDISPORT || '6379';
  const password = process.env.REDISPASSWORD;
  const user = process.env.REDISUSER;
  if (!host) return null;
  const auth = password
    ? `${encodeURIComponent(user || 'default')}:${encodeURIComponent(password)}@`
    : '';
  return withFamily(`redis://${auth}${host}:${port}`);
}

function redisReady() {
  return redisClient && redisClient.isOpen;
}

async function connectRedis(attempt) {
  attempt = attempt || 1;
  const maxAttempts = 8;
  const url = redisUrlFromEnv();

  if (!url) {
    useMemory = true;
    console.warn('[storage] no Redis config — using in-memory store');
    return;
  }

  if (redisClient) {
    try { await redisClient.quit(); } catch (_) { /* ignore */ }
    redisClient = null;
  }

  const client = createClient({
    url,
    socket: {
      family: 0,
      connectTimeout: 10000,
      reconnectStrategy: (retries) => {
        if (retries > 20) return new Error('Redis reconnect limit reached');
        return Math.min(retries * 300, 3000);
      }
    }
  });

  client.on('error', (err) => {
    console.error('[redis] error:', err.message || err);
  });

  client.on('end', () => {
    console.warn('[redis] connection closed — using in-memory store until reconnected');
    useMemory = true;
  });

  client.on('ready', () => {
    useMemory = false;
    console.log('[redis] ready');
  });

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connect timeout')), 12000)
      )
    ]);
    redisClient = client;
    useMemory = false;
    console.log('[redis] connected');
  } catch (err) {
    console.error(`[redis] connect attempt ${attempt}/${maxAttempts} failed:`, err.message || err);
    try { await client.quit(); } catch (_) { /* ignore */ }
    redisClient = null;
    useMemory = true;
    if (attempt < maxAttempts) {
      const delay = Math.min(attempt * 2000, 10000);
      await new Promise((r) => setTimeout(r, delay));
      return connectRedis(attempt + 1);
    }
    console.error('[redis] giving up — in-memory store active (live sync will not persist)');
  }
}

async function withRedis(fn, fallback) {
  if (redisReady()) {
    try {
      return await fn(redisClient);
    } catch (err) {
      console.error('[redis] op failed, falling back to memory:', err.message || err);
      useMemory = true;
    }
  }
  return fallback();
}

async function storageGet(key, shared) {
  const rkey = toRedisKey(key, shared);
  return withRedis(
    (client) => client.get(rkey),
    () => (memoryStore.has(rkey) ? memoryStore.get(rkey) : null)
  );
}

async function storageSet(key, value, shared) {
  const rkey = toRedisKey(key, shared);
  const str = value == null ? '' : String(value);
  return withRedis(
    (client) => client.set(rkey, str),
    () => { memoryStore.set(rkey, str); }
  );
}

async function storageDelete(key, shared) {
  const rkey = toRedisKey(key, shared);
  return withRedis(
    (client) => client.del(rkey),
    () => (memoryStore.delete(rkey) ? 1 : 0)
  );
}

async function storageList(prefix, shared) {
  const base = toRedisKey(prefix || '', shared);
  const stripLen = `storage:${scopePrefix(shared)}:`.length;
  const pattern = base + '*';

  return withRedis(
    async (client) => {
      const keys = [];
      let cursor = 0;
      do {
        const reply = await client.scan(cursor, { MATCH: pattern, COUNT: 200 });
        cursor = reply.cursor;
        for (const rkey of reply.keys) keys.push(rkey.slice(stripLen));
      } while (cursor !== 0);
      return keys.sort();
    },
    () => {
      const keys = [];
      for (const rkey of memoryStore.keys()) {
        if (rkey.startsWith(base)) keys.push(rkey.slice(stripLen));
      }
      return keys.sort();
    }
  );
}

function parseShared(query) {
  return query.shared === 'true' || query.shared === true;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    storage: redisReady() ? 'redis' : 'memory'
  });
});

app.get('/api/storage/list', async (req, res) => {
  try {
    const shared = parseShared(req.query);
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const keys = await storageList(prefix, shared);
    res.json({ keys, prefix: prefix || undefined, shared });
  } catch (err) {
    console.error('[api] list failed', err);
    res.status(500).json({ error: 'Storage list failed' });
  }
});

app.get('/api/storage/:key', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const shared = parseShared(req.query);
    const value = await storageGet(key, shared);
    if (value === null) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ key, value, shared });
  } catch (err) {
    console.error('[api] get failed', err);
    res.status(500).json({ error: 'Storage get failed' });
  }
});

app.put('/api/storage/:key', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const shared = parseShared(req.query);
    const value = req.body && 'value' in req.body ? req.body.value : req.body;
    if (value === undefined) {
      res.status(400).json({ error: 'Missing value' });
      return;
    }
    await storageSet(key, value, shared);
    res.json({ key, value: String(value), shared });
  } catch (err) {
    console.error('[api] set failed', err);
    res.status(500).json({ error: 'Storage set failed' });
  }
});

app.delete('/api/storage/:key', async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    const shared = parseShared(req.query);
    const deleted = await storageDelete(key, shared);
    res.json({ key, deleted: deleted > 0, shared });
  } catch (err) {
    console.error('[api] delete failed', err);
    res.status(500).json({ error: 'Storage delete failed' });
  }
});

app.use(express.static(ROOT, { index: 'index.html', maxAge: '1h' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[process] unhandledRejection:', err);
});

function start() {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${PORT}`);
    console.log(`[server] health check: GET /health`);
    console.log(`[server] Railway target port must be ${PORT} (Settings → Networking)`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  connectRedis().catch((err) => {
    console.error('[redis] background connect error', err);
    useMemory = true;
    redisClient = null;
  });
}

start();
