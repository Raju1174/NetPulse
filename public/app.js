/* NetPulse - Monitor Client (LIVE GNS3). No external libraries. */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const api = (p, opts) => fetch(p, opts).then((r) => r.json());
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let currentView = 'overview';
  let pollTimer = null;
  let session = null;

  // ---------- CONNECT ----------
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
          project: $('#project').value.trim(),
        }),
      });
      if (!res.success) throw new Error(res.error || 'Connection failed');
      session = res;
      enterDashboard();
    } catch (e2) {
      err.textContent = e2.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect to GNS3';
    }
  });

  function enterDashboard() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#sessInfo').textContent = `${session.project} · ${session.nodesUp}/${session.nodes} up`;
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
  const TITLES = { overview: 'Network Overview', devices: 'Devices', monitor: 'Live Monitor', maps: 'Topology Map' };
  function switchView(view) {
    currentView = view;
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + view).classList.remove('hidden');
    $('#viewTitle').textContent = TITLES[view];
    refresh();
  }

  // ---------- POLLING ----------
  function startPolling() { stopPolling(); pollTimer = setInterval(refresh, 3000); }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  async function refresh() {
    if (!session) return;
    try {
      if (currentView === 'overview') await renderOverview();
      else if (currentView === 'devices') await renderDevices();
      else if (currentView === 'monitor') await renderMonitor();
      else if (currentView === 'maps') await renderTopology();
    } catch (e) { /* transient */ }
  }

  // ---------- NETWORKS dropdown ----------
  async function loadNetworks() {
    const nets = await api('/api/networks');
    const sel = $('#networkSelect');
    sel.innerHTML = '<option value="">All networks</option>' +
      nets.map((n) => `<option value="${esc(n.id)}">${esc(n.label)} — ${n.count} devices</option>`).join('');
    sel.onchange = renderDevices;
  }

  // ---------- OVERVIEW ----------
  async function renderOverview() {
    const o = await api('/api/overview');
    $('#upCount').textContent = `${o.devicesUp}/${o.devicesTotal} nodes up`;

    const banner = $('#connBanner');
    if (o.connected === false || o.error) {
      banner.className = 'conn-banner err';
      banner.textContent = '⚠ Not connected to GNS3: ' + (o.error || 'unknown error') + ' — is the controller running and the project open?';
    } else {
      banner.className = 'conn-banner hidden';
    }

    $('#s-total').textContent = o.devicesTotal;
    $('#s-up').textContent = o.devicesUp;
    $('#s-down').textContent = o.devicesTotal - o.devicesUp;
    $('#s-nets').textContent = o.networks;
    $('#s-links').textContent = o.links;
    $('#ovCtrl').textContent = o.controller || '—';
    $('#ovProj').textContent = `${o.project} (${o.projectStatus})`;

    $('#overviewDevices').innerHTML = (o.devicesList || []).map((d) => `
      <div class="node-pill ${d.status}">
        <span class="dot ${d.status}"></span>
        <span class="np-name">${esc(d.name)}</span>
        <span class="np-ip">${esc(d.ip || d.type)}</span>
      </div>`).join('');

    const types = o.byType || {};
    $('#typeBreakdown').innerHTML = Object.keys(types).sort().map((t) =>
      `<div class="type-row"><span>${esc(t)}</span><strong>${types[t]}</strong></div>`).join('') || '<p class="muted-note">No nodes.</p>';
  }

  // ---------- DEVICES ----------
  async function renderDevices() {
    const net = $('#networkSelect').value;
    const list = await api('/api/devices' + (net ? '?network=' + encodeURIComponent(net) : ''));
    $('#devicesBody').innerHTML = list.map((d) => `
      <tr>
        <td><span class="dot ${d.status}"></span> ${d.status === 'up' ? 'started' : 'stopped'}</td>
        <td>${esc(d.name)}</td>
        <td>${esc(d.ip)}</td>
        <td>${esc(d.osName)}</td>
        <td>${esc(d.network)}</td>
        <td>${esc(d.subnet)}</td>
        <td>${esc(d.iface)}</td>
        <td>${esc(d.gateway)}</td>
        <td class="mono">${esc(d.console)}</td>
        <td>${esc(d.reachability)}</td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted-note">No devices in this network.</td></tr>';
  }

  // ---------- LIVE MONITOR (console-probed real metrics) ----------
  function bar(pct, color) {
    const v = Math.max(0, Math.min(100, pct == null ? 0 : pct));
    return `<div class="mini-bar"><div class="mini-fill" style="width:${v}%;background:${color}"></div><span>${pct == null ? '—' : v + '%'}</span></div>`;
  }
  async function renderMonitor() {
    const m = await api('/api/monitor');
    const when = m.lastSweep ? new Date(m.lastSweep).toLocaleTimeString() : 'pending…';
    $('#monMeta').innerHTML = `Last console sweep: <strong>${when}</strong>` +
      (m.sweeping ? ' · <em>sweeping now…</em>' : '') +
      ` · hosts reachable: <strong>${m.reachableHosts}/${m.totalHosts}</strong>` +
      (m.error ? ` · <span style="color:#fca5a5">${esc(m.error)}</span>` : '') +
      (!m.lastSweep ? ' — first sweep can take ~30–60s.' : '');

    $('#monRouters').innerHTML = (m.routers || []).map((r) => {
      const ifs = (r.interfaces || []).map((i) =>
        `<div class="iface-line"><span class="dot ${i.up ? 'up' : 'down'}"></span>${esc(i.iface)}: ${i.inKbps == null ? '—' : i.inKbps}/${i.outKbps == null ? '—' : i.outKbps}</div>`).join('');
      const mem = r.memUsedPct == null ? '—' : `${bar(r.memUsedPct, '#a78bfa')}<span class="sub">${r.memUsedMB}/${r.memTotalMB} MB</span>`;
      return `<tr>
        <td><strong>${esc(r.name)}</strong></td><td>${esc(r.ip)}</td>
        <td>${bar(r.cpu5sec, '#38bdf8')}</td><td>${r.cpu1min == null ? '—' : r.cpu1min + '%'}</td><td>${r.cpu5min == null ? '—' : r.cpu5min + '%'}</td>
        <td>${mem}</td>
        <td class="ifaces">${ifs || '—'}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="7" class="muted-note">No router data yet (sweep pending or routers down).</td></tr>`;

    $('#monHosts').innerHTML = (m.hosts || []).map((h) => `
      <tr class="${h.reachable ? '' : 'violating'}">
        <td><span class="dot ${h.reachable ? 'up' : 'down'}"></span> ${h.reachable ? 'reachable' : 'unreachable'}</td>
        <td>${esc(h.name)}</td><td>${esc(h.ip)}</td><td>${esc(h.target)}</td>
        <td>${h.latencyMs == null ? '—' : '<strong>' + h.latencyMs + ' ms</strong>'}</td>
        <td class="muted-note">${esc(h.note)}</td>
      </tr>`).join('') || `<tr><td colspan="6" class="muted-note">No host data yet (first sweep pending).</td></tr>`;
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
})();
