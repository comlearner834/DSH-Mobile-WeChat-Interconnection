# uninstall.ps1 — 卸载 dsh-wechat-link（移除链接与 profile 注册，不删除插件源码）
param(
    [string]$Profile = "web",
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $DshHome "profiles\$Profile"

# 移除 node_modules 链接
$link = Join-Path $profileDir "node_modules\dsh-wechat-link"
if (Test-Path $link) {
    Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "已移除链接：$link"
}

# 从 package.json 移除依赖与 bundle
$pkgPath = Join-Path $profileDir "package.json"
if (Test-Path $pkgPath) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $changed = $false
    if ($pkg.dependencies -and $pkg.dependencies.'dsh-wechat-link') {
        $pkg.dependencies.PSObject.Properties.Remove('dsh-wechat-link')
        $changed = $true
    }
    if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
        $bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-wechat-link' })
        $pkg.dsh.profile.bundles = @($bundles)
        $changed = $true
    }
    if ($changed) {
        [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 12), $utf8NoBom)
        Write-Host "已从 profile package.json 移除注册"
    }
}

Write-Host ""
Write-Host "✅ 卸载完成。请重启 DSH 桌面客户端（或 dsh web）生效。"
