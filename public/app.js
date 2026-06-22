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
  const TITLES = { overview: 'Network Overview', devices: 'Devices', maps: 'Topology Map' };
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

  // ---------- MAPS (topology, SVG tree with connector lines) ----------
  async function renderTopology() {
    const t = await api('/api/topology');
    const host = $('#topoMap');
    const W = Math.max(host.clientWidth || 900, 760);
    const nets = t.networks;
    const cols = Math.max(1, nets.length);

    const coreW = 200, coreH = 50, coreY = 16;
    const rtrY = 132, rtrH = 46, nodeW = 172;
    const leafTop = 224, leafH = 42, leafStep = 58;
    const colX = (i) => (W * (i + 0.5)) / cols;

    const layout = nets.map((n) => {
      const gw = n.devices.find((d) => d.isRouter) || n.devices[0] || { hostname: n.label, ip: '', status: 'down', isRouter: true };
      const leaves = n.devices.filter((d) => d !== gw);
      return { net: n, gw, leaves };
    });
    const maxLeaves = Math.max(1, ...layout.map((l) => l.leaves.length));
    const H = leafTop + maxLeaves * leafStep + 10;
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
      edges += `<path d="M ${coreCx} ${coreBottom} C ${coreCx} ${rtrY - 30}, ${cx} ${coreY + 80}, ${cx} ${rtrY}" class="topo-edge"/>`;
      if (l.leaves.length) {
        const lastY = leafTop + (l.leaves.length - 1) * leafStep + leafH / 2;
        edges += `<line x1="${cx}" y1="${rtrY + rtrH}" x2="${cx}" y2="${lastY}" class="topo-edge"/>`;
      }
      nodes += node(cx, rtrY, nodeW, rtrH, l.gw.isRouter ? '🌐' : '🔀', l.gw.hostname, l.gw.ip || l.gw.type || '',
        { cls: 'router', stroke: stroke(l.gw.status), dim: l.gw.status !== 'up' });
      nodes += `<text x="${cx}" y="${rtrY - 14}" text-anchor="middle" class="topo-cap">${esc(l.net.label)}</text>`;
      l.leaves.forEach((d, j) => {
        const y = leafTop + j * leafStep;
        const icon = d.isRouter ? '🌐' : d.type === 'ethernet_switch' ? '🔀' : '💻';
        nodes += node(cx, y, nodeW - 8, leafH, icon, d.hostname, d.ip || d.type,
          { stroke: stroke(d.status), dim: d.status !== 'up' });
      });
    });

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" class="topo-svg">
      ${edges}
      ${node(coreCx, coreY, coreW, coreH, '🛰️', t.core.label, t.core.sub, { cls: 'core', stroke: '#38bdf8' })}
      ${nodes}
    </svg>`;
  }
})();
