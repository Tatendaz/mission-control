#!/bin/sh
# Assemble "Mission Control.app": a real, resident Dock app (Swift + WKWebView)
# that opens the board in its own window. Being a regular app is the point —
# the Dock shows the running-indicator dot and clicking the icon re-focuses
# the board, which the old fire-and-exit script launcher could never do.
# Needs Xcode (swiftc). Run from the repo root or app/.
set -e
cd "$(dirname "$0")"

APP="Mission Control.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

xcrun swiftc -O main.swift -o "$APP/Contents/MacOS/mission-control"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>mission-control</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundleIdentifier</key><string>io.github.tatendaz.mission-control</string>
	<key>CFBundleName</key><string>Mission Control</string>
	<key>CFBundleDisplayName</key><string>Mission Control</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>2.0.0</string>
	<key>CFBundleVersion</key><string>2</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "built: app/$APP — copy to /Applications; the existing Dock tile picks it up"
