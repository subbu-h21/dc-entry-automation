@echo off
echo =============================================
echo   DC Entry Automation - First Time Setup
echo =============================================
echo.

:: Backend setup
echo [1/4] Creating Python virtual environment...
cd backend
python -m venv venv
echo Done.
echo.

echo [2/4] Installing Python dependencies...
call venv\Scripts\activate
pip install -r requirements.txt
echo Done.
echo.

echo [3/4] Installing Playwright browser...
playwright install chromium
echo Done.
echo.

:: Create .env if it doesn't exist
if not exist .env (
    copy .env.example .env
    echo Created backend\.env from .env.example
    echo.
    echo  IMPORTANT: Open backend\.env and fill in your API keys before running the app.
    echo  - OPENROUTER_API_KEY
    echo  - ELEVENLABS_API_KEY
    echo  - PRODUCT_LIST_PATH  (path to your Product_List.xlsx)
    echo.
) else (
    echo backend\.env already exists, skipping.
    echo.
)

cd ..

:: Frontend setup
echo [4/4] Installing frontend dependencies...
cd frontend
call npm install
cd ..
echo Done.
echo.

echo =============================================
echo   Setup complete!
echo.
echo   Next steps:
echo   1. Edit backend\.env with your API keys
echo   2. Double-click start.bat to run the app
echo =============================================
pause
