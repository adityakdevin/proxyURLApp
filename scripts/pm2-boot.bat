@echo off
REM Boot launcher for ProxyURLApp under PM2.
REM Register as a single Task Scheduler entry: trigger "At system startup",
REM run whether user is logged on or not, highest privileges.
REM Builds + pushes schema once per boot, then hands the long-lived processes to PM2.

cd /d "%~dp0.."

if not exist "logs" mkdir logs

REM Task Scheduler's boot PATH has npm but not the npm global bin dir where
REM pm2.cmd lives, so resolve it from npm itself instead of assuming %APPDATA%.
for /f "delims=" %%p in ('npm prefix -g') do set "PATH=%%p;%PATH%"

REM Stop apps first so the schema push and rebuild never run under a live server.
REM (Prisma 7 ships a wasm engine, so the old query_engine DLL lock is gone.)
REM This ecosystem only, NOT "pm2 stop all" — the start below brings back just
REM proxyurl-server and proxyurl-backup, so stopping everything in the daemon
REM would leave any other PM2 service on the host down after every reboot.
REM Harmless no-op on a clean boot, where nothing is running yet.
call pm2 stop ecosystem.config.js >> logs\boot.log 2>&1

REM prisma generate + db push + build + Chromium install (NOT prisma migrate)
call npm run deploy >> logs\boot.log 2>&1

call pm2 start ecosystem.config.js >> logs\boot.log 2>&1
call pm2 save >> logs\boot.log 2>&1
