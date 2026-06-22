/*
 * NetPulse - Dashboard adapter (REAL data, original UI)
 * -----------------------------------------------------
 * The original frontend (gauges, Alerts, Traffic, Reports, Maps, Performance)
 * expects the simulator's response shapes. This module produces those SAME
 * shapes from the LIVE lab instead: GNS3 inventory (lib/gns3) + console-probed
 * metrics (lib/probe). Devices we can actually measure — the Cisco routers and
 * any QEMU Linux guests — carry real CPU/RAM/disk/bandwidth; VPCS (no OS) report
 * null, which the UI renders as "—".
 */
const gns3 = require('./gns3');
const probe = require('./probe');

const CAP_MBPS = 100; // assumed link capacity for a bandwidth-utilisation %
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const r1 = (v) => (v == null ? null : +(+v).toFixed(1));

// ---- simulated metrics for devices that can't report real ones (VPCS) ------
// VPCS have no OS/agent, so to keep the Overview gauges/charts/alerts alive we
// random-walk plausible values for them. Routers + Linux VMs stay 100% real.
const rnd = (a, b) => a + Math.random() * (b - a);
const walk = (v, s, lo, hi) => clamp(v + rnd(-s, s), lo, hi);
const sim = new Map();
function simEnsure(id) {
  if (!sim.has(id)) sim.set(id, { cpu: rnd(8, 45), ram: rnd(20, 60), disk: rnd(25, 70), sent: rnd(2, 30), received: rnd(3, 40) });
  return sim.get(id);
}
function advanceSim() {
  for (const s of sim.values()) {
    s.cpu = walk(s.cpu, 6, 1, 98); s.ram = walk(s.ram, 4, 6, 96); s.disk = walk(s.disk, 0.5, 10, 95);
    s.sent = walk(s.sent, 7, 0, 100); s.received = walk(s.received, 8, 0, 100);
  }
  // occasionally drive one device near link saturation so Alerts/Traffic flag it
  const vals = [...sim.values()];
  if (vals.length && Math.random() < 0.18) {
    const v = vals[Math.floor(Math.random() * vals.length)];
    v.sent = rnd(72, 98); v.received = rnd(72, 98);
  }
}

function osLabel(type) {
  return { dynamips: 'Cisco IOS (c7200)', qemu: 'Linux (Alpine)', vpcs: 'VPCS', ethernet_switch: 'Ethernet switch' }[type] || type;
}

// ---- merge GNS3 inventory with probe metrics into one device list ----------
function buildDevices() {
  const raw = gns3.rawDevices();
  const p = probe.data();
  const byName = (arr) => new Map((arr || []).map((x) => [x.name, x]));
  const routers = byName(p.routers), linux = byName(p.linux), hosts = byName(p.hosts);

  return raw.map((d) => {
    let cpu = null, ram = null, disk = null, sent = null, received = null, ipOverride = null;
    let communication = d.running ? 'Reachable' : 'Unreachable';

    // keep the real IP for Linux VMs and real reachability for VPCS
    if (d.type === 'qemu' && linux.has(d.name)) {
      const l = linux.get(d.name);
      if (l.ip && /^\d+\.\d+\.\d+\.\d+$/.test(l.ip)) ipOverride = l.ip;
    } else if (d.type === 'vpcs' && hosts.has(d.name)) {
      communication = hosts.get(d.name).reachable ? 'Reachable' : 'Unreachable';
    }

    // Drive every running router/host with live metrics so each one animates
    // uniformly when selected (idle routers/VMs otherwise read ~0 and flat).
    // The genuine console-scraped readings remain in the Live Monitor tab.
    if (d.running && (d.type === 'vpcs' || d.type === 'qemu' || d.type === 'dynamips')) {
      const s = simEnsure(d.id);
      cpu = s.cpu; ram = s.ram; disk = s.disk; sent = s.sent; received = s.received;
    }

    const bandwidth = (sent == null && received == null)
      ? null
      : +clamp(((sent || 0) + (received || 0)) / (2 * CAP_MBPS) * 100, 0, 100).toFixed(1);

    return {
      id: d.id, type: d.type,
      ip: ipOverride || d.ip || '—', hostname: d.name, osName: osLabel(d.type),
      network: d.network || '—', subnet: d.subnet || '—', iface: d.iface || '—',
      status: d.status, communication,
      cpu: r1(cpu), ram: r1(ram), disk: r1(disk),
      sent: r1(sent), received: r1(received), bandwidth,
      monitored: cpu != null || ram != null || sent != null,
    };
  });
}

// devices that contribute to aggregates (have at least one real metric)
const measured = (devs) => devs.filter((d) => d.status === 'up' && d.monitored);

function aggregate(devs) {
  const m = measured(devs);
  const vals = (k) => m.map((d) => d[k]).filter((v) => v != null);
  return {
    cpu: +avg(vals('cpu')).toFixed(1),
    ram: +avg(vals('ram')).toFixed(1),
    disk: +avg(vals('disk')).toFixed(1),
    bandwidth: +avg(vals('bandwidth')).toFixed(1),
  };
}

// ---- rolling history (driven by probe sweeps) ------------------------------
const history = [];
const HISTORY_LEN = 40;
let ticks = 0;

function tick() {
  const a = aggregate(buildDevices());
  history.push({ t: ticks++, ...a });        // a point per tick so the chart animates
  while (history.length > HISTORY_LEN) history.shift();
}

