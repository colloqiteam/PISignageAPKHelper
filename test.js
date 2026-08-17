#!/usr/bin/env node
'use strict';
// ponytail: one runnable check for the non-trivial bits — arg sanitising, the
// concurrency pool, the TCP probe, subnet derivation. Run: node test.js
const assert = require('assert');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// fetchApkFrom writes into the cache dir; keep the real one out of it.
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'sideload-test-'));
process.env.SIDELOAD_CACHE = CACHE;
const { subnets, pool, probe, safe, fetchApkFrom, sha256 } = require('./sideload.js');

(async () => {
  // safe() guards adb *flag* injection, not shell injection (execFile takes an array).
  assert.ok(safe('192.168.1.42:5555'));
  assert.ok(safe('emulator-5554'));
  assert.ok(!safe('-s'), 'must reject leading dash: adb would read it as a flag');
  assert.ok(!safe('--version'));
  assert.ok(!safe('a b'));
  assert.ok(!safe('a;rm -rf /'));
  assert.ok(!safe('a'.repeat(200)));
  assert.ok(!safe(undefined));

  // pool() collects every truthy result and never exceeds the concurrency limit.
  let live = 0, peak = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const got = await pool(items, 7, async (i) => {
    peak = Math.max(peak, ++live);
    await new Promise((r) => setTimeout(r, 1));
    live--;
    return i % 2 ? i : null; // half the probes "miss"
  });
  assert.strictEqual(got.length, 25, 'keeps only truthy results');
  assert.ok(peak <= 7, `concurrency cap breached: ${peak}`);
  assert.ok(peak > 1, 'never ran concurrently');

  // probe() resolves the target on an open port, null on a closed one.
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  const hit = await probe('127.0.0.1', port);
  assert.strictEqual(hit.ip, '127.0.0.1');
  assert.strictEqual(hit.port, port);
  // rtt drives the radar radius, so it must be a real positive measurement.
  assert.ok(hit.rtt > 0 && hit.rtt < 500, `implausible rtt: ${hit.rtt}`);
  srv.close();
  assert.strictEqual(await probe('127.0.0.1', port, 300), null, 'closed port must not report open');
  // A black-holed address must time out rather than hang forever.
  const t = Date.now();
  assert.strictEqual(await probe('192.0.2.1', 5555, 300), null);
  assert.ok(Date.now() - t < 2000, 'probe ignored its timeout');

  // subnets() yields /24 prefixes only, deduped, private-only.
  for (const s of subnets()) {
    assert.match(s, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, `not a /24 prefix: ${s}`);
  }
  assert.strictEqual(new Set(subnets()).size, subnets().length, 'duplicate subnets');

  // fetchApkFrom must never leave an APK on disk it hasn't verified: this file
  // gets installed onto every screen the customer owns.
  const payload = Buffer.from('not-really-an-apk, but it hashes like one');
  const good = sha256(payload);
  let manifest = {};
  const api = http.createServer((req, rq) => {
    if (req.url === '/manifest') return rq.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(manifest));
    if (req.url === '/player.apk') return rq.writeHead(200).end(payload);
    rq.writeHead(404).end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const dest = path.join(CACHE, 'player.apk');

  manifest = { version: '9.9.9', versionCode: 99, apkUrl: `${base}/player.apk`, sha256: good };
  const apk = await fetchApkFrom(`${base}/manifest`);
  assert.strictEqual(apk.version, '9.9.9');
  assert.strictEqual(apk.cached, false, 'first fetch cannot be a cache hit');
  assert.strictEqual(sha256(fs.readFileSync(apk.path)), good, 'wrote something other than what it verified');

  // Second call reuses the verified file instead of re-downloading 5 MB.
  assert.strictEqual((await fetchApkFrom(`${base}/manifest`)).cached, true);

  // The branch that matters: hash disagrees, so nothing may be written.
  fs.rmSync(dest, { force: true });
  manifest = { ...manifest, sha256: 'f'.repeat(64) };
  await assert.rejects(() => fetchApkFrom(`${base}/manifest`), /sha256 mismatch/);
  assert.ok(!fs.existsSync(dest), 'wrote an APK whose hash did not match');

  // A stale cached file with the wrong hash must be replaced, not trusted.
  fs.writeFileSync(dest, Buffer.from('stale build from a previous release'));
  manifest = { ...manifest, sha256: good };
  assert.strictEqual((await fetchApkFrom(`${base}/manifest`)).cached, false, 'trusted a cached file it never verified');
  assert.strictEqual(sha256(fs.readFileSync(dest)), good);

  // A manifest that points the download at plaintext off-loopback is refused
  // outright — we never reach the server, so a MITM has nothing to answer.
  manifest = { ...manifest, apkUrl: 'http://example.com/evil.apk' };
  await assert.rejects(() => fetchApkFrom(`${base}/manifest`), /not https/);
  // A manifest with no usable hash is unverifiable, so it is not installable.
  manifest = { ...manifest, apkUrl: `${base}/player.apk`, sha256: 'nope' };
  await assert.rejects(() => fetchApkFrom(`${base}/manifest`), /no usable sha256/);
  api.close();
  fs.rmSync(CACHE, { recursive: true, force: true });

  console.log(`ok — all checks passed (scanning ${subnets().join(', ') || 'no private subnet'})`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
