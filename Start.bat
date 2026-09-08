@echo off
rem  Kotatsu launcher — docs/ship-v0.md decision 5.
rem
rem  Three jobs beyond "run the server":
rem    1. Install dependencies ONLY when package-lock.json has moved since the last
rem       install. The proof is a sha256 stamp under data\.kotatsu\ — Kotatsu state
rem       lives in a dotfolder and is rebuildable (repo CLAUDE.md): delete the stamp
rem       and the next launch simply installs once more.
rem    2. Build dist\lib.js only when it is missing. The release mirror ships it, so
rem       on an installed box this never runs.
rem    3. Relaunch on exit code 75 — the in-app "Restart Kotatsu" contract with
rem       src/endpoints/kotatsu/update.js. Any other non-zero code is a crash: hold
rem       the window open so the error is readable. A clean exit closes it.
title Kotatsu
pushd %~dp0
set NODE_ENV=production

node -e "const c=require('crypto'),f=require('fs'),p=require('path');const l=p.resolve('package-lock.json');if(!f.existsSync(l))process.exit(0);const h=c.createHash('sha256').update(f.readFileSync(l)).digest('hex');let s=null;try{s=f.readFileSync(p.resolve('data','.kotatsu','install-stamp'),'utf8').trim()}catch{};process.exit(h===s?0:1)"
if not errorlevel 1 goto deps_ok

echo Dependencies changed. Installing...
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts
if errorlevel 1 goto install_failed
node -e "const c=require('crypto'),f=require('fs'),p=require('path');const d=p.resolve('data','.kotatsu');f.mkdirSync(d,{recursive:true});f.writeFileSync(p.join(d,'install-stamp'),c.createHash('sha256').update(f.readFileSync(p.resolve('package-lock.json'))).digest('hex'))"

:deps_ok
if exist "dist\lib.js" goto launch
echo dist\lib.js not found. Building the frontend bundle...
call npm run build:lib

:launch
node server.js %*
rem  Captured immediately: every later command (echo, if, set) is free to clobber
rem  ERRORLEVEL, and the exit code has to survive to the bottom of the file.
set KOTATSU_EXIT=%errorlevel%
if "%KOTATSU_EXIT%"=="75" goto restart
if not "%KOTATSU_EXIT%"=="0" goto crashed
popd
exit /b 0

:restart
echo.
echo Restarting Kotatsu...
goto launch

:install_failed
echo.
echo Dependency install failed. Kotatsu was not started.
pause
popd
exit /b 1

:crashed
echo.
echo Kotatsu exited with code %KOTATSU_EXIT%.
pause
popd
exit /b %KOTATSU_EXIT%
