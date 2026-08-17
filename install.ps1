# install.ps1 — dsh-wechat-link 一键安装脚本（Windows）
#
# 用法（小白友好）：直接双击同目录下的「双击安装.bat」即可，
#      或执行：  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 可选参数：
#   -Profile <名称>  目标 DSH profile（默认 web，即 dsh web / DSH 桌面客户端使用的 profile）
#   -DshHome <路径>  DSH 数据目录（默认 $env:DSH_HOME，缺省为 ~\.dsh）
#
# 脚本做什么：把插件链接进 DSH profile → 注册到 profile 的 bundle 列表
#             （幂等，可重复执行）→ 提示重启。依赖已随包自带，无需安装 Node/npm。

param(
    [string]$Profile = "",
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    $msg" -ForegroundColor Green }

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  dsh-wechat-link 一键安装 (DSH 手机微信互联)" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# ---- 1. 自动定位 DSH 数据目录与 profile（小白无需手动指定）----
if (-not $DshHome) { $DshHome = $env:DSH_HOME }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
if (-not $Profile) {
    # 默认 web profile；不存在则扫描 profiles 目录自动挑选
    if (Test-Path (Join-Path $DshHome "profiles\web")) {
        $Profile = "web"
    } else {
        $profilesDir = Join-Path $DshHome "profiles"
        if (Test-Path $profilesDir) {
            $candidates = @(Get-ChildItem $profilesDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "package.json") } | Select-Object -ExpandProperty Name)
            if ($candidates.Count -eq 1) { $Profile = $candidates[0] }
            elseif ($candidates.Count -gt 1) {
                Write-Host "检测到多个 DSH profile：$($candidates -join '、')" -ForegroundColor Yellow
                $Profile = Read-Host "请输入要安装到的 profile 名称（直接回车默认 web）"
                if (-not $Profile) { $Profile = "web" }
            }
        }
        if (-not $Profile) { $Profile = "web" }
    }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
    Write-Error "未找到 DSH profile：$profileDir`n请先安装并运行过一次 DSH 桌面客户端（或 dsh web），再运行本安装脚本。"
    exit 1
}
Write-Step "1/4 定位 DSH"
Write-OK "DSH 数据目录：$DshHome"
Write-OK "目标 profile：$Profile（$profileDir）"

# ---- 2. 插件目录 = 本脚本所在目录 ----
$pluginDir = (Split-Path -Parent $MyInvocation.MyCommand.Path).TrimEnd('\')
Write-OK "插件目录：$pluginDir"

# ---- 3. 依赖自检（qrcode 已随包自带；缺失时才尝试 npm 安装）----
Write-Step "2/4 依赖自检 (qrcode)"
if (Test-Path (Join-Path $pluginDir "node_modules\qrcode")) {
    Write-OK "qrcode 已就绪（随包自带，无需联网）"
} else {
    Write-Host "    未找到 qrcode，尝试联网安装…" -ForegroundColor Yellow
    Push-Location $pluginDir
    try {
        npm install --no-audit --no-fund 2>&1 | Out-Null
        if (Test-Path (Join-Path $pluginDir "node_modules\qrcode")) {
            Write-OK "qrcode 已就绪"
        } else {
            Write-Host "    [警告] qrcode 安装失败；二维码图片功能不可用，其余功能正常。" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    [警告] npm install 失败：$($_.Exception.Message)" -ForegroundColor Yellow
    }
    Pop-Location
}

# ---- 4. 复制插件到 profile 的 node_modules（自包含，装完可删除下载文件夹）----
Write-Step "3/4 安装插件到 DSH"
$target = Join-Path $profileDir "node_modules\dsh-wechat-link"
if (Test-Path (Join-Path $target "lib\index.js")) {
    Write-OK "插件已安装（跳过）：$target"
} else {
    $nmDir = Join-Path $profileDir "node_modules"
    if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Copy-Item (Join-Path $pluginDir "package.json") $target -Force
    Copy-Item (Join-Path $pluginDir "lib") $target -Recurse -Force
    Copy-Item (Join-Path $pluginDir "client") $target -Recurse -Force
    Copy-Item (Join-Path $pluginDir "cordis.patch.yml") $target -Force
    if (Test-Path (Join-Path $pluginDir "node_modules")) {
        Copy-Item (Join-Path $pluginDir "node_modules") $target -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-OK "插件已安装到：$target"
    Write-Host "    （安装完成后，下载文件夹可随意移动/删除，不影响使用）" -ForegroundColor DarkGray
}

# ---- 5. 注册到 profile package.json（幂等）----
Write-Step "4/4 注册到 profile bundle 列表"
$pkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path $pkgPath)) {
    Write-Error "profile 缺少 package.json：$pkgPath"
    exit 1
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([PSCustomObject]@{}) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-wechat-link') {
    $bundles += 'dsh-wechat-link'
    $pkg.dsh.profile.bundles = @($bundles)
    [System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 12), $utf8NoBom)
    Write-OK "已注册 bundle：dsh-wechat-link"
} else {
    Write-OK "bundle 已注册（跳过）"
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Green
Write-Host "  ✅ 安装完成！" -ForegroundColor Green
Write-Host "  下一步：" -ForegroundColor Green
Write-Host "  1) 重启 DSH 桌面客户端（或重启 dsh web）" -ForegroundColor White
Write-Host "  2) 点击右上角【📱 手机微信互联】按钮" -ForegroundColor White
Write-Host "  3) 用手机微信扫码 → 确认授权 → 即可在微信里遥控本机 DSH" -ForegroundColor White
Write-Host "  （微信指令：/status  /workspace 路径  /stop  /unbind）" -ForegroundColor White
Write-Host "==============================================" -ForegroundColor Green
