@echo off
setlocal
set PYTHONUTF8=1
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Install cutccc[web,mcp] in .venv first. See README.md.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:18765/ in your browser after startup.
"%~dp0.venv\Scripts\python.exe" -m cutccc serve %*
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
