@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%agent"
set "FRONTEND_DIR=%ROOT%frontend"
set "PYTHON_EXE=python"
set "BACKEND_URL=http://127.0.0.1:8899"
set "FRONTEND_URL=http://127.0.0.1:5899"

if exist "%ROOT%.venv\Scripts\python.exe" set "PYTHON_EXE=%ROOT%.venv\Scripts\python.exe"

echo Starting Vibe-Trading...
echo Root: %ROOT%
echo Backend: %BACKEND_URL%
echo Frontend: %FRONTEND_URL%
echo.

start "Vibe-Trading Backend" cmd /k "cd /d \"%BACKEND_DIR%\" && \"%PYTHON_EXE%\" -m cli serve --port 8899"
start "Vibe-Trading Frontend" cmd /k "cd /d \"%FRONTEND_DIR%\" && npm run dev -- --host 127.0.0.1 --port 5899"

timeout /t 8 /nobreak >nul
start "" "%FRONTEND_URL%"

echo.
echo Browser opened. Keep these windows open to watch logs.
endlocal
