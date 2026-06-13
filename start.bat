@echo off
echo Starting DC Entry Automation...

:: Start backend in a new window
start "Backend" cmd /k "cd backend && venv\Scripts\activate && python main.py"

:: Start frontend in a new window
start "Frontend" cmd /k "cd frontend && npm run dev"

:: Wait for servers to be ready then open browser
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173"

:: Start cloudflare tunnel + QR code in a new window
start "Tunnel + QR" cmd /k "backend\venv\Scripts\activate && python tunnel.py"
