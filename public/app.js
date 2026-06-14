/* NetPulse - Monitor Client (frontend logic). No external libraries. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const api = (p, opts) => fetch(p, opts).then((r) => r.json());

  let currentView = 'overview';
  let pollTimer = null;
  let session = null;

  // ---------- LOGIN ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#connectBtn');
    const err = $('#loginError');
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    try {
      const res = await api('/api/connect-ssh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostname: $('#hostname').value.trim(),
          username: $('#username').value.trim(),
          password: $('#password').value,
        }),
      });
      if (!res.success) throw new Error(res.error || 'Connection failed');
      session = res;
      enterDashboard();
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  });

  function enterDashboard() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#sessInfo').textContent = `${session.username}@${session.hostname}`;
    loadNetworks();
    switchView('overview');
    startPolling();
  }

  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/disconnect', { method: 'POST' });
    stopPolling();
    session = null;
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
  });

  // ---------- NAV ----------
  document.querySelectorAll('#nav a').forEach((a) => {
    a.addEventListener('click', () => switchView(a.dataset.view));
  });
  const TITLES = {
    overview: 'Network Overview', devices: 'Devices', alerts: 'Alerts',
    traffic: 'Traffic Analysis', reports: 'Reports', maps: 'Maps', perf: 'Performance Metrics',
  };
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + view).classList.remove('hidden');
    $('#viewTitle').textContent = TITLES[view];
    refresh();
  }

  // ---------- POLLING ----------
  function startPolling() { stopPolling(); pollTimer = setInterval(refresh, 2000); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  async function refresh() {
    if (!session) return;
    try {
      if (currentView === 'overview') await renderOverview();
      else if (currentView === 'devices') await renderDevices();
      else if (currentView === 'alerts') await renderAlerts();
      else if (currentView === 'traffic') await renderTraffic();
      else if (currentView === 'reports') await renderReports();
      else if (currentView === 'maps') await renderTopology();
      else if (currentView === 'perf') await renderMetrics();
    } catch (e) { /* transient */ }
  }

  // ---------- NETWORKS dropdown ----------
  async function loadNetworks() {
    const nets = await api('/api/networks');
    const sel = $('#networkSelect');
    sel.innerHTML = '<option value="">All networks</option>' +
      nets.map((n) => `<option value="${n.id}">${n.label} — ${n.count} devices</option>`).join('');
    sel.onchange = renderDevices;
  }

  // ---------- OVERVIEW ----------
  async function renderOverview() {
    const o = await api('/api/overview');
    $('#upCount').textContent = `${o.devicesUp}/${o.devicesTotal} devices up`;
    drawGauge($('#g-cpu'), o.cpu, '#38bdf8');
    drawGauge($('#g-ram'), o.ram, '#a78bfa');
    drawGauge($('#g-disk'), o.disk, '#f59e0b');
    drawGauge($('#g-bw'), o.bandwidth, '#34d399');
    drawPie($('#pie'), o.resource.used, o.resource.free);
    drawLineChart(o.history);
    $('#overviewDevices').innerHTML = o.deviceIps.map((ip) => `<div class="chip">${ip}</div>`).join('');
  }

  // ---------- DEVICES ----------
  async function renderDevices() {
    const net = $('#networkSelect').value;
    const list = await api('/api/devices' + (net ? '?network=' + encodeURIComponent(net) : ''));
    $('#devicesBody').innerHTML = list.map((d) => `
      <tr>
        <td><span class="dot ${d.status}"></span> ${d.status}</td>
        <td>${d.ip}</td><td>${d.hostname}</td><td>${d.osName}</td>
        <td>${d.network}</td><td>${d.subnet}</td><td>${d.iface}</td>
        <td>${d.communication}</td>
        <td>${d.cpu}%</td><td>${d.ram}%</td><td>${d.disk}%</td>
      </tr>`).join('');
  }

  // ---------- ALERTS ----------
  const thInput = $('#threshold');
  thInput.addEventListener('input', () => { $('#thLabel').textContent = thInput.value; renderAlerts(); });
  async function renderAlerts() {
    const data = await api('/api/alerts?threshold=' + thInput.value);
    const badge = $('#violBadge');
    badge.textContent = `${data.violations} violating`;
    badge.classList.toggle('hot', data.violations > 0);
    $('#alertsBody').innerHTML = data.devices.map((d) => `
      <tr class="${d.violating ? 'violating' : ''}">
        <td>${d.violating ? '<span class="flag">⚑ RED</span>' : ''}</td>
        <td><span class="dot ${d.status}"></span> ${d.status}</td>
        <td>${d.ip}</td><td>${d.hostname}</td><td>${d.network}</td><td>${d.iface}</td>
        <td>${d.sent}</td><td>${d.received}</td>
        <td><strong>${d.bandwidth}%</strong></td>
      </tr>`).join('');
  }

  // ---------- TRAFFIC ----------
  async function renderTraffic() {
    const list = await api('/api/traffic');
    const max = Math.max(100, ...list.map((d) => d.total));
    $('#trafficBars').innerHTML = list.map((d) => {
      const pct = (d.total / max) * 100;
      const hot = d.total > 0.7 * max;
      return `<div class="bar-row">
        <div class="lbl">${d.ip} · ${d.hostname}</div>
        <div class="bar-track"><div class="bar-fill ${hot ? 'hot' : ''}" style="width:${pct}%"></div></div>
        <div class="val">${d.total} Mbps</div>
      </div>`;
    }).join('');
  }

  // ---------- REPORTS ----------
  $('#printReport').addEventListener('click', () => window.print());
  async function renderReports() {
    const r = await api('/api/report?threshold=' + thInput.value);
    const s = r.summary;
    const when = new Date(r.generatedAt).toLocaleString();
    const healthClass = s.health === 'Healthy' ? 'ok' : s.health === 'Attention' ? 'warn' : 'bad';
    $('#reportBody').innerHTML = `
      <div class="rep-title">
        <div class="rep-title-brand">🛰️ NetPulse — Network Status Report</div>
        <div class="rep-title-sub">Remote Network Monitoring · Generated ${when}</div>
      </div>
      <div class="rep-head">
        <div><strong>Generated:</strong> ${when}</div>
        <div><strong>Overall health:</strong> <span class="badge ${healthClass}">${s.health}</span></div>
      </div>
      <div class="rep-grid">
        <div class="rep-stat"><span>${s.devicesUp}/${s.devicesTotal}</span>Devices up</div>
        <div class="rep-stat"><span>${s.avgCpu}%</span>Avg CPU</div>
        <div class="rep-stat"><span>${s.avgRam}%</span>Avg RAM</div>
        <div class="rep-stat"><span>${s.avgDisk}%</span>Avg Disk</div>
        <div class="rep-stat"><span>${s.avgBandwidth}%</span>Avg Bandwidth</div>
        <div class="rep-stat"><span class="${s.violations ? 'hot' : ''}">${s.violations}</span>Alerts > ${s.threshold}%</div>
      </div>
      <h4>Networks</h4>
      <table class="data"><thead><tr><th>Network</th><th>Subnet</th><th>Devices Up</th></tr></thead><tbody>
        ${r.perNetwork.map((n) => `<tr><td>${n.label}</td><td>${n.subnet}</td><td>${n.up}/${n.total}</td></tr>`).join('')}
      </tbody></table>
      <h4>Top Talkers</h4>
      <table class="data"><thead><tr><th>IP</th><th>Hostname</th><th>Network</th><th>Total (Mbps)</th><th>Bandwidth %</th></tr></thead><tbody>
        ${r.topTalkers.map((t) => `<tr><td>${t.ip}</td><td>${t.hostname}</td><td>${t.network}</td><td>${t.total}</td><td>${t.bandwidth}%</td></tr>`).join('')}
      </tbody></table>
      <h4>Devices Over Threshold (${s.threshold}%)</h4>
      ${r.flagged.length
        ? `<table class="data"><thead><tr><th>IP</th><th>Hostname</th><th>Network</th><th>Bandwidth %</th></tr></thead><tbody>
            ${r.flagged.map((f) => `<tr class="violating"><td>${f.ip}</td><td>${f.hostname}</td><td>${f.network}</td><td><strong>${f.bandwidth}%</strong></td></tr>`).join('')}
          </tbody></table>`
        : '<p class="muted-note">No devices currently exceed the threshold.</p>'}`;
  }

  // ---------- MAPS (topology, SVG tree with connector lines) ----------
  async function renderTopology() {
    const t = await api('/api/topology');
    const host = $('#topoMap');
    const W = Math.max(host.clientWidth || 900, 760);
    const nets = t.networks;
    const cols = nets.length;

    // layout constants
    const coreW = 190, coreH = 50, coreY = 16;
    const rtrY = 132, rtrH = 46, nodeW = 168;
    const leafTop = 224, leafH = 42, leafStep = 58;
    const colX = (i) => (W * (i + 0.5)) / cols; // column centre x

    // gateway (router) per network + its leaf devices
    const layout = nets.map((n) => {
      const gw = n.devices.find((d) => d.isRouter) || n.devices[0];
      const leaves = n.devices.filter((d) => d !== gw);
      return { net: n, gw, leaves };
    });
    const maxLeaves = Math.max(1, ...layout.map((l) => l.leaves.length));
    const H = leafTop + maxLeaves * leafStep + 10;

    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const stroke = (st) => (st === 'up' ? '#34d399' : '#f43f5e');

    function node(cx, topY, w, h, icon, title, sub, opts) {
      const x = cx - w / 2;
      const cls = (opts && opts.cls) || '';
      const sc = (opts && opts.stroke) || '#243150';
      const dim = opts && opts.dim ? 'opacity="0.55"' : '';
      return `<g ${dim}><title>${esc(title)} — ${esc(sub)}</title>
        <rect x="${x}" y="${topY}" rx="10" width="${w}" height="${h}" class="topo-node ${cls}" stroke="${sc}"/>
        <text x="${cx}" y="${topY + h / 2 - 3}" text-anchor="middle" class="topo-t1">${icon} ${esc(title)}</text>
        <text x="${cx}" y="${topY + h / 2 + 13}" text-anchor="middle" class="topo-t2">${esc(sub)}</text></g>`;
    }

    let edges = '', nodes = '';
    const coreCx = W / 2, coreBottom = coreY + coreH;
    layout.forEach((l, i) => {
      const cx = colX(i);
      // core -> router
      edges += `<path d="M ${coreCx} ${coreBottom} C ${coreCx} ${rtrY - 30}, ${cx} ${coreY + 80}, ${cx} ${rtrY}" class="topo-edge"/>`;
      // vertical spine router -> last leaf (behind boxes)
      if (l.leaves.length) {
        const lastY = leafTop + (l.leaves.length - 1) * leafStep + leafH / 2;
        edges += `<line x1="${cx}" y1="${rtrY + rtrH}" x2="${cx}" y2="${lastY}" class="topo-edge"/>`;
      }
      // router node
      nodes += node(cx, rtrY, nodeW, rtrH, '🌐', l.gw.hostname, l.gw.ip,
        { cls: 'router', stroke: stroke(l.gw.status), dim: l.gw.status !== 'up' });
      // subnet caption
      nodes += `<text x="${cx}" y="${rtrY - 14}" text-anchor="middle" class="topo-cap">${esc(l.net.label)}</text>`;
      // leaf devices
      l.leaves.forEach((d, j) => {
        const y = leafTop + j * leafStep;
        nodes += node(cx, y, nodeW - 8, leafH, d.isRouter ? '🌐' : '💻', d.hostname, `${d.ip} · ${d.bandwidth}%`,
          { stroke: stroke(d.status), dim: d.status !== 'up' });
      });
    });

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="topo-svg">
      ${edges}
      ${node(coreCx, coreY, coreW, coreH, '🛰️', t.core.label, t.core.sub, { cls: 'core', stroke: '#38bdf8' })}
      ${nodes}
    </svg>`;
  }

  // ---------- PERFORMANCE METRICS ----------
  const METRIC_META = [
    { key: 'cpu', label: 'CPU', color: '#38bdf8' },
    { key: 'ram', label: 'RAM', color: '#a78bfa' },
    { key: 'disk', label: 'Disk', color: '#f59e0b' },
    { key: 'bandwidth', label: 'Bandwidth', color: '#34d399' },
  ];
  async function renderMetrics() {
    const m = await api('/api/metrics');
    $('#mSamples').textContent = m.samples;
    $('#metricStats').innerHTML = METRIC_META.map((meta) => {
      const st = m.stats[meta.key];
      return `<div class="card metric-card">
        <h3 style="color:${meta.color}">${meta.label}</h3>
        <div class="metric-current">${st.current}%</div>
        <div class="metric-mma"><span>min ${st.min}</span><span>avg ${st.avg}</span><span>max ${st.max}</span></div>
      </div>`;
    }).join('');
    $('#perNetBody').innerHTML = m.perNetwork.map((n) => `
      <tr><td>${n.label}</td><td>${n.up}/${n.total}</td><td>${n.cpu}%</td><td>${n.ram}%</td><td>${n.disk}%</td><td>${n.bandwidth}%</td></tr>`).join('');
    drawMultiLine($('#metricChart'), m.series, METRIC_META);
  }

  // ================= CHART RENDERERS (pure SVG/Canvas) =================
  function drawGauge(el, value, color) {
    const v = Math.max(0, Math.min(100, value));
    const R = 52, C = Math.PI * R; // semicircle length
    const off = C * (1 - v / 100);
    el.innerHTML = `
      <svg width="150" height="100" viewBox="0 0 150 100">
        <path d="M15 90 A 60 60 0 0 1 135 90" fill="none" stroke="#243150" stroke-width="14" stroke-linecap="round"/>
        <path d="M15 90 A 60 60 0 0 1 135 90" fill="none" stroke="${color}" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"
              style="transition:stroke-dashoffset .6s ease"/>
        <text x="75" y="78" text-anchor="middle" font-size="26" font-weight="700" fill="#e6edf7">${v.toFixed(1)}</text>
        <text x="75" y="94" text-anchor="middle" font-size="11" fill="#8aa0c0">%</text>
      </svg>`;
  }

  function drawPie(el, used, free) {
    const total = used + free || 1;
    const usedAngle = (used / total) * 360;
    const large = usedAngle > 180 ? 1 : 0;
    const rad = (a) => (a - 90) * Math.PI / 180;
    const x = 60 + 50 * Math.cos(rad(usedAngle));
    const y = 60 + 50 * Math.sin(rad(usedAngle));
    el.innerHTML = `
      <svg width="180" height="150" viewBox="0 0 120 130">
        <circle cx="60" cy="60" r="50" fill="none" stroke="#243150" stroke-width="18"/>
        <path d="M60 10 A 50 50 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)}" fill="none" stroke="#38bdf8" stroke-width="18"/>
        <text x="60" y="58" text-anchor="middle" font-size="20" font-weight="700" fill="#e6edf7">${used.toFixed(1)}%</text>
        <text x="60" y="74" text-anchor="middle" font-size="10" fill="#8aa0c0">used</text>
        <text x="60" y="125" text-anchor="middle" font-size="11" fill="#34d399">${free.toFixed(1)}% free</text>
      </svg>`;
  }

  function drawLineChart(history) {
    const cv = $('#lineChart');
    const w = cv.width = cv.clientWidth || 600;
    const h = cv.height;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const pad = 28;
    // grid
    ctx.strokeStyle = '#1b2740'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (h - 2 * pad) * (i / 4);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 6, y); ctx.stroke();
      ctx.fillStyle = '#8aa0c0'; ctx.font = '10px sans-serif';
      ctx.fillText(String(100 - i * 25), 4, y + 3);
    }
    if (!history || history.length < 2) return;
    const series = [
      { key: 'cpu', color: '#38bdf8' },
      { key: 'ram', color: '#a78bfa' },
      { key: 'bandwidth', color: '#34d399' },
    ];
    const n = history.length;
    const xOf = (i) => pad + (w - pad - 6) * (i / (n - 1));
    const yOf = (v) => pad + (h - 2 * pad) * (1 - v / 100);
    for (const s of series) {
      ctx.beginPath();
      ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      history.forEach((pt, i) => {
        const x = xOf(i), y = yOf(pt[s.key]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  // multi-series line chart from { key: [values] } + meta [{key,color}]
  function drawMultiLine(cv, series, meta) {
    const w = cv.width = cv.clientWidth || 600;
    const h = cv.height;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const pad = 28;
    ctx.strokeStyle = '#1b2740'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad + (h - 2 * pad) * (i / 4);
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 6, y); ctx.stroke();
      ctx.fillStyle = '#8aa0c0'; ctx.font = '10px sans-serif';
      ctx.fillText(String(100 - i * 25), 4, y + 3);
    }
    const len = Math.max(...meta.map((s) => (series[s.key] || []).length), 0);
    if (len < 2) return;
    const xOf = (i) => pad + (w - pad - 6) * (i / (len - 1));
    const yOf = (v) => pad + (h - 2 * pad) * (1 - v / 100);
    for (const s of meta) {
      const data = series[s.key] || [];
      ctx.beginPath();
      ctx.strokeStyle = s.color; ctx.lineWidth = 2;
      data.forEach((v, i) => { const x = xOf(i), y = yOf(v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
    }
  }
})();
