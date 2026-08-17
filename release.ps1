# release.ps1 — 构建发布 zip（上传到 GitHub Releases 供用户下载）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File release.ps1
# 输出：release/dsh-wechat-link-v<版本>.zip
# 内容：插件本体 + 双击安装.bat + 安装说明.txt + README/LICENSE（不含测试与开发文件）

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg  = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ver  = $pkg.version
$outDir = Join-Path $root "release"
$staging = Join-Path $root ".release-staging"
$zipName = "dsh-wechat-link-v$ver.zip"
$zipPath = Join-Path $outDir $zipName

Write-Host "==> 构建发布包 v$ver" -ForegroundColor Cyan

# 清理旧产物
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

# 拷贝发布内容（不含 test/ 与脚本自身的开发文件）
Copy-Item (Join-Path $root "package.json") $staging -Force
Copy-Item (Join-Path $root "cordis.patch.yml") $staging -Force
Copy-Item (Join-Path $root "lib") $staging -Recurse -Force
Copy-Item (Join-Path $root "client") $staging -Recurse -Force
Copy-Item (Join-Path $root "node_modules") $staging -Recurse -Force
Copy-Item (Join-Path $root "install.ps1") $staging -Force
Copy-Item (Join-Path $root "uninstall.ps1") $staging -Force
Copy-Item (Join-Path $root "双击安装.bat") $staging -Force
Copy-Item (Join-Path $root "安装说明.txt") $staging -Force
Copy-Item (Join-Path $root "README.md") $staging -Force
Copy-Item (Join-Path $root "LICENSE") $staging -Force

# 打成 zip
$tmpZip = Join-Path $outDir ".tmp-$zipName"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $tmpZip -CompressionLevel Optimal
Move-Item $tmpZip $zipPath -Force
Remove-Item $staging -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "✅ 发布包已生成：" -ForegroundColor Green
Write-Host "   $zipPath ($sizeMb MB)" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：把该 zip 上传到 GitHub Releases，普通用户下载解压后" -ForegroundColor White
Write-Host "双击「双击安装.bat」即可使用。终端用户可运行：install-remote.ps1" -ForegroundColor White
