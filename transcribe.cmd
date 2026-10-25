@echo off
setlocal
set PYTHONUTF8=1
if "%~1"=="" (
  echo Drag a video onto this file, or run: transcribe.cmd "video.mp4"
  pause
  exit /b 1
)
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Install the .venv environment first. See README.md.
  pause
  exit /b 1
)
"%~dp0.venv\Scripts\python.exe" -m cutccc transcribe "%~f1"
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
