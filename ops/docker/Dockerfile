# LIJOX adapter — the Docker image (ops/docker, adapter 0.108.1).
#
# Build from the repository root, never from this folder:
#     docker build -f ops/docker/Dockerfile -t lijox-adapter:v0.108.1 .
# (ops/docker/README.md has the full build / run / update steps.)
#
# What the image holds: Node.js 22 (the engine the adapter is developed on; README: "Node.js 20 or newer"),
# the adapter's runtime files only — lij-adapter.js, every module it requires, the five .proto files,
# package.json + package-lock.json — and the production dependencies. No tests, no build_*.py, no docs,
# no console secrets, no .env: the operator's settings and state come in at run time through /data.
#
# The adapter reads its .env from the folder it is STARTED in (dotenv's config(): path.resolve(process.cwd(),
# '.env'), lij-adapter.js line 402). WORKDIR is /data, so /data/.env is the file it reads, and LIJ_DATA_DIR=/data
# puts every state file beside it. Nothing is written under /app at run time.
#
# Dependencies: package-lock.json is pinned at package version 0.53.0 by convention (the lock is NOT bumped per
# release; its dependency ranges equal package.json's, so `npm ci` accepts it — checked 2026-10-19 in the
# sandbox: "added 95 packages"). Two packages ship native code: secp256k1 (a prebuilt binary for linux-x64 is
# inside the npm tarball — glibc and musl; there is NONE for linux-arm64, so on a Raspberry Pi / arm64 box the
# pure-JS fallback (elliptic) loads instead: correct, slower; the Tatara boot line names which one when Tatara is on) and
# better-sqlite3 (prebuild-install downloads a binary at install time; the adapter never requires it at run time —
# the SQLite store was retired in v0.18.7 and registry.js loads it lazily, so skipping the download costs nothing).
# `--ignore-scripts` is therefore safe and keeps the image build free of compilers and downloads.

FROM node:22-bookworm-slim

# curl for the HEALTHCHECK only; tini is not needed — node handles SIGTERM itself (lij-adapter.js shutdown()).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. dependencies first (their layer is reused across adapter releases)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# 2. the adapter's runtime files — the exact set `require` reaches from lij-adapter.js (checked against the
#    file list on 2026-10-19; a new module in a later release is added here or the image fails at start)
COPY lij-adapter.js \
     console.js \
     cooperative-chain-bridge.js \
     cooperative-chain-msg.js \
     copies.js \
     delegate.js \
     jit-guard.js \
     kits.js \
     lij-sm.js \
     lnd-grpc.js \
     nip04.js \
     nwc.js \
     pl.js \
     push.js \
     registry.js \
     schnorr.js \
     tatara-channels.js \
     tatara-forward.js \
     tatara-host.js \
     tatara-list.js \
     tatara-nostr.js \
     tatara-relay.js \
     tatara-ring.js \
     tatara-ringstore.js \
     tatara.js \
     wallet-limits.js \
     ws-tunnel.js \
     ./
COPY lightning.proto \
     lightning-openchannel.proto \
     chainnotifier.proto \
     router.proto \
     walletkit.proto \
     ./

# 3. a non-root user owning the state root. uid 1000 is the image's "node" user; LND's tls.cert mount must be
#    readable by uid 1000 (ops/docker/README.md explains the one chmod).
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /data
VOLUME ["/data"]

# The adapter's state root and its .env both live in /data (see the head of this file).
ENV LIJ_DATA_DIR=/data \
    NODE_ENV=production \
    DOTENV_CONFIG_QUIET=true

# 7000 the HTTP API · 7001 the browser peer proxy (WSS) · 7004 the operator console.
# The console binds 127.0.0.1 and any tailscale* interface only (console.js binds()); with network_mode: host
# that means the box's own loopback — nothing more unless the operator sets CONSOLE_BIND in .env.
EXPOSE 7000 7001 7004

# /health answers only once LND is reachable and the macaroon accepted (lij-adapter.js /health → /v1/getinfo).
# start-period 90 s: the first-run doctor and LND's own start can take that long after a reboot.
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${ADAPTER_PORT:-7000}/health" >/dev/null || exit 1

CMD ["node", "/app/lij-adapter.js"]
