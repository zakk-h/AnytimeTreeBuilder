@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Building requires Node.js 22.12+ and npm. Downloaded apps do not.
  pause
  exit /b 1
)
node "%~dp0scripts\build-desktop.mjs" %*
if errorlevel 1 (
  echo.
  echo Build failed. Review the error above.
  pause
  exit /b 1
)
echo.
echo Build complete. Open dist\desktop for your portable app and ZIP.
start "" "%~dp0dist\desktop"
