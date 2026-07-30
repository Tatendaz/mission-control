#!/bin/sh
# Assemble "Mission Control.app": a Dock icon that makes sure the server is up,
# then opens the board as a Chrome app window (or the default browser).
# Uses only tools that ship with macOS. Run from the repo root or app/.
set -e
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "build-app.sh: node is not on PATH. Install Node 18+ and re-run." >&2
  exit 1
fi
PORT="$("$NODE" -p 'JSON.parse(require("fs").readFileSync("'"$ROOT"'/config.json","utf8")).port ?? 8765' 2>/dev/null || echo 8765)"
case "$PORT" in ''|*[!0-9]*) PORT=8765 ;; esac

APP="Mission Control.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/MacOS/mission-control" <<SH
#!/bin/sh
HEALTH="http://localhost:$PORT/health"
BOARD="http://localhost:$PORT/"
# the build-time node may have moved (nvm, reinstall): fall back to PATH
NODE="$NODE"
[ -x "\$NODE" ] || NODE="\$(command -v node || true)"
if [ -z "\$NODE" ]; then
  osascript -e 'display alert "Mission Control" message "Node is not installed or not on PATH."' >/dev/null 2>&1
  exit 1
fi
if ! curl -s -m 2 -o /dev/null "\$HEALTH"; then
  cd "$ROOT" && nohup "\$NODE" server.js >/dev/null 2>&1 &
  i=0; while [ \$i -lt 24 ]; do
    curl -s -m 1 -o /dev/null "\$HEALTH" && break
    sleep 0.5; i=\$((i+1))
  done
fi
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "\$CHROME" ]; then "\$CHROME" --app="\$BOARD" >/dev/null 2>&1 &
else open "\$BOARD"; fi
SH
chmod +x "$APP/Contents/MacOS/mission-control"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>mission-control</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundleIdentifier</key><string>local.mission-control</string>
	<key>CFBundleName</key><string>Mission Control</string>
	<key>CFBundleDisplayName</key><string>Mission Control</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>12.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$APP"
echo "built: app/$APP — copy it to /Applications and drag to the Dock"
