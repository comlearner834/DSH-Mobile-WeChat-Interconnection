@echo off
title DSH WeChat Link - Installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
echo ================================================
echo   The installer has finished. Check the window above.
echo   Next steps (also in the installer output above):
echo     1. Fully quit and reopen DSH Desktop
echo     2. Click the [WeChat Link] button (top-right)
echo     3. Scan the QR code with WeChat
echo ================================================
echo.
pause