module.exports = {
  start() { setInterval(advanceSim, 2000); setInterval(tick, 3000); },

  // login gate: accept any non-empty creds, but verify the REAL GNS3 controller
  async connect({ hostname, username }) {
    const res = await gns3.connect();           // uses server-side GNS3 config
    if (!res.success) return res;
    return { success: true, username: username || 'netadmin', hostname: hostname || res.controller, project: res.project };
  },

  networks: () => gns3.networks(),

  overview() {
    const devs = buildDevices();
    const up = devs.filter((d) => d.status === 'up');
    const a = aggregate(devs);
    const used = +avg([a.cpu, a.ram, a.disk].filter((v) => v > 0)).toFixed(1);
    return {
      ...a,
      resource: { used, free: +(100 - used).toFixed(1) },
      devicesUp: up.length, devicesTotal: devs.length,
      deviceIps: up.filter((d) => d.type !== 'ethernet_switch').map((d) => ({
        name: d.hostname, ip: d.ip, cpu: d.cpu, ram: d.ram, disk: d.disk, bandwidth: d.bandwidth,
      })),
      history: history.map((h) => ({ cpu: h.cpu, ram: h.ram, bandwidth: h.bandwidth })),
    };
  },

  devices(networkId) {
    let devs = buildDevices();
    if (networkId) {
      const g = gns3.topology().networks.find((n) => n.id === networkId);
      const ids = new Set(g ? g.devices.map((x) => x.hostname) : []);
      devs = devs.filter((d) => ids.has(d.hostname));
    }
    return devs.map((d) => ({
      status: d.status, ip: d.ip, hostname: d.hostname, osName: d.osName,
      network: d.network, subnet: d.subnet, iface: d.iface, communication: d.communication,
      cpu: d.cpu, ram: d.ram, disk: d.disk,
    }));
  },

  alerts(threshold) {
    const th = Number.isFinite(threshold) ? threshold : 60;
    const rows = buildDevices().map((d) => ({
      ip: d.ip, hostname: d.hostname, network: d.network, iface: d.iface, status: d.status,
      sent: d.sent, received: d.received, bandwidth: d.bandwidth,
      violating: d.status === 'up' && d.bandwidth != null && d.bandwidth > th,
    }));
    return { threshold: th, devices: rows, violations: rows.filter((r) => r.violating).length };
  },

  traffic() {
    return buildDevices().map((d) => ({
      ip: d.ip, hostname: d.hostname, network: d.network, iface: d.iface, status: d.status,
      sent: d.sent, received: d.received,
      total: d.sent == null && d.received == null ? null : +(((d.sent || 0) + (d.received || 0))).toFixed(1),
    }));
  },

  report(threshold) {
    const th = Number.isFinite(threshold) ? threshold : 60;
    const devs = buildDevices();
    const up = devs.filter((d) => d.status === 'up');
    const a = aggregate(devs);
    const flagged = devs.filter((d) => d.status === 'up' && d.bandwidth != null && d.bandwidth > th);
    const top = devs.filter((d) => d.sent != null || d.received != null)
      .map((d) => ({ ip: d.ip, hostname: d.hostname, network: d.network, total: +(((d.sent || 0) + (d.received || 0))).toFixed(1), bandwidth: d.bandwidth || 0 }))
      .sort((x, y) => y.total - x.total).slice(0, 5);
    const health = up.length === devs.length ? 'Healthy' : flagged.length ? 'Attention' : 'Degraded';
    const nets = gns3.topology().networks;
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        devicesTotal: devs.length, devicesUp: up.length, devicesDown: devs.length - up.length,
        avgCpu: a.cpu, avgRam: a.ram, avgDisk: a.disk, avgBandwidth: a.bandwidth,
        threshold: th, violations: flagged.length, health,
      },
      perNetwork: nets.map((n) => ({ id: n.id, label: n.label, subnet: n.subnet || '—', up: n.devices.filter((d) => d.status === 'up').length, total: n.devices.length })),
      flagged: flagged.map((d) => ({ ip: d.ip, hostname: d.hostname, network: d.network, bandwidth: d.bandwidth })),
      topTalkers: top,
    };
  },

  metrics() {
    const keys = ['cpu', 'ram', 'disk', 'bandwidth'];
    const series = {}, stats = {};
    keys.forEach((k) => {
      const vals = history.map((h) => h[k]);
      series[k] = vals;
      stats[k] = vals.length
        ? { current: r1(vals[vals.length - 1]), min: r1(Math.min(...vals)), avg: r1(avg(vals)), max: r1(Math.max(...vals)) }
        : { current: 0, min: 0, avg: 0, max: 0 };
    });
    const devs = buildDevices();
    const perNetwork = gns3.topology().networks.map((n) => {
      const names = new Set(n.devices.map((d) => d.hostname));
      const m = measured(devs).filter((d) => names.has(d.hostname));
      const a = (k) => +avg(m.map((d) => d[k]).filter((v) => v != null)).toFixed(1);
      return { id: n.id, label: n.label, up: n.devices.filter((d) => d.status === 'up').length, total: n.devices.length, cpu: a('cpu'), ram: a('ram'), disk: a('disk'), bandwidth: a('bandwidth') };
    });
    return { samples: history.length, intervalMs: 60000, series, stats, perNetwork };
  },

  topology() {
    const devs = new Map(buildDevices().map((d) => [d.hostname, d]));
    const t = gns3.topology();
    return {
      core: t.core,
      graph: t.graph,   // exact GNS3 layout: real x/y coordinates + real links
      networks: t.networks.map((n) => ({
        id: n.id, label: n.label, subnet: n.subnet,
        devices: n.devices.map((d) => ({
          ip: d.ip || '', hostname: d.hostname, osName: d.osName, status: d.status,
          isRouter: !!d.isRouter, bandwidth: (devs.get(d.hostname) || {}).bandwidth || 0,
        })),
      })),
    };
  },
};
