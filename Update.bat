@echo off
rem  Kotatsu manual updater — docs/ship-v0.md decision 5.
rem
rem  One double-click: fast-forward onto the release mirror, then hand over to
rem  Start.bat, which owns the dependency stamp, the bundle build and the restart
rem  loop. Nothing is installed here on purpose — one install path, one stamp.
rem
rem  --ff-only, not ST's --rebase --autostash: a household install has no local
rem  commits to rebase, and silently stashing someone's edits is how a "why is my
rem  theme gone" bug is born. If the pull cannot fast-forward, say so and stop.
title Kotatsu Update
pushd %~dp0

git --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [91mGit is not installed on this system.[0m
    echo Install it from https://git-scm.com/downloads
    goto end
)

if not exist ".git" (
    echo [91mNot running from a Git repository. Reinstall using an officially supported method to get updates.[0m
    echo See the Install section of README.md
    goto end
)

echo Updating Kotatsu...
call git pull --ff-only
if %errorlevel% neq 0 (
    echo [91mThere were errors while updating.[0m
    echo The pull could not fast-forward. Local commits or changed tracked files are the usual cause.
    goto end
)

popd
call "%~dp0Start.bat" %*
exit /b %errorlevel%

:end
echo.
pause
popd
exit /b 1
