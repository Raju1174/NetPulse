#!/bin/bash
# ============================================================
#  NetPulse - one-click launcher (macOS)
#  Double-click this file in Finder to start the demo and open
#  it in your browser. No command line needed.
#  (macOS equivalent of start.bat)
# ============================================================
cd "$(dirname "$0")" || exit 1

echo ""
echo "  =========================================="
echo "    NetPulse - Network Monitoring"
echo "  =========================================="
echo ""

# --- check Node.js is installed -----------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "  [ERROR] Node.js is not installed or not on PATH."
  echo "  Install it from https://nodejs.org and try again."
  echo ""
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

# --- install dependencies on first run ----------------------
if [ ! -d "node_modules" ]; then
  echo "  First run: installing dependencies, please wait..."
  echo ""
  npm install --no-audit --no-fund || {
    echo ""
    echo "  [ERROR] npm install failed. Check your internet connection."
    read -n 1 -s -r -p "  Press any key to close..."
    exit 1
  }
  echo ""
fi

# --- open the dashboard in the default browser --------------
echo "  Opening http://localhost:3000 in your browser..."
echo "  Keep this window open while using NetPulse."
echo "  Press Ctrl+C (or close the window) to stop the server."
echo ""
( sleep 2 && open "http://localhost:3000" ) &

# --- start the server (blocks until stopped) ----------------
node server.js
