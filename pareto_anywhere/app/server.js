'use strict';

/**
 * Pareto Anywhere add-on manager.
 *
 *  - supervises the pareto-anywhere process (start, crash-restart, on-demand restart)
 *  - manages enocean.json (EEP <-> device ID mapping) with validation and backups
 *  - serves the ingress web UI and proxies the Pareto Anywhere web apps under /pareto/
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const express = require('express');
const httpProxy = require('http-proxy');

// ---------------------------------------------------------------- settings --

const PORT = parseInt(process.env.PORT, 10) || 8099;
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const DATA_DIR = process.env.DATA_DIR || '/data';
const SSL_DIR = process.env.SSL_DIR || '/ssl';
const OPTIONS_FILE = process.env.OPTIONS_FILE || path.join(DATA_DIR, 'options.json');
const PARETO_PORT = parseInt(process.env.PARETO_PORT, 10) || 3001;
const PARETO_WORKDIR = path.join(DATA_DIR, 'pareto');
const PARETO_BIN = process.env.PARETO_BIN || 'pareto-anywhere';
const ALLOW_ANY = process.env.ALLOW_ANY === '1'; // dev only: skip ingress-gateway IP check
const INGRESS_GATEWAY = '172.30.32.2';

const ENOCEAN_FILE = path.join(CONFIG_DIR, 'enocean.json');
const CERT_FILE = path.join(CONFIG_DIR, 'certificate.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'key.pem');
const LABELS_FILE = path.join(DATA_DIR, 'enocean-labels.json');
const BACKUP_DIR = path.join(DATA_DIR, 'enocean-backups');
const TLS_MARKER = path.join(DATA_DIR, '.tls-managed-by-addon');
const MAX_BACKUPS = 20;

const ID_RE = /^[0-9a-f]{8}$/;
const KEY_RE = /^[0-9a-f]{8}\/7$/;
const EEP_RE = /^[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}$/;
const BACKUP_RE = /^enocean-[0-9TZ.\-]+\.json$/;

// ----------------------------------------------------------------- logging --

const logBuffer = [];
let logSeq = 0;
const MAX_LOG_LINES = 1000;

function log(source, text) {
  const line = String(text).replace(/\r?\n$/, '');
  if (!line) return;
  logBuffer.push({ id: ++logSeq, t: Date.now(), src: source, text: line });
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  console.log(`[${source}] ${line}`);
}

// ----------------------------------------------------------------- options --

function readOptions() {
  const defaults = { tls: false, certfile: 'fullchain.pem', keyfile: 'privkey.pem' };
  try {
    return Object.assign(defaults, JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8')));
  } catch (e) {
    return defaults;
  }
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } };

// -------------------------------------------------------- pareto location --

function findParetoPackageDir() {
  const candidates = [];
  if (process.env.PARETO_PKG_DIR) candidates.push(process.env.PARETO_PKG_DIR);
  try {
    candidates.push(path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'pareto-anywhere'));
  } catch (e) { /* ignore */ }
  candidates.push('/usr/local/lib/node_modules/pareto-anywhere', '/usr/lib/node_modules/pareto-anywhere');
  return candidates.find((c) => exists(path.join(c, 'package.json'))) || null;
}

const PARETO_PKG_DIR = findParetoPackageDir();

function paretoVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PARETO_PKG_DIR, 'package.json'), 'utf8')).version;
  } catch (e) { return null; }
}

/**
 * pareto-anywhere reads enocean.json from <package>/config/enocean.json (not from
 * PARETO_ANYWHERE_CONFIG_PATH), so link it to the persistent file in the add-on config folder.
 */
