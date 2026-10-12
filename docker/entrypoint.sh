#!/bin/sh
# Kotatsu container entrypoint: make sure /config is usable, then hand over to the server.
# No root step and no chown: the folders must already be writable by the user we run as.
set -e

for dir in /config "$SILLYTAVERN_DATAROOT" "$CLAUDE_CONFIG_DIR" "$HOME"; do
    if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
        uid="$(id -u)"
        gid="$(id -g)"
        echo "Kotatsu can't write to $dir (running as uid $uid, gid $gid)." >&2
        echo "Give the folder you mounted at /config to that user, for example:" >&2
        echo "    sudo chown -R $uid:$gid ./kotatsu" >&2
        echo "or run the container as the folder's owner with --user." >&2
        exit 1
    fi
done

exec node /app/server.js --configPath /config/config.yaml "$@"
