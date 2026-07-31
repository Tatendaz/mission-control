#!/bin/sh
# Smoke test: boots server.js in a throwaway sandbox on a per-process port and
# exercises every HTTP surface — board, health, manifest, icon, launch, guards.
# Zero dependencies beyond node + curl, like the project itself.  Run: sh test/smoke.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
PORT=$((20000 + $$ % 20000))   # per-process port so parallel runs don't collide
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
  i=$((i+1))
  if [ $i -gt 40 ]; then echo "FAIL: server never came up on port $PORT"; exit 1; fi
  sleep 0.25
done

fails=0
# req <curl args...> — one wrapper for every check: quiet but error-reporting,
# bounded, and with the HTTP status appended on its own last line
req() { curl -sS -m 5 -w '\n%{http_code}' "$@" 2>&1; }

check() { # name expected-status body-pattern response
  status="$(printf '%s' "$4" | tail -1)"
  body="$(printf '%s' "$4" | sed '$d')"
  if [ "$status" = "$2" ] && printf '%s' "$body" | /usr/bin/grep -q "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1: wanted status $2 body /$3/, got status $status body: $body"
    fails=$((fails+1))
  fi
}

B="http://localhost:$PORT"
check "health"            200 '"ok":true'                "$(req "$B/health")"
check "board served"      200 'fixture board'            "$(req "$B/")"
check "manifest"          200 '"name":"Mission Control"' "$(req "$B/manifest.webmanifest")"
check "icon 404s in sandbox" 404 'no icon on disk'       "$(req "$B/icon.png")"
check "launch bad JSON"   400 'body is not JSON'         "$(req -X POST -H 'Content-Type: application/json' -d 'not json' "$B/api/launch")"
check "launch unknown id" 200 'unknown project'          "$(req -X POST -H 'Content-Type: application/json' -d '{"id":"nope"}' "$B/api/launch")"
check "host guard"        403 'bad host'                 "$(req -H 'Host: evil.example' "$B/")"
check "site guard"        403 'cross-site'               "$(req -X POST -H 'Sec-Fetch-Site: cross-site' "$B/api/launch")"
check "404 route"         404 'not found'                "$(req "$B/nope")"

if [ "$fails" -eq 0 ]; then
  echo "smoke: all checks passed"
else
  echo "smoke: $fails check(s) failed"
  exit 1
fi
