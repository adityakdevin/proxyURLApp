@echo off
REM Database Backup Script for Windows Task Scheduler
REM Schedule this file in Task Scheduler to run daily backups

cd /d "%~dp0.."
call npm run db:backup

if %ERRORLEVEL% NEQ 0 (
    echo Backup failed with error code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)

echo Backup completed successfully
exit /b 0
