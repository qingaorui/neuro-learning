#Requires -Version 5
<#
    在桌面创建「神经生物学学习」的一键启动快捷方式。

    用法：
        powershell -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1
    或指定位置（默认桌面）：
        powershell -ExecutionPolicy Bypass -File .\创建桌面快捷方式.ps1 -Destination "C:\某目录"
#>

param(
    [string]$Destination = '',
    [string]$Name = '神经生物学学习'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$bat  = Join-Path $root '启动神经生物学学习.bat'

if (-not (Test-Path $bat)) {
    Write-Host "找不到启动脚本：$bat" -ForegroundColor Red
    exit 1
}

if (-not $Destination) {
    $Destination = [Environment]::GetFolderPath('Desktop')
}

if (-not (Test-Path $Destination)) {
    Write-Host "目标目录不存在：$Destination" -ForegroundColor Red
    exit 1
}

$linkPath = Join-Path $Destination "$Name.lnk"

try {
    $shell = New-Object -ComObject WScript.Shell
    $link  = $shell.CreateShortcut($linkPath)
    $link.TargetPath       = $bat
    $link.WorkingDirectory = $root
    $link.WindowStyle      = 7          # 7 = 最小化，服务窗口不打扰
    $link.Description      = '启动本地神经生物学学习工具'
    $link.IconLocation     = "$env:SystemRoot\System32\shell32.dll,70"
    $link.Save()
}
catch {
    Write-Host ""
    Write-Host "创建快捷方式失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "可以退而求其次：直接把「启动神经生物学学习.bat」右键拖到桌面，" -ForegroundColor Yellow
    Write-Host "选择「在当前位置创建快捷方式」。效果一样。" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "已创建快捷方式：" -ForegroundColor Green
Write-Host "  $linkPath"
Write-Host ""
Write-Host "双击它即可启动服务并自动打开浏览器。" -ForegroundColor Gray
