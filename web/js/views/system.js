//system.js
//系统信息

import { api } from '../api.js';
import { $, fmt1 } from '../utils.js';

function setBar(textId, barId, text, pct) {
  $(textId).textContent = text;
  $(barId).style.width = Math.min(100, Math.max(0, pct || 0)).toFixed(1) + '%';
}

export async function renderSystem() {
  const d = await api.system();
  if (!d) return;

  //CPU
  if (d.cpu_percent != null) {
    setBar('cpu-text', 'cpu-bar', fmt1(d.cpu_percent, '%'), d.cpu_percent);
  } else {
    setBar('cpu-text', 'cpu-bar', '—', 0);
  }

  //内存
  if (d.mem_used_mb != null && d.mem_total_mb != null) {
    const txt = `${Math.round(d.mem_used_mb)} / ${Math.round(d.mem_total_mb)} MB`;
    setBar('mem-text', 'mem-bar', txt, d.mem_percent);
  }

  //磁盘
  if (d.disk_used_gb != null && d.disk_total_gb != null) {
    const txt = `${d.disk_used_gb.toFixed(1)} / ${d.disk_total_gb.toFixed(1)} GB`;
    setBar('disk-text', 'disk-bar', txt, d.disk_percent);
  }

  //元信息
  $('sys-os').textContent = d.os || '—';
  $('sys-host').textContent = d.hostname || '—';
  $('sys-python').textContent = d.python_version || '—';
  $('sys-started').textContent = d.started_at || '—';

  const py = $('hero-python');
  if (py) py.textContent = d.python_version || '—';
}
