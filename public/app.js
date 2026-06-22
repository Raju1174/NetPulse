/* NetPulse - Monitor Client (frontend logic). No external libraries. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const api = (p, opts) => fetch(p, opts).then((r) => r.json());
  const fmt = (v, suf = '') => (v == null ? '—' : v + suf);   // VPCS report no metrics -> "—"
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
  let selectedDevice = null;   // null = whole network (aggregate)
  let deviceHist = [];         // client-side history for the selected device
  async function renderOverview() {
    const o = await api('/api/overview');
    $('#upCount').textContent = `${o.devicesUp}/${o.devicesTotal} devices up`;
    const list = o.deviceIps || [];

    // resolve the current selection (fall back to network view if it vanished)
    let sel = selectedDevice ? list.find((d) => d.name === selectedDevice) : null;
    if (selectedDevice && !sel) { selectedDevice = null; deviceHist = []; }

    let cpu, ram, disk, bw, used, free, hist, title;
    if (sel) {
      cpu = sel.cpu || 0; ram = sel.ram || 0; disk = sel.disk || 0; bw = sel.bandwidth || 0;
      used = +(((cpu + ram + disk) / 3)).toFixed(1); free = +(100 - used).toFixed(1);
      deviceHist.push({ cpu, ram, bandwidth: bw });
      while (deviceHist.length > 40) deviceHist.shift();
      hist = deviceHist;
      title = `${sel.name} — CPU / RAM / Bandwidth %`;
    } else {
      cpu = o.cpu; ram = o.ram; disk = o.disk; bw = o.bandwidth;
      used = o.resource.used; free = o.resource.free;
      hist = o.history;
      title = 'Network Performance (CPU / RAM / Bandwidth %)';
    }

    drawGauge($('#g-cpu'), cpu, '#38bdf8');
    drawGauge($('#g-ram'), ram, '#a78bfa');
    drawGauge($('#g-disk'), disk, '#f59e0b');
    drawGauge($('#g-bw'), bw, '#34d399');
    drawPie($('#pie'), used, free);
    drawLineChart(hist);
    const heading = document.querySelector('#view-overview .card.grow h3');
    if (heading) heading.textContent = title;

    const chip = (dev, label, ip, active) =>
      `<div class="chip selectable${active ? ' active' : ''}" data-dev="${dev}">${label}${ip && ip !== '—' ? ` <span class="chip-ip">${ip}</span>` : ''}</div>`;
    $('#overviewDevices').innerHTML =
      chip('', 'All Devices', '', !selectedDevice) +
      list.map((d) => chip(d.name, d.name, d.ip, selectedDevice === d.name)).join('');
    $('#overviewDevices').querySelectorAll('.chip').forEach((c) => {
      c.onclick = () => { selectedDevice = c.dataset.dev || null; deviceHist = []; renderOverview(); };
    });
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
        <td>${fmt(d.cpu, '%')}</td><td>${fmt(d.ram, '%')}</td><td>${fmt(d.disk, '%')}</td>
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
        <td>${fmt(d.sent)}</td><td>${fmt(d.received)}</td>
        <td><strong>${fmt(d.bandwidth, '%')}</strong></td>
      </tr>`).join('');
  }

  // ---------- TRAFFIC ----------
  async function renderTraffic() {
    const list = await api('/api/traffic');
    const max = Math.max(100, ...list.map((d) => d.total || 0));
    $('#trafficBars').innerHTML = list.map((d) => {
      const t = d.total || 0;
      const pct = (t / max) * 100;
      const hot = t > 0.7 * max;
      return `<div class="bar-row">
        <div class="lbl">${d.ip} · ${d.hostname}</div>
        <div class="bar-track"><div class="bar-fill ${hot ? 'hot' : ''}" style="width:${pct}%"></div></div>
        <div class="val">${d.total == null ? '—' : t + ' Mbps'}</div>
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

  // ---------- MAPS (exact GNS3 layout: real x/y coordinates + real links) ----------
  async function renderTopology() {
    const t = await api('/api/topology');
    const g = t.graph || { nodes: [], links: [] };
    const host = $('#topoMap');
    if (!g.nodes.length) { host.innerHTML = '<p class="muted-note">No nodes.</p>'; return; }

    // node box size in GNS3-coordinate space, then fit everything to a viewBox
    const NW = 150, NH = 46, PAD = 90;
    const xs = g.nodes.map((n) => n.x), ys = g.nodes.map((n) => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + NW;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + NH;
    const W = (maxX - minX) + PAD * 2, H = (maxY - minY) + PAD * 2;
    const X = (x) => x - minX + PAD;           // GNS3 x -> svg x (box top-left)
    const Y = (y) => y - minY + PAD;
    const cx = (n) => X(n.x) + NW / 2, cy = (n) => Y(n.y) + NH / 2;

    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const stroke = (st) => (st === 'up' ? '#34d399' : '#f43f5e');
    const icon = (n) => (n.type === 'dynamips' ? '🌐' : n.type === 'ethernet_switch' ? '🔀' : '💻');

    // links first (under nodes), with port labels at each end
    let edges = '';
    for (const l of g.links) {
      const a = byId.get(l.source), b = byId.get(l.target);
      if (!a || !b) continue;
      const ax = cx(a), ay = cy(a), bx = cx(b), by = cy(b);
      edges += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="topo-edge"/>`;
      const lx = ax + (bx - ax) * 0.22, ly = ay + (by - ay) * 0.22;
      const rx = ax + (bx - ax) * 0.78, ry = ay + (by - ay) * 0.78;
      if (l.sourcePort) edges += `<text x="${lx}" y="${ly}" class="topo-port">${esc(l.sourcePort)}</text>`;
      if (l.targetPort) edges += `<text x="${rx}" y="${ry}" class="topo-port">${esc(l.targetPort)}</text>`;
    }

    let nodes = '';
    for (const n of g.nodes) {
      const x = X(n.x), y = Y(n.y);
      const dim = n.status !== 'up' ? 'opacity="0.5"' : '';
      const cls = n.type === 'dynamips' ? 'router' : '';
      nodes += `<g ${dim}><title>${esc(n.name)} — ${esc(n.ip || n.type)} (${n.status === 'up' ? 'started' : 'stopped'})</title>
        <rect x="${x}" y="${y}" rx="9" width="${NW}" height="${NH}" class="topo-node ${cls}" stroke="${stroke(n.status)}"/>
        <text x="${x + NW / 2}" y="${y + NH / 2 - 3}" text-anchor="middle" class="topo-t1">${icon(n)} ${esc(n.name)}</text>
        <text x="${x + NW / 2}" y="${y + NH / 2 + 13}" text-anchor="middle" class="topo-t2">${esc(n.ip || n.type)}</text></g>`;
    }

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${Math.min(H, 760)}" preserveAspectRatio="xMidYMid meet" class="topo-svg">
      ${edges}
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
    const R = 60, C = Math.PI * R; // semicircle length (must match arc radius below)
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
