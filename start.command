#!/bin/sh
# Double-click this instead of radar.html — macOS opens .command files in Terminal.
# radar.html on its own has no sockets and falls back to demo devices; this starts
# the helper and opens the same page with real data.
cd "$(dirname "$0")" || exit 1
exec node sideload.js
