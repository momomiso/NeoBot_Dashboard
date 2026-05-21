//utils.js
//工具函数

const TOKEN_KEY = 'neobot-dashboard-token';

//取当前token
export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
      || new URLSearchParams(location.search).get('token')
      || '';
}
export function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); }

export const TOKEN = getToken();
export const TOKEN_QS = '';

export async function authFetch(path, init = {}) {
  const tk = getToken();
  const headers = new Headers(init.headers || {});
  if (tk) headers.set('X-Token', tk);
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401) {
    if (!location.pathname.endsWith('/login.html')) {
      clearToken();
      const reason = tk ? 'expired' : 'required';
      location.replace('./login.html?reason=' + reason);
    }
  }
  return r;
}

export const $ = (id) => document.getElementById(id);

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

export function fmtUptime(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 时 ${m} 分`;
  return m > 0 ? `${m} 分` : '< 1 分';
}

export function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmt1(n, suf = '') {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(1) + suf;
}

export function mapTag(level) {
  level = String(level || '').toLowerCase();
  if (level === 'success') return 'ok';
  if (level === 'warning') return 'warn';
  if (level === 'error' || level === 'critical') return 'err';
  return 'info';
}
