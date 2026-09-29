#!/usr/bin/env node
'use strict';
// Local helper for ui.html. A browser has no raw TCP sockets and no mDNS, so the
// scanning + adb work has to live here. Binds 127.0.0.1 only: this endpoint can
// install arbitrary code onto any reachable device.
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Present only when packaged by build.js. Node 18 has no node:sea at all.
let sea = null;
try { sea = require('node:sea'); } catch {}
const IS_SEA = !!(sea && sea.isSea && sea.isSea());

const ADB_PORT = 5555; // `adb tcpip` / Android TV "ADB debugging over network"
const PKG = process.env.SIDELOAD_PKG || 'com.pisignage.player2';
const ACTIVITY = process.env.SIDELOAD_ACTIVITY || '.MainActivity';
// The published build is the source of truth for what customers should run.
const MANIFEST_URL = process.env.SIDELOAD_MANIFEST || 'https://pisignage.com/api/android/version';

// A packaged binary lives somewhere read-only (/Applications, a DMG), and inside
// SEA __dirname is meaningless, so downloads and the unpacked adb go here.
function cacheDir() {
  const d = process.env.SIDELOAD_CACHE || path.join(os.homedir(), '.pisignage-sideloader');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// radar.html is embedded in the binary; on disk it just sits next to this file.
function asset(name) {
  if (IS_SEA) return Buffer.from(sea.getRawAsset(name));
  return fs.readFileSync(path.join(__dirname, name));
}

// ---------- adb + apk discovery ----------

function findAdb() {
  if (process.env.ADB) return process.env.ADB;
  const home = os.homedir();
  const name = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(home, 'Library/Android/sdk/platform-tools'),
    path.join(home, 'Android/Sdk/platform-tools'),
    path.join(home, 'AppData/Local/Android/Sdk/platform-tools'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ];
  for (const d of dirs) {
    if (!d) continue;
    try { const p = path.join(d, name); fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function findApk() {
  const flag = process.argv.slice(2).find((a) => a.toLowerCase().endsWith('.apk'));
  if (flag) return path.resolve(flag);
  // Double-clicked from Finder, cwd is the customer's home or /. Scavenging a
  // stray .apk from there would install unverified code onto every screen they
  // own and skip the manifest's sha256 entirely, so a packaged build only ever
  // takes an APK named explicitly on the command line.
  if (IS_SEA) return null;
  for (const dir of [__dirname, process.cwd()]) {
    try {
      const hit = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.apk')).sort();
      if (hit.length) return path.join(dir, hit[0]);
    } catch {}
  }
  return null;
}

// A shipped binary can't assume the customer has Android platform-tools, so the
// build embeds adb and we unpack it on first run. You cannot exec a file that
// exists only inside your own binary.
function unpackAdb() {
  if (!IS_SEA) return null;
  const win = process.platform === 'win32';
  let raw;
  try { raw = Buffer.from(sea.getRawAsset(win ? 'adb.exe' : 'adb')); } catch { return null; }
  const dir = cacheDir();
  const out = path.join(dir, win ? 'adb.exe' : 'adb');
  if (!fs.existsSync(out) || fs.statSync(out).size !== raw.length) {
    fs.writeFileSync(out, raw, { mode: 0o755 });
  }
  // adb.exe refuses to start without these sitting beside it, even for network-only use.
  if (win) {
    for (const dll of ['AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      try {
        const b = Buffer.from(sea.getRawAsset(dll));
        const p = path.join(dir, dll);
        if (!fs.existsSync(p) || fs.statSync(p).size !== b.length) fs.writeFileSync(p, b);
      } catch {}
    }
  }
  return out;
}

const ADB = findAdb() || unpackAdb();
let APK = findApk();   // an .apk sitting next to us still wins: offline use, pinning a build
let META = null;       // manifest fields once we've fetched
let apkError = null;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The manifest's sha256 is not decoration. This file gets installed onto devices,
// so a truncated download or a swapped mirror has to fail loudly instead of
// shipping unknown code to every screen the customer owns.
async function fetchApkFrom(manifestUrl) {
  const r = await fetch(manifestUrl, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
  const m = await r.json();
  const url = String(m.apkUrl || '');
  const want = String(m.sha256 || '').toLowerCase();
  // A hostile manifest must not be able to downgrade the download to plaintext.
  // Only a loopback apkUrl is exempt — nothing on the wire to tamper with there.
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) {
    throw new Error('manifest apkUrl is not https');
  }
  if (!/^[a-f0-9]{64}$/.test(want)) throw new Error('manifest has no usable sha256');

  const dest = path.join(cacheDir(), path.basename(new URL(url).pathname) || 'player.apk');
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === want) {
    return { path: dest, version: m.version, versionCode: m.versionCode, cached: true };
  }
  const d = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!d.ok) throw new Error(`APK download HTTP ${d.status}`);
  const buf = Buffer.from(await d.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`sha256 mismatch — refusing it (want ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`);
  fs.writeFileSync(dest, buf);
  return { path: dest, version: m.version, versionCode: m.versionCode, cached: false };
}

// Boot and the page's first /api/state both want the APK; without this they race
// and download it twice. Clearing the job on failure lets a reload retry.
let apkJob = null;
function ensureApk() {
  if (APK) return Promise.resolve();
  if (!apkJob) {
    apkJob = fetchApkFrom(MANIFEST_URL)
      .then((g) => { APK = g.path; META = g; apkError = null; })
      .catch((e) => { apkError = String(e.message || e); throw e; })
      .finally(() => { apkJob = null; });
  }
  return apkJob;
}

// ---------- adb wrapper ----------

// Args go to execFile as an array, so there is no shell to inject into. The check
// that matters is that no arg can pass for an adb *flag*.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const safe = (s) => typeof s === 'string' && s.length < 128 && SAFE.test(s);
const CODE = /^[0-9]{6}$/;

function adb(args, timeout = 25000) {
  return new Promise((resolve) => {
    if (!ADB) return resolve({ ok: false, out: 'adb not found' });
    execFile(ADB, args, { timeout, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
      let out = `${stdout || ''}${stderr || ''}`.trim();
      // Killed by our own timeout: say so, or the UI shows a blank failure.
      if (err && err.killed) out += `${out ? '\n' : ''}timed out after ${timeout / 1000}s`
        + (args.includes('install') ? ' — the device may be waiting for an on-screen confirmation (e.g. Play Protect).' : '');
      resolve({ ok: !err, out, cmd: `adb ${args.join(' ')}` });
    });
  });
}

async function devices() {
  const { out } = await adb(['devices', '-l']);
  return out.split('\n').slice(1).map((l) => {
    const m = l.match(/^(\S+)\s+(device|offline|unauthorized|authorizing)\b(.*)$/);
    if (!m) return null;
    const model = (m[3].match(/model:(\S+)/) || [, ''])[1].replace(/_/g, ' ');
    return { serial: m[1], state: m[2], model };
  }).filter(Boolean);
}

// Android 11+ picks a random port per session, so it can only be found via mDNS.
// adb has an mDNS browser built in; if the backend is unavailable we just get nothing.
async function mdns() {
  const { out } = await adb(['mdns', 'services'], 8000);
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/(_adb-tls-(?:pairing|connect))\._tcp\.?\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})/);
    if (m) found.push({ ip: m[2], port: +m[3], source: m[1].endsWith('pairing') ? 'pairing' : 'connect' });
  }
  return found;
}

