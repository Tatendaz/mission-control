#!/bin/sh
# Smoke test: boots server.js in a throwaway sandbox on a scratch port and
# exercises every HTTP surface — board, health, manifest, icon, launch guard.
# Zero dependencies beyond node + curl, like the project itself.  Run: sh test/smoke.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
PORT=18765
SANDBOX="$(mktemp -d)"
trap 'kill "$SRV_PID" 2>/dev/null; rm -rf "$SANDBOX"' EXIT

cp "$ROOT/server.js" "$SANDBOX/server.js"
printf '%s\n' '<!doctype html><title>fixture board</title>' > "$SANDBOX/board.html"
cat > "$SANDBOX/config.json" <<JSON
{ "home": ".", "boardHtml": "board.html", "port": $PORT,
  "herdr": "/usr/bin/false", "projects": [] }
JSON

"$NODE" "$SANDBOX/server.js" &
SRV_PID=$!

i=0
until curl -s -m 1 -o /dev/null "http://localhost:$PORT/health"; do
  i=$((i+1)); [ $i -gt 40 ] && { echo "FAIL: server never came up"; exit 1; }
  sleep 0.25
done

fails=0
check() { # name expected actual
  if printf '%s' "$3" | /usr/bin/grep -q "$2"; then echo "ok   $1"; else
    echo "FAIL $1: wanted /$2/ got: $3"; fails=$((fails+1)); fi
}

check "health"          '"ok":true'            "$(curl -s "http://localhost:$PORT/health")"
check "board served"    'fixture board'        "$(curl -s "http://localhost:$PORT/")"
check "manifest"        '"name":"Mission Control"' "$(curl -s "http://localhost:$PORT/manifest.webmanifest")"
check "icon 404s in sandbox" 'no icon on disk' "$(curl -s "http://localhost:$PORT/icon.png")"
check "launch bad JSON" 'body is not JSON'     "$(curl -s -X POST -H 'Content-Type: application/json' -d 'not json' "http://localhost:$PORT/api/launch")"
check "launch unknown id" 'unknown project'    "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"id":"nope"}' "http://localhost:$PORT/api/launch")"
check "host guard"      'bad host'             "$(curl -s -H 'Host: evil.example' "http://localhost:$PORT/")"
check "site guard"      'cross-site'           "$(curl -s -X POST -H 'Sec-Fetch-Site: cross-site' "http://localhost:$PORT/api/launch")"
check "404 route"       'not found'            "$(curl -s "http://localhost:$PORT/nope")"

[ $fails -eq 0 ] && echo "smoke: all checks passed" || { echo "smoke: $fails failed"; exit 1; }
