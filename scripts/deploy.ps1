# ============================================================
# BGMI Marketplace — Deploy to Cloudflare Workers
# Prereq: `wrangler login` (browser OAuth, once per machine)
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
# ============================================================
$ErrorActionPreference = "Stop"

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
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
"@ -Encoding UTF8
  Write-Host "`n[!] Fill in: $keysFile  (Brevo + Razorpay keys) then re-run this script.`n"
  exit 1
}
$keysEnv = @{}
Get-Content $keysFile | ForEach-Object { if ($_ -match "^\s*([^#=]+)=(.*)$") { $keysEnv[$Matches[1].Trim()] = $Matches[2].Trim() } }
$BREVO_API_KEY = $keysEnv["BREVO_API_KEY"]
$RAZORPAY_KEY_ID = $keysEnv["RAZORPAY_KEY_ID"]
$RAZORPAY_KEY_SECRET = $keysEnv["RAZORPAY_KEY_SECRET"]

# ---- 4. wrangler must be logged in ----
$who = & wrangler whoami 2>&1 | Out-String
if ($who -match "Not logged in") { throw "Run `wrangler login` first" }

function Put-Secret($name, $value) {
  if (-not $value) { Write-Host "[skip] secret $name (empty)"; return }
  Write-Host "[secret] $name -> $name"
  $value | wrangler secret put $name 2>&1 | Out-Null
}

function Deploy-Worker($dir, $envName) {
  Write-Host "`n[deploy] $dir (env=$envName)"
  if ($envName) { Push-Location $dir; try { wrangler deploy --env $envName 2>&1 | Select-String -Pattern "Uploaded|Deployed|Current Version|Worker Startup|Failed|Error" } finally { Pop-Location } }
  else { Push-Location $dir; try { wrangler deploy 2>&1 | Select-String -Pattern "Uploaded|Deployed|Current Version|Worker Startup|Failed|Error" } finally { Pop-Location } }
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
$RAZORPAY_KEY_ID | wrangler secret put RAZORPAY_KEY_ID --name bgmi-marketplace 2>&1 | Out-Null
$RAZORPAY_KEY_SECRET | wrangler secret put RAZORPAY_KEY_SECRET --name bgmi-marketplace 2>&1 | Out-Null

# ---- 7. Apply D1 schemas (remote) ----
Write-Host "`n[schema] applying D1 migrations..."
wrangler d1 execute verification_d1 --remote --file (Join-Path $root "services\auth_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error" 
wrangler d1 execute verification_d1 --remote --file (Join-Path $root "services\verification_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute bgmi_chat_db --remote --file (Join-Path $root "services\chat_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute bgmi_marketplace_db --remote --file (Join-Path $root "services\marketplace_service\hosting_cloudflare\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"
wrangler d1 execute bgmi_db --remote --file (Join-Path $root "services\wallet_service\schema.sql") 2>&1 | Select-String -Pattern "Executed|error|Error"

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
Write-Host "  endpoint: https://bgmi-gateway.bgmi-gateway.workers.dev/api/auth/admin/login"
Write-Host "=============================================="
