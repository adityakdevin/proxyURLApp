@echo off
REM Boot launcher for ProxyURLApp under PM2.
REM Register as a single Task Scheduler entry: trigger "At system startup",
REM run whether user is logged on or not, highest privileges.
REM Builds + pushes schema once per boot, then hands the long-lived processes to PM2.

cd /d "%~dp0.."

if not exist "logs" mkdir logs

REM prisma generate + db push + build (correct for this repo; NOT prisma migrate)
call npm run deploy >> logs\boot.log 2>&1

call pm2 start ecosystem.config.js >> logs\boot.log 2>&1
call pm2 save >> logs\boot.log 2>&1
