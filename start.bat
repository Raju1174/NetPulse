@echo off
REM ============================================================
REM  NetPulse - one-click launcher
REM  Double-click this file to start the demo and open it in
REM  your browser. No command line needed.
REM ============================================================
title NetPulse Monitor Server
cd /d "%~dp0"

echo.
echo   ==========================================
echo     NetPulse - Network Monitoring (demo)
echo   ==========================================
echo.

REM --- check Node.js is installed -----------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js is not installed or not on PATH.
  echo   Please install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

REM --- install dependencies on first run ----------------------
if not exist "node_modules" (
  echo   First run: installing dependencies, please wait...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
  )
  echo.
)

REM --- open the dashboard in the default browser --------------
echo   Opening http://localhost:3000 in your browser...
echo   (Login is pre-filled - just click Connect)
echo.
echo   Keep this window open while using NetPulse.
echo   Close it (or press Ctrl+C) to stop the server.
echo.
start "" http://localhost:3000

REM --- start the server (blocks until window is closed) -------
node server.js

pause