function linkEnoceanFile() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!exists(ENOCEAN_FILE)) fs.writeFileSync(ENOCEAN_FILE, '{}\n');
  if (!PARETO_PKG_DIR) {
    log('manager', 'WARNING: could not locate the pareto-anywhere package; enocean.json will not be linked');
    return;
  }
  const pkgConfig = path.join(PARETO_PKG_DIR, 'config');
  const link = path.join(pkgConfig, 'enocean.json');
  fs.mkdirSync(pkgConfig, { recursive: true });
  try {
    if (fs.lstatSync(link)) fs.rmSync(link, { force: true });
  } catch (e) { /* did not exist */ }
  fs.symlinkSync(ENOCEAN_FILE, link);
  log('manager', `linked ${link} -> ${ENOCEAN_FILE}`);
}

// --------------------------------------------------------------------- TLS --

function removeManagedTls() {
  if (!exists(TLS_MARKER)) return;
  fs.rmSync(CERT_FILE, { force: true });
  fs.rmSync(KEY_FILE, { force: true });
  fs.rmSync(TLS_MARKER, { force: true });
  log('manager', 'removed add-on managed TLS files');
}

function prepareTls(opts) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!opts.tls) return removeManagedTls();

  const srcCert = path.join(SSL_DIR, opts.certfile);
  const srcKey = path.join(SSL_DIR, opts.keyfile);
  if (!exists(srcCert) || !exists(srcKey)) {
    log('manager', `TLS enabled but ${srcCert} / ${srcKey} not found: starting WITHOUT TLS`);
    return removeManagedTls();
  }
  fs.copyFileSync(srcCert, CERT_FILE);
  fs.copyFileSync(srcKey, KEY_FILE);
  fs.chmodSync(KEY_FILE, 0o600);
  fs.writeFileSync(TLS_MARKER, new Date().toISOString());
  log('manager', 'TLS enabled: copied certificate and key from /ssl');
}

const paretoProtocol = () => (exists(CERT_FILE) && exists(KEY_FILE) ? 'https' : 'http');
const paretoTarget = () => `${paretoProtocol()}://127.0.0.1:${PARETO_PORT}`;

// -------------------------------------------------------------- supervisor --

let child = null;
let startedAt = null;
let restarts = 0;
let backoff = 0;
let restartTimer = null;
let shuttingDown = false;
let lastExit = null;

function pipeLines(stream, src) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    rest += chunk;
    const lines = rest.split('\n');
    rest = lines.pop();
    lines.forEach((l) => log(src, l));
  });
  stream.on('end', () => rest && log(src, rest));
}

function startPareto() {
  if (child || shuttingDown) return;
  clearTimeout(restartTimer);
  fs.mkdirSync(PARETO_WORKDIR, { recursive: true });
  linkEnoceanFile();

  log('manager', `starting ${PARETO_BIN} (v${paretoVersion() || '?'})`);
  const proc = spawn(PARETO_BIN, [], {
    cwd: PARETO_WORKDIR,
    env: Object.assign({}, process.env, {
      PARETO_ANYWHERE_CONFIG_PATH: CONFIG_DIR,
      PORT: String(PARETO_PORT),
    }),
  });
  child = proc;
  startedAt = Date.now();
  pipeLines(proc.stdout, 'pareto');
  pipeLines(proc.stderr, 'pareto');

  proc.on('error', (err) => log('manager', `failed to spawn: ${err.message}`));
  proc.on('exit', (code, signal) => {
    const ranFor = Date.now() - startedAt;
    lastExit = { code, signal, at: Date.now() };
    log('manager', `pareto-anywhere exited (code=${code}, signal=${signal})`);
    child = null;
    startedAt = null;
    if (shuttingDown || proc.__intentional) return;
    backoff = ranFor > 60000 ? 1000 : Math.min(30000, (backoff || 500) * 2);
    restarts += 1;
    log('manager', `restarting in ${Math.round(backoff / 1000)}s`);
    restartTimer = setTimeout(startPareto, backoff);
  });
}

function stopPareto() {
  return new Promise((resolve) => {
    clearTimeout(restartTimer);
    if (!child) return resolve();
    const proc = child;
    proc.__intentional = true;
    const killer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.once('exit', () => { clearTimeout(killer); resolve(); });
    proc.kill('SIGTERM');
  });
}

