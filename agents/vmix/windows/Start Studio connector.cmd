@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "connector_exit=%errorlevel%"
if /I not "%~1"=="-SelfTestOnly" pause
exit /b %connector_exit%
