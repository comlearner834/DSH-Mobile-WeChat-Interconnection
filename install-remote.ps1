# install-remote.ps1 — 终端一行命令安装（从 GitHub Releases 下载并安装）
#
# 普通用户只需在 PowerShell 里粘贴执行下面这一行（无需下载任何文件）：
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/comlearner834/dsh-wechat-link/main/install-remote.ps1 | iex"
#
# 脚本会自动：从最新 Release 下载 zip → 解压 → 运行 install.ps1 安装 → 清理临时文件。

$ErrorActionPreference = "Stop"

# ================= 仓库信息 =================
$RepoOwner = "comlearner834"         # GitHub 用户名
$RepoName  = "dsh-wechat-link"       # 仓库名（默认不变）
# ==========================================

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  dsh-wechat-link 远程安装（DSH 手机微信互联）" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# 1. 查询最新 Release 的 zip 资源
Write-Host "==> 1/4 查询最新版本…" -ForegroundColor Cyan
$api = "https://api.github.com/repos/$RepoOwner/$RepoName/releases/latest"
$release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "dsh-wechat-link-installer" }
$asset = @($release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1)
if (-not $asset) {
    Write-Error "未在 GitHub Releases 中找到 zip 安装包（$RepoOwner/$RepoName）。请确认已发布 Release。"
    exit 1
}
Write-Host "    最新版本：$($release.tag_name)"
Write-Host "    安装包：$($asset.name)"

# 2. 下载 zip
Write-Host "==> 2/4 下载安装包…" -ForegroundColor Cyan
$tmpDir = Join-Path $env:TEMP "dsh-wechat-link-install"
if (Test-Path $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$zip = Join-Path $tmpDir $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
Write-Host "    已下载：$zip"

# 3. 解压并安装
Write-Host "==> 3/4 解压并安装…" -ForegroundColor Cyan
$extract = Join-Path $tmpDir "pkg"
Expand-Archive -Path $zip -DestinationPath $extract -Force
$installer = Join-Path $extract "install.ps1"
if (-not (Test-Path $installer)) {
    Write-Error "安装包内容不完整（缺少 install.ps1）。"
    exit 1
}
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer

# 4. 清理
Write-Host "==> 4/4 清理临时文件…" -ForegroundColor Cyan
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  ✅ 远程安装完成！" -ForegroundColor Green
Write-Host "  下一步：" -ForegroundColor Green
Write-Host "  1) 完全退出并重新打开 DSH 桌面客户端" -ForegroundColor White
Write-Host "  2) 点右上角【手机微信互联】→ 扫码即可使用" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor Green
