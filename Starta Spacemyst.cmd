@echo off
chcp 65001 >nul
rem Startar Spacemyst 3D: bygger spelet, startar spelservern i ett eget fönster och öppnar
rem spelet i webbläsaren. Stäng fönstret "Spacemyst 3D server" för att stänga av spelet.
setlocal
cd /d "%~dp0"
title Spacemyst 3D

where node >nul 2>nul || goto :nonode

rem Kör servern redan räcker det att bygga om spelet och öppna det.
call :alive
if not errorlevel 1 goto :open

rem Paketen installeras första gången och igen när package-lock.json har ändrats.
set "INSTALL="
if not exist "node_modules\.package-lock.json" set "INSTALL=1"
if not defined INSTALL powershell -NoProfile -Command "if ((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item 'node_modules\.package-lock.json').LastWriteTime) { exit 1 }"
if errorlevel 1 set "INSTALL=1"
if defined INSTALL (
  echo Installerar paket. Det tar en stund första gången...
  call npm ci --no-audit --no-fund || goto :failed
)

call :build || goto :failed
echo Startar spelservern...
start "Spacemyst 3D server" cmd /k node --import tsx server/index.ts
echo Väntar på att servern svarar...
powershell -NoProfile -Command "for ($i = 0; $i -lt 120; $i++) { try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:2567/health').StatusCode -eq 200) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo Servern svarade inte. Felet syns i fönstret "Spacemyst 3D server".
  pause
  exit /b 1
)
start "" http://localhost:2567
exit /b 0

:open
call :build || goto :failed
start "" http://localhost:2567
exit /b 0

:build
echo Bygger spelet...
call npm run build
exit /b %errorlevel%

:alive
powershell -NoProfile -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:2567/health').StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
exit /b %errorlevel%

:nonode
echo Node.js saknas. Installera det från https://nodejs.org och starta filen igen.
pause
exit /b 1

:failed
echo Något gick fel, se meddelandet ovan.
pause
exit /b 1