async function restartPareto() {
  log('manager', 'restart requested');
  await stopPareto();
  backoff = 0;
  prepareTls(readOptions());
  startPareto();
}

// ------------------------------------------------------ enocean.json logic --

let chain = Promise.resolve();
function withLock(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

function normaliseId(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s.endsWith('/7')) s = s.slice(0, -2);
  s = s.replace(/^0x/, '').replace(/[\s:\-_]/g, '');
  if (!ID_RE.test(s)) {
    throw new Error(`"${raw}" is not a valid 32-bit EnOcean ID (expected 8 hex characters, e.g. 05174fc4)`);
  }
  return `${s}/7`;
}

function normaliseEep(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/[_\s]/g, '-');
  if (!EEP_RE.test(s)) {
    throw new Error(`"${raw}" is not a valid EEP (expected RORG-FUNC-TYPE in hex, e.g. A5-04-03)`);
  }
  return s;
}

/** Validate an arbitrary {id: {eepType}} object. Returns { map, errors }. */
function validateMap(input) {
  const errors = [];
  const map = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { map, errors: ['enocean.json must be a JSON object keyed by device ID'] };
  }
  for (const [k, v] of Object.entries(input)) {
    try {
      const id = normaliseId(k);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`entry for ${k} must be an object like {"eepType": "A5-04-03"}`);
      if (map[id]) throw new Error(`duplicate device ID ${id}`);
      map[id] = Object.assign({}, v, { eepType: normaliseEep(v.eepType) });
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { map, errors };
}

function sortedMap(map) {
  return Object.keys(map).sort().reduce((o, k) => { o[k] = map[k]; return o; }, {});
}

function readEnoceanText() {
  try { return fs.readFileSync(ENOCEAN_FILE, 'utf8'); } catch (e) { return null; }
}

function readLabels() {
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function writeLabels(labels, map) {
  const kept = {};
  Object.keys(labels).forEach((k) => { if (map[k] && labels[k]) kept[k] = labels[k]; });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LABELS_FILE, JSON.stringify(kept, null, 2));
}

function backupCurrent() {
  const current = readEnoceanText();
  if (current == null || !current.trim()) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const existing = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort();
  if (existing.length) {
    const last = fs.readFileSync(path.join(BACKUP_DIR, existing[existing.length - 1]), 'utf8');
    if (last === current) return null; // identical to newest backup
  }
  const name = `enocean-${new Date().toISOString().replace(/[:]/g, '-')}.json`;
  fs.writeFileSync(path.join(BACKUP_DIR, name), current);
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort();
  all.slice(0, Math.max(0, all.length - MAX_BACKUPS)).forEach((f) => fs.rmSync(path.join(BACKUP_DIR, f), { force: true }));
  return name;
}

/** Atomically write a validated map to enocean.json (after backing up the previous version). */
function writeEnocean(map) {
  backupCurrent();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${ENOCEAN_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(sortedMap(map), null, 2) + '\n');
  fs.renameSync(tmp, ENOCEAN_FILE);
}

function buildMappingsResponse() {
  const text = readEnoceanText();
  const labels = readLabels();
  let parsed = {};
  let parseError = null;
  if (text && text.trim()) {
    try { parsed = JSON.parse(text); } catch (e) { parseError = e.message; }
  }
  const { map, errors } = parseError ? { map: {}, errors: [] } : validateMap(parsed);
  const mappings = Object.keys(map).sort().map((id) => ({ id, eepType: map[id].eepType, label: labels[id] || '' }));
  return {
    mappings,
    raw: text == null ? '{}\n' : text,
    parseError,
    warnings: errors,
    mtime: exists(ENOCEAN_FILE) ? fs.statSync(ENOCEAN_FILE).mtimeMs : null,
  };
}

// ------------------------------------------------------ pareto http client --

