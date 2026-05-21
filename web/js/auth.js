//auth.js
//token存取

const KEY = 'neobot-dashboard-token';

export function getToken()    { return localStorage.getItem(KEY) || ''; }
export function setToken(t)   { if (t) localStorage.setItem(KEY, t); }
export function clearToken()  { localStorage.removeItem(KEY); }

export function gotoLogin() {
  clearToken();
  location.replace('./login.html');
}

export async function authFetch(url, opts = {}) {
  const token = getToken();
  const headers = new Headers(opts.headers || {});
  if (token) headers.set('X-Token', token);
  const r = await fetch(url, { ...opts, headers, cache: 'no-store' });
  if (r.status === 401) {
    gotoLogin();
    throw new Error('unauthorized');
  }
  return r;
}
