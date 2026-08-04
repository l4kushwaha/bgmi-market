# ============================================================
# BGMI Marketplace - Deploy to Cloudflare Workers
# Prereq: `wrangler login` (browser OAuth, once per machine)
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
# ============================================================
# "Continue" (not "Stop") so native wrangler stderr warnings (2>&1 merges them
# as ErrorRecords) don't abort the whole script. Deploy-Worker checks exit codes.
$ErrorActionPreference = "Continue"

$root = Split-Path $PSScriptRoot -Parent
$secretsDir = Join-Path $PSScriptRoot ".secrets"
New-Item -ItemType Directory -Force -Path $secretsDir | Out-Null

# ---- 1. JWT_SECRET (shared across all workers) ----
$jwtFile = Join-Path $secretsDir "jwt.secret"
if (-not (Test-Path $jwtFile)) {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  Set-Content -Path $jwtFile -Value ([Convert]::ToBase64String($bytes)) -NoNewline
  Write-Host "[ok] generated $jwtFile"
}
$jwt = (Get-Content $jwtFile -Raw).Trim()
if (-not $jwt) { throw "JWT_SECRET empty" }

# ---- 2. Admin credentials (ADMIN_EMAIL / ADMIN_PASSWORD) ----
$adminFile = Join-Path $secretsDir "admin.env"
if (-not (Test-Path $adminFile)) {
  $email = Read-Host "Admin email"
  if (-not $email) { throw "Admin email required" }
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*"
  $pass = -join (1..18 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
  Set-Content -Path $adminFile -Value "ADMIN_EMAIL=$email`nADMIN_PASSWORD=$pass`n" -Encoding UTF8
  Write-Host "[ok] admin credentials saved to $adminFile"
}
$adminEnv = @{}
Get-Content $adminFile | ForEach-Object { if ($_ -match "^\s*([^#=]+)=(.*)$") { $adminEnv[$Matches[1].Trim()] = $Matches[2].Trim() } }
$ADMIN_EMAIL = $adminEnv["ADMIN_EMAIL"]
$ADMIN_PASSWORD = $adminEnv["ADMIN_PASSWORD"]
if (-not $ADMIN_EMAIL -or -not $ADMIN_PASSWORD) { throw "admin.env incomplete" }

# ---- 3. Integration keys (user must fill in) ----
$keysFile = Join-Path $secretsDir "keys.env"
if (-not (Test-Path $keysFile)) {
  Set-Content -Path $keysFile -Value @"
BREVO_API_KEY=
ADMIN_UPI_ID=
ADMIN_UPI_NAME=
MARKETPLACE_URL=https://bgmi_marketplace_service.bgmi-gateway.workers.dev
"@ -Encoding UTF8
  Write-Host "`n[!] Fill in: $keysFile  (Brevo key + platform UPI ID) then re-run this script.`n"
  exit 1
}
$keysEnv = @{}
Get-Content $keysFile | ForEach-Object { if ($_ -match "^\s*([^#=]+)=(.*)$") { $keysEnv[$Matches[1].Trim()] = $Matches[2].Trim() } }
$BREVO_API_KEY = $keysEnv["BREVO_API_KEY"]
$ADMIN_UPI_ID = $keysEnv["ADMIN_UPI_ID"]
$ADMIN_UPI_NAME = $keysEnv["ADMIN_UPI_NAME"]
$MARKETPLACE_URL = $keysEnv["MARKETPLACE_URL"]

# ---- 4. wrangler must be logged in ----
$who = & wrangler whoami 2>&1 | Out-String
if ($who -match "Not logged in") { throw "Run `wrangler login` first" }

function Deploy-Worker($dir, $envName) {
  Write-Host "`n[deploy] $dir (env=$envName)"
  $oldEA = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($envName) { Push-Location $dir; try { wrangler deploy --env $envName 2>&1 | Select-String -Pattern "Uploaded|Deployed|Current Version|Worker Startup|Failed|Error|error" } finally { Pop-Location } }
    else { Push-Location $dir; try { wrangler deploy 2>&1 | Select-String -Pattern "Uploaded|Deployed|Current Version|Worker Startup|Failed|Error|error" } finally { Pop-Location } }
    if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed (exit $LASTEXITCODE)" }
  } finally {
    $ErrorActionPreference = $oldEA
  }
}

# ---- 5. Deploy all workers ----
Deploy-Worker (Join-Path $root "gateway\hosting_cloudflare") $null
Deploy-Worker (Join-Path $root "services\auth_service\hosting_cloudflare") $null
Deploy-Worker (Join-Path $root "services\marketplace_service\hosting_cloudflare") "production"
Deploy-Worker (Join-Path $root "services\wallet_service") $null
Deploy-Worker (Join-Path $root "services\verification_service\hosting_cloudflare") $null
Deploy-Worker (Join-Path $root "services\chat_service\hosting_cloudflare") $null

