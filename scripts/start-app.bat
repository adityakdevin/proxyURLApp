@echo off
REM Start ProxyURLApp Server
REM Can be used with Windows Task Scheduler for auto-start on boot

cd /d "%~dp0.."

echo Starting ProxyURLApp...
echo.

REM Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    echo.
)

REM Run database migrations
echo Running database migrations...
call npm run db:migrate:deploy --workspace=server
echo.

REM Start the application
echo Starting server...
call npm run start

if %ERRORLEVEL% NEQ 0 (
    echo Application failed to start with error code %ERRORLEVEL%
    pause
    exit /b %ERRORLEVEL%
)
