/*
 * NetPulse - Live GNS3 data source
 * --------------------------------
 * Replaces the old lib/simulator.js. Instead of inventing numbers, this talks
 * to the real GNS3 controller REST API (v2, e.g. http://127.0.0.1:3080) and
 * reports the ACTUAL project: nodes, their types, started/stopped status, the
 * links between them, and each device's real IP/subnet/gateway (read from the
 * VPCS `startup.vpc` and router configs via the GNS3 file API).
 *
 * What GNS3 exposes (and we surface): inventory, node status, links, configs.
 * What GNS3 does NOT expose for VPCS/dynamips guests: live CPU/RAM/bandwidth.
 * Those screens are intentionally gone — this is real data only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- configuration ---------------------------------------------------------
// Resolve GNS3 server URL / credentials / project from env, falling back to the
// local gns3_server.conf (same machine) so it "just works" without committing
// any secret into the repo.
function readServerConf() {
  const base = path.join(os.homedir(), '.config', 'GNS3');
  let conf = {};
  try {
    for (const ver of fs.readdirSync(base)) {
      const f = path.join(base, ver, 'gns3_server.conf');
      if (!fs.existsSync(f)) continue;
      const txt = fs.readFileSync(f, 'utf8');
      const get = (k) => (txt.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+)$', 'm')) || [])[1];
      const host = (get('host') || 'localhost').trim();
      const port = (get('port') || '3080').trim();
      conf = {
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
        user: (get('user') || '').trim(),
        password: (get('password') || '').trim(),
      };
      if (conf.password) break; // prefer a conf that actually has auth
    }
  } catch (_) { /* no conf -> rely on env/defaults */ }
  return conf;
}

const fileConf = readServerConf();
const CFG = {
  url: (process.env.GNS3_URL || fileConf.url || 'http://127.0.0.1:3080').replace(/\/$/, ''),
  user: process.env.GNS3_USER || fileConf.user || '',
  password: process.env.GNS3_PASSWORD || fileConf.password || '',
  project: process.env.GNS3_PROJECT || 'Network Topology',
  pollMs: parseInt(process.env.GNS3_POLL_MS || '3000', 10),
};

// allow the dashboard's "Connect" form to override the target at runtime
function applyOverrides(o) {
  if (!o) return;
  if (o.url) CFG.url = String(o.url).replace(/\/$/, '');
  if (o.user) CFG.user = o.user;
  if (o.password) CFG.password = o.password;
  if (o.project) CFG.project = o.project;
}

