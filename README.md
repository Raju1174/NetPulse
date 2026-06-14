# NetPulse — Working Demo

A runnable implementation of **NetPulse**, the remote network-monitoring tool
from the research paper / report. It reproduces the documented architecture
(Express **Monitor Server** + web **Monitor Client**) and all four dashboard
screens, backed by a **simulated network** so it runs on any machine without
GNS3, real devices, SSH targets, or admin rights.

## Run it

```bash
cd Demo
npm install      # one time
npm start
```

Then open **http://localhost:3000** in a browser.

Log in with **any non-empty** Hostname / Username / Password (the form is
pre-filled with `127.0.0.3` / `netadmin` / `demo`). The login performs a
*simulated* SSH connection to a jump server, exactly like the real flow.

## What you get (maps to the report)

| Screen | Report ref | What it shows |
|--------|-----------|----------------|
| **Login** | 7.2.1 | Hostname / Username / Password → Connect (SSH to jump server) |
| **Network Overview** | 7.2.2 | Live CPU, RAM, Disk & Bandwidth gauges, resource pie, performance line chart, devices in network |
| **Devices** | 7.2.3 | Select a network (subnet) → device table: OS Name, Network, Subnet, Interface, live metrics |
| **Alerts** | 6.1 / Fig 3.3 | Set bandwidth **threshold**; devices over the limit get a **red ⚑ flag** |
| **Traffic Analysis** | 6.1 | Bandwidth usage (Mbps) of all devices as live bars |

The simulated topology mirrors the architecture diagram's three tiers:
`192.168.1.0/24` (Client), `10.10.20.0/24` (Infra), `127.0.0.0/26` (Middle).

## Architecture

```
Demo/
├─ server.js          Monitor Server — Express; routes from report sec 7.1.1
│                      (/api/connect-ssh, /api/execute-command,
│                       /sendNetworkUsage, /getNetworkUsage) + dashboard APIs
├─ lib/simulator.js   Simulated GNS3 network: devices, live metrics, alerts
└─ public/            Monitor Client (single-page dashboard)
   ├─ index.html
   ├─ styles.css
   └─ app.js          polling + hand-rolled SVG gauges / canvas charts (no CDN)
```

## API endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/connect-ssh` | Simulated SSH login to jump server |
| POST | `/api/execute-command` | Simulated `snmpget` / `nmap` / `ifconfig` output |
| GET  | `/api/networks` | List of subnets |
| GET  | `/api/overview` | Aggregate CPU/RAM/disk/bandwidth + history |
| GET  | `/api/devices?network=` | Devices in a subnet |
| GET  | `/api/alerts?threshold=` | Devices flagged over the bandwidth threshold |
| GET  | `/api/traffic` | Per-device bandwidth |
| POST | `/api/disconnect` | End session |

## From demo → real monitoring

`lib/simulator.js` is the only "fake" part. To monitor a real network, replace
its functions with real implementations using the `ssh2`, `net-snmp`, and
`node-nmap` packages (and `ping` for ICMP) — the server routes and the entire
frontend stay unchanged.

> Note: data is **simulated** for a self-contained, repeatable demo (ideal for a
> presentation/viva). No real hosts are scanned or contacted.
