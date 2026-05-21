//overview.js
//欢迎横幅
//统计卡
//今日消息

import { api } from '../api.js';
import { $, fmtUptime, fmtNum } from '../utils.js';

const SPARK_W = 110;
const SPARK_H = 40;
const SPARK_PAD = 4;

function buildSparkPaths(series) {
  const n = series.length;
  if (n < 2) return { line: '', area: '' };

  const counts = series.map((s) => s.count || 0);
  const max = Math.max(1, ...counts);
  const usable = SPARK_H - SPARK_PAD * 2;

  const pts = counts.map((c, i) => {
    const x = (i / (n - 1)) * SPARK_W;
    const y = SPARK_PAD + (1 - c / max) * usable;
    return [x.toFixed(1), y.toFixed(1)];
  });

  const line = 'M' + pts.map(([x, y]) => `${x},${y}`).join(' L');
  const area = line + ` L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z`;
  return { line, area };
}

async function renderMessagesSpark() {
  const data = await api.seriesMessages();
  if (!data || !Array.isArray(data.series)) return;

  const linePath = $('spark-line');
  const areaPath = $('spark-area');
  if (!linePath || !areaPath) return;

  const { line, area } = buildSparkPaths(data.series);
  linePath.setAttribute('d', line);
  areaPath.setAttribute('d', area);

  const last30 = data.series.reduce((a, b) => a + (b.count || 0), 0);
  const sub = $('stat-total-sub');
  if (sub) sub.title = `近 30 分钟 ${last30} 条`;
}

export async function renderOverview() {
  const d = await api.overview();
  if (!d) return;

  $('hero-today').textContent = fmtNum(d.today_messages);
  $('hero-plugins').textContent = d.plugins_loaded ?? '—';
  $('hero-status').textContent = d.online ? '正常' : '离线';
  $('hero-uptime').textContent = fmtUptime(d.uptime_seconds);
  $('hero-app').textContent =
    (d.app_name && d.app_name !== '—')
      ? `${d.app_name} ${d.app_version || ''}`.trim()
      : '—';

  $('stat-plugins').textContent = d.plugins_loaded ?? '—';
  $('stat-plugins-sub').textContent = `共 ${d.plugins_total ?? '—'} 个`;

  $('stat-bot').textContent = d.bot_nickname || '—';
  $('stat-bot-sub').textContent = d.bot_user_id ? `QQ ${d.bot_user_id}` : '未连接';

  $('stat-today').textContent = fmtNum(d.today_messages);
  $('stat-total-sub').textContent = `累计 ${fmtNum(d.total_messages)}`;

  $('stat-uptime').textContent = fmtUptime(d.uptime_seconds);
  $('stat-uptime-sub').textContent = d.online ? '在线' : '离线';

  renderMessagesSpark();
}
