#!/bin/bash
# ============================================================
#  NetPulse - stop the server / free port 3000 (macOS)
#  Double-click this if NetPulse was left running and you want
#  to shut it down (e.g. "port already in use").
#  (macOS equivalent of stop.bat)
# ============================================================
echo ""
echo "  Stopping NetPulse (freeing port 3000)..."
echo ""

PIDS=$(lsof -ti tcp:3000 2>/dev/null)
if [ -n "$PIDS" ]; then
  for P in $PIDS; do
    echo "  Stopping process PID $P ..."
    kill "$P" 2>/dev/null
  done
  sleep 1
  # force-kill anything still holding the port
  PIDS=$(lsof -ti tcp:3000 2>/dev/null)
  [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
  echo ""
  echo "  NetPulse stopped. Port 3000 is now free."
else
  echo "  No NetPulse server was running on port 3000."
fi

echo ""
read -n 1 -s -r -p "  Press any key to close..."
