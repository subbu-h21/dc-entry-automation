@echo off
echo Starting DC Entry Automation...

:: Build frontend (runs synchronously — ~30s)
echo Building frontend...
pushd frontend
call npm run build
popd

:: Start backend (serves API + built frontend on port 3001)
start "Backend" cmd /k "cd backend && venv\Scripts\activate && python main.py"

:: Start cloudflare tunnel + QR code
start "Tunnel + QR" cmd /k "backend\venv\Scripts\activate && python tunnel.py"

:: Open browser once backend is ready
powershell -NoProfile -Command "do { Start-Sleep 1 } until ((Test-NetConnection localhost -Port 3001 -InformationLevel Quiet -WarningAction SilentlyContinue)); Start-Process 'http://localhost:3001'"
