#!/usr/bin/env bash
#
# Kotatsu launcher (macOS / Linux) — the POSIX twin of Start.bat.
# docs/ship-v0.md decision 5. Same three jobs:
#   1. npm install only when package-lock.json has moved since the last install
#      (sha256 stamp under data/.kotatsu/ — a dotfolder, rebuildable, safe to delete).
#   2. build dist/lib.js only when it is missing.
#   3. relaunch on exit code 75 — the in-app "Restart Kotatsu" contract with
#      src/endpoints/kotatsu/update.js. Any other non-zero code ends the loop.

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v npm &> /dev/null
then
    echo -e "\033[0;31mnpm could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"
fi

export NODE_ENV=production

STAMP_DIR="data/.kotatsu"
STAMP_FILE="$STAMP_DIR/install-stamp"

# Hashed in node, not sha256sum/shasum: node is guaranteed present (we are about to
# run the server with it) and the digest has to match Start.bat's byte for byte.
lock_hash() {
    node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('package-lock.json')).digest('hex'))"
}

if [ -f "package-lock.json" ]; then
    WANTED="$(lock_hash)"
    CURRENT=""
    if [ -f "$STAMP_FILE" ]; then
        CURRENT="$(tr -d '[:space:]' < "$STAMP_FILE")"
    fi
    if [ "$WANTED" != "$CURRENT" ]; then
        echo "Dependencies changed. Installing..."
        if ! npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts; then
            echo -e "\033[0;31mDependency install failed. Kotatsu was not started.\033[0m"
            exit 1
        fi
        mkdir -p "$STAMP_DIR"
        printf '%s' "$WANTED" > "$STAMP_FILE"
    fi
fi

if [ ! -f "dist/lib.js" ]; then
    echo "dist/lib.js not found. Building the frontend bundle..."
    npm run build:lib
fi

echo "Entering Kotatsu..."
while true; do
    node "server.js" "$@"
    KOTATSU_EXIT=$?
    if [ "$KOTATSU_EXIT" -eq 75 ]; then
        echo
        echo "Restarting Kotatsu..."
        continue
    fi
    exit "$KOTATSU_EXIT"
done
