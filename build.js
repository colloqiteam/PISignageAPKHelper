#!/usr/bin/env node
'use strict';
// Packs sideload.js + radar.html + adb into one double-clickable binary using
// Node's built-in SEA. Run: node build.js
//
// SEA cannot cross-compile — it patches a copy of *this* machine's node binary,
// so you need a real macOS box for the mac build and a real Windows box for the
// Windows one. The APK is deliberately not embedded: it's fetched from the
// version manifest at runtime so a shipped binary never goes stale.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findAdb } = require('./sideload.js');

// The SEA binary *is* this machine's node, so the build's Node version ships
// to customers — pin the major to keep builds reproducible across machines.
const WANT = parseInt(fs.readFileSync(path.join(__dirname, '.nvmrc'), 'utf8'), 10);
if (parseInt(process.versions.node, 10) !== WANT) {
  console.error(`error: build requires Node ${WANT}.x (see .nvmrc), got ${process.versions.node}`);
  process.exit(1);
}

const WIN = process.platform === 'win32';
const OUT = path.join(__dirname, 'dist', WIN ? 'pisignage-sideloader.exe' : 'pisignage-sideloader');
const WORK = path.join(__dirname, 'dist', 'build');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const run = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1) + ' MB';

fs.rmSync(path.join(__dirname, 'dist'), { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// ---------- assets ----------
const assets = { 'radar.html': path.join(__dirname, 'radar.html') };

const adb = process.env.ADB_EMBED || findAdb();
if (adb) {
  assets[WIN ? 'adb.exe' : 'adb'] = adb;
  // adb.exe won't even start without these beside it, network-only use included.
  if (WIN) {
    for (const dll of ['AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const p = path.join(path.dirname(adb), dll);
      if (fs.existsSync(p)) assets[dll] = p;
      else console.warn(`  warn: ${dll} not found next to adb — the build will not run on a clean Windows box`);
    }
  }
  console.log(`  adb: embedding ${adb} (${mb(adb)})`);
} else {
  console.warn('  warn: no adb found to embed — the binary will need platform-tools already installed.\n'
    + '        Set ADB_EMBED=/path/to/adb to include it.');
}

const cfg = path.join(WORK, 'sea-config.json');
fs.writeFileSync(cfg, JSON.stringify({
  main: path.join(__dirname, 'sideload.js'),
  output: path.join(WORK, 'sea.blob'),
  disableExperimentalSEAWarning: true,
  assets,
}, null, 2));

// ---------- blob, then inject it into a copy of node ----------
run(process.execPath, ['--experimental-sea-config', cfg]);
fs.copyFileSync(process.execPath, OUT);
fs.chmodSync(OUT, 0o755);

// Windows icon = rewriting node.exe's resources (its icon group id is 1). Must
// happen BEFORE postject: resource edits rewrite the PE and would corrupt the blob.
if (WIN) {
  run('npx.cmd', ['--yes', 'resedit-cli', '--in', OUT, '--out', OUT,
    '--icon', `1,${path.join(__dirname, 'logo.ico')}`].map((a) => `"${a}"`), { shell: true });
}

// Injecting invalidates the signature node ships with; macOS then refuses to run
// it at all, so strip first and ad-hoc re-sign after.
if (process.platform === 'darwin') run('codesign', ['--remove-signature', OUT]);

const inject = ['--yes', 'postject', OUT, 'NODE_SEA_BLOB', path.join(WORK, 'sea.blob'),
  '--sentinel-fuse', FUSE,
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])];

// npx on Windows is npx.cmd, and Node refuses to spawn a .cmd without a shell
// (the CVE-2024-27980 fix, Node 18.20.2+) — it throws EINVAL. So go through the
// shell there, quoting every argument ourselves since the shell resplits them.
if (WIN) run('npx.cmd', inject.map((a) => `"${a}"`), { shell: true });
else run('npx', inject);

// A bare Mach-O can't carry an icon on macOS — wrap the binary in a minimal .app.
// Finder launches an .app with no terminal, so the bundle's entry point is a stub
// that hands the real binary to Terminal, same behaviour as start.command.
let SHIP = OUT; // what we ship (the .exe / the .app)
let BIN = OUT;  // the actual binary, for the size line
if (process.platform === 'darwin') {
  run('codesign', ['--sign', '-', OUT]);
  SHIP = path.join(__dirname, 'dist', 'PiSignage Sideloader.app');
  const macos = path.join(SHIP, 'Contents', 'MacOS');
  const res = path.join(SHIP, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  BIN = path.join(macos, 'pisignage-sideloader');
  fs.renameSync(OUT, BIN);
  fs.copyFileSync(path.join(__dirname, 'logo.icns'), path.join(res, 'logo.icns'));
  fs.writeFileSync(path.join(macos, 'launcher'),
    '#!/bin/sh\nexec open -a Terminal "$(dirname "$0")/pisignage-sideloader"\n');
  fs.chmodSync(path.join(macos, 'launcher'), 0o755);
  fs.writeFileSync(path.join(SHIP, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>PiSignage Sideloader</string>
  <key>CFBundleIdentifier</key><string>com.colloqi.pisignage-sideloader</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>logo</string>
</dict></plist>
`);
  run('codesign', ['--force', '--sign', '-', SHIP]);
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n  built ${SHIP}  (${mb(BIN)})`);
console.log('  ponytail: ad-hoc signed only. Shipping to customers needs a Developer ID\n'
  + '  signature + notarisation, or Gatekeeper blocks it on first launch.\n');
