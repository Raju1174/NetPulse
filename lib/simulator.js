/*
 * NetPulse - Network Simulator
 * --------------------------------
 * The real NetPulse server (see report sec 7.1) talks to GNS3 devices over
 * SSH/SNMP/NMAP. For a self-contained demo we simulate that same network so the
 * dashboard behaves identically without needing GNS3, real devices, or admin
 * rights. The topology mirrors the architecture diagram in the report
 * (Client / Middle / Infra tiers).
 */

// ---- clamp + random-walk helpers -------------------------------------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rnd = (min, max) => min + Math.random() * (max - min);

function walk(value, step, lo, hi) {
  return clamp(value + rnd(-step, step), lo, hi);
}

// ---- initial topology (from report: architecture + screenshots) ------------
// Each "network" is a subnet the admin can select. Devices carry the same
// fields the real Devices screen shows: OS Name, Network, Subnet, Interface.
function buildTopology() {
  return [
    {
      id: '192.168.1.0/24',
      label: 'Client Tier (192.168.1.0/24)',
      subnet: '255.255.255.0',
      cidr: 24,
      devices: [
        dev('192.168.1.1', 'R1-Edge', 'Cisco IOS 15.2', 'GigabitEthernet0/0', true),
        dev('192.168.1.6', 'WS-Admin', 'Windows Server 2019', 'Ethernet0', true),
        dev('192.168.1.10', 'SRV-Web', 'Ubuntu 22.04 LTS', 'eth0', true),
        dev('192.168.1.12', 'SRV-DB', 'Ubuntu 22.04 LTS', 'eth0', true),
        dev('192.168.1.14', 'SW-Access', 'Cisco IOU L2', 'Ethernet0/1', true),
      ],
    },
    {
      id: '10.10.20.0/24',
      label: 'Infra Tier (10.10.20.0/24)',
      subnet: '255.255.255.0',
      cidr: 24,
      devices: [
        dev('10.10.20.1', 'R3-Core', 'Cisco IOS 15.2', 'GigabitEthernet0/1', true),
        dev('10.10.20.10', 'SRV-Storage', 'Ubuntu 22.04 LTS', 'eth0', true),
        dev('10.10.20.11', 'SRV-Backup', 'Ubuntu 22.04 LTS', 'eth1', true),
      ],
    },
    {
      id: '127.0.0.0/26',
      label: 'Middle Tier (127.0.0.0/26)',
      subnet: '255.255.255.192',
      cidr: 26,
      devices: [
        dev('127.0.0.3', 'GW-Jump', 'Ubuntu 22.04 LTS', 'eth0', true),
        dev('127.0.0.4', 'NMS-Probe', 'Ubuntu 22.04 LTS', 'eth0', true),
        dev('127.0.0.5', 'IDS-Sensor', 'Debian 12', 'eth0', false),
      ],
    },
  ];
}

function dev(ip, hostname, osName, iface, up) {
  return {
    ip,
    hostname,
    osName,
    iface,
    communication: up ? 'Reachable' : 'Unreachable',
    status: up ? 'up' : 'down',
    // live metrics
    cpu: rnd(5, 40),
    ram: rnd(15, 55),
    disk: rnd(20, 70),
    // bandwidth in Mbps (interface throughput)
    sent: rnd(2, 30),
    received: rnd(2, 40),
    capacity: 100, // link capacity Mbps, used for bandwidth % vs threshold
  };
}

// ---- live state ------------------------------------------------------------
const networks = buildTopology();

// rolling history for the "network performance over time" line chart
const history = []; // [{ t, cpu, ram, bandwidth }]
const HISTORY_LEN = 40;

function tick() {
  for (const net of networks) {
    for (const d of net.devices) {
      if (d.status === 'down') {
        d.cpu = d.ram = d.sent = d.received = 0;
        continue;
      }
      d.cpu = walk(d.cpu, 6, 1, 99);
      d.ram = walk(d.ram, 4, 5, 97);
      d.disk = walk(d.disk, 0.6, 10, 95);
      d.sent = walk(d.sent, 8, 0, d.capacity);
      d.received = walk(d.received, 9, 0, d.capacity);
    }
  }
  // occasionally drive a random device near link saturation so Alerts have
  // something to flag (utilization stays <= 100%, then decays naturally).
  // NOTE: mutate the REAL device object, not an allDevices() copy.
  if (Math.random() < 0.22) {
    const live = networks.flatMap((n) => n.devices).filter((d) => d.status === 'up');
    const victim = live[Math.floor(Math.random() * live.length)];
    if (victim) {
      victim.sent = clamp(rnd(0.72, 0.98) * victim.capacity, 0, victim.capacity);
      victim.received = clamp(rnd(0.72, 0.98) * victim.capacity, 0, victim.capacity);
    }
  }

  const agg = aggregate();
  history.push({ t: Date.now(), cpu: agg.cpu, ram: agg.ram, disk: agg.disk, bandwidth: agg.bandwidth });
  while (history.length > HISTORY_LEN) history.shift();
}