# ---- 6. Secrets ----
Write-Host "`n[secrets] setting shared JWT_SECRET..."
foreach ($w in @("bgmi-gateway","auth-service","bgmi_marketplace_service","bgmi-marketplace","verification_service","bgmi_chat_service")) {
  $jwt | wrangler secret put JWT_SECRET --name $w 2>&1 | Out-Null
}
foreach ($w in @("bgmi-gateway","auth-service")) {
  $ADMIN_EMAIL  | wrangler secret put ADMIN_EMAIL    --name $w 2>&1 | Out-Null
  $ADMIN_PASSWORD | wrangler secret put ADMIN_PASSWORD --name $w 2>&1 | Out-Null
}
$BREVO_API_KEY | wrangler secret put BREVO_API_KEY --name auth-service 2>&1 | Out-Null
if ($ADMIN_UPI_ID)      { $ADMIN_UPI_ID      | wrangler secret put ADMIN_UPI_ID --name bgmi-marketplace 2>&1 | Out-Null }
else { Write-Host "[skip] ADMIN_UPI_ID (empty) - buyer will fall back to default payee" }
if ($ADMIN_UPI_NAME)    { $ADMIN_UPI_NAME    | wrangler secret put ADMIN_UPI_NAME --name bgmi-marketplace 2>&1 | Out-Null }
else { Write-Host "[skip] ADMIN_UPI_NAME (empty)" }
if ($MARKETPLACE_URL)   { $MARKETPLACE_URL   | wrangler secret put MARKETPLACE_URL --name bgmi-marketplace 2>&1 | Out-Null }
else { Write-Host "[skip] MARKETPLACE_URL (empty) - wallet will use its default" }

# ---- 7. Apply D1 schemas (remote) ----
Write-Host "`n[schema] applying D1 migrations..."
wrangler d1 execute verification_d1 --remote --file (Join-Path $root "services\auth_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error" 
wrangler d1 execute verification_d1 --remote --file (Join-Path $root "services\verification_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute bgmi_chat_db --remote --file (Join-Path $root "services\chat_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute marketplace-db --remote --file (Join-Path $root "services\marketplace_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute bgmi_db --remote --file (Join-Path $root "services\wallet_service\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"

# ---- 7b. Idempotent ALTERs (existing D1 DBs won't get new columns from CREATE TABLE) ----
function Get-D1Count($db, $sql) {
  $out = wrangler d1 execute $db --remote --json --command $sql 2>&1 | Out-String
  try { return [int](($out | ConvertFrom-Json)[0].results[0].c) } catch { return -1 }
}
$hasPurpose = Get-D1Count "bgmi_db" "SELECT COUNT(*) AS c FROM pragma_table_info('service_payments') WHERE name='purpose'"
if ($hasPurpose -eq 0) {
  Write-Host "[migrate] service_payments.purpose column"
  wrangler d1 execute bgmi_db --remote --command "ALTER TABLE service_payments ADD COLUMN purpose TEXT DEFAULT 'full'" 2>&1 | Select-String -Pattern "Executed|error|Error"
} elseif ($hasPurpose -lt 0) { Write-Host "[warn] could not check service_payments.purpose - skipping" }
$hasSettings = Get-D1Count "bgmi_db" "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='settings'"
if ($hasSettings -eq 0) {
  Write-Host "[migrate] settings table (admin-editable platform UPI)"
  wrangler d1 execute bgmi_db --remote --command "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)" 2>&1 | Select-String -Pattern "Executed|error|Error"
} elseif ($hasSettings -lt 0) { Write-Host "[warn] could not check settings table - skipping" }
$hasPriceCfg = Get-D1Count "marketplace-db" "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='price_config'"
if ($hasPriceCfg -eq 0) {
  Write-Host "[migrate] price_config table"
  wrangler d1 execute marketplace-db --remote --command "CREATE TABLE IF NOT EXISTS price_config (key TEXT PRIMARY KEY, value REAL NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)" 2>&1 | Select-String -Pattern "Executed|error|Error"
} elseif ($hasPriceCfg -lt 0) { Write-Host "[warn] could not check price_config - skipping" }

# ---- 8. Seed admin user into auth DB (verification_d1.users) ----
Write-Host "`n[seed] admin user..."
$npmRoot = Join-Path $secretsDir "bcrypt"
if (-not (Test-Path (Join-Path $npmRoot "node_modules\bcryptjs"))) {
  Push-Location $npmRoot
  npm init -y 2>&1 | Out-Null
  npm install bcryptjs --no-audit --no-fund 2>&1 | Out-Null
  Pop-Location
}
$hash = node -e "const b=require('$($npmRoot -replace '\\','/')/node_modules/bcryptjs');process.stdout.write(b.hashSync(process.argv[1],10));" $ADMIN_PASSWORD
$seedSql = @"
INSERT OR IGNORE INTO users(email,username,password_hash,role,status,created_at)
VALUES('$ADMIN_EMAIL','admin','$hash','admin','active',datetime('now'));
UPDATE users SET role='admin', status='active' WHERE lower(email)=lower('$ADMIN_EMAIL');
"@
Set-Content -Path (Join-Path $secretsDir "seed-admin.sql") -Value $seedSql -Encoding UTF8
wrangler d1 execute verification_d1 --remote --file (Join-Path $secretsDir "seed-admin.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"

Write-Host "`n=============================================="
Write-Host "DONE. Admin login:"
Write-Host "  email:    $ADMIN_EMAIL"
Write-Host "  password: $ADMIN_PASSWORD"
Write-Host "  endpoint: https://bgmi-gateway.bgmi-gateway.workers.dev/api/auth/login"
Write-Host "  platform UPI: admin dashboard -> Settings tab"
Write-Host "=============================================="
