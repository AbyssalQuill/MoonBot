@echo off
chcp 65001 >nul
title QQ-Bridge 管理端
cd /d "%~dp0"

REM 首次使用自动装依赖（GUI+manager）
if not exist node_modules (
    echo 首次运行：正在安装管理端依赖...
    call npm install
    if errorlevel 1 ( echo 依赖安装失败，请确认已安装 Node.js >= 22.13 后重试 & pause & exit /b 1 )
)

echo 正在打开管理界面（http://127.0.0.1:5173）...
start "" http://127.0.0.1:5173

echo.
echo ============================================================
echo  QQ-Bridge 管理端已启动（开发模式）
echo  - 管理界面: http://127.0.0.1:5173
echo  - 后端 API : http://127.0.0.1:1921
echo  打开后依次在「实例」卡片 Start: NapCat → DSH → Bridge
echo  关闭本窗口 = 停止管理端
echo ============================================================
call npm run dev
pause
