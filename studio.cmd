@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer first. See README.md.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:18765/ in your browser after startup.
node "%~dp0cutccc\node\cli.js" serve %*
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
