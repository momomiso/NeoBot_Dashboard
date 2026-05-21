//botsPage.js
//机器人详情页

import { $, escapeHTML, fmtUptime, fmtNum, authFetch } from '../utils.js';

async function fetchJSON(path) {
  try {
    const r = await authFetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('[bots] fetch failed:', path, e);
    return null;
  }
}

let pollTimer = null;

async function renderHeader() {
  const d = await fetchJSON('/api/bot/detail');
  if (!d) return;

  // 头像
  const avatarEl = $('bot-avatar');
  if (avatarEl) {
    if (d.avatar_url) {
      avatarEl.src = d.avatar_url;
      avatarEl.alt = d.nickname || `QQ ${d.user_id}`;
    } else {
      avatarEl.removeAttribute('src');
    }
  }

  $('bd-name').textContent = d.nickname || '未连接';

  const pill = $('bd-status');
  if (pill) {
    pill.className = `status-pill ${d.online ? 'on' : 'off'}`;
    pill.querySelector('span:last-child').textContent = d.online ? '在线' : '离线';
  }

  $('bd-qq').textContent     = d.user_id || '—';
  $('bd-onebot').textContent = d.app_name
    ? `${d.app_name} ${d.app_version || ''}`.trim()
    : '—';
  $('bd-latency').textContent = (d.latency_ms != null)
    ? `${Math.round(d.latency_ms)} ms`
    : '—';
  $('bd-uptime').textContent  = fmtUptime(d.uptime_seconds);
  $('bd-today').textContent   = fmtNum(d.today_messages);
  $('bd-total').textContent   = fmtNum(d.total_messages);
}

//折线图
const CHART_W = 600, CHART_H = 140;
const PAD = { l: 40, r: 20, t: 20, b: 20 };

