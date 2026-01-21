@echo off
setlocal enabledelayedexpansion

echo ========================================
echo   ProxyURLApp Deployment Script
echo ========================================
echo.

:: Check if running as administrator
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [WARNING] Not running as administrator. Some features may not work.
    echo.
)

:: Set variables
set "APP_DIR=%~dp0.."
cd /d "%APP_DIR%"

echo [1/7] Checking Node.js installation...
node --version >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do echo        Node.js version: %%i

echo.
echo [2/7] Installing dependencies...
call npm install
if %errorLevel% neq 0 (
    echo [ERROR] Failed to install dependencies
    pause
    exit /b 1
)

echo.
echo [3/7] Installing Playwright Chromium browser...
call npx playwright install chromium
if %errorLevel% neq 0 (
    echo [WARNING] Playwright installation had issues - headless mode may not work
)

echo.
echo [4/7] Checking environment configuration...
if not exist "server\.env" (
    echo [WARNING] server\.env file not found!
    echo Creating template .env file...
    (
        echo DATABASE_URL="mysql://root:password@localhost:3306/proxyapp_db"
        echo PORT=3001
        echo NODE_ENV=production
        echo CLIENT_URL=http://localhost:5173
        echo ADMIN_USERNAME=admin
        echo ADMIN_PASSWORD=Admin@123456
        echo ADMIN_FULLNAME=Administrator
    ) > server\.env
    echo.
    echo [IMPORTANT] Please edit server\.env with your actual database credentials!
    echo Press any key after updating the .env file...
    pause >nul
)

echo.
echo [5/7] Running database migrations...
cd server
call npx prisma generate
call npx prisma migrate deploy
if %errorLevel% neq 0 (
    echo [WARNING] Migration may have failed. Checking if this is a fresh database...
    call npx prisma db push --accept-data-loss
)
cd ..

echo.
echo [6/7] Seeding database (if needed)...
call npm run db:seed 2>nul
if %errorLevel% neq 0 (
    echo [INFO] Seed skipped - database may already be seeded
)

echo.
echo [7/7] Building application...
call npm run build
if %errorLevel% neq 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Deployment Complete!
echo ========================================
echo.
echo To start the application:
echo   npm run start
echo.
echo Or install PM2 for production:
echo   npm install -g pm2
echo   pm2 start npm --name "proxyapp" -- run start
echo   pm2 save
echo.
pause
