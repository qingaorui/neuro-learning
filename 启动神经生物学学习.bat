@echo off
chcp 65001 >nul
title 神经生物学学习
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Python not found.
    echo   Please install Python 3.9+ and check "Add Python to PATH".
    echo.
    pause
    exit /b 1
)

python "app\server.py" --open
if errorlevel 1 (
    echo.
    echo   Server exited with an error. Please copy the message above.
    pause
)
