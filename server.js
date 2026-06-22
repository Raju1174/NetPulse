/*
 * NetPulse - Monitor Server (LIVE GNS3 mode)
 * ------------------------------------------
 * Express server backed by lib/gns3.js, which reads the REAL GNS3 project over
 * the GNS3 controller REST API. No simulated data: every node, status, link and
 * IP you see comes from the running lab. Screens that depended on guest metrics
 * GNS3 cannot expose (CPU/RAM/bandwidth alerts, traffic, perf) were removed.
 */
const path = require('path');
const express = require('express');
const gns3 = require('./lib/gns3');

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

// ---- connect: verify the GNS3 controller + project are reachable -----------
app.post('/api/connect-ssh', async (req, res) => {
  const { hostname, username, password, project } = req.body || {};
  const overrides = {};
  if (hostname) overrides.url = /^https?:\/\//.test(hostname) ? hostname : `http://${hostname}`;
  if (username) overrides.user = username;
  if (password) overrides.password = password;
  if (project) overrides.project = project;
  const result = await gns3.connect(Object.keys(overrides).length ? overrides : undefined);
  if (!result.success) return res.status(502).json(result);
  res.json({ success: true, ...result });
});

app.post('/api/disconnect', (req, res) => res.json({ success: true }));

// ---- live dashboard data (all real, from GNS3) -----------------------------
app.get('/api/status', (req, res) => res.json(gns3.status()));
app.get('/api/networks', (req, res) => res.json(gns3.networks()));
app.get('/api/overview', (req, res) => res.json(gns3.overview()));
app.get('/api/devices', (req, res) => res.json(gns3.devices(req.query.network)));
app.get('/api/topology', (req, res) => res.json(gns3.topology()));

// ---- fallback: serve the dashboard for any other (non-API) path ------------
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- start -----------------------------------------------------------------
gns3.start();
app.listen(PORT, () => {
  const s = gns3.status();
  console.log('');
  console.log('  NetPulse Monitor Server running (LIVE GNS3 mode)');
  console.log(`  Dashboard:   http://localhost:${PORT}`);
  console.log(`  GNS3 target: ${s.controller}  ·  project "${s.project}"`);
  console.log('');
});
