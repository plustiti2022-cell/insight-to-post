param([switch]$Production, [int]$Port = 3001)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22 或 24 LTS。' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw '未找到 npm，请检查 Node.js 安装。' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw '端口应在 1024–65535 之间。' }
& node scripts/configure.mjs
if ($LASTEXITCODE -ne 0) { throw '后端配置不完整，请检查 key.txt 或 .env.local 中的千问、Tavily 和 MiniMax 密钥。' }
if (-not (Test-Path -LiteralPath 'node_modules')) {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
Write-Host "电脑访问：http://localhost:$Port"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.InterfaceAlias -notmatch 'VMware|vEthernet|Loopback' } |
  ForEach-Object { Write-Host "同 Wi-Fi 手机访问：http://$($_.IPAddress):$Port" }
if ($Production) {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw '生产构建失败。' }
  & npm.cmd run start -- --port $Port
} else { & npm.cmd run dev -- --port $Port }
