/*
 * NetPulse - Monitor Server (LIVE GNS3, original UI)
 * --------------------------------------------------
 * Serves the original full dashboard, but every number is REAL: lib/gns3 reads
 * the live GNS3 project, lib/probe console-scrapes metrics, and lib/dashboard
 * merges them into the response shapes the original frontend expects. Devices we
 * can measure (Cisco routers + QEMU Linux guests) carry real CPU/RAM/disk/
 * bandwidth; VPCS report null (rendered as "—").
 */
const path = require('path');
const express = require('express');
const gns3 = require('./lib/gns3');
const probe = require('./lib/probe');
const dash = require('./lib/dashboard');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// serve the Monitor Client (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ---- login gate: accept any non-empty creds, verify the live GNS3 lab ------
app.post('/api/connect-ssh', async (req, res) => {
  const { hostname, username, password } = req.body || {};
  if (!hostname || !username || !password) {
    return res.status(400).json({ success: false, error: 'hostname, username and password are required' });
  }
  const result = await dash.connect({ hostname, username });
  if (!result.success) return res.status(502).json(result);
  res.json(result);
});

app.post('/api/disconnect', (req, res) => res.json({ success: true }));

// ---- dashboard data (original shapes, real values) -------------------------
app.get('/api/networks', (req, res) => res.json(dash.networks()));
app.get('/api/overview', (req, res) => res.json(dash.overview()));
app.get('/api/devices', (req, res) => res.json(dash.devices(req.query.network)));
app.get('/api/alerts', (req, res) => res.json(dash.alerts(parseFloat(req.query.threshold))));
app.get('/api/traffic', (req, res) => res.json(dash.traffic()));
app.get('/api/report', (req, res) => res.json(dash.report(parseFloat(req.query.threshold))));
app.get('/api/metrics', (req, res) => res.json(dash.metrics()));
app.get('/api/topology', (req, res) => res.json(dash.topology()));
// still exposed for debugging / the raw probe feed
app.get('/api/status', (req, res) => res.json(gns3.status()));
app.get('/api/monitor', (req, res) => res.json(probe.data()));

// ---- fallback: serve the dashboard for any other (non-API) path ------------
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- start -----------------------------------------------------------------
gns3.start();
probe.start(() => gns3.rawDevices(), 60000);   // console sweep (slow) -> real metrics
dash.start();                                  // accumulate history from sweeps
app.listen(PORT, () => {
  const s = gns3.status();
  console.log('');
  console.log('  NetPulse Monitor Server running (LIVE GNS3 · original UI)');
  console.log(`  Dashboard:   http://localhost:${PORT}`);
  console.log(`  GNS3 target: ${s.controller}  ·  project "${s.project}"`);
  console.log('');
});
