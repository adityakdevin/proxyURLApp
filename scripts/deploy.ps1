# ProxyURLApp Deployment Script for Windows
# Run with: powershell -ExecutionPolicy Bypass -File deploy.ps1

param(
    [switch]$SkipBuild,
    [switch]$SkipMigration,
    [switch]$InstallService
)

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ProxyURLApp Deployment Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Change to app directory
Set-Location $AppDir

# Step 1: Check prerequisites
Write-Host "[1/8] Checking prerequisites..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version
    Write-Host "       Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js is not installed!" -ForegroundColor Red
    Write-Host "Please install from https://nodejs.org" -ForegroundColor Red
    exit 1
}

try {
    $npmVersion = npm --version
    Write-Host "       npm: v$npmVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] npm is not available!" -ForegroundColor Red
    exit 1
}

# Step 2: Install dependencies
Write-Host ""
Write-Host "[2/8] Installing dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "[ERROR] Failed to install dependencies" -ForegroundColor Red
    exit 1
}
Write-Host "       Dependencies installed" -ForegroundColor Green

# Step 3: Install Playwright
Write-Host ""
Write-Host "[3/8] Installing Playwright Chromium..." -ForegroundColor Yellow
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
    Write-Host "[WARNING] Playwright installation had issues" -ForegroundColor Yellow
}

# Step 4: Check/Create .env
Write-Host ""
Write-Host "[4/8] Checking environment configuration..." -ForegroundColor Yellow
$envPath = Join-Path $AppDir "server\.env"
if (-not (Test-Path $envPath)) {
    Write-Host "       Creating template .env file..." -ForegroundColor Yellow
    @"
DATABASE_URL="mysql://root:password@localhost:3306/proxyapp_db"
PORT=3001
NODE_ENV=production
CLIENT_URL=http://localhost:5173
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin@123456
ADMIN_FULLNAME=Administrator
"@ | Out-File -FilePath $envPath -Encoding UTF8
    Write-Host "[IMPORTANT] Please edit server\.env with your database credentials!" -ForegroundColor Red
    Read-Host "Press Enter after updating the .env file"
} else {
    Write-Host "       .env file exists" -ForegroundColor Green
}

# Step 5: Generate Prisma Client
Write-Host ""
Write-Host "[5/8] Generating Prisma client..." -ForegroundColor Yellow
Set-Location (Join-Path $AppDir "server")
npx prisma generate
Set-Location $AppDir

# Step 6: Run migrations
if (-not $SkipMigration) {
    Write-Host ""
    Write-Host "[6/8] Running database migrations..." -ForegroundColor Yellow
    Set-Location (Join-Path $AppDir "server")

    # Use migrate deploy for production (doesn't prompt)
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) {
        Write-Host "       Trying db push for fresh database..." -ForegroundColor Yellow
        npx prisma db push
    }
    Set-Location $AppDir
    Write-Host "       Migrations complete" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[6/8] Skipping migrations (--SkipMigration)" -ForegroundColor Yellow
}

# Step 7: Seed database
Write-Host ""
Write-Host "[7/8] Seeding database..." -ForegroundColor Yellow
npm run db:seed 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "       Seed skipped (may already exist)" -ForegroundColor Yellow
} else {
    Write-Host "       Database seeded" -ForegroundColor Green
}

# Step 8: Build
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "[8/8] Building application..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Build failed" -ForegroundColor Red
        exit 1
    }
    Write-Host "       Build complete" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "[8/8] Skipping build (--SkipBuild)" -ForegroundColor Yellow
}

# Optional: Install as Windows Service
if ($InstallService) {
    Write-Host ""
    Write-Host "Installing PM2 and setting up service..." -ForegroundColor Yellow
    npm install -g pm2
    npm install -g pm2-windows-startup
    pm2-startup install
    pm2 start npm --name "proxyapp" -- run start
    pm2 save
    Write-Host "       PM2 service installed" -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deployment Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To start the application:" -ForegroundColor White
Write-Host "  npm run start" -ForegroundColor Gray
Write-Host ""
Write-Host "Or with PM2:" -ForegroundColor White
Write-Host "  pm2 start npm --name 'proxyapp' -- run start" -ForegroundColor Gray
Write-Host ""
Write-Host "Access the app at:" -ForegroundColor White
Write-Host "  http://localhost:5173" -ForegroundColor Gray
Write-Host ""
