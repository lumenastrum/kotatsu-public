@echo off
setlocal EnableExtensions
title Install Kotatsu
REM Kotatsu bootstrap installer (Windows, per-user, no admin unless a prerequisite is missing).
REM What it does: checks Node 20+ and git and installs what is missing; offers to set up
REM Claude Code (optional - only the Claude subscription connection uses it); clones the public
REM mirror into Documents\Kotatsu; puts a shortcut on the Desktop; launches Kotatsu (first launch
REM installs dependencies, then opens the browser).
REM Usage: "Install Kotatsu.bat" [folder] [/nolaunch] [/claude or /noclaude]
REM   /claude and /noclaude answer the Claude Code question up front (unattended installs).
REM Design: docs/ship-v0.md in the source repo.

set "MIRROR=https://github.com/lumenastrum/kotatsu-public.git"
set "TARGET=%USERPROFILE%\Documents\Kotatsu"
set "NEED_RESTART="
set "NOLAUNCH="
set "CLAUDE_MODE=ask"
set "CLAUDE_READY="

:parse_args
if [%1]==[] goto args_done
if /i "%~1"=="/nolaunch" set "NOLAUNCH=1" & goto next_arg
if /i "%~1"=="/claude" set "CLAUDE_MODE=yes" & goto next_arg
if /i "%~1"=="/noclaude" set "CLAUDE_MODE=no" & goto next_arg
if not "%~1"=="" set "TARGET=%~1"
:next_arg
shift
goto parse_args
:args_done

echo.
echo   Kotatsu installer
echo   -----------------
echo   Install folder: %TARGET%
echo.

REM ---------- 1) Node.js 20 or newer ----------
REM "v" is a delimiter so the token is already the bare major number. Never use %VAR:v=% here:
REM on an undefined VAR (no Node) cmd expands it to "v=" and the script dies at parse time
REM ("= was unexpected at this time") - the window just closes on a double-click.
REM The LSS compare stays out of a parenthesized block for the same reason: an empty
REM NODE_MAJOR inside a block is a parse error even on the branch that never runs.
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR (
    echo   [1/5] Node.js not found. Installing Node.js LTS with winget...
    goto node_install
)
if %NODE_MAJOR% LSS 20 (
    echo   [1/5] Node.js %NODE_MAJOR% is too old. Installing Node.js LTS with winget...
    goto node_install
)
echo   [1/5] Node.js v%NODE_MAJOR% found.
goto node_done
:node_install
winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements -e
if errorlevel 1 echo         If that did not work, install Node.js LTS from https://nodejs.org and run this again.
set "NEED_RESTART=1"
:node_done

REM ---------- 2) git ----------
git --version >nul 2>&1
if errorlevel 1 (
    echo   [2/5] git not found. Installing Git with winget...
    winget install --id Git.Git --accept-source-agreements --accept-package-agreements -e
    if errorlevel 1 echo         If that did not work, install Git from https://git-scm.com and run this again.
    set "NEED_RESTART=1"
) else (
    echo   [2/5] git found.
)

REM A window keeps the PATH it was opened with, so it can't see what winget just installed.
REM Reload PATH from the registry (what a fresh window would get) and look again, so one run
REM is enough. "Close and run again" is only the fallback when that still finds nothing.
if not defined NEED_RESTART goto prereqs_ready
echo.
echo   Picking up the newly installed programs...
call :refresh_path
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto prereqs_restart
if %NODE_MAJOR% LSS 20 goto prereqs_restart
git --version >nul 2>&1
if errorlevel 1 goto prereqs_restart
echo         Node.js v%NODE_MAJOR% and git are ready.
goto prereqs_ready
:prereqs_restart
echo.
echo   Node.js or git still isn't available in this window. Close this window and run the
echo   installer again. If it keeps stopping here, install them by hand and run this again:
echo     Node.js LTS: https://nodejs.org
echo     Git:         https://git-scm.com
echo.
pause
exit /b 0
:prereqs_ready

REM ---------- 3) Claude Code - OPTIONAL (only the Claude subscription connection uses it) ----------
REM Nothing in this step may stop the install: every failure falls through to step 4 with a note.
if /i "%CLAUDE_MODE%"=="no" goto claude_skip
if /i "%CLAUDE_MODE%"=="yes" goto claude_setup
echo   [3/5] Optional: connect a Claude Pro or Max plan.
echo         Kotatsu can write through your Claude plan using Claude Code. You do not need
echo         this for API keys, a ChatGPT plan or local models, and you can add it later.
echo.
choice /c YN /n /m "Set up Claude Code now? [Y/N] " 2>nul
if errorlevel 2 goto claude_skip
if not errorlevel 1 goto claude_skip

:claude_setup
where claude >nul 2>&1
if not errorlevel 1 goto claude_update
echo   [3/5] Claude Code not found. Installing it...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
if errorlevel 1 goto claude_install_failed
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where claude >nul 2>&1
if errorlevel 1 goto claude_install_failed
goto claude_login

:claude_update
echo   [3/5] Claude Code found. Updating it...
call claude update >nul 2>&1

:claude_login
for /f "delims=" %%v in ('claude --version 2^>nul') do echo         %%v
claude auth status 2>nul | findstr /C:"\"loggedIn\": true" >nul
if not errorlevel 1 goto claude_signed_in
echo.
echo   Claude Code needs to sign in to your Claude subscription. A browser window will open.
echo.
call claude auth login
claude auth status 2>nul | findstr /C:"\"loggedIn\": true" >nul
if errorlevel 1 goto claude_login_failed

:claude_signed_in
echo         Signed in.
set "CLAUDE_READY=1"
goto get_kotatsu

:claude_install_failed
echo.
echo   Claude Code did not install. Kotatsu will be installed without it.
echo   To use a Claude plan later: install Claude Code from https://claude.ai/code,
echo   run "claude auth login", then start Kotatsu again.
echo.
goto get_kotatsu

:claude_login_failed
echo.
echo   Claude Code is not signed in. Kotatsu will be installed without the Claude plan connection.
echo   To add it later: run "claude auth login", then start Kotatsu again.
echo.
goto get_kotatsu

:claude_skip
echo   [3/5] Skipping Claude Code. Kotatsu works without it.

REM ---------- 4) Get Kotatsu ----------
:get_kotatsu
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
if not defined CLAUDE_READY (
    echo   Claude Code was not set up. In the welcome tour's Connect step, pick "An API key" or
    echo   "Something else", or sign in with a ChatGPT plan under "Your subscription".
    echo.
)
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

REM PATH as a newly opened window would see it: machine entries, then the user's.
:refresh_path
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
exit /b 0
