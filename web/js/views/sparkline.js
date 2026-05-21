//sparkline.js
//今日消息折线

import { api } from '../api.js';
import { $ } from '../utils.js';

const W = 110, H = 40, PADX = 2, PADY = 4;

function buildPath(values) {
  if (!values.length) return { line: '', area: '' };

  const maxVal = Math.max(1, ...values);
  const innerW = W - PADX * 2;
  const innerH = H - PADY * 2;
  const n = values.length;

  const stepX = n > 1 ? innerW / (n - 1) : 0;

  const pts = values.map((v, i) => {
    const x = PADX + (n > 1 ? i * stepX : innerW / 2);
    const y = PADY + (1 - v / maxVal) * innerH;
    return [x, y];
  });

  const line = pts.map(([x, y], i) =>
    `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  ).join(' ');

  const first = pts[0], last = pts[pts.length - 1];
  const area = line +
    ` L${last[0].toFixed(1)},${H} L${first[0].toFixed(1)},${H} Z`;

  return { line, area };
}

export async function renderSparkline() {
  const data = await api.seriesMessages(30);
  if (!data || !Array.isArray(data.series)) return;

  const values = data.series.map((p) => Number(p.count || 0));
  const { line, area } = buildPath(values);

  const lineEl = $('spark-line');
  const areaEl = $('spark-area');
  if (lineEl) lineEl.setAttribute('d', line);
  if (areaEl) areaEl.setAttribute('d', area);

  const svg = $('spark-messages');
  if (svg) {
    svg.setAttribute('data-points', data.series.length);
    const last = data.series[data.series.length - 1];
    if (last) svg.setAttribute('title', `今日 ${last.date}: ${last.count} 条`);
  }
}
