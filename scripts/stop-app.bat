@echo off
REM Stop ProxyURLApp Server
REM Kills all Node.js processes running the app

echo Stopping ProxyURLApp...

REM Find and kill node processes running on port 3001
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do (
    echo Killing process %%a
    taskkill /F /PID %%a 2>nul
)

REM Alternative: Kill all node processes (use with caution)
REM taskkill /F /IM node.exe 2>nul

echo ProxyURLApp stopped.
exit /b 0
