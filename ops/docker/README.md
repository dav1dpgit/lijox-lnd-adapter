# LIJOX adapter in Docker — the kit

Three files: `Dockerfile` (the image), `docker-compose.yml` (how it runs), `env.example` (the settings). For a
box that already runs LND and Docker: a plain Linux node, an Umbrel, a RaspiBlitz. The full operator walk-through,
step by step with every command, is `docs/operator-docker-runbook.md`; this page is the short form.

**StartOS (Start9):** this kit does not run on a StartOS box as it stands. StartOS 0.4 runs no Docker and no
Podman ("StartOS does not use Docker or Podman; standard container tooling will not work" — Start9's own docs,
`docs.start9.com/start-os/0.4.0.x/service-containers.html`, read 2026-10-19); the clean path there is the StartOS
package (s9pk), which is being built separately. The runbook's §2 says what a Start9 operator can do today.

**Sandbox note:** the kit was written and checked where no Docker daemon runs — `node --check` on the runtime files,
`docker compose config` on the compose file, `npm ci --omit=dev --ignore-scripts` with the repository's lock file,
and the Dockerfile's `COPY` list read against the repository's file list. The image has NOT been built or run. The
first operator who builds it is the first build; the runbook says what to look for.

## What the image is

- `node:22-bookworm-slim` — Node.js 22, the engine the adapter is developed on (README: "Node.js 20 or newer").
- The adapter's runtime files only: `lij-adapter.js`, the 26 modules it requires, the five `.proto` files,
  `package.json` and `package-lock.json`. No tests, no `build_*.py`, no docs, no `.env`, no secrets of any kind.
- `npm ci --omit=dev --ignore-scripts`. The lock file is pinned at package version 0.53.0 by convention; its
  dependency ranges equal `package.json`'s, so `npm ci` accepts it. `--ignore-scripts` skips the two native-build
  steps: `secp256k1` (a prebuilt linux-x64 binary is in the tarball; arm64 falls back to the JavaScript
  implementation, correct and slower) and `better-sqlite3` (never loaded at run time — v0.18.7 retired the SQLite
  store).
- Runs as the image's `node` user (uid 1000), never root. `WORKDIR /data`: the adapter reads `.env` from the
  folder it starts in (dotenv), so `/data/.env` is its config and `LIJ_DATA_DIR=/data` keeps every state file beside it.
- `EXPOSE 7000 7001 7004`; a `HEALTHCHECK` on `/health` every 30 s (90 s grace after start).
- The console (7004) binds the loopback only, as it does under systemd; `CONSOLE_BIND` in `.env` is the opt-in.

## Build

From the repository root, at a release tag, after the hash check (next section):

    docker build -f ops/docker/Dockerfile -t lijox-adapter:v0.109.1 .

The tag in the image name is the adapter's tag. `docker-compose.yml` names the same tag in `image:` — change both
together on an update.

## Run

    cd ops/docker
    cp env.example .env
    chmod 600 .env

Fill `.env` (the runbook §4 goes line by line; `LIJOX_DATA_HOST` and `LND_TLS_CERT_HOST` are the two Docker-only
lines), then:

    docker compose up -d
    docker compose logs -f

The boot banner shows the version; `[Doctor] all checks passed.` means LND answered the baked macaroon and the node
identity matches `NODE_PUBKEY`. `curl -s http://127.0.0.1:7000/health` answers JSON.

Why the host network, in one line: the adapter must reach LND at `localhost:8080` / `:10009` / `:9735` and be
reached by cloudflared or Caddy at `127.0.0.1:7000` / `:7001`, exactly as the systemd install; the console must
stay on the loopback. The long form is at the head of `docker-compose.yml`.

## The hash check against RELEASES.md

Every release row names the files that changed and their sha256; a file the row calls unchanged keeps the hash of
the last row that named it. Before building, at the checked-out tag:

    git fetch --tags
    git checkout v0.109.1
    sha256sum lij-adapter.js tatara.js tatara-list.js tatara-host.js tatara-nostr.js nip04.js config.env.example package.json

Compare each line with the row for the tag in `RELEASES.md` (the row is also the changelog). A mismatch = do not
build. The image carries exactly those files, so the check on the checkout is the check on the image.

## Update

    git fetch --tags
    git checkout v<NEW>
    sha256sum <the files the new row names>
    docker build -f ops/docker/Dockerfile -t lijox-adapter:v<NEW> .

Then in `ops/docker/docker-compose.yml` change `image: lijox-adapter:v<OLD>` to `v<NEW>` (a dated `.bak` first —
the runbook shows the sed), and:

    cd ops/docker
    docker compose up -d

Compose re-creates the container from the new image; `/data` (the state) and `.env` are mounts and are untouched.
The boot banner must show the new version. Never run from `main`.

## Notes

- **Restart on unhealthy.** Docker restarts a crashed container (`restart: unless-stopped`) but not one whose
  `HEALTHCHECK` fails. The systemd unit's watchdog does that job on a systemd install; under Docker, if you want it,
  run `willfarrell/autoheal` beside the adapter with `AUTOHEAL_CONTAINER_LABEL=all` — or watch `docker compose ps`.
- **The lease and recover-close** shell out to `lncli` (`LEASE_LNCLI`); there is no `lncli` in this image. Runbook §9.
- **Logs** go to Docker's json-file driver, capped at 10 × 20 MB in the compose file. `docker compose logs` reads them;
  there is no journald entry for the adapter on a Docker install.
- **Nothing in this folder is operator-specific.** Every value in `env.example` is an example.