function chartBuild({ values, labels, areaId, lineId, gridId, fmtTick }) {
  const innerW = CHART_W - PAD.l - PAD.r;
  const innerH = CHART_H - PAD.t - PAD.b;
  const lineEl = $(lineId), areaEl = $(areaId), gridEl = $(gridId);
  if (!lineEl || !areaEl) return;

  const numeric = values.map((v) => (v == null || isNaN(v)) ? null : Number(v));
  const validValues = numeric.filter((v) => v != null);
  if (validValues.length === 0) {
    lineEl.setAttribute('d', '');
    areaEl.setAttribute('d', '');
    if (gridEl) gridEl.innerHTML = '';
    return;
  }
  const min = 0;                              // 强制从 0 起
  const max = Math.max(1, ...validValues) * 1.1;
  const n = numeric.length;
  const stepX = n > 1 ? innerW / (n - 1) : 0;

  if (gridEl) {
    const yTicks = [0, max / 2, max];
    gridEl.classList.add('chart-grid');
    gridEl.innerHTML = yTicks.map((v) => {
      const y = PAD.t + (1 - (v - min) / (max - min || 1)) * innerH;
      return `
        <line x1="${PAD.l}" y1="${y}" x2="${CHART_W - PAD.r}" y2="${y}"/>
        <text x="${PAD.l - 6}" y="${y + 3}" text-anchor="end">${fmtTick ? fmtTick(v) : Math.round(v)}</text>
      `;
    }).join('');
  }

  const pts = numeric.map((v, i) => {
    const x = PAD.l + i * stepX;
    if (v == null) return null;
    const y = PAD.t + (1 - (v - min) / (max - min || 1)) * innerH;
    return [x, y];
  });

  let dLine = '';
  let started = false;
  for (const p of pts) {
    if (p == null) { started = false; continue; }
    dLine += `${started ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
    started = true;
  }
  const valid = pts.filter((p) => p != null);
  let dArea = '';
  if (valid.length) {
    dArea = 'M' + valid.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
    dArea += ` L${valid[valid.length - 1][0].toFixed(1)},${CHART_H - PAD.b}`;
    dArea += ` L${valid[0][0].toFixed(1)},${CHART_H - PAD.b} Z`;
  }
  lineEl.setAttribute('d', dLine.trim());
  areaEl.setAttribute('d', dArea);
}

async function renderLatency() {
  const d = await fetchJSON('/api/series/latency');
  if (!d) return;
  const series = d.series || [];
  chartBuild({
    values: series.map((p) => p.ms),
    labels: series.map((p) => p.ts),
    areaId: 'latency-area',
    lineId: 'latency-line',
    gridId: 'latency-grid',
    fmtTick: (v) => `${Math.round(v)}ms`,
  });
  const sub = $('bd-latency-sub');
  if (sub) {
    if (series.length) {
      const cur = d.current_ms != null ? `${Math.round(d.current_ms)} ms` : '—';
      const avg = d.avg_ms     != null ? `${d.avg_ms} ms` : '—';
      const rate = d.success_rate != null ? `${d.success_rate}%` : '—';
      sub.innerHTML = `当前 <b>${cur}</b> · 平均 <b>${avg}</b> · 成功率 <b>${rate}</b>`;
    } else {
      sub.textContent = '等待首次采样…';
    }
  }
}

//消息趋势
async function renderMessages() {
  const d = await fetchJSON('/api/series/messages?days=30');
  if (!d) return;
  const series = d.series || [];
  chartBuild({
    values: series.map((p) => p.count),
    labels: series.map((p) => p.date),
    areaId: 'msg-area',
    lineId: 'msg-line',
    gridId: 'msg-grid',
    fmtTick: (v) => fmtNum(Math.round(v)),
  });
  const sub = $('bd-msg-sub');
  if (sub) {
    if (series.length) {
      const total = series.reduce((s, p) => s + (p.count || 0), 0);
      const peak = series.reduce((m, p) => Math.max(m, p.count || 0), 0);
      sub.innerHTML = `共 <b>${fmtNum(total)}</b> 条 · 峰值 <b>${fmtNum(peak)}</b>/天`;
    } else {
      sub.textContent = '尚无历史数据';
    }
  }
}

//API调用排行
async function renderApiCalls() {
  const d = await fetchJSON('/api/stats/api-calls?limit=10');
  if (!d) return;
  $('bd-api-total').textContent  = fmtNum(d.total_calls || 0);
  $('bd-api-unique').textContent = d.unique_actions || 0;

  const list = $('api-calls-list');
  if (!list) return;
  const items = d.items || [];
  if (!items.length) {
    list.innerHTML = '<li class="bar-empty">尚未捕获到 API 调用</li>';
    return;
  }
  const maxCount = items[0].count || 1;
  list.innerHTML = items.map((it, i) => {
    const pct = (it.count / maxCount) * 100;
    return `
      <li>
        <span class="rank">${i + 1}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct.toFixed(1)}%"></div>
          <div class="bar-label">${escapeHTML(it.action)}</div>
        </div>
        <span class="bar-count">${fmtNum(it.count)}</span>
      </li>
    `;
  }).join('');
}

//活跃用户
function fmtRelTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

async function renderActiveUsers() {
  const d = await fetchJSON('/api/stats/active-users?limit=10');
  if (!d) return;
  $('bd-users-tracked').textContent = d.tracked_users || 0;

  const list = $('active-users-list');
  if (!list) return;
  const items = d.items || [];
  if (!items.length) {
    list.innerHTML = '<li class="bar-empty">尚无消息记录</li>';
    return;
  }
  list.innerHTML = items.map((u, i) => {
    const nick = escapeHTML(u.nickname || `用户${u.user_id}`);
    const initial = (u.nickname || String(u.user_id) || 'U').slice(0, 1).toUpperCase();
    const avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${u.user_id}&s=100`;
    return `
      <li>
        <span class="rank">${i + 1}</span>
        <span class="user-avatar">
          <img src="${avatarUrl}" alt=""
               onerror="this.replaceWith(Object.assign(document.createTextNode(${JSON.stringify(initial)}),{}))">
        </span>
        <div>
          <div class="user-name">${nick}</div>
          <div class="user-id">QQ ${u.user_id}</div>
        </div>
        <span class="user-count">${fmtNum(u.count)} 条</span>
        <span class="user-last">${escapeHTML(fmtRelTime(u.last_seen))}</span>
      </li>
    `;
  }).join('');
}

async function refreshAll() {
  await Promise.all([
    renderHeader(),
    renderLatency(),
    renderMessages(),
    renderApiCalls(),
    renderActiveUsers(),
  ]);
}

export async function enterBotsPage() {
  await refreshAll();
  if (pollTimer) clearInterval(pollTimer);
  let tick = 0;
  pollTimer = setInterval(() => {
    tick++;
    renderHeader();
    renderLatency();
    renderApiCalls();
    if (tick % 6 === 0) {
      renderMessages();
      renderActiveUsers();
    }
  }, 10000);
}

export function leaveBotsPage() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
