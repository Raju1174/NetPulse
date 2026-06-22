/*
 * NetPulse - Live probe
 * --------------------------------
 * "Monitor what's possible now." GNS3 cannot expose guest CPU/RAM/disk for
 * VPCS, so we collect REAL signals by driving each node's console (telnet):
 *   - VPCS / hosts : ping the gateway -> reachability + latency (ms)
 *   - Cisco routers: `show` commands -> CPU %, memory used %, per-interface bitrate
 * Results are cached and refreshed by a slow background loop so the dashboard
 * stays responsive (a full console sweep is inherently slow).
 */
const net = require('net');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Drive a telnet console: connect, (optionally) wake, send commands, collect output.
function consoleExec(port, commands, { perCmd = 1400, settle = 700, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const sock = net.connect({ host, port });
    const finish = () => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(buf); } };
    sock.setTimeout(15000, finish);
    sock.on('data', (d) => {
      const out = [];
      for (let i = 0; i < d.length; i++) {
        if (d[i] === 255 && i + 2 < d.length) {          // telnet IAC: refuse all negotiation
          const cmd = d[i + 1], opt = d[i + 2];
          if (cmd === 253) sock.write(Buffer.from([255, 252, opt])); // DO  -> WONT
          else if (cmd === 251) sock.write(Buffer.from([255, 254, opt])); // WILL -> DONT
          i += 2; continue;
        }
        out.push(d[i]);
      }
      buf += Buffer.from(out).toString('latin1');
    });
    sock.on('error', finish);
    sock.on('connect', async () => {
      try {
        await delay(settle); sock.write('\r'); await delay(settle);
        for (const c of commands) { sock.write(c + '\r'); await delay(perCmd); }
        await delay(250);
      } catch (_) { /* ignore */ }
      finish();
    });
  });
}

// ---- VPCS: ping gateway -> reachability + latency --------------------------
async function probeHost(dev) {
  const port = consolePort(dev);
  if (!port || !dev.gateway || dev.gateway === '—') return null;
  const out = await consoleExec(port, [`ping ${dev.gateway} -c 1`], { perCmd: 2200 });
  const m = out.match(/bytes from [\d.]+ .*?time=([\d.]+)\s*ms/i);
  const reachable = !!m;
  return {
    name: dev.name,
    ip: dev.ip,
    target: dev.gateway,
    reachable,
    latencyMs: m ? +parseFloat(m[1]).toFixed(1) : null,
    note: reachable ? 'gateway reachable' : (/not reachable|timeout|host/i.test(out) ? 'no reply from gateway' : 'no response'),
  };
}

// ---- Router: CPU %, memory used %, interface bitrates ----------------------
async function probeRouter(dev) {
  const port = consolePort(dev);
  if (!port) return null;
  const out = await consoleExec(port, [
    'enable', 'terminal length 0',
    'show processes cpu | include utilization',
    'show memory statistics',
    'show interfaces',
  ], { perCmd: 1500 });

  // CPU: "CPU utilization for five seconds: 6%/0%; one minute: 5%; five minutes: 4%"
  const cpuM = out.match(/five seconds:\s*(\d+)%\/(\d+)%;\s*one minute:\s*(\d+)%;\s*five minutes:\s*(\d+)%/i);
  // Memory: "Processor   <head>   <total>   <used>   <free> ..."
  const memM = out.match(/Processor\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)/i);
  let memUsedPct = null, memTotalMB = null, memUsedMB = null;
  if (memM) {
    const total = +memM[1], used = +memM[2];
    memUsedPct = +((used / total) * 100).toFixed(1);
    memTotalMB = +(total / 1048576).toFixed(0);
    memUsedMB = +(used / 1048576).toFixed(0);
  }
  // Interfaces: name + "5 minute input rate X bits/sec" / "output rate Y bits/sec"
  const ifaces = [];
  const seen = new Set();
  const blocks = out.split(/\n(?=[A-Z]\w+\d+\/\d+ is )/);
  for (const b of blocks) {
    const nm = (b.match(/^([A-Z]\w+\d+\/\d+) is (up|administratively down|down)/) || []);
    if (!nm[1] || seen.has(nm[1])) continue;   // dedup (console buffer can echo twice)
    seen.add(nm[1]);
    const din = (b.match(/input rate (\d+) bits\/sec/i) || [])[1];
    const dout = (b.match(/output rate (\d+) bits\/sec/i) || [])[1];
    ifaces.push({
      iface: nm[1],
      up: nm[2] === 'up',
      inKbps: din != null ? +(din / 1000).toFixed(1) : null,
      outKbps: dout != null ? +(dout / 1000).toFixed(1) : null,
    });
  }
  return {
    name: dev.name,
    ip: dev.ip,
    cpu5sec: cpuM ? +cpuM[1] : null,
    cpu1min: cpuM ? +cpuM[3] : null,
    cpu5min: cpuM ? +cpuM[4] : null,
    memUsedPct, memTotalMB, memUsedMB,
    interfaces: ifaces,
  };
}

