/**
 * Railway storage shim — implements the Claude Artifacts window.storage API
 * against the app's /api/storage REST backend (Redis-backed on Railway).
 */
(function () {
  'use strict';

  function apiUrl(key, shared) {
    const q = shared ? '?shared=true' : '';
    return '/api/storage/' + encodeURIComponent(key) + q;
  }

  function listUrl(prefix, shared) {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    if (shared) params.set('shared', 'true');
    const qs = params.toString();
    return '/api/storage/list' + (qs ? '?' + qs : '');
  }

  async function parseJson(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || 'Storage request failed');
      err.status = res.status;
      throw err;
    }
    return body;
  }

  window.storage = {
    async get(key, shared) {
      const res = await fetch(apiUrl(key, !!shared));
      if (res.status === 404) throw new Error('Key not found: ' + key);
      return parseJson(res);
    },

    async set(key, value, shared) {
      const res = await fetch(apiUrl(key, !!shared), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value })
      });
      return parseJson(res);
    },

    async delete(key, shared) {
      const res = await fetch(apiUrl(key, !!shared), { method: 'DELETE' });
      return parseJson(res);
    },

    async list(prefix, shared) {
      const res = await fetch(listUrl(prefix || '', !!shared));
      return parseJson(res);
    }
  };
})();
