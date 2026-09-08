@echo off
setlocal EnableExtensions
title Install Kotatsu
REM Kotatsu bootstrap installer (Windows, per-user, no admin unless a prerequisite is missing).
REM What it does: checks Node 20+, git, and Claude Code; installs what is missing; makes sure
REM Claude Code is logged in; clones the public mirror into Documents\Kotatsu; puts a shortcut
REM on the Desktop; launches Kotatsu (first launch installs dependencies, then opens the browser).
REM Design: docs/ship-v0.md in the source repo.

set "MIRROR=https://github.com/lumenastrum/kotatsu-public.git"
set "TARGET=%USERPROFILE%\Documents\Kotatsu"
if not "%~1"=="" set "TARGET=%~1"
set "NEED_RESTART="
set "NOLAUNCH="
if /i "%~2"=="/nolaunch" set "NOLAUNCH=1"

echo.
echo   Kotatsu installer
echo   -----------------
echo   Install folder: %TARGET%
echo.

REM ---------- 1) Node.js 20 or newer ----------
set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
set "NODE_MAJOR=%NODE_MAJOR:v=%"
if "%NODE_MAJOR%"=="" (
    echo   [1/5] Node.js not found. Installing Node.js LTS with winget...
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -e
    set "NEED_RESTART=1"
) else (
    if %NODE_MAJOR% LSS 20 (
        echo   [1/5] Node.js %NODE_MAJOR% is too old. Installing Node.js LTS with winget...
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -e
        set "NEED_RESTART=1"
    ) else (
        echo   [1/5] Node.js v%NODE_MAJOR% found.
    )
)

REM ---------- 2) git ----------
git --version >nul 2>&1
if errorlevel 1 (
    echo   [2/5] git not found. Installing Git with winget...
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements -e
    set "NEED_RESTART=1"
) else (
    echo   [2/5] git found.
)

if defined NEED_RESTART (
    echo.
    echo   A prerequisite was just installed. Close this window and run the installer again
    echo   so the new programs are on your PATH.
    echo.
    pause
    exit /b 0
)

REM ---------- 3) Claude Code (the Claude subscription bridge runs through it) ----------
where claude >nul 2>&1
if errorlevel 1 (
    echo   [3/5] Claude Code not found. Installing it...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
    if errorlevel 1 (
        echo   Claude Code did not install. Install it from https://claude.ai/code and run this again.
        pause
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
) else (
    echo   [3/5] Claude Code found. Updating it...
    call claude update >nul 2>&1
)
for /f "delims=" %%v in ('claude --version 2^>nul') do echo         %%v

claude auth status 2>nul | findstr /C:"\"loggedIn\": true" >nul
if errorlevel 1 (
    echo.
    echo   Claude Code needs to sign in to your Claude subscription. A browser window will open.
    echo.
    call claude auth login
    claude auth status 2>nul | findstr /C:"\"loggedIn\": true" >nul
    if errorlevel 1 (
        echo   Still not signed in. Run "claude auth login" yourself, then run this installer again.
        pause
        exit /b 1
    )
)
echo         Signed in.

REM ---------- 4) Get Kotatsu ----------
if exist "%TARGET%\.git" (
    echo   [4/5] Kotatsu is already installed. Updating it...
    git -C "%TARGET%" pull --ff-only
) else (
    if exist "%TARGET%" (
        echo   [4/5] %TARGET% exists but is not a Kotatsu install. Move it away and run this again.
        pause
        exit /b 1
    )
    echo   [4/5] Downloading Kotatsu...
    git clone "%MIRROR%" "%TARGET%"
    if errorlevel 1 (
        echo   Download failed. Check your connection and run this again.
        pause
        exit /b 1
    )
)

REM ---------- 5) Desktop shortcut + first launch ----------
echo   [5/5] Creating the Desktop shortcut...
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Kotatsu.lnk'); $s.TargetPath='%TARGET%\Start.bat'; $s.WorkingDirectory='%TARGET%'; $s.IconLocation='%TARGET%\public\favicon.ico'; $s.Description='Kotatsu'; $s.Save()"

echo.
if defined NOLAUNCH (
    echo   Done. Kotatsu is installed. Use the Kotatsu shortcut on your Desktop to start it.
    echo.
    endlocal
    exit /b 0
)
echo   Done. Starting Kotatsu - the first start installs its dependencies, then your browser opens.
echo   Next time, use the Kotatsu shortcut on your Desktop.
echo.
start "Kotatsu" /D "%TARGET%" "%TARGET%\Start.bat"
endlocal
exit /b 0
