#Requires -RunAsAdministrator
#
# ProxyApp Installation Script for Windows Server (with WAMP/MySQL)
#
# Run in PowerShell as Administrator:
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   .\scripts\install-windows-native.ps1
#

param(
    [string]$InstallPath = "C:\ProxyApp",
    [string]$MySqlUser = "root",
    [string]$MySqlPassword = "",
    [string]$MySqlHost = "localhost",
    [int]$MySqlPort = 3306,
    [string]$DbName = "proxyapp_db",
    [string]$AdminPassword = "Admin@2024Secure!",
    [int]$AppPort = 3001
)

$ErrorActionPreference = "Stop"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  ProxyApp Installation (WAMP/MySQL)"
Write-Host "  Windows Server"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Helper functions
function Write-Info { param($Message) Write-Host "[INFO] " -ForegroundColor Green -NoNewline; Write-Host $Message }
function Write-Warn { param($Message) Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline; Write-Host $Message }
function Write-Err { param($Message) Write-Host "[ERROR] " -ForegroundColor Red -NoNewline; Write-Host $Message }

# Check if running as Administrator
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Err "Please run this script as Administrator"
    exit 1
}

# ============================================
# Step 1: Check WAMP/MySQL
# ============================================
Write-Host ""
Write-Host "Step 1: Checking WAMP/MySQL..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

$wampPaths = @(
    "C:\wamp64\bin\mysql\mysql8.0.31\bin\mysql.exe",
    "C:\wamp64\bin\mysql\mysql8.0.30\bin\mysql.exe",
    "C:\wamp64\bin\mysql\mysql5.7.36\bin\mysql.exe",
    "C:\wamp\bin\mysql\mysql8.0.31\bin\mysql.exe",
    "C:\wamp\bin\mysql\mysql5.7.36\bin\mysql.exe"
)

$mysqlPath = $null
foreach ($path in $wampPaths) {
    if (Test-Path $path) {
        $mysqlPath = $path
        break
    }
}

if ($mysqlPath) {
    Write-Info "MySQL found: $mysqlPath"
} else {
    Write-Warn "MySQL not found in common WAMP locations"
    Write-Host "Please ensure WAMP is installed and MySQL is running"
    $mysqlPath = Read-Host "Enter MySQL path (or press Enter to skip)"
}

# ============================================
# Step 2: Install Node.js
# ============================================
Write-Host ""
Write-Host "Step 2: Checking Node.js..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = node --version
    Write-Info "Node.js already installed: $nodeVersion"
} else {
    Write-Host ""
    Write-Host "Node.js is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please download and install Node.js 20 LTS from:"
    Write-Host "  https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "After installing, restart this script."
    exit 1
}

# ============================================
# Step 3: Create Database
# ============================================
Write-Host ""
Write-Host "Step 3: Creating Database..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

if ($mysqlPath -and (Test-Path $mysqlPath)) {
    try {
        $createDbCmd = "CREATE DATABASE IF NOT EXISTS $DbName CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

        if ($MySqlPassword) {
            & $mysqlPath -u $MySqlUser -p"$MySqlPassword" -e $createDbCmd 2>$null
        } else {
            & $mysqlPath -u $MySqlUser -e $createDbCmd 2>$null
        }
        Write-Info "Database '$DbName' ready"
    } catch {
        Write-Warn "Could not create database automatically"
        Write-Host "Please create database manually in phpMyAdmin:"
        Write-Host "  1. Open http://localhost/phpmyadmin"
        Write-Host "  2. Create database: $DbName"
    }
} else {
    Write-Host "Please create database manually in phpMyAdmin:"
    Write-Host "  1. Open http://localhost/phpmyadmin"
    Write-Host "  2. Create database: $DbName"
}

# ============================================
# Step 4: Create Environment File
# ============================================
Write-Host ""
Write-Host "Step 4: Creating Environment Configuration..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

$sessionSecret = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 64 | ForEach-Object {[char]$_})

# Build DATABASE_URL
if ($MySqlPassword) {
    $dbUrl = "mysql://${MySqlUser}:${MySqlPassword}@${MySqlHost}:${MySqlPort}/${DbName}"
} else {
    $dbUrl = "mysql://${MySqlUser}:@${MySqlHost}:${MySqlPort}/${DbName}"
}

$envContent = @"
# Database (MySQL via WAMP)
DATABASE_URL="$dbUrl"

# Session
SESSION_SECRET=$sessionSecret
SESSION_MAX_AGE_MS=1800000

# Server
PORT=$AppPort
NODE_ENV=production

# Admin (for initial seed)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$AdminPassword
ADMIN_FULLNAME=System Administrator

# bcrypt
BCRYPT_ROUNDS=12

# Client URL (for CORS)
CLIENT_URL=http://localhost:$AppPort
"@

# Create install directory
if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
    Write-Info "Created directory: $InstallPath"
}

$envPath = Join-Path $InstallPath "server\.env"
$serverPath = Join-Path $InstallPath "server"

if (-not (Test-Path $serverPath)) {
    Write-Host ""
    Write-Host "Please copy the proxyURLApp project files to: $InstallPath" -ForegroundColor Cyan
    Write-Host "Then run this script again."
    exit 0
}

if (-not (Test-Path $envPath)) {
    $envContent | Out-File -FilePath $envPath -Encoding UTF8 -NoNewline
    Write-Info "Environment file created: $envPath"
} else {
    Write-Info "Environment file already exists: $envPath"
}

# ============================================
# Step 5: Install Dependencies
# ============================================
Write-Host ""
Write-Host "Step 5: Installing Dependencies..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

Push-Location $InstallPath

Write-Info "Running npm install..."
npm install

Write-Info "Building application..."
npm run build

Pop-Location

# ============================================
# Step 6: Setup Database
# ============================================
Write-Host ""
Write-Host "Step 6: Setting up Database Tables..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

Push-Location (Join-Path $InstallPath "server")

Write-Info "Pushing schema to database..."
npx prisma db push

Write-Info "Seeding admin user..."
npm run db:seed

Pop-Location

# ============================================
# Step 7: Configure Firewall
# ============================================
Write-Host ""
Write-Host "Step 7: Configuring Firewall..." -ForegroundColor Yellow
Write-Host "------------------------------------------------"

$ruleName = "ProxyApp"
$existingRule = netsh advfirewall firewall show rule name="$ruleName" 2>$null

if (-not $existingRule) {
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=TCP localport=$AppPort
    Write-Info "Firewall rule added for port $AppPort"
} else {
    Write-Info "Firewall rule already exists"
}

# ============================================
# Complete
# ============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To start the application:" -ForegroundColor Yellow
Write-Host "  cd $InstallPath"
Write-Host "  npm start"
Write-Host ""
Write-Host "Access the app at:" -ForegroundColor Yellow
Write-Host "  http://localhost:$AppPort"
Write-Host ""
Write-Host "Admin Credentials:" -ForegroundColor Green
Write-Host "  Username: admin"
Write-Host "  Password: $AdminPassword"
Write-Host ""
Write-Host "For auto-start as Windows Service, see:" -ForegroundColor Yellow
Write-Host "  WINDOWS-SERVER-INSTALL.md"
Write-Host ""
