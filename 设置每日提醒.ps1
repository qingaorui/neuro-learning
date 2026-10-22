#Requires -Version 5
<#
    注册一个「每天定时打开今日论文」的计划任务。

    用法（普通 PowerShell 窗口即可，不需要管理员）：
        powershell -ExecutionPolicy Bypass -File .\设置每日提醒.ps1 -Time 08:30

    取消：
        schtasks /delete /tn "神经生物学每日推送" /f
#>

param(
    [string]$Time = '08:30',
    [string]$TaskName = '神经生物学每日推送'
)

$ErrorActionPreference = 'Stop'

if ($Time -notmatch '^\d{1,2}:\d{2}$') {
    Write-Host "时间格式应为 HH:mm，例如 08:30" -ForegroundColor Red
    exit 1
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$bat  = Join-Path $root '启动神经生物学学习.bat'

if (-not (Test-Path $bat)) {
    Write-Host "找不到启动脚本：$bat" -ForegroundColor Red
    exit 1
}

# 已存在则先删掉，避免重复注册
$existing = schtasks /query /tn $TaskName 2>$null
if ($LASTEXITCODE -eq 0) {
    schtasks /delete /tn $TaskName /f | Out-Null
    Write-Host "已移除同名旧任务" -ForegroundColor Gray
}

$action = schtasks /create `
    /tn $TaskName `
    /tr "`"$bat`"" `
    /sc daily `
    /st $Time `
    /f 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "注册失败：" -ForegroundColor Red
    Write-Host $action
    Write-Host ""
    Write-Host "如果提示权限不足，请用管理员身份重试，或手动把「启动神经生物学学习.bat」放进 启动 文件夹。" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "已设置每日推送：每天 $Time 自动打开今日论文" -ForegroundColor Green
Write-Host "任务名称：$TaskName"
Write-Host ""
Write-Host "取消命令：schtasks /delete /tn `"$TaskName`" /f" -ForegroundColor Gray
