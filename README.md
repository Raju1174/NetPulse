# NetPulse — Live GNS3 Monitoring

NetPulse is a remote network-monitoring tool (Express **Monitor Server** + web
**Monitor Client**). This build runs in **live mode**: instead of simulated
data, it reads your **real GNS3 lab** over the GNS3 controller REST API and
shows the actual nodes, their started/stopped status, the links between them,
and each device's real IP / subnet / gateway (parsed from the live VPCS and
router configs).

## Run it

```bash
npm install      # one time
npm start
```

Then open **http://localhost:3000**, and click **Connect to GNS3**.

The server auto-discovers the local GNS3 controller and its credentials from
`~/.config/GNS3/<ver>/gns3_server.conf`, so on the same machine it just works.
The login form lets you override the controller / user / password / project.

### Requirements

- **GNS3 must be running** with the controller API up (default
  `http://127.0.0.1:3080`) and the target **project open**.
- Node.js 18+ (uses the built-in `fetch`).

### Configuration (env overrides)

| Variable | Default | Purpose |
|----------|---------|---------|
| `GNS3_URL` | from conf, else `http://127.0.0.1:3080` | controller base URL |
| `GNS3_USER` / `GNS3_PASSWORD` | from `gns3_server.conf` | Basic-auth creds |
| `GNS3_PROJECT` | `Network Topology` | project to monitor |
| `GNS3_POLL_MS` | `3000` | how often to refresh from the API |
| `PORT` | `3000` | NetPulse web port |

## Screens

| Screen | What it shows (all live from GNS3) |
|--------|-------------------------------------|
| **Network Overview** | counts of nodes / started / stopped / subnets / links, every node's live status, breakdown by node type |
| **Devices** | per-network table: status, name, real IP, type/OS, network, subnet, interface, gateway, console |
| **Topology Map** | the real lab as a tree: controller → gateway router per subnet → host devices, colored by started/stopped |

## What is and isn't available from GNS3

The GNS3 controller API exposes **inventory, node status, links, and device
configs** — all of which NetPulse surfaces as real data. It does **not** expose
guest **CPU / RAM / bandwidth** for VPCS or dynamips nodes, so the old
metric-based screens (gauges, alerts, traffic, performance) were removed rather
than faked. To add real per-device metrics you'd poll the devices directly
(SNMP on the routers, or scripted pings/`show` over each node's console).

## Architecture

```
server.js          Monitor Server — Express; live data routes
lib/gns3.js        GNS3 REST API client: nodes, links, status, parsed configs
public/            Monitor Client (single-page dashboard, no CDN)
  ├─ index.html
  ├─ styles.css
  └─ app.js
```

## API endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/connect-ssh` | verify the GNS3 controller + project are reachable |
| GET  | `/api/status` | connection state / last error |
| GET  | `/api/overview` | aggregate counts + per-node status |
| GET  | `/api/networks` | discovered subnets |
| GET  | `/api/devices?network=` | devices (optionally filtered to a subnet) |
| GET  | `/api/topology` | nodes grouped by subnet for the map |
| POST | `/api/disconnect` | end session |
