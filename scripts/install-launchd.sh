#!/bin/bash
#
# Installs flight-tracker as a macOS LaunchAgent so it keeps polling in the
# background, starts at login, and restarts if it ever crashes.
#
#   ./scripts/install-launchd.sh            install and start
#   ./scripts/install-launchd.sh --uninstall  stop and remove
#
set -euo pipefail

LABEL="com.flighttracker.watch"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
PORT="${FLIGHT_TRACKER_PORT:-4127}"

uninstall() {
  if [ -f "$PLIST" ]; then
    launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $PLIST"
  else
    echo "Not installed — nothing to remove."
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  exit 0
fi

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node is not on PATH." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/watches.json" ]; then
  echo "error: $PROJECT_DIR/watches.json does not exist." >&2
  echo "       Run 'node bin/flight-tracker.js serve' and add a route first." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "warning: no .env found — Pushover is not configured, so alerts will only" >&2
  echo "         be written to the log, not pushed to your phone." >&2
fi

# Fail fast on a bad config rather than installing an agent that crash-loops.
"$NODE_BIN" "$PROJECT_DIR/bin/flight-tracker.js" list >/dev/null

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <!-- `serve` rather than `watch`: it polls *and* keeps the dashboard up, so
         there is exactly one poller. Running both would double every request. -->
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$PROJECT_DIR/bin/flight-tracker.js</string>
        <string>serve</string>
        <string>--no-open</string>
        <string>--port</string>
        <string>$PORT</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <!-- Do not hammer Google if the process is crash-looping. -->
    <key>ThrottleInterval</key>
    <integer>60</integer>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/flight-tracker.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/flight-tracker.error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NO_COLOR</key>
        <string>1</string>
    </dict>
</dict>
</plist>
PLIST_EOF

# Replace any previous copy so re-running this script is safe.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo
echo "Installed $LABEL"
echo "  dashboard  http://localhost:$PORT"
echo "  plist      $PLIST"
echo "  logs       $LOG_DIR/flight-tracker.log"
echo
echo "  tail -f \"$LOG_DIR/flight-tracker.log\"       # watch it work"
echo "  ./scripts/install-launchd.sh --uninstall    # stop and remove"
echo
echo "The agent already polls. Don't also run 'serve' or 'watch' by hand, or"
echo "every route will be checked twice."
echo
