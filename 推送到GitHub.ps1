#Requires -Version 5
<#
    把本地仓库推送到你的 GitHub 仓库。

    用法：
        powershell -ExecutionPolicy Bypass -File .\推送到GitHub.ps1 -RepoUrl https://github.com/你的用户名/神经生物学学习.git

    说明：
    - 首次推送会自动弹窗让你登录 GitHub（Windows 凭据管理器）。
    - 如果目标仓库里已经有文件（比如初始化时勾了 README），
      用 -Force 覆盖，脚本会改写为强推。
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

function Fail($msg) {
    Write-Host ""
    Write-Host $msg -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $root '.git'))) {
    Fail "当前目录不是 git 仓库。"
}

# 规范化 URL：允许直接粘贴浏览器地址
$RepoUrl = $RepoUrl.Trim().TrimEnd('/')
if ($RepoUrl -notmatch '\.git$') { $RepoUrl += '.git' }

Write-Host ""
Write-Host "目标仓库：$RepoUrl" -ForegroundColor Cyan
Write-Host ""

$remotes = git remote
if ($remotes -contains 'origin') {
    git remote remove origin | Out-Null
}
git remote add origin $RepoUrl

Write-Host "正在推送 main 分支…" -ForegroundColor Gray
if ($Force) {
    git push -u --force origin main
} else {
    git push -u origin main
}

if ($LASTEXITCODE -ne 0) {
    Fail @"
推送失败。常见原因：

  1) 仓库地址错 / 仓库还没创建 —— 先去 GitHub 新建一个空仓库（不要勾 README）。
  2) 没有登录 —— 首次推送会弹窗，登录后重试。
  3) 远端已有提交（初始化时勾了 README）—— 加 -Force 参数重推：
        .\推送到GitHub.ps1 -RepoUrl $RepoUrl -Force
  4) 中文文件名在部分终端显示为转义 —— 不影响推送，可忽略。
"@
}

Write-Host ""
Write-Host "推送完成。" -ForegroundColor Green
git log --oneline -1
Write-Host ""
Write-Host "如果仓库名还是旧的，去 GitHub → Settings → Repository name 改成「神经生物学学习」即可，" -ForegroundColor Gray
Write-Host "改名后本地远端地址需要同步一次：" -ForegroundColor Gray
Write-Host "    git remote set-url origin $RepoUrl" -ForegroundColor Gray
