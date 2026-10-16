# Kotatsu in Docker

Kotatsu has an official image, built for every release on GitHub Actions:

```
ghcr.io/lumenastrum/kotatsu
```

It runs on `linux/amd64` and `linux/arm64` (so Apple silicon Macs and ARM servers too), and you can pull it without logging in. The Docker setup was first built by [siestamode](https://github.com/siestamode). The official image grew out of their work.

## Quick start

Docker Compose, from an empty folder:

```sh
mkdir kotatsu                       # Kotatsu keeps everything in here
curl -O https://raw.githubusercontent.com/lumenastrum/kotatsu-public/main/docker/docker-compose.yml
# edit `user:` in the file if `id -u` / `id -g` aren't 1000
docker compose up -d
```

Or plain `docker run`:

```sh
mkdir kotatsu
docker run -d --name kotatsu \
  --user "$(id -u):$(id -g)" \
  --read-only --tmpfs /tmp \
  -p 8000:8000 \
  --add-host=host.docker.internal:host-gateway \
  --add-host=gateway.docker.internal:host-gateway \
  -v "$PWD/kotatsu:/config" \
  ghcr.io/lumenastrum/kotatsu:latest
```

Then open <http://localhost:8000>. On Docker Desktop (macOS, Windows) you can leave out the two `--add-host` lines.

## Tags

| Tag | What it is |
| --- | --- |
| `0.7.7` | exactly that release |
| `0.6` | the newest `0.6.x` patch |
| `latest` | the newest release |

Every image carries the commit it was built from: `docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ghcr.io/lumenastrum/kotatsu:latest`, or `KOTATSU_SOURCE_REVISION` inside the container.

## One folder holds everything

Mount one folder at `/config`. Nothing else in the container is written to.

| Path | Holds |
| --- | --- |
| `/config/config.yaml` | the server config, created on first start |
| `/config/data` | chats, characters, personas, presets, settings, API keys, extensions, backups, caches |
| `/config/claude` | the Claude Code login for the Claude bridge |
| `/config/home` | the container's home folder, for anything else a tool writes |

### Ownership

The image runs as uid `1000` by default, and it never starts as root to fix permissions. The folder you mount has to be writable by the user the container runs as:

- **Named volume** (`-v kotatsu:/config`): works as-is, because Docker gives a new volume to uid 1000.
- **Folder on your disk** (`-v ./kotatsu:/config`): run the container as the folder's owner (`--user "$(id -u):$(id -g)"`, or `user:` in compose), or `sudo chown -R 1000:1000 ./kotatsu`.

If the folder isn't writable, the container stops right away and tells you which uid it ran as and what to change.

### Rootless Docker and Podman

Both work: no privileged mode, no host networking, no root start. Under rootless Docker, the uid inside the container maps to a subordinate uid on the host, so `--user 0:0` (root inside = you outside) is the simplest way to own a bind-mounted folder. Rootless networking can make your browser's requests arrive from an address the IP whitelist doesn't know. If you get a 403, see the next section.

### Read-only

The container runs fine with `--read-only --tmpfs /tmp` (the compose file does this). The app's own files are never written at runtime. One thing that needs a writable app folder: installing a third-party extension "for all users". Install extensions for your own user instead (the default); those go to `/config/data`.

## Security

Kotatsu won't start in a container without some protection on. Out of the box that's SillyTavern's **IP whitelist**: only localhost and your Docker host get in. CSRF protection is always on.

### "403 Forbidden"

That's the whitelist. Add the addresses you open Kotatsu from to `whitelist` in `kotatsu/config.yaml`, then `docker restart kotatsu`:

```yaml
whitelist:
  - ::1
  - 127.0.0.1
  - 192.168.1.0/24     # your LAN
  - 100.64.0.0/10      # Tailscale
```

On Linux, also keep the two `--add-host` lines (the compose file has them), which let the whitelist recognize your Docker host.

### A password instead

To reach Kotatsu from anywhere, switch the whitelist off and turn on a login. Either SillyTavern's user accounts (each with a password), or one basic-auth user:

```yaml
whitelistMode: false
basicAuthMode: true
basicAuthUser:
  username: "pick-a-name"
  password: "pick-a-long-password"     # the default is "password": change it
```

The same settings work as environment variables (`SILLYTAVERN_WHITELISTMODE=false`, `SILLYTAVERN_BASICAUTHMODE=true`, `SILLYTAVERN_BASICAUTHUSER_USERNAME=...`, `SILLYTAVERN_BASICAUTHUSER_PASSWORD=...`). With the whitelist off and no login, Kotatsu refuses to start.

### Behind a reverse proxy

- **Serve it over HTTPS** at the proxy, and turn on a login (above). Don't put a whitelist-only Kotatsu on the internet.
- **Whitelist:** when the whitelist is on, Kotatsu checks the proxy's address and the forwarded client address (`X-Real-IP` / `X-Forwarded-For`), so both must be on the list. Behind a public proxy, a login is simpler.
- **Host check:** add your domain so requests with other `Host` headers are refused:

  ```yaml
  hostWhitelist:
    enabled: true
    hosts:
      - kotatsu.example.com
  ```

- **Uploads:** let large requests through (character cards, backgrounds, chat imports). For nginx: `client_max_body_size 100m;`.
- **Timeouts:** replies stream for a while. Raise the proxy's read timeout (nginx: `proxy_read_timeout 600s;`) and leave response buffering off for Kotatsu (`proxy_buffering off;`).

## Model connections

API keys and local models work as usual. Keys are kept in `/config/data`.

### Claude bridge (your Claude subscription)

The bridge listens on `127.0.0.1:5107` inside the container and answers with your Claude Code login. You don't publish that port. Sign in once:

```sh
docker exec -it kotatsu claude
# then type /login
```

Claude Code prints a link. Open it on any device, approve, and paste the code back in. Exit with `/exit`. The login is kept in `/config/claude`. If Kotatsu's Connect step still says Claude Code isn't signed in, run `docker restart kotatsu`.

### ChatGPT bridge: not in Docker yet

ChatGPT's sign-in sends your browser to `127.0.0.1:5108` and expects Kotatsu to answer there. In a container (and on a server you reach from another machine) it can't, so the sign-in never finishes. Use an API key, a local model or the Claude bridge.

## Updating

The in-app updater is turned off in the image. To update, pull the new image and recreate the container. Your folder stays as it is.

```sh
docker compose pull && docker compose up -d
# or: docker pull ghcr.io/lumenastrum/kotatsu:latest, then remove and re-run the container
```

To stay on one version, use a version tag such as `0.7.7` instead of `latest`.

## Backup and restore

Everything is in the one folder, so a backup is a copy of it. Stop the container first, so nothing is written mid-copy:

```sh
docker stop kotatsu
tar czf kotatsu-backup-$(date +%F).tar.gz kotatsu
docker start kotatsu
```

To restore, stop the container, put the folder back (same owner), and start it. Your API keys are in that folder, so keep backups somewhere private.

## Moving from the 0.6.0 Docker setup

The Dockerfile in 0.6.0 used three volumes (`kotatsu-data`, `kotatsu-config`, `kotatsu-claude`). To move them into one folder:

```sh
docker stop kotatsu
mkdir -p kotatsu/data kotatsu/claude
docker run --rm -v kotatsu-config:/from -v "$PWD/kotatsu:/to" alpine cp -a /from/. /to/
docker run --rm -v kotatsu-data:/from -v "$PWD/kotatsu/data:/to" alpine cp -a /from/. /to/
docker run --rm -v kotatsu-claude:/from -v "$PWD/kotatsu/claude:/to" alpine cp -a /from/. /to/
sudo chown -R "$(id -u):$(id -g)" kotatsu
docker rm kotatsu
```

Then start the new image as in Quick start. Once you've checked your chats are there, you can delete the old volumes with `docker volume rm kotatsu-data kotatsu-config kotatsu-claude`.

## Building it yourself

From a clone of this repo:

```sh
docker build -f docker/Dockerfile -t kotatsu .
```

Or with no clone (BuildKit fetches the source):

```sh
docker build -f docker/Dockerfile -t kotatsu https://github.com/lumenastrum/kotatsu-public.git#v0.7.7
```

## License

Kotatsu is a fork of [SillyTavern](https://github.com/SillyTavern/SillyTavern), and both are AGPL-3.0. The license is in the image at `/app/LICENSE`. The image's source is this repository at the commit in its `org.opencontainers.image.revision` label.