function paretoGet(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = paretoProtocol() === 'https' ? https : http;
    const req = lib.get({
      host: '127.0.0.1', port: PARETO_PORT, path: pathname, rejectUnauthorized: false,
      timeout: timeoutMs || 3000, headers: { accept: 'application/json' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 8e6) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------- app --

const app = express();
app.disable('x-powered-by');

function isAllowedAddress(addr) {
  if (ALLOW_ANY) return true;
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === INGRESS_GATEWAY || a === '127.0.0.1' || a === '::1';
}

app.use((req, res, next) => {
  if (isAllowedAddress(req.socket.remoteAddress)) return next();
  res.status(403).send('Forbidden: this interface is only reachable through Home Assistant ingress');
});

// ---- Pareto Anywhere web apps / APIs, proxied through ingress (best effort) ----

const proxy = httpProxy.createProxyServer({ secure: false, ws: true, selfHandleResponse: true });

proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('accept-encoding', 'identity'));
proxy.on('proxyRes', (proxyRes, req, res) => {
  const prefix = (req.headers['x-ingress-path'] || '') + '/pareto';
  const headers = Object.assign({}, proxyRes.headers);
  if (headers.location && headers.location.startsWith('/') && !headers.location.startsWith('//')) {
    headers.location = prefix + headers.location;
  }
  if (/text\/html/i.test(headers['content-type'] || '')) {
    const chunks = [];
    proxyRes.on('data', (c) => chunks.push(c));
    proxyRes.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8')
        .replace(/(\s(?:href|src|action)=)(["'])\/(?!\/)/gi, (m, a, q) => `${a}${q}${prefix}/`);
      headers['content-length'] = Buffer.byteLength(html);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(html);
    });
  } else {
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  }
});
proxy.on('error', (err, req, res) => {
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Pareto Anywhere is not reachable: ${err.message}`);
  } else if (res && typeof res.destroy === 'function') {
    res.destroy();
  }
});

app.use('/pareto', (req, res) => proxy.web(req, res, { target: paretoTarget() }));

// ---- JSON API ----

app.use('/api', express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message, details: e.details });
});

function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  e.details = details;
  return e;
}

app.get('/api/enocean', wrap(async (req, res) => res.json(buildMappingsResponse())));

app.put('/api/enocean', wrap((req, res) => withLock(async () => {
  const rows = req.body && req.body.mappings;
  if (!Array.isArray(rows)) throw httpError(400, 'Body must be {"mappings": [...]}');
  const errors = [];
  const labels = {};
  const staged = {};
  // Preserve any extra properties that were already on an entry.
  let existing = {};
  try { existing = JSON.parse(readEnoceanText() || '{}'); } catch (e) { /* ignore */ }
  const existingNorm = validateMap(existing).map;

  rows.forEach((row, i) => {
    try {
      const id = normaliseId(row.id);
      const eepType = normaliseEep(row.eepType);
      if (staged[id]) throw new Error(`duplicate device ID ${id}`);
      staged[id] = Object.assign({}, existingNorm[id], { eepType });
      if (row.label && String(row.label).trim()) labels[id] = String(row.label).trim().slice(0, 100);
    } catch (e) {
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  });
  if (errors.length) throw httpError(400, 'Validation failed', errors);

  writeEnocean(staged);
  writeLabels(labels, staged);
  log('manager', `enocean.json saved (${Object.keys(staged).length} devices)`);
  if (req.query.restart === '1') await restartPareto();
  res.json(Object.assign({ ok: true, restarted: req.query.restart === '1' }, buildMappingsResponse()));
})));

app.put('/api/enocean/raw', wrap((req, res) => withLock(async () => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string') throw httpError(400, 'Body must be {"text": "..."}');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw httpError(400, `Invalid JSON: ${e.message}`); }
  const { map, errors } = validateMap(parsed);
  if (errors.length) throw httpError(400, 'Validation failed', errors);

  writeEnocean(map);
  writeLabels(readLabels(), map);
  log('manager', `enocean.json saved from raw editor (${Object.keys(map).length} devices)`);
  if (req.query.restart === '1') await restartPareto();
  res.json(Object.assign({ ok: true, restarted: req.query.restart === '1' }, buildMappingsResponse()));
})));

app.get('/api/enocean/export', wrap(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', 'attachment; filename="enocean.json"');
  res.send(readEnoceanText() || '{}\n');
}));

app.get('/api/backups', wrap(async (req, res) => {
  const files = exists(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_RE.test(f)).sort().reverse() : [];
  res.json({
    backups: files.map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    }),
  });
}));

app.get('/api/backups/:name', wrap(async (req, res) => {
  if (!BACKUP_RE.test(req.params.name)) throw httpError(400, 'Invalid backup name');
  const file = path.join(BACKUP_DIR, req.params.name);
  if (!exists(file)) throw httpError(404, 'Backup not found');
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="${req.params.name}"`);
  res.send(fs.readFileSync(file, 'utf8'));
}));

app.post('/api/backups/:name/restore', wrap((req, res) => withLock(async () => {
  if (!BACKUP_RE.test(req.params.name)) throw httpError(400, 'Invalid backup name');
  const file = path.join(BACKUP_DIR, req.params.name);
  if (!exists(file)) throw httpError(404, 'Backup not found');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw httpError(400, `Backup is not valid JSON: ${e.message}`); }
  const { map, errors } = validateMap(parsed);
  if (errors.length) throw httpError(400, 'Backup failed validation', errors);
  writeEnocean(map);
  writeLabels(readLabels(), map);
  log('manager', `restored ${req.params.name}`);
  if (req.query.restart === '1') await restartPareto();
  res.json(Object.assign({ ok: true, restarted: req.query.restart === '1' }, buildMappingsResponse()));
})));