// ---- Linux QEMU guest: REAL cpu/ram/disk/bandwidth from /proc + df ---------
// Run commands on a Linux serial console, auto-logging in as root if prompted.
function linuxExec(port, commands, { user = 'root', perCmd = 1300 } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const sock = net.connect({ host: '127.0.0.1', port });
    const finish = () => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(buf); } };
    sock.setTimeout(15000, finish);
    sock.on('data', (d) => {
      const out = [];
      for (let i = 0; i < d.length; i++) {
        if (d[i] === 255 && i + 2 < d.length) {
          const cmd = d[i + 1], opt = d[i + 2];
          if (cmd === 253) sock.write(Buffer.from([255, 252, opt]));
          else if (cmd === 251) sock.write(Buffer.from([255, 254, opt]));
          i += 2; continue;
        }
        out.push(d[i]);
      }
      buf += Buffer.from(out).toString('latin1');
    });
    sock.on('error', finish);
    sock.on('connect', async () => {
      try {
        await delay(600); sock.write('\r'); await delay(900);
        if (/login:/i.test(buf.slice(-200))) { sock.write(user + '\r'); await delay(1500); }
        buf = '';                                  // discard banner; keep only command output
        for (const c of commands) { sock.write(c + '\r'); await delay(perCmd); }
        await delay(200);
      } catch (_) { /* ignore */ }
      finish();
    });
  });
}

function parseStatCpu(text) {
  const m = text.match(/^cpu\s+(.+)$/m);
  if (!m) return null;
  const v = m[1].trim().split(/\s+/).map(Number);
  const idle = (v[3] || 0) + (v[4] || 0);          // idle + iowait
  const total = v.reduce((a, b) => a + b, 0);
  return { idle, total };
}
function parseEth(text, iface = 'eth0') {
  const re = new RegExp('^\\s*' + iface + ':\\s*(.+)$', 'm');
  const m = text.match(re);
  if (!m) return null;
  const f = m[1].trim().split(/\s+/).map(Number);
  return { rx: f[0] || 0, tx: f[8] || 0 };          // rx bytes col0, tx bytes col8
}

