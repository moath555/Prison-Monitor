@echo off
setlocal

cd /d "%~dp0"

if not exist ".env" (
  echo Missing .env file.
  echo Copy .env.example to .env and add your Discord bot token first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting Prison Monitor Bot...
call npm start

pause