// ---- derived views ---------------------------------------------------------
function allDevices() {
  return networks.flatMap((n) =>
    n.devices.map((d) => ({ ...d, network: n.id, networkSubnet: n.subnet })),
  );
}

function bandwidthPct(d) {
  // utilization = combined send+receive throughput against the link's two-way
  // capacity, so a fully saturated link reads 100% (never above).
  return clamp(((d.sent + d.received) / (2 * d.capacity)) * 100, 0, 100);
}

function aggregate() {
  const up = allDevices().filter((d) => d.status === 'up');
  const avg = (k) => (up.length ? up.reduce((s, d) => s + d[k], 0) / up.length : 0);
  const bandwidth = up.length
    ? up.reduce((s, d) => s + bandwidthPct(d), 0) / up.length
    : 0;
  const disk = avg('disk');
  return {
    cpu: +avg('cpu').toFixed(2),
    ram: +avg('ram').toFixed(2),
    disk: +disk.toFixed(2),
    bandwidth: +bandwidth.toFixed(2),
    devicesUp: up.length,
    devicesTotal: allDevices().length,
  };
}

// public API consumed by server.js routes
module.exports = {
  start() {
    tick();
    setInterval(tick, 2000);
  },
  networks: () =>
    networks.map((n) => ({ id: n.id, label: n.label, subnet: n.subnet, count: n.devices.length })),
  overview() {
    const agg = aggregate();
    const used = +((agg.cpu + agg.ram + agg.disk) / 3).toFixed(2);
    return {
      cpu: agg.cpu,
      ram: agg.ram,
      disk: agg.disk,
      bandwidth: agg.bandwidth,
      resource: { used, free: +(100 - used).toFixed(2) },
      devicesUp: agg.devicesUp,
      devicesTotal: agg.devicesTotal,
      deviceIps: allDevices()
        .filter((d) => d.status === 'up')
        .map((d) => d.ip),
      history: history.map((h) => ({ cpu: +h.cpu.toFixed(2), ram: +h.ram.toFixed(2), bandwidth: +h.bandwidth.toFixed(2) })),
    };
  },
  devices(networkId) {
    const list = networkId
      ? allDevices().filter((d) => d.network === networkId)
      : allDevices();
    return list.map((d) => ({
      ip: d.ip,
      hostname: d.hostname,
      osName: d.osName,
      network: d.network,
      subnet: d.networkSubnet,
      iface: d.iface,
      communication: d.communication,
      status: d.status,
      cpu: +d.cpu.toFixed(1),
      ram: +d.ram.toFixed(1),
      disk: +d.disk.toFixed(1),
    }));
  },
  alerts(threshold) {
    const th = Number.isFinite(threshold) ? threshold : 60;
    const rows = allDevices().map((d) => {
      const pct = +bandwidthPct(d).toFixed(1);
      return {
        ip: d.ip,
        hostname: d.hostname,
        network: d.network,
        iface: d.iface,
        status: d.status,
        bandwidth: pct,
        sent: +d.sent.toFixed(1),
        received: +d.received.toFixed(1),
        violating: d.status === 'up' && pct > th,
      };
    });
    return { threshold: th, devices: rows, violations: rows.filter((r) => r.violating).length };
  },
  traffic() {
    return allDevices().map((d) => ({
      ip: d.ip,
      hostname: d.hostname,
      network: d.network,
      iface: d.iface,
      status: d.status,
      sent: +d.sent.toFixed(1),
      received: +d.received.toFixed(1),
      total: +(d.sent + d.received).toFixed(1),
    }));
  },

  // ---- Performance Metrics screen ------------------------------------------
  metrics() {
    const keys = ['cpu', 'ram', 'disk', 'bandwidth'];
    const stat = (k) => {
      const vals = history.map((h) => h[k]);
      if (!vals.length) return { current: 0, min: 0, avg: 0, max: 0 };
      const sum = vals.reduce((s, v) => s + v, 0);
      return {
        current: +vals[vals.length - 1].toFixed(1),
        min: +Math.min(...vals).toFixed(1),
        avg: +(sum / vals.length).toFixed(1),
        max: +Math.max(...vals).toFixed(1),
      };
    };
    const series = {};
    keys.forEach((k) => (series[k] = history.map((h) => +h[k].toFixed(1))));
    const stats = {};
    keys.forEach((k) => (stats[k] = stat(k)));
    // per-network averages
    const perNetwork = networks.map((n) => {
      const up = n.devices.filter((d) => d.status === 'up');
      const a = (k) => (up.length ? +(up.reduce((s, d) => s + d[k], 0) / up.length).toFixed(1) : 0);
      const bw = up.length ? +(up.reduce((s, d) => s + bandwidthPct(d), 0) / up.length).toFixed(1) : 0;
      return { id: n.id, label: n.label, cpu: a('cpu'), ram: a('ram'), disk: a('disk'), bandwidth: bw, up: up.length, total: n.devices.length };
    });
    return { samples: history.length, intervalMs: 2000, series, stats, perNetwork };
  },

  // ---- Reports screen -------------------------------------------------------
  report(threshold) {
    const th = Number.isFinite(threshold) ? threshold : 60;
    const agg = aggregate();
    const devs = allDevices();
    const flagged = devs.filter((d) => d.status === 'up' && bandwidthPct(d) > th);
    const top = devs
      .map((d) => ({ ip: d.ip, hostname: d.hostname, network: d.network, total: +(d.sent + d.received).toFixed(1), bandwidth: +bandwidthPct(d).toFixed(1) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const health = agg.devicesUp === agg.devicesTotal ? 'Healthy' : flagged.length > 0 ? 'Attention' : 'Degraded';
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        devicesTotal: agg.devicesTotal,
        devicesUp: agg.devicesUp,
        devicesDown: agg.devicesTotal - agg.devicesUp,
        avgCpu: agg.cpu,
        avgRam: agg.ram,
        avgDisk: agg.disk,
        avgBandwidth: agg.bandwidth,
        threshold: th,
        violations: flagged.length,
        health,
      },
      perNetwork: networks.map((n) => {
        const up = n.devices.filter((d) => d.status === 'up').length;
        return { id: n.id, label: n.label, subnet: n.subnet, up, total: n.devices.length };
      }),
      flagged: flagged.map((d) => ({ ip: d.ip, hostname: d.hostname, network: d.network, bandwidth: +bandwidthPct(d).toFixed(1) })),
      topTalkers: top,
    };
  },

  // ---- Maps screen (topology) ----------------------------------------------
  topology() {
    return {
      core: { label: 'NetPulse Monitor', sub: 'Jump server 127.0.0.3' },
      networks: networks.map((n) => ({
        id: n.id,
        label: n.label,
        subnet: n.subnet,
        devices: n.devices.map((d) => ({
          ip: d.ip,
          hostname: d.hostname,
          osName: d.osName,
          status: d.status,
          isRouter: /R\d|Edge|Core|GW/i.test(d.hostname),
          bandwidth: +bandwidthPct(d).toFixed(1),
        })),
      })),
    };
  },

  // simulate the SSH command execution route from the report's pseudo-code
  execute(command) {
    const cmd = (command || '').trim();
    if (/snmpget|snmpwalk/i.test(cmd)) {
      return allDevices()
        .map((d) => `IP-MIB::ipAdEntAddr.${d.ip} = IpAddress: ${d.ip}  (${d.subnet || d.networkSubnet})`)
        .join('\n');
    }
    if (/nmap/i.test(cmd)) {
      const up = allDevices().filter((d) => d.status === 'up');
      return [
        'Starting Nmap 7.94 ( https://nmap.org )',
        ...up.map((d) => `Nmap scan report for ${d.hostname} (${d.ip})\nHost is up (0.0010s latency).`),
        `Nmap done: ${up.length} IP addresses (${up.length} hosts up) scanned`,
      ].join('\n');
    }
    if (/ipconfig|ifconfig/i.test(cmd)) {
      return 'eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 192.168.1.6  netmask 255.255.255.0';
    }
    return `Executed: ${cmd}`;
  },
};
