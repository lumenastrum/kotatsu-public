# Kotatsu in Docker

Builds [Kotatsu](https://github.com/lumenastrum/kotatsu-public) straight from GitHub. You don't need a local clone.

```sh
docker compose up -d --build
# or, with no compose and no build context:
docker build -t kotatsu - < Dockerfile
```

Then open <http://localhost:8000>.

## "403 Forbidden" on first load

Kotatsu keeps SillyTavern's **IP whitelist**, and it's on by default. Only localhost is allowed, plus the Docker host when the container can resolve `host.docker.internal`.

- **Docker Desktop (macOS / Windows):** those names resolve automatically, so it should just work.
- **Linux:** they don't resolve unless you add them. `compose.yaml` already does this. With plain `docker run`, add:

  ```sh
  --add-host=host.docker.internal:host-gateway \
  --add-host=gateway.docker.internal:host-gateway
  ```

**Opening it from another device (LAN, Tailscale)** is also a 403 until you allow that device. Edit `config.yaml` in the `kotatsu-config` volume (`/app/config/config.yaml`), then restart:

```yaml
whitelist:
  - ::1
  - 127.0.0.1
  - 192.168.1.0/24     # your LAN
  - 100.64.0.0/10      # Tailscale
```

The other route is `whitelistMode: false` together with `basicAuthMode: true`. Don't turn the whitelist off without auth.

## Claude bridge (use your Claude subscription)

Kotatsu talks to Claude through a small bridge inside the container. The bridge listens on `127.0.0.1:5107`, uses your Claude Code login, and needs no API key. You don't publish this port, because only Kotatsu itself calls it.

Sign in once:

```sh
docker exec -it kotatsu claude
# then type /login inside the prompt
```

Claude Code prints a URL. Open it on any machine, approve, and paste the code back into the prompt. Exit with `/exit`.

- The login is saved in the `kotatsu-claude` volume (`CLAUDE_CONFIG_DIR=/home/node/.claude`), so it survives restarts and rebuilds.
- If the Connect step in Kotatsu still says Claude Code isn't signed in, run `docker restart kotatsu`.

## Volumes

| Volume           | Path in container     | Holds                                   |
| ---------------- | --------------------- | --------------------------------------- |
| `kotatsu-data`   | `/app/data`           | chats, characters, presets (your data)  |
| `kotatsu-config` | `/app/config`         | `config.yaml`, created on first boot    |
| `kotatsu-claude` | `/home/node/.claude`  | Claude Code login                       |

## Updating

The in-app updater is disabled in the image because it does `git pull` inside the container. To update, rebuild instead. Your data volumes are kept.

```sh
docker compose build --no-cache && docker compose up -d
```

To pin a version, set `REF` to a tag or commit in `compose.yaml`, or pass `--build-arg REF=...`.