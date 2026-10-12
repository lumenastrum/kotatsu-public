# syntax=docker/dockerfile:1.7
#
# Kotatsu's official image (ghcr.io/lumenastrum/kotatsu) is built from this file by
# .github/workflows/docker.yml on every release. To build it yourself, from a clone:
#
#   docker build -f docker/Dockerfile -t kotatsu .
#
# or with no clone at all (BuildKit fetches the repo):
#
#   docker build -f docker/Dockerfile -t kotatsu https://github.com/lumenastrum/kotatsu-public.git#main
#
# Everything the container keeps lives under ONE mount, /config:
#   /config/config.yaml   server config, created on first boot
#   /config/data          chats, characters, settings, API keys, extensions, backups, caches
#   /config/claude        Claude Code login for the Claude bridge
#   /config/home          the runtime HOME, for anything else a tool writes
#
# Original layout and Claude bridge wiring by siestamode (PR #2).

# ---- build: install deps, build the frontend bundle, drop dev deps ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --loglevel=error

COPY . .
# dist/lib.js ships in the repo, but rebuild so it always matches the source being packaged.
RUN npm run build:lib \
 && npm prune --omit=dev --no-audit --no-fund
# The server creates these folders under /app on every start (src/users.js
# ensurePublicDirectoriesExist). Create them now so a read-only /app already has them.
RUN node --input-type=module -e "import fs from 'node:fs'; import { PUBLIC_DIRECTORIES } from './src/constants.js'; for (const dir of Object.values(PUBLIC_DIRECTORIES)) fs.mkdirSync(dir, { recursive: true });"

# ---- runtime ----
FROM node:22-bookworm-slim

ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="Kotatsu" \
      org.opencontainers.image.description="SillyTavern underneath, user friendliness on top." \
      org.opencontainers.image.source="https://github.com/lumenastrum/kotatsu-public" \
      org.opencontainers.image.url="https://github.com/lumenastrum/kotatsu-public" \
      org.opencontainers.image.documentation="https://github.com/lumenastrum/kotatsu-public/blob/main/docker/docker.md" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"

ENV NODE_ENV=production \
    KOTATSU_SOURCE_REVISION=${REVISION} \
    HOME=/config/home \
    CLAUDE_CONFIG_DIR=/config/claude \
    # SillyTavern maps SILLYTAVERN_<KEY> env vars onto config.yaml keys.
    SILLYTAVERN_DATAROOT=/config/data \
    SILLYTAVERN_LISTEN=true \
    SILLYTAVERN_BROWSERLAUNCH_ENABLED=false \
    SILLYTAVERN_HEARTBEATINTERVAL=30 \
    # In-app self-update does git pull + restart; in a container you pull a new image instead.
    SILLYTAVERN_KOTATSU_UPDATE_ENABLED=false \
    SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Owned by root and read-only to the app: nothing under /app is written at runtime, which is what
# lets the container run with --read-only.
COPY --from=build /app /app

# The Agent SDK ships a native `claude` binary per platform (x64 / arm64). Put it on PATH so the
# bridge can be signed in with `docker exec -it kotatsu claude`.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude /usr/local/bin/claude \
 && claude --version \
 && chmod 0755 /app/docker/entrypoint.sh \
 && mkdir -p /config/data /config/claude /config/home \
 && chown -R node:node /config

# uid 1000. Any other uid works too (`--user 1234:1234`) as long as it can write /config.
USER node
EXPOSE 8000
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

# tini forwards SIGTERM to node, and the server shuts down cleanly on it.
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]
