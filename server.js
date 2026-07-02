'use strict';

const express = require('express');
const path = require('path');
const { createClient } = require('redis');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const app = express();
app.use(express.json({ limit: '6mb' }));

/** @type {import('redis').RedisClientType | null} */
let redisClient = null;
/** @type {Map<string, string>} */
const memoryStore = new Map();
let useMemory = false;

function scopePrefix(shared) {
  return shared === true || shared === 'true' ? 'shared' : 'personal';
}

function toRedisKey(key, shared) {
  return `storage:${scopePrefix(shared)}:${key}`;
}

function redisUrlFromEnv() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const host = process.env.REDISHOST;
  const port = process.env.REDISPORT || '6379';
  const password = process.env.REDISPASSWORD;
  const user = process.env.REDISUSER;
  if (!host) return null;
  const auth = password
    ? `${encodeURIComponent(user || 'default')}:${encodeURIComponent(password)}@`
    : '';
  return `redis://${auth}${host}:${port}`;
}

async function connectRedis() {
  const url = redisUrlFromEnv();
  if (!url) {
    useMemory = true;
    console.warn('[storage] REDIS_URL not set — using in-memory store (single instance / local dev only)');
    return;
  }

  const client = createClient({
    url,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 3000)
    }
  });
  client.on('error', (err) => console.error('[redis]', err.message || err));

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connect timeout')), 8000)
      )
    ]);
    redisClient = client;
    useMemory = false;
    console.log('[redis] connected');
  } catch (err) {
    console.error('[redis] connection failed — falling back to in-memory store:', err.message || err);
    try { await client.quit(); } catch (_) { /* ignore */ }
    redisClient = null;
    useMemory = true;
  }
}

async function storageGet(key, shared) {
  const rkey = toRedisKey(key, shared);
  if (useMemory) {
    if (!memoryStore.has(rkey)) return null;
    return memoryStore.get(rkey);
  }
  return redisClient.get(rkey);
}

async function storageSet(key, value, shared) {
  const rkey = toRedisKey(key, shared);
  const str = value == null ? '' : String(value);
  if (useMemory) {
    memoryStore.set(rkey, str);
    return;
  }
  await redisClient.set(rkey, str);
}

async function storageDelete(key, shared) {
  const rkey = toRedisKey(key, shared);
  if (useMemory) {
    const deleted = memoryStore.delete(rkey);
    return deleted ? 1 : 0;
  }
  return redisClient.del(rkey);
}

async function storageList(prefix, shared) {
  const base = toRedisKey(prefix || '', shared);
  const stripLen = `storage:${scopePrefix(shared)}:`.length;
  const pattern = base + '*';

  if (useMemory) {
    const keys = [];
    for (const rkey of memoryStore.keys()) {
      if (rkey.startsWith(base)) keys.push(rkey.slice(stripLen));
    }
    return keys.sort();
  }

  const keys = [];
  let cursor = 0;
  do {
    const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 200 });
    cursor = reply.cursor;
    for (const rkey of reply.keys) {
      keys.push(rkey.slice(stripLen));
    }
  } while (cursor !== 0);

  return keys.sort();
}

function parseShared(query) {
  return query.shared === 'true' || query.shared === true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, storage: useMemory ? 'memory' : 'redis' });
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

app.use(express.static(ROOT, { index: 'index.html' }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

function start() {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] listening on 0.0.0.0:${PORT} (storage: ${useMemory ? 'memory' : 'redis'})`);
  });
  connectRedis()
    .then(() => {
      console.log(`[server] storage ready (${useMemory ? 'memory' : 'redis'})`);
    })
    .catch((err) => {
      console.error('[redis] background connect error', err);
      useMemory = true;
      redisClient = null;
    });
}

start();
