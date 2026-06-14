/*
 * NetPulse - Monitor Server
 * --------------------------------
 * Node.js + Express server, structured after the report's pseudo-code
 * (sec 7.1.1 Server.js). In the real system these routes drive SSH/SNMP/NMAP
 * against GNS3 devices; here they are backed by lib/simulator.js so the whole
 * tool runs stand-alone for the demo.
 */
const path = require('path');
const express = require('express');
const sim = require('./lib/simulator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// simple permissive CORS (cors middleware in the original pseudo-code)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// serve the Monitor Client (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// in-memory session + network-usage store (mirrors pseudo-code variables)
let sshConnection = null;
const networkUsageData = {};

// ---- auth / connection (report 7.1.1, steps 7) -----------------------------
// SSH to the jump server. Simulated: any non-empty credentials "connect".
app.post('/api/connect-ssh', (req, res) => {
  const { hostname, username, password } = req.body || {};
  if (!hostname || !username || !password) {
    return res.status(400).json({ success: false, error: 'hostname, username and password are required' });
  }
  sshConnection = { hostname, username, connectedAt: Date.now() };
  console.log(`[SSH] connected to ${username}@${hostname} (simulated)`);
  res.json({ success: true, message: `Connected to ${hostname}`, hostname, username });
});

app.post('/api/disconnect', (req, res) => {
  sshConnection = null;
  res.json({ success: true });
});

// ---- execute command over the SSH session (report 7.1.1, step 8) -----------
app.post('/api/execute-command', (req, res) => {
  if (!sshConnection) return res.status(401).json({ success: false, error: 'No SSH connection' });
  const { command } = req.body || {};
  res.json({ success: true, output: sim.execute(command) });
});

// ---- network usage ingest/read (report 7.1.1, steps 5-6) -------------------
app.post('/sendNetworkUsage', (req, res) => {
  const { sent, received, ip_address } = req.body || {};
  if (ip_address) networkUsageData[ip_address] = { sent, received, ts: Date.now() };
  res.json({ status: 'received' });
});
app.get('/getNetworkUsage', (req, res) => res.json(networkUsageData));

// ---- dashboard data routes (Monitor Client screens) ------------------------
app.get('/api/networks', (req, res) => res.json(sim.networks()));
app.get('/api/overview', (req, res) => res.json(sim.overview()));
app.get('/api/devices', (req, res) => res.json(sim.devices(req.query.network)));
app.get('/api/alerts', (req, res) => res.json(sim.alerts(parseFloat(req.query.threshold))));
app.get('/api/traffic', (req, res) => res.json(sim.traffic()));
app.get('/api/metrics', (req, res) => res.json(sim.metrics()));
app.get('/api/report', (req, res) => res.json(sim.report(parseFloat(req.query.threshold))));
app.get('/api/topology', (req, res) => res.json(sim.topology()));

// ---- start -----------------------------------------------------------------
sim.start();
app.listen(PORT, () => {
  console.log('');
  console.log('  NetPulse Monitor Server running');
  console.log(`  Open the dashboard:  http://localhost:${PORT}`);
  console.log('  (network data is simulated - no GNS3/SSH required)');
  console.log('');
});