app.get('/api/discovered', wrap(async (req, res) => {
  const mapped = validateMap(parseSafe(readEnoceanText())).map;
  let reply;
  try {
    reply = await paretoGet('/devices', 4000);
  } catch (e) {
    return res.json({ reachable: false, error: e.message, devices: [] });
  }
  let data;
  try { data = JSON.parse(reply.body); } catch (e) {
    return res.json({ reachable: true, error: 'Unexpected response from Pareto Anywhere /devices', devices: [] });
  }
  const bag = (data && typeof data.devices === 'object' && data.devices) || data || {};
  const devices = Object.keys(bag).filter((k) => KEY_RE.test(k)).sort().map((id) => {
    const v = bag[id] || {};
    const ts = (v.timestamp) || (v.dynamb && v.dynamb.timestamp) || null;
    return { id, mapped: !!mapped[id], eepType: mapped[id] ? mapped[id].eepType : null, lastSeen: ts };
  });
  res.json({ reachable: true, devices, total: Object.keys(bag).length });
}));

function parseSafe(text) {
  try { return JSON.parse(text || '{}'); } catch (e) { return {}; }
}

app.get('/api/status', wrap(async (req, res) => {
  const opts = readOptions();
  let reachable = false;
  try { reachable = (await paretoGet('/', 1500)).status < 500; } catch (e) { /* not up */ }
  res.json({
    running: !!child,
    pid: child ? child.pid : null,
    uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    restarts,
    lastExit,
    reachable,
    protocol: paretoProtocol(),
    tlsRequested: !!opts.tls,
    port: PARETO_PORT,
    paretoVersion: paretoVersion(),
    enoceanFile: ENOCEAN_FILE,
  });
}));

app.post('/api/restart', wrap(async (req, res) => {
  await restartPareto();
  res.json({ ok: true });
}));

app.get('/api/logs', wrap(async (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ lines: logBuffer.filter((l) => l.id > since), last: logSeq });
}));

app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).json({ error: err.message });
});

// ------------------------------------------------------------------ server --

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  if (!isAllowedAddress(req.socket.remoteAddress) || !req.url.startsWith('/pareto/')) return socket.destroy();
  req.url = req.url.slice('/pareto'.length);
  proxy.ws(req, socket, head, { target: paretoTarget() });
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('manager', 'shutting down');
  stopPareto().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  log('manager', `management UI listening on :${PORT}`);
  prepareTls(readOptions());
  startPareto();
});
