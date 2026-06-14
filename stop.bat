@echo off
REM ============================================================
REM  NetPulse - stop the server / free port 3000
REM  Double-click this if NetPulse was left running and you
REM  want to shut it down (e.g. "port already in use").
REM ============================================================
title Stop NetPulse
echo.
echo   Stopping NetPulse (freeing port 3000)...
echo.

set "FOUND="
REM --- find any process listening on port 3000 and kill it ----
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr ":3000 " ^| findstr "LISTENING"') do (
  if not "%%P"=="0" (
    echo   Stopping process PID %%P ...
    taskkill /PID %%P /F >nul 2>nul
    set "FOUND=1"
  )
)

if defined FOUND (
  echo.
  echo   NetPulse stopped. Port 3000 is now free.
) else (
  echo   No NetPulse server was running on port 3000.
)

echo.
pause