async function probeLinux(dev) {
  const port = consolePort(dev);
  if (!port) return null;
  const snapCmds = ['cat /proc/stat', 'cat /proc/net/dev'];
  const s1text = await linuxExec(port, snapCmds);
  const t0 = Date.now();
  await delay(1800);
  const s2text = await linuxExec(port, [...snapCmds, 'cat /proc/meminfo', 'df -k /', 'ip -4 addr show eth0']);
  const dt = (Date.now() - t0) / 1000;
  const ipm = s2text.match(/inet (\d+\.\d+\.\d+\.\d+)/);   // real IP read from the guest

  const c1 = parseStatCpu(s1text), c2 = parseStatCpu(s2text);
  let cpuPct = null;
  if (c1 && c2 && c2.total > c1.total) {
    const dTotal = c2.total - c1.total, dIdle = c2.idle - c1.idle;
    cpuPct = +(100 * (dTotal - dIdle) / dTotal).toFixed(1);
  }
  const e1 = parseEth(s1text), e2 = parseEth(s2text);
  let rxKbps = null, txKbps = null;
  if (e1 && e2 && dt > 0) {
    rxKbps = +(Math.max(0, e2.rx - e1.rx) * 8 / 1000 / dt).toFixed(1);
    txKbps = +(Math.max(0, e2.tx - e1.tx) * 8 / 1000 / dt).toFixed(1);
  }
  const total = (s2text.match(/MemTotal:\s+(\d+)/) || [])[1];
  const avail = (s2text.match(/MemAvailable:\s+(\d+)/) || [])[1];
  let memUsedPct = null, memUsedMB = null, memTotalMB = null;
  if (total && avail) {
    memTotalMB = +(total / 1024).toFixed(0);
    memUsedMB = +((total - avail) / 1024).toFixed(0);
    memUsedPct = +(100 * (1 - avail / total)).toFixed(1);
  }
  const df = s2text.match(/\n\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/);
  let diskUsedPct = null, diskUsedMB = null, diskTotalMB = null;
  if (df) { diskTotalMB = +(df[1] / 1024).toFixed(0); diskUsedMB = +(df[2] / 1024).toFixed(0); diskUsedPct = +df[4]; }

  return {
    name: dev.name, ip: (ipm && ipm[1]) || dev.ip || '—',
    cpuPct, memUsedPct, memUsedMB, memTotalMB,
    diskUsedPct, diskUsedMB, diskTotalMB, rxKbps, txKbps,
  };
}

function consolePort(dev) {
  // dev.console looks like "telnet:5006"
  if (!dev.console || dev.console === '—') return null;
  const m = String(dev.console).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- background sweep -------------------------------------------------------
const cache = { hosts: [], routers: [], linux: [], sweeping: false, lastSweep: 0, error: null };

async function sweep(getDevices) {
  if (cache.sweeping) return;
  cache.sweeping = true;
  try {
    const devs = getDevices();
    const routers = devs.filter((d) => d.type === 'dynamips' && d.running);
    const linux = devs.filter((d) => d.type === 'qemu' && d.running);
    const hosts = devs.filter((d) => d.type === 'vpcs' && d.running && d.gateway && d.gateway !== '—');
    // routers + linux guests (real resource metrics) first, then host reachability
    const rOut = [];
    for (const r of routers) { try { const v = await probeRouter(r); if (v) rOut.push(v); } catch (_) {} }
    const lOut = [];
    for (const l of linux) { try { const v = await probeLinux(l); if (v) lOut.push(v); } catch (_) {} }
    const hOut = [];
    for (const h of hosts) { try { const v = await probeHost(h); if (v) hOut.push(v); } catch (_) {} }
    cache.routers = rOut;
    cache.linux = lOut;
    cache.hosts = hOut;
    cache.lastSweep = Date.now();
    cache.error = null;
  } catch (e) {
    cache.error = e.message;
  } finally {
    cache.sweeping = false;
  }
}

module.exports = {
  // getDevices: () => array of shaped device records (from gns3.devices-like source)
  start(getDevices, intervalMs = 60000) {
    const run = () => sweep(getDevices);
    setTimeout(run, 8000);           // let GNS3 populate the device inventory first
    setInterval(run, intervalMs);
  },
  data() {
    return {
      hosts: cache.hosts,
      routers: cache.routers,
      linux: cache.linux,
      lastSweep: cache.lastSweep,
      sweeping: cache.sweeping,
      error: cache.error,
      reachableHosts: cache.hosts.filter((h) => h.reachable).length,
      totalHosts: cache.hosts.length,
    };
  },
  // exposed for self-test
  _probeHost: probeHost,
  _probeRouter: probeRouter,
  _consoleExec: consoleExec,
};

// ---- self-test:  node lib/probe.js <port> router|host ----------------------
if (require.main === module) {
  const port = parseInt(process.argv[2], 10);
  const kind = process.argv[3] || 'router';
  const dev = { name: 'test', ip: '?', console: 'telnet:' + port, gateway: process.argv[4] || '192.168.1.1', type: kind === 'router' ? 'dynamips' : 'vpcs', running: true };
  const fn = kind === 'router' ? probeRouter : kind === 'linux' ? probeLinux : probeHost;
  fn(dev).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  });
}
