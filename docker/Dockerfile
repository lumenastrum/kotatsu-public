# syntax=docker/dockerfile:1.7
#
#   docker build -t kotatsu - < Dockerfile                  # no build context at all
#   docker build -t kotatsu --build-arg REF=v0.X.0 - < Dockerfile
#
#   docker run -d --name kotatsu -p 8000:8000 \
#     --add-host=host.docker.internal:host-gateway \
#     --add-host=gateway.docker.internal:host-gateway \
#     -v kotatsu-data:/app/data \
#     -v kotatsu-config:/app/config \
#     -v kotatsu-claude:/home/node/.claude \
#     kotatsu
#
#   The --add-host lines let the IP whitelist admit your host (Linux needs them;
#   Docker Desktop resolves those names on its own).
#
#   Claude subscription bridge — sign in once, persists in the kotatsu-claude volume:
#     docker exec -it kotatsu claude        # then /login

ARG REPO=https://github.com/lumenastrum/kotatsu-public.git
ARG REF=main

# ---- build: fetch source, install prod deps, (re)build the frontend bundle ----
FROM node:22-bookworm-slim AS build
ARG REPO
ARG REF
WORKDIR /app

# BuildKit fetches the repo itself — nothing is cloned into your working dir.
ADD --keep-git-dir=false ${REPO}#${REF} /app

RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund --loglevel=error

# dist/lib.js ships in the repo, but rebuild so it always matches the checked-out source.
RUN npm run build:lib \
 && npm prune --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    # SillyTavern maps SILLYTAVERN_<KEY> env vars onto config.yaml keys.
    SILLYTAVERN_LISTEN=true \
    SILLYTAVERN_BROWSERLAUNCH_ENABLED=false \
    SILLYTAVERN_HEARTBEATINTERVAL=30 \
    SILLYTAVERN_DATAROOT=/app/data \
    # In-app self-update does git pull + restart; rebuild the image instead.
    SILLYTAVERN_KOTATSU_UPDATE_ENABLED=false \
    SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build --chown=node:node /app /app

# The Agent SDK ships a native `claude` binary per platform (x64 / arm64). Put it on PATH
# so the bridge can be signed in with `docker exec -it kotatsu claude`.
RUN ln -s /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude /usr/local/bin/claude \
 && claude --version \
 && mkdir -p /app/data /app/config /home/node/.claude \
 && chown -R node:node /app/data /app/config /home/node/.claude

# Keep all Claude Code state (credentials + .claude.json) inside the one volume.
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

USER node
EXPOSE 8000
VOLUME ["/app/data", "/app/config", "/home/node/.claude"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node src/healthcheck.js

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js", "--configPath", "/app/config/config.yaml"]
