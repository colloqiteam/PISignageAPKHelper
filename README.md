# PiSignage Sideloader

Finds Android devices with wireless debugging enabled on the local network and
installs the PiSignage player APK onto them. Ships as a single double-clickable
app with Node, `adb` and the UI embedded — customers need nothing installed.
The APK itself is downloaded (and SHA-256 verified) from
`https://pisignage.com/api/android/version` at runtime, so builds never go stale.

## Building

The build uses Node's SEA, which patches a copy of *this* machine's `node`
binary — so it cannot cross-compile. Build on a Mac for Mac, on Windows for
Windows.

Prerequisites on the build machine:

- Node 18+
- Android platform-tools (`adb`), auto-detected from PATH or the usual SDK
  spots; override with `ADB_EMBED=/path/to/adb`

### macOS (Apple Silicon)

```sh
node test.js && node build.js
# → dist/PiSignage Sideloader.app
```

For Intel Macs, run `build.js` with an x64 Node (e.g. under Rosetta) — the
output architecture matches the Node that ran the build.

### Windows

```powershell
node test.js; node build.js
# → dist\pisignage-sideloader.exe
```

`adb.exe` needs `AdbWinApi.dll` and `AdbWinUsbApi.dll` beside it; `build.js`
embeds them automatically and warns if they're missing.

Watch the build output: an `adb: embedding ...` line with no `warn:` lines
means the binary is fully self-contained. Note the result is ad-hoc signed
only — customer-facing builds need a Developer ID signature + notarisation
(macOS) to avoid the Gatekeeper block on first launch.

GitHub Actions (`.github/workflows/build.yml`) builds macOS arm64, Linux x64
and Windows x64 on every push and uploads them as artifacts.
