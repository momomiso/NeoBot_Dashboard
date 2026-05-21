//api.js
//api的统一客户端

import { authFetch } from './utils.js';
async function getJSON(path) {
  try {
    const r = await authFetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('[api] fetch failed:', path, e);
    return null;
  }
}

export const api = {
  overview: () => getJSON('/api/overview'),
  bots:     () => getJSON('/api/bots'),
  plugins:  () => getJSON('/api/plugins'),
  logs:     (limit = 80)    => getJSON(`/api/logs?limit=${limit}`),
  logsSince:(since, limit = 500) =>
    getJSON(`/api/logs?since=${since}&limit=${limit}`),
  system:   () => getJSON('/api/system'),
  seriesMessages: (days = 30) => getJSON(`/api/series/messages?days=${days}`),
};
