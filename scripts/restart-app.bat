@echo off
REM Restart ProxyURLApp Server
REM Stops the running app and starts it again

cd /d "%~dp0"

echo Restarting ProxyURLApp...
echo.

REM Stop the app first
call stop-app.bat

REM Wait 2 seconds
timeout /t 2 /nobreak >nul

REM Start the app
call start-app.bat
