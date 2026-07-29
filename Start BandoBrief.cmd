@echo off
setlocal
set "PROJECT_DIR=%~dp0"
set "LOCAL_NPM=%PROJECT_DIR%.tools\node\npm.cmd"

if exist "%LOCAL_NPM%" (
  set "PATH=%PROJECT_DIR%.tools\node;%PATH%"
  start "BandoBrief development server" /min "%LOCAL_NPM%" run dev
) else (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo BandoBrief needs Node.js 22 or newer.
    echo Read README.md for setup details.
    pause
    exit /b 1
  )
  start "BandoBrief development server" /min npm run dev
)

timeout /t 2 /nobreak >nul
start "" "http://localhost:5173/#brief"