// ---------- network scan ----------

// The RTT is what the radar plots as radius. There is no way to read a remote
// device's Wi-Fi RSSI from here, so connect latency stands in for link quality.
function probe(ip, port, timeout = 500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const t0 = process.hrtime.bigint();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok ? { ip, port, rtt: Number(process.hrtime.bigint() - t0) / 1e6 } : null);
    };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, ip);
  });
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const r = await fn(items[i++]);
      if (r) out.push(r);
    }
  }));
  return out;
}

// ponytail: /24 around each local IPv4 only. A /16 would be 65k dials; widen here
// if anyone actually runs signage on a flat /16.
function subnets() {
  const seen = new Map();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const o = a.address.split('.').map(Number);
      const private_ = o[0] === 10 || (o[0] === 192 && o[1] === 168) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31);
      if (private_) seen.set(o.slice(0, 3).join('.'), a.address);
    }
  }
  return [...seen.keys()];
}

async function scan() {
  const nets = subnets();
  const targets = nets.flatMap((base) => Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`));
  const [open, services] = await Promise.all([
    pool(targets, 256, (ip) => probe(ip, ADB_PORT)),
    mdns(),
  ]);

  const byKey = new Map();
  for (const d of open) byKey.set(`${d.ip}:${d.port}`, { ...d, source: 'connect' });
  for (const s of services) byKey.set(`${s.ip}:${s.port}`, s);

  const live = new Map((await devices()).map((d) => [d.serial, d]));
  const found = [...byKey.entries()].map(([serial, d]) => ({
    ...d, serial,
    state: live.get(serial)?.state || 'new',
    model: live.get(serial)?.model || '',
  }));

  // Already-connected devices that the sweep can't see (different subnet, USB).
  for (const [serial, d] of live) {
    if (byKey.has(serial)) continue;
    const m = serial.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/);
    found.push({ serial, ip: m ? m[1] : serial, port: m ? +m[2] : 0, source: m ? 'connect' : 'usb', ...d });
  }
  return { subnets: nets, found };
}

// ---------- api ----------

function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const routes = {
  async 'GET /api/state'() {
    // Reloading the page retries a download that failed while the machine was offline.
    await ensureApk().catch(() => {});
    return {
      adb: ADB, pkg: PKG, apkError,
      apk: APK && fs.existsSync(APK)
        ? { name: path.basename(APK), size: fs.statSync(APK).size, version: META && META.version }
        : null,
      devices: await devices(),
    };
  },

  'GET /api/scan': scan,

  async 'POST /api/connect'({ ip, port }) {
    const target = `${ip}:${port}`;
    if (!safe(target)) throw new Error('bad target');
    // A stale entry sticks as `offline` and blocks a fresh handshake.
    if ((await devices()).some((d) => d.serial === target && d.state !== 'device')) {
      await adb(['disconnect', target]);
    }
    const r = await adb(['connect', target], 15000);
    const ok = r.ok && /connected to/i.test(r.out);
    if (!ok) return { ok: false, out: r.out || 'connect failed' };
    const model = await adb(['-s', target, 'shell', 'getprop', 'ro.product.model'], 10000);
    const rel = await adb(['-s', target, 'shell', 'getprop', 'ro.build.version.release'], 10000);
    return { ok: true, out: r.out, serial: target, model: model.out, android: rel.out };
  },

  async 'POST /api/pair'({ ip, port, code }) {
    const target = `${ip}:${port}`;
    if (!safe(target) || !CODE.test(String(code || ''))) throw new Error('bad target or code');
    const r = await adb(['pair', target, String(code)], 30000);
    const ok = r.ok && /successfully paired/i.test(r.out);
    // The connect service sits on a different port than pairing; find it post-pair.
    const connect = ok ? (await mdns()).find((s) => s.ip === ip && s.source === 'connect') : null;
    return { ok, out: r.out, connect };
  },

  async 'POST /api/install'({ serial }) {
    if (!safe(serial)) throw new Error('bad serial');
    await ensureApk();
    if (!APK || !fs.existsSync(APK)) throw new Error(apkError || 'no APK available');
    // -g pre-grants runtime permissions, which unattended signage needs. Some ROMs
    // reject the flag outright, so fall back rather than fail the install.
    let r = await adb(['-s', serial, 'install', '-r', '-g', APK], 300000);
    if (!r.ok && /unknown option|Unrecognized|INSTALL_FAILED_(?:INVALID|TEST_ONLY)/i.test(r.out)) {
      r = await adb(['-s', serial, 'install', '-r', APK], 300000);
    }
    // Different signing key than the installed build: the only way through is an
    // uninstall, which drops the player's config. Let the UI ask rather than assume.
    const signature = /signatures do not match|UPDATE_INCOMPATIBLE/i.test(r.out);
    const downgrade = /VERSION_DOWNGRADE/i.test(r.out);
    return { ok: r.ok && /success/i.test(r.out), out: r.out, signature, downgrade };
  },

  // Destructive: wipes app data. Only ever reached from an explicit confirm in the UI.
  async 'POST /api/uninstall'({ serial }) {
    if (!safe(serial)) throw new Error('bad serial');
    const r = await adb(['-s', serial, 'uninstall', PKG], 60000);
    return { ok: r.ok && /success/i.test(r.out), out: r.out };
  },

  async 'POST /api/launch'({ serial }) {
    if (!safe(serial)) throw new Error('bad serial');
    const r = await adb(['-s', serial, 'shell', 'am', 'start', '-n', `${PKG}/${ACTIVITY}`], 20000);
    return { ok: r.ok && !/Error/i.test(r.out), out: r.out };
  },

  async 'POST /api/disconnect'({ serial }) {
    if (!safe(serial)) throw new Error('bad serial');
    return adb(['disconnect', serial]);
  },
};

const server = http.createServer(async (req, res) => {
  // Any origin that resolves to us could otherwise drive adb via DNS rebinding.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    res.writeHead(403).end('bad host');
    return;
  }
  const key = `${req.method} ${req.url.split('?')[0]}`;
  if (key === 'GET /' || key === 'GET /radar.html') {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(asset('radar.html'));
    } catch {
      res.writeHead(500).end('radar.html must sit in the same folder as sideload.js');
    }
    return;
  }
  const handler = routes[key];
  if (!handler) return res.writeHead(404).end('not found');
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    // Resolve fully before touching the response: `writeHead(200).end(await ...)`
    // evaluates writeHead first, so a throw would leave headers already sent.
    const payload = JSON.stringify(await handler(body));
    res.writeHead(200, { 'content-type': 'application/json' }).end(payload);
  } catch (e) {
    if (res.headersSent) return res.end();
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, out: String(e.message || e) }));
  }
});

function listen(port, tries = 10) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) return listen(port + 1, tries - 1);
    throw e;
  });
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  PiSignage sideloader  ${url}`);
    console.log(`  adb: ${ADB || 'NOT FOUND — install Android platform-tools'}`);
    if (!APK) console.log(`  apk: fetching ${MANIFEST_URL} …`);
    await ensureApk().catch(() => {});
    console.log(`  apk: ${APK ? `${APK}${META && META.cached === false ? ' (downloaded)' : ''}` : `UNAVAILABLE — ${apkError}`}\n`);
    if (!process.argv.includes('--no-open')) {
      // `start` is a cmd.exe builtin, not an executable — execFile('start') is
      // ENOENT, and the ignored callback would swallow it, so the browser just
      // never opens. Go through cmd; the '' is start's title argument.
      const [cmd, args] = process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      // xdg-open isn't installed on a minimal/server Ubuntu, so say so rather than
      // swallowing the ENOENT — the URL above still works, but silence reads as a hang.
      execFile(cmd, args, (e) => { if (e) console.log(`  (couldn't open a browser — open ${url} yourself)`); });
    }
  });
}

// Inside SEA there is no require.main, so that check alone never starts the server.
if (IS_SEA || require.main === module) listen(+(process.env.PORT || 7654));
module.exports = { subnets, pool, probe, safe, findAdb, fetchApkFrom, sha256 };