function authHeader() {
  if (!CFG.user && !CFG.password) return {};
  const token = Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function api(pathname, { raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(CFG.url + pathname, {
      headers: { Accept: 'application/json', ...authHeader() },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`GNS3 ${res.status} ${res.statusText} for ${pathname}`);
    return raw ? res.text() : res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- config parsing --------------------------------------------------------
function parseVpcs(text) {
  // startup.vpc:  ip 192.168.1.20/24 192.168.1.1   /   set pcname FOO
  const out = { ip: null, cidr: null, gateway: null, pcname: null };
  const ipm = text.match(/^\s*ip\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)(?:\s+(\d+\.\d+\.\d+\.\d+))?/m);
  if (ipm) { out.ip = ipm[1]; out.cidr = parseInt(ipm[2], 10); out.gateway = ipm[3] || null; }
  const nm = text.match(/^\s*set\s+pcname\s+(.+)$/m);
  if (nm) out.pcname = nm[1].trim();
  return out;
}

function parseRouter(text) {
  // pull hostname + each "interface X / ip address A B" pair
  const out = { hostname: null, interfaces: [] };
  const hm = text.match(/^\s*hostname\s+(\S+)/m);
  if (hm) out.hostname = hm[1];
  const re = /^\s*interface\s+(\S+)([\s\S]*?)(?=^\s*interface\s|\Z|^\s*end\s*$)/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const iface = m[1];
    const body = m[2];
    const ipm = body.match(/ip\s+address\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (ipm) out.interfaces.push({ iface, ip: ipm[1], mask: ipm[2], cidr: maskToCidr(ipm[2]) });
    else if (/ip\s+address\s+dhcp/i.test(body)) out.interfaces.push({ iface, ip: 'dhcp', mask: null, cidr: null });
  }
  return out;
}

// ---- ip helpers ------------------------------------------------------------
const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + (+o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
function maskToCidr(mask) {
  return mask.split('.').reduce((a, o) => a + (((+o).toString(2).match(/1/g) || []).length), 0);
}
function cidrToMask(cidr) {
  const n = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  return intToIp(n);
}
function networkAddr(ip, cidr) {
  const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  return intToIp((ipToInt(ip) & mask) >>> 0);
}

// ---- device classification -------------------------------------------------
function osLabel(node) {
  const p = node.properties || {};
  switch (node.node_type) {
    case 'dynamips': return `Cisco IOS · ${p.platform || 'router'}`;
    case 'vpcs': return 'VPCS (virtual PC)';
    case 'ethernet_switch': return 'Ethernet switch (L2)';
    case 'qemu': return p.hda_disk_image ? `QEMU · ${p.hda_disk_image}` : 'QEMU VM';
    case 'docker': return `Docker · ${p.image || 'container'}`;
    default: return node.node_type;
  }
}
const isUp = (node) => node.status === 'started';
const firstPortName = (node) => (node.ports && node.ports[0] && node.ports[0].short_name) || (node.ports && node.ports[0] && node.ports[0].name) || '';

// ---- live state ------------------------------------------------------------
const state = {
  connected: false,
  error: null,
  project: null,        // { name, project_id, status }
  raw: { nodes: [], links: [] },
  configCache: {},      // node_id -> parsed config (refreshed lazily)
  configFetchedAt: 0,
  devices: [],          // shaped device records
  networks: [],         // subnet groups for Devices/Maps
  updatedAt: 0,
};

async function findProject() {
  const projects = await api('/v2/projects');
  const byName = projects.find((p) => p.name === CFG.project);
  const opened = projects.find((p) => p.status === 'opened');
  const proj = byName || opened || projects[0];
  if (!proj) throw new Error('No GNS3 projects found on the controller');
  return proj;
}

async function loadConfigs(projectId, nodes) {
  // fetch + parse device configs (cached; refreshed at most every 60s)
  const cache = {};
  await Promise.all(nodes.map(async (n) => {
    try {
      if (n.node_type === 'vpcs') {
        const txt = await api(`/v2/projects/${projectId}/nodes/${n.node_id}/files/startup.vpc`, { raw: true });
        cache[n.node_id] = { kind: 'vpcs', ...parseVpcs(txt) };
      } else if (n.node_type === 'dynamips') {
        const did = (n.properties || {}).dynamips_id;
        if (did != null) {
          const txt = await api(`/v2/projects/${projectId}/nodes/${n.node_id}/files/configs/i${did}_startup-config.cfg`, { raw: true });
          cache[n.node_id] = { kind: 'router', ...parseRouter(txt) };
        }
      }
    } catch (_) { /* a node may have no saved config yet */ }
  }));
  return cache;
}

function shape(nodes, links, configs) {
  // 1) build device records
  const devices = nodes.map((n) => {
    const cfg = configs[n.node_id] || {};
    let ip = null, cidr = null, gateway = null, iface = firstPortName(n), interfaces = [];
    if (cfg.kind === 'vpcs') {
      ip = cfg.ip; cidr = cfg.cidr; gateway = cfg.gateway;
    } else if (cfg.kind === 'router') {
      interfaces = cfg.interfaces || [];
      const primary = interfaces.find((i) => i.ip && i.ip !== 'dhcp');
      if (primary) { ip = primary.ip; cidr = primary.cidr; iface = primary.iface; }
    }
    // QEMU/other guests have no GNS3 config to parse — fall back to an IP in the node name
    if (!ip) {
      const nameIp = (n.name.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/) || [])[1];
      if (nameIp) ip = nameIp;
    }
    return {
      id: n.node_id,
      name: n.name,
      type: n.node_type,
      osName: osLabel(n),
      status: isUp(n) ? 'up' : 'down',
      running: isUp(n),
      console: n.console ? `${n.console_type || 'telnet'}:${n.console}` : null,
      ip, cidr, gateway, iface, interfaces,
      subnet: ip && cidr != null ? cidrToMask(cidr) : null,
      network: ip && cidr != null ? `${networkAddr(ip, cidr)}/${cidr}` : null,
    };
  });

  // 2) group into subnets (only hosts with an IP define a subnet)
  const groups = new Map();
  const ensure = (id, label) => {
    if (!groups.has(id)) groups.set(id, { id, label, subnet: null, gatewayIp: null, devices: [] });
    return groups.get(id);
  };
  const byInterfaceIp = new Map();           // router interface ip -> device
  devices.forEach((d) => {
    if (d.type === 'dynamips') d.interfaces.forEach((i) => { if (i.ip && i.ip !== 'dhcp') byInterfaceIp.set(i.ip, d); });
  });

  for (const d of devices) {
    if (d.network && (d.type === 'vpcs' || d.type === 'qemu' || d.type === 'docker')) {
      const g = ensure(d.network, `Subnet ${d.network}`);
      g.subnet = d.subnet;
      g.devices.push({ ...d, isRouter: false });
      if (d.gateway && !g.gatewayIp) g.gatewayIp = d.gateway;
    }
  }
  // attach the gateway router to each subnet it serves
  for (const g of groups.values()) {
    if (g.gatewayIp && byInterfaceIp.has(g.gatewayIp)) {
      const r = byInterfaceIp.get(g.gatewayIp);
      g.devices.unshift({ ...r, ip: g.gatewayIp, isRouter: true });
    }
  }
  // everything not placed (switches, IP-less VPCS, unconfigured nodes) -> infra
  const placed = new Set();
  for (const g of groups.values()) g.devices.forEach((d) => placed.add(d.id));
  const infra = devices.filter((d) => !placed.has(d.id));
  if (infra.length) {
    const g = ensure('infrastructure', 'Infrastructure (L2 / no IP)');
    infra.forEach((d) => g.devices.push({ ...d, isRouter: /dynamips/.test(d.type) }));
  }

  return { devices, networks: Array.from(groups.values()) };
}

async function refresh(overrides) {
  applyOverrides(overrides);
  const proj = await findProject();
  state.project = { name: proj.name, project_id: proj.project_id, status: proj.status };
  const [nodes, links] = await Promise.all([
    api(`/v2/projects/${proj.project_id}/nodes`),
    api(`/v2/projects/${proj.project_id}/links`),
  ]);
  state.raw = { nodes, links };

  // configs are heavier; refresh them at most once a minute (or when empty)
  const ageOk = Date.now() - state.configFetchedAt < 60000 && Object.keys(state.configCache).length;
  if (!ageOk) {
    state.configCache = await loadConfigs(proj.project_id, nodes);
    state.configFetchedAt = Date.now();
  }

  const shaped = shape(nodes, links, state.configCache);
  state.devices = shaped.devices;
  state.networks = shaped.networks;
  state.connected = true;
  state.error = null;
  state.updatedAt = Date.now();
}

// ---- public API (consumed by server.js routes) -----------------------------
module.exports = {
  start() {
    refresh().catch((e) => { state.connected = false; state.error = e.message; });
    setInterval(() => {
      refresh().catch((e) => { state.connected = false; state.error = e.message; });
    }, CFG.pollMs);
  },

  // "Connect" button -> verify the GNS3 controller + project are reachable
  async connect(overrides) {
    try {
      await refresh(overrides);
      return {
        success: true,
        controller: CFG.url,
        project: state.project.name,
        projectStatus: state.project.status,
        nodes: state.raw.nodes.length,
        nodesUp: state.devices.filter((d) => d.running).length,
      };
    } catch (e) {
      state.connected = false;
      state.error = e.message;
      return { success: false, error: `Cannot reach GNS3 at ${CFG.url}: ${e.message}` };
    }
  },

  status() {
    return { connected: state.connected, error: state.error, controller: CFG.url, project: CFG.project, updatedAt: state.updatedAt };
  },

  // raw shaped device records (for the console probe: console port, gateway, type)
  rawDevices() {
    return state.devices;
  },

  networks() {
    return state.networks.map((n) => ({ id: n.id, label: n.label, subnet: n.subnet, count: n.devices.length }));
  },

  overview() {
    const d = state.devices;
    const up = d.filter((x) => x.running);
    const byType = {};
    for (const x of d) byType[x.type] = (byType[x.type] || 0) + 1;
    return {
      connected: state.connected,
      error: state.error,
      controller: CFG.url,
      project: state.project ? state.project.name : CFG.project,
      projectStatus: state.project ? state.project.status : 'unknown',
      devicesUp: up.length,
      devicesTotal: d.length,
      networks: state.networks.length,
      links: state.raw.links.length,
      byType,
      devicesList: d.map((x) => ({ name: x.name, ip: x.ip, type: x.type, status: x.status })),
      updatedAt: state.updatedAt,
    };
  },

  devices(networkId) {
    let list = state.devices;
    if (networkId) {
      const g = state.networks.find((n) => n.id === networkId);
      const ids = new Set(g ? g.devices.map((x) => x.id) : []);
      list = list.filter((x) => ids.has(x.id));
    }
    return list.map((d) => ({
      status: d.status,
      ip: d.ip || '—',
      name: d.name,
      osName: d.osName,
      type: d.type,
      network: d.network || '—',
      subnet: d.subnet || '—',
      iface: d.iface || '—',
      gateway: d.gateway || '—',
      console: d.console || '—',
      reachability: d.running ? 'Running' : 'Stopped',
    }));
  },

  topology() {
    // exact GNS3 layout: real x/y coordinates + real links between nodes
    const devById = new Map(state.devices.map((d) => [d.id, d]));
    const nodes = state.raw.nodes.map((n) => {
      const d = devById.get(n.node_id) || {};
      return {
        id: n.node_id,
        name: n.name,
        type: n.node_type,
        status: d.status || (n.status === 'started' ? 'up' : 'down'),
        isRouter: n.node_type === 'dynamips',
        ip: d.ip || '',
        x: n.x,
        y: n.y,
      };
    });
    const links = (state.raw.links || []).map((l) => {
      const a = (l.nodes && l.nodes[0]) || {};
      const b = (l.nodes && l.nodes[1]) || {};
      const lbl = (e) => (e.label && e.label.text) || '';
      return { source: a.node_id, target: b.node_id, sourcePort: lbl(a), targetPort: lbl(b) };
    });
    return {
      core: { label: 'GNS3 Controller', sub: state.project ? state.project.name : CFG.project },
      graph: { nodes, links },
      // legacy subnet grouping kept for any consumer that still wants it
      networks: state.networks.map((n) => ({
        id: n.id,
        label: n.label,
        subnet: n.subnet || '',
        devices: n.devices.map((d) => ({
          ip: d.ip || '',
          hostname: d.name,
          osName: d.osName,
          status: d.status,
          isRouter: !!d.isRouter,
          type: d.type,
        })),
      })),
    };
  },
};
