# Running a LIJOX provider in Docker — the operator runbook

Written 2026-10-19 for adapter 0.109.1 and the first independent provider: a tester in South Africa whose node
is a Start9 running LND. It is also the general path for any Linux box that runs LND and Docker — an Umbrel, a
RaspiBlitz, a plain Ubuntu node. Every command is in its own box, labelled with the machine it runs on. Nothing
here overwrites a file on your box: a dated `.bak` copy comes first, lines are appended, and you see the change.

The kit it uses is `ops/docker/` (Dockerfile, docker-compose.yml, env.example). The relay kit for the direct
door is `ops/relay/`. The older systemd guide (`docs/adapter-standalone-setup.md`) is still right for a box
without Docker.

**Honesty notes, up front.**
- This runbook was written in a sandbox with no Docker daemon. The Dockerfile and compose file were checked as far
  as that allows (see `ops/docker/README.md`); the image has not been built or run anywhere yet. Your build is the
  first. Section 5 says what a good first start looks like and what to send back if it is not.
- §2 is the honest answer on Start9: today the kit does not run on a StartOS box as it stands. Read §2 before
  anything else if your node is a Start9.

---

## 0. Where things run

Three machines appear in the commands:

| label | what it is |
|---|---|
| **[NODE]** | the Linux box that runs LND and will run the adapter — your Umbrel, RaspiBlitz, Ubuntu node (or, later, the Start9) |
| **[DESK]** | your own computer, used to ssh into the others and to read the registry |
| **[VPS]** | the small rented server of the direct door (§7 only) |

Replace every `<...>` with your value before pressing Enter.

---

## 1. Before you start — what the node must have

### 1a. LND, and the Terminus patch

The adapter opens every channel to a wallet as a **static-remote-key channel without anchors** (`LSPS2_COMMITMENT_TYPE=STATIC_REMOTE_KEY`), and it opens them **zero-conf** (the wallet can receive before the funding confirms). Stock LND refuses that pair — its channel-type whitelist has no zero-conf case without anchors (`rpcserver` answers "use anchors for zero-conf"). DP's **Terminus** patch adds the missing rows; it runs on both of his nodes.

Why not anchors: the LiJ wallet refuses an anchors channel from its own provider (engine v312+, DP's ruling of 2026-10-07 — "the user is aware, JIT channels fail in plain sight"). A provider on stock LND therefore opens no channel to any LiJ wallet. So:

- **A Start9:** the Terminus LND ships as a StartOS *flavor* of the LND package (DP's ruling 2026-10-10). It is being packaged separately and is not part of this runbook. Until it is installed, the adapter can run, register and answer, but every JIT open fails.
- **Any other Linux box:** build LND from DP's fork with the patch (`dav1dpgit/lnd`; the patch file lives in the wallet repository at `ops/lnd-terminus/lnd-terminus.patch`). The ritual is the UM890's: re-apply on every LND upgrade.

The LND version on both of DP's nodes is 0.20.x/0.21.x-beta; the macaroon recipe (§3) checks its URI names against your build.

### 1b. lnd.conf lines the adapter depends on

Zero-conf + alias channels need two protocol switches, and the adapter's open-channel path assumes LND lets more than one inbound pending channel per peer. In `lnd.conf` (on a Start9: *LND → Actions → Channel Settings* has the first two as switches — Start9's LND package, read 2026-10-06):

```
[protocol]
protocol.zero-conf=true
protocol.option-scid-alias=true
```

```
[Application Options]
maxpendingchannels=10
```

(`maxpendingchannels` is the number of incoming pending channels LND allows per peer; the default is 1 — lnd.conf reference, docs.lightning.engineering.) The REST and gRPC ports must be on: `restlisten=127.0.0.1:8080` and `rpclisten=127.0.0.1:10009` are LND's defaults and what the adapter expects.

Check on the box — **[NODE]**:

```
grep -nE "^(protocol\.zero-conf|protocol\.option-scid-alias|maxpendingchannels|restlisten|rpclisten)" ~/.lnd/lnd.conf
```

(Umbrel: the file is `~/umbrel/app-data/lightning/data/lnd/umbrel-lnd.conf`; RaspiBlitz: `/mnt/hdd/lnd/lnd.conf`.)

### 1c. Money

JIT channels are opened from **your** on-chain balance. The adapter refuses to open below `JIT_MIN_ONCHAIN_RESERVE_SATS` (default 2,000,000 sats confirmed). You also want one or two outbound channels to well-connected nodes so your wallets' payments route out.

### 1d. Optional: bitcoind for the filter server

A provider may offer its wallets its own block-filter server (and the silent-payment index). That needs `bitcoind` on the same box with `blockfilterindex=1`. It is a separate install (`docs/adapter-standalone-setup.md` §10) and not needed for the first start. Skip it today.

### 1e. Docker

**[NODE]**:

```
docker --version
```

```
docker compose version
```

Both must answer. Umbrel and RaspiBlitz ship Docker. A plain Ubuntu node: `sudo apt install docker.io docker-compose-v2` (Ubuntu 24.04 names). Your user must be in the `docker` group, or prefix every `docker` command with `sudo`.

---

## 2. Start9 (StartOS) — what the box allows today

Read on 2026-10-19 from Start9's own documentation and the LND package's README. Sources are named by URL.

**What StartOS runs.** StartOS 0.4.0 (released July 2026; Start9's announcement on X dated 2026-07-30; the 0.4.0.1 follow-up about two months before this note) replaced its service runtime: *"LXC container runtime — replacing Docker/Podman"* (release notes, github.com/Start9Labs/start-technologies release start-os/v0.4.0). Its docs say plainly: *"StartOS does not use Docker or Podman; standard container tooling will not work"* (docs.start9.com/start-os/0.4.0.x/service-containers.html). The 0.3.5.x line before it ran services under **Podman** (`sudo podman exec -it SERVICE-NAME COMMAND`, docs.start9.com/0.3.5.x/user-manual/container-access). There is no StartOS 0.3.6 in Start9's docs or release list; 0.3.5.1 is the last 0.3.x and the required step before 0.4.0 (docs.start9.com/start-os/0.4.0.x/update-040.html).

**SSH.** Allowed and documented: *System → SSH → Add Key*, then `ssh start9@<server-name>.local`; "The SSH user is `start9`, not `root`." Start9 calls it advanced: "you can cause permanent damage to your server, potentially resulting in loss of data" (docs.start9.com/start-os/0.4.0.x/ssh.html).

**Where LND's files are on the host.** Service volumes live at `/media/startos/data/package-data/volumes/<PACKAGE>/data/<VOLUME>` (service-containers.html). LND's package keeps everything in its `main` volume, mounted at `/root/.lnd` inside the container (github.com/Start9Labs/lnd-startos README), so on the host:

```
/media/startos/data/package-data/volumes/lnd/data/main/tls.cert
/media/startos/data/package-data/volumes/lnd/data/main/data/chain/bitcoin/mainnet/admin.macaroon
```

(the 0.3.x path was `/embassy-data/package-data/volumes/lnd/data/main/...`, Start9 community thread 311, 2023.) The paths are read from documents, not from a live box: confirm with `sudo ls` before using them. Start9's own warning: "Do not modify volume files on the host while the service is running" — the adapter only reads `tls.cert`.

**Reaching LND's REST and gRPC from the host.** Every service sits on one internal bridge, `lxcbr0`, with the OS at `10.0.3.1`; a dependency is reached at `10.0.3.1:<assigned external port>`, and *"that external port is not guaranteed and can only be read at runtime"* (docs.start9.com/packaging/0.4.0.x/service-to-service.html). The `lnd.startos` hostnames of 0.3.x are deprecated. On the host, `start-cli package host binding list` shows LND's bindings (docs.start9.com/start-os/0.4.0.x/cli-reference.html). LND's gRPC is passed through without a TLS rewrap, so a client sees LND's own certificate (lnd-startos README, "gRPC can't pass through a TLS-terminating path"). So a process on the host **can** reach LND's REST and gRPC — at an address and port it must read from `start-cli` first, not `localhost:8080`.

**Running something that is not a package.** Start9 does not document any way to run your own software on the host, and says "StartOS does not use Docker or Podman." Installing Docker over SSH onto the host would be unsupported, and Start9 gives no promise that host changes survive a StartOS update (its FAQ's one example of a host change says: "after a StartOS update, check that it is still present and re-create it if needed"). DP's ruling (2026-10-06) is that the LSP runs **on the Start9 itself**, not on a second box.

**So, plainly:** on a Start9 the clean path is the **StartOS package** (an `.s9pk` that runs the adapter as a service, with LND as a dependency and the Terminus LND as a flavor) — being built separately. This Docker kit is the path for every other Linux node. A Start9 operator can do three things today: (1) add an SSH key and confirm the LND paths and bindings above, so the package work has real values; (2) bake the macaroon (§3) — it is needed either way; (3) set up the direct door's VPS (§7) — it does not depend on how the adapter runs. Everything in §4–§6 waits for the package.

---

## 3. Bake the adapter's macaroon

The adapter never gets your admin macaroon. You bake a key with exactly the 29 permissions in `bake-permissions-nodelegate.json` (the delegate-free recipe — the key DP's second node runs). `bake-permissions.json` is the 37-permission key for a provider that also offers delegated spends (chits) and wants the console's PL and on-chain panes: it adds `AddInvoice`, `GetNodeInfo`, `SendPaymentSync` (which newer LND builds reject — bake without it) and five read-only ones (`ChannelBalance`, `ClosedChannels`, `ForwardingHistory`, `GetTransactions`, `PendingSweeps`); `MACAROON.md` explains each. Start with the 29. The recipe is `lncli bakemacaroon --root_key_id <id> <uri: entries>`. Root key id 4546 means the key can be revoked alone later (`lncli deletemacaroonid 4546`).

First check LND knows every name — **[NODE]** (Umbrel: put `docker exec lightning_lnd_1 ` in front of `lncli`; Start9 0.4: `start-cli package attach lnd -- lncli ...`):

```
lncli listpermissions | grep -cE "GetInfo|AddHoldInvoice|HtlcInterceptor|AbandonChannel|SendPaymentV2"
```

Expect `5` or more. Then bake — one command, long, into a file in your home folder — **[NODE]**:

```
lncli bakemacaroon --save_to ~/lijox-adapter.macaroon --root_key_id 4546 uri:/lnrpc.Lightning/GetInfo uri:/lnrpc.Lightning/SignMessage uri:/lnrpc.Lightning/ListChannels uri:/lnrpc.Lightning/PendingChannels uri:/lnrpc.Lightning/AbandonChannel uri:/lnrpc.Lightning/WalletBalance uri:/lnrpc.Lightning/GetChanInfo uri:/lnrpc.Lightning/QueryRoutes uri:/lnrpc.Lightning/ListPeers uri:/lnrpc.Lightning/ConnectPeer uri:/lnrpc.Lightning/LookupInvoice uri:/lnrpc.Lightning/OpenChannelSync uri:/lnrpc.Lightning/UpdateChannelPolicy uri:/lnrpc.Lightning/SendCustomMessage uri:/lnrpc.Lightning/SubscribeCustomMessages uri:/invoicesrpc.Invoices/AddHoldInvoice uri:/invoicesrpc.Invoices/SettleInvoice uri:/invoicesrpc.Invoices/CancelInvoice uri:/routerrpc.Router/HtlcInterceptor uri:/routerrpc.Router/SendToRouteV2 uri:/chainrpc.ChainNotifier/RegisterBlockEpochNtfn uri:/chainrpc.ChainNotifier/RegisterConfirmationsNtfn uri:/chainrpc.ChainNotifier/RegisterSpendNtfn uri:/walletrpc.WalletKit/PublishTransaction uri:/walletrpc.WalletKit/EstimateFee uri:/lnrpc.Lightning/DecodePayReq uri:/lnrpc.Lightning/ListPayments uri:/lnrpc.Lightning/VerifyMessage uri:/routerrpc.Router/SendPaymentV2
```

Turn it into the hex the `.env` wants — **[NODE]** (`od` is on every box; `xxd` may be missing):

```
od -An -v -tx1 ~/lijox-adapter.macaroon | tr -d ' \n'
```

(The hex ends without a line break; press Enter once to get your prompt back.)

Copy the one long line; it is `LIJ_ADAPTER_MACAROON_HEX` in §4. Then delete the file — **[NODE]**:

```
rm ~/lijox-adapter.macaroon
```

If `bakemacaroon` refuses one name (`invalid permission action`), your LND does not have that RPC; remove that one `uri:` and bake again — the adapter says at boot which rail is missing it.

Without `lncli` (Umbrel without the docker wrapper, or a box where you only have the admin macaroon file): `MACAROON.md` has the REST form — POST the same list to LND's `/v1/macaroon`.

---

## 4. Get the kit, build the image, write the .env

### 4a. The code, at a tag, hash-checked

**[NODE]**:

```
sudo mkdir -p /opt/lijox
```

```
sudo chown $USER /opt/lijox
```

```
git clone https://github.com/dav1dpgit/lijox-lnd-adapter.git /opt/lijox
```

```
git -C /opt/lijox fetch --tags
```

```
git -C /opt/lijox checkout v0.110.0
```

```
sha256sum /opt/lijox/lij-adapter.js /opt/lijox/tatara.js /opt/lijox/tatara-list.js /opt/lijox/tatara-host.js /opt/lijox/tatara-nostr.js /opt/lijox/nip04.js /opt/lijox/config.env.example /opt/lijox/package.json
```

Open `RELEASES.md`, find the row `0.110.0`, and compare every hash. A file the row calls "unchanged" keeps the hash of the last row that named it. One mismatch = stop and ask.

### 4b. Build the image

**[NODE]** (a few minutes; it downloads the Node.js base image and the adapter's dependencies):

```
docker build -f /opt/lijox/ops/docker/Dockerfile -t lijox-adapter:v0.110.0 /opt/lijox
```

The last line is `naming to docker.io/library/lijox-adapter:v0.110.0`. If `npm ci` fails inside the build, send back the last twenty lines; nothing is on your box yet.

### 4c. The state folder

The adapter keeps its state (registries, sealed kits, tapes, the PL ledger, console notes) in one folder on the box, owned by the container's user (uid 1000). **[NODE]**:

```
sudo mkdir -p /opt/lijox-data
```

```
sudo chown 1000:1000 /opt/lijox-data
```

```
sudo chmod 700 /opt/lijox-data
```

### 4d. LND's certificate must be readable

The adapter reads LND's `tls.cert` (a public certificate; nothing secret). The container's user is uid 1000. **[NODE]** — pick the line for your box:

```
sudo chmod 644 ~/.lnd/tls.cert
```

Umbrel:

```
sudo chmod 644 ~/umbrel/app-data/lightning/data/lnd/tls.cert
```

RaspiBlitz:

```
sudo chmod 644 /mnt/hdd/lnd/tls.cert
```

### 4e. The .env

**[NODE]**:

```
cp /opt/lijox/ops/docker/env.example /opt/lijox/ops/docker/.env
```

```
chmod 600 /opt/lijox/ops/docker/.env
```

```
nano /opt/lijox/ops/docker/.env
```

Fill these lines (the file explains each; the rest can stay):

| line | value |
|---|---|
| `LIJOX_DATA_HOST` | `/opt/lijox-data` (the folder from 4c) |
| `LND_TLS_CERT_HOST` | the host path of `tls.cert` from 4d — the one you chmod'ed |
| `ADAPTER_SECRET` | the output of `openssl rand -hex 32` (next box) |
| `NODE_PUBKEY` | `lncli getinfo` → `identity_pubkey` |
| `NODE_HOST` | your onion address `…onion:9735` (from `lncli getinfo` → `uris`), or `<VPS_IP>:9735` after §7 |
| `PUBLIC_HTTPS_URL` | `https://lsp.<yourdomain>` — the name you will create in §6 |
| `PUBLIC_WSS_URL` | `wss://ws.<yourdomain>` — the second name from §6 |
| `WS_ALLOWED_ORIGINS` | `https://lightninginajar.xyz` (as shipped) |
| `LIJ_ADAPTER_MACAROON_HEX` | the hex line from §3 |
| `NODE_NAME` | the name wallets will see |
| `LSPS2_COMMITMENT_TYPE` | `STATIC_REMOTE_KEY` (only with the Terminus LND — §1a) |
| `LIJOX_REGISTRY` | leave the line commented out for now (registry-free); §6c turns it on |
| `PUBLIC_REACH` | `cloudflare` for §6, `direct` for §7 |

**[NODE]**:

```
openssl rand -hex 32
```

`ADAPTER_SECRET` is the route token the registry hands to every wallet. It is public by design and protects nothing — it is not an admin secret (KNOWN-FINDINGS 2026-09-10).

---

## 5. First start, and the receipts

**[NODE]**:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml up -d
```

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml logs -f
```

What a good first start prints, in order (Ctrl-C leaves the log; the adapter keeps running):

1. `[Doctor] LND REST reachable, macaroon accepted, node identity matches (03…).` — the baked key works and `NODE_PUBKEY` is right.
2. `[Doctor] LND gRPC port reachable at localhost:10009.`
3. `[Doctor] all checks passed.`
4. The banner: `LIJOX Adapter v0.110.0`.
5. `[Startup] LND connected: <alias> (N active channels, pubkey 03…)`
6. `[Startup] HtlcInterceptor: subscribed` — the JIT path is live.
7. `[Registry] no registry configured — running registry-free` (until §6c), or `[Registry] Registered: { ok: true … }`.
8. `[Startup] HTTP API listening on port 7000`

If the doctor prints `The adapter found problems it cannot start with:` it says in one sentence what to fix (the certificate path, the macaroon, the ports). The container restarts every few seconds until it is fixed; `docker compose logs` keeps showing the same sentence. Fix `.env` with `nano` (it writes the file in place) or by appending a line, then:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml restart
```

One Docker detail worth knowing: `.env` is mounted into the container as a single file. `nano` and `>>` change that same file, and a restart reads the change. A tool that writes a NEW file under the old name (`sed -i`, some editors' "safe save") leaves the container looking at the old one; after such a tool, re-create instead of restart:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml up -d --force-recreate
```

The two local receipts — **[NODE]**:

```
curl -s http://127.0.0.1:7000/health
```

JSON with `"ok":true`, your `node` pubkey, your `name`, `"synced":true`. And:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml ps
```

`STATUS` reads `Up … (healthy)` after about ninety seconds.

---

## 6. The front door, way one: a Cloudflare tunnel (the default for a first install)

The wallets are browsers. They need two public `https://` / `wss://` names that reach your adapter's ports 7000 and 7001 with a real certificate. The Cloudflare tunnel is the honest default for a first install: no inbound port at home, no certificate to manage, free. Its cost, stated plainly: Cloudflare ends the TLS and sees the plaintext of the wallet API (not the Lightning traffic — the websocket carries Noise-encrypted Lightning transport, and peers reach LND directly). Your registry record will carry the word `cloudflare` and wallets will show it as a badge (§6d). The direct door (§7) is the private alternative; you can run both.

### 6a. Domain and tunnel

In a browser — **[DESK]**:

1. A domain you own (any registrar). Cloudflare dashboard → *Add a site* → your domain → change the nameservers at the registrar to the two Cloudflare names. Wait until Cloudflare says the site is active.
2. *Zero Trust* → *Networks* → *Tunnels* → *Create a tunnel* → *Cloudflared* → name it `lijox`. Pick *Debian/Ubuntu*. The page shows two commands: one installs `cloudflared`, one starts it with your tunnel's token.

Run those two commands as the page shows them — **[NODE]** (they are the page's, not this document's; the token is yours).

3. In the tunnel's *Public Hostnames*, add two:
   - `lsp.<yourdomain>` → service `http://localhost:7000`
   - `ws.<yourdomain>` → service `http://localhost:7001`

   Nothing under *Additional settings* needs changing; websockets are on by default.

### 6b. Prove the door

**[DESK]**:

```
curl -s https://lsp.<yourdomain>/health
```

The same JSON as the local receipt. A `530` or `1033` error page means the tunnel is up but `cloudflared` cannot reach port 7000 — the adapter is not running, or the hostname entry points at the wrong port.

### 6c. Register with the registry

The registry is the list every LiJ wallet reads. `https://lij-worker.dp-a95.workers.dev` is the LiJ registry (any other LIJOX registry works the same way; no line = run registry-free). Now that the door answers, append the line to `.env` — **[NODE]** (a dated copy first, the appended line, the diff, then a restart):

```
cp /opt/lijox/ops/docker/.env /opt/lijox/ops/docker/.env.bak-$(date +%F)
```

```
printf '\n# registry, added %s\nLIJOX_REGISTRY=https://lij-worker.dp-a95.workers.dev\n' "$(date +%F)" >> /opt/lijox/ops/docker/.env
```

```
diff /opt/lijox/ops/docker/.env.bak-$(date +%F) /opt/lijox/ops/docker/.env
```

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml restart
```

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml logs --tail=60 | grep -E "Registry|Doctor|Adapter v"
```

The receipts in the log:

- `[Registry] Registering with https://lij-worker.dp-a95.workers.dev`
- `[Registry] route 1 cloudflare: https://lsp.<yourdomain> — HTTP 200 through Cloudflare (cf-ray)` — the adapter checked its own front door
- `[Registry] Registered: { ok: true, … }`

The record is signed by your node key (LND `signmessage` over the whole record); the registry refuses an unsigned or altered one. The adapter re-registers every `LIJOX_REGISTER_EVERY_HOURS` (6); the registry marks a record stale after 24 hours without one.

### 6d. See yourself listed

**[DESK]**:

```
curl -s https://lij-worker.dp-a95.workers.dev/lsps | python3 -m json.tool | grep -B4 -A24 "<your NODE_NAME>"
```

Your record shows `endpoint`, `wss_url`, `pubkey`, the fees and limits, and (0.108.0) a `routes` list — each door with its `reach`. Then the real test: in a LiJ wallet, *Connections → Switch LSP* → pick your name → receive a small payment. The JIT open lands from your node; the adapter's log shows `[LSPS2] opening …-sat channel to 03…`.

### 6e. The direct door and the wallet's "Reach my provider" dial — what is live and what is coming

Since adapter 0.108.0 the provider side is built: the registry record carries a `routes` list, every door with its `reach` — `cloudflare` or `direct` — from `PUBLIC_REACH` for door 1 and `ROUTE_2_*` for a second door (`lijox-register:v4`, registry 0.13.0+). The adapter keeps the word honest without you: a door that claims `direct` but answers with Cloudflare's own header is registered as `cloudflare` and the journal says so. On the wallet side this is **upcoming, not live**: the LiJ wallet will read `routes`, show the reach as a badge beside your name, and gain a "Reach my provider" dial on which a user can refuse Cloudflare — the wallet then takes your `direct` door only, or none. Until that wallet release, wallets read the first door (your `PUBLIC_HTTPS_URL` / `PUBLIC_WSS_URL`) as they always have, whatever its reach. Register both doors (§7g) and nothing changes for today's wallets; tomorrow's choose.

---

## 7. The front door, way two: the direct door (the VPS relay kit)

The private door. A small rented server with a fixed address passes two TCP ports down a WireGuard tunnel to your node as raw bytes — port 443 (the wallet API and websocket) and port 9735 (Lightning peers). **TLS ends on your node**, in Caddy, with Let's Encrypt certificates the node gets itself through the relay. The rented server sees the names clients ask for (TLS SNI), client addresses and byte counts — never the content. The kit is `ops/relay/`; its README is the long form. DP's own relay runs this way (Hetzner, 2026-10-19). What follows is the kit's eight steps, one command per box.

### 7a. Rent the server

**[DESK]**, in a browser: any provider with a fixed IPv4. Hetzner Cloud is the one DP uses: hetzner.com → *Cloud* → sign up → *New project* → *Add server* → a location near you → image *Ubuntu 24.04* (or the newest Ubuntu offered) → the smallest type (CX22 / CPX11, about €4 a month) → *SSH key*: paste your public key. Its firewall (the provider's): inbound 22/tcp, 443/tcp, 9735/tcp, 51820/udp, ICMP. Note the address: `<VPS_IP>`.

Your SSH public key, if you have one — **[DESK]**:

```
cat ~/.ssh/id_ed25519.pub
```

If not, make one first — **[DESK]**:

```
ssh-keygen -t ed25519
```

### 7b. DNS: three names, NOT proxied

**[DESK]**, at your DNS (at Cloudflare DNS: the **grey** cloud, "DNS only" — an orange, proxied record would put Cloudflare's edge back in the middle): three A records to `<VPS_IP>`:

- `direct-lsp.<yourdomain>`
- `direct-ws.<yourdomain>`
- `direct-filters.<yourdomain>` (only if you run the filter server; harmless otherwise)

New names beside the Cloudflare ones, so you test before you switch anything.

### 7c. The node's WireGuard key

**[NODE]**:

```
sudo apt install -y wireguard
```

```
wg genkey | sudo install -m 600 /dev/stdin /etc/wireguard/node.key
```

```
sudo wg pubkey < /etc/wireguard/node.key | sudo tee /etc/wireguard/node.pub
```

The line printed is the node's **public** key: `<NODE_PUBLIC_KEY>`. The private key stays in `/etc/wireguard/node.key` (mode 600); you never paste it anywhere but the next step's file.

### 7d. The rented server

Copy the relay kit there — **[NODE]**:

```
scp -r /opt/lijox/ops/relay root@<VPS_IP>:/root/relay
```

Log in — **[DESK]** or **[NODE]**:

```
ssh root@<VPS_IP>
```

Run the kit's script once — **[VPS]**:

```
bash /root/relay/vps-setup.sh <NODE_PUBLIC_KEY>
```

It installs WireGuard and HAProxy, makes the server's key pair, writes `/etc/wireguard/wg0.conf` (a dated `.bak` of any existing one), installs `haproxy.cfg` (a dated `.bak` of the distribution's), starts both, and prints `VPS public key: <VPS_PUBLIC_KEY>`. Copy that key.

### 7e. The node's tunnel

Write `/etc/wireguard/wg0.conf` from the template, in three steps — **[NODE]**. First copy the template (if a `wg0.conf` already exists on your box, stop: copy it to `wg0.conf.bak-$(date +%F)` before this):

```
sudo cp /opt/lijox/ops/relay/wg0-node.conf /etc/wireguard/wg0.conf
```

```
sudo chmod 600 /etc/wireguard/wg0.conf
```

Then put the node's private key in (the command reads it from the key file; you type nothing):

```
sudo sed -i "s|<NODE_PRIVATE_KEY>|$(sudo cat /etc/wireguard/node.key)|" /etc/wireguard/wg0.conf
```

Then the two values from the server, by hand:

```
sudo nano /etc/wireguard/wg0.conf
```

Replace `<VPS_PUBLIC_KEY>` with the key the script printed and `<VPS_IP>` with the server's address; Ctrl-O, Enter, Ctrl-X. Check — every `<...>` must be gone:

```
sudo grep -c "<" /etc/wireguard/wg0.conf
```

Expect `0`.

```
sudo systemctl enable --now wg-quick@wg0
```

```
ping -c 2 10.9.0.1
```

Two replies = the tunnel is up (`10.9.0.1` is the server, `10.9.0.2` is your node, inside the tunnel).

### 7f. Caddy on the node

Install Caddy from its own apt repository — the four commands at caddyserver.com/docs/install (Debian/Ubuntu) — **[NODE]**. Then write the Caddyfile from the template with your three names. Back up the distribution's file first:

```
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
```

```
sed -e "s|<LSP_HOST>|direct-lsp.<yourdomain>|" -e "s|<WS_HOST>|direct-ws.<yourdomain>|" -e "s|<FILTERS_HOST>|direct-filters.<yourdomain>|" /opt/lijox/ops/relay/Caddyfile.node | sudo tee /etc/caddy/Caddyfile > /dev/null
```

```
sudo caddy validate --config /etc/caddy/Caddyfile
```

```
sudo systemctl restart caddy
```

Within a minute Caddy holds certificates for the three names (the TLS-ALPN challenge arrives through the relay like any client). From anywhere — **[DESK]**:

```
curl -sS https://direct-lsp.<yourdomain>/health
```

The same JSON. Caddy listens on the tunnel address `10.9.0.2` only — nothing on your home network can reach those ports.

### 7g. Tell the adapter

Caddy writes each client's real address into `x-forwarded-for`, so the adapter must be told to trust it (never behind Cloudflare alone). And the record should carry both doors. Append to `.env` — **[NODE]** (a dated copy first, then the appended lines, then the diff):

```
cp /opt/lijox/ops/docker/.env /opt/lijox/ops/docker/.env.bak-$(date +%F)
```

```
printf '\n# direct door (ops/relay), added %s\nTRUST_FORWARDED_FOR=true\nROUTE_2_REACH=direct\nROUTE_2_HTTPS_URL=https://direct-lsp.<yourdomain>\nROUTE_2_WSS_URL=wss://direct-ws.<yourdomain>\n' "$(date +%F)" >> /opt/lijox/ops/docker/.env
```

```
diff /opt/lijox/ops/docker/.env.bak-$(date +%F) /opt/lijox/ops/docker/.env
```

The diff shows only the appended lines. (A later line in `.env` wins over an earlier one, so appending is how you change a value here too.) Restart:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml restart
```

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml logs --tail=60 | grep Registry
```

Receipt: `[Registry] route 2 direct: https://direct-lsp.<yourdomain> — HTTP 200 without Cloudflare's header`, then `Registered: { ok: true … }`. Your record now lists two doors. When you want the direct door **first** (what today's wallets read), swap: make the direct names `PUBLIC_HTTPS_URL` / `PUBLIC_WSS_URL` with `PUBLIC_REACH=direct`, and the Cloudflare names `ROUTE_2_*` with `ROUTE_2_REACH=cloudflare` — appended lines again, restart again. DP's ruling 2026-10-19: providers who keep Cloudflare as set up today may, unchanged; the badge tells the user.

### 7h. Lightning over the relay

LND must advertise the relay's address and listen on every interface (the tunnel's included). Append to `lnd.conf` — **[NODE]** (a dated copy, the appended lines, the diff; the path is `~/.lnd/lnd.conf` on a plain node — Umbrel and RaspiBlitz keep theirs elsewhere, §1b; keep the Tor lines, both addresses are advertised):

```
cp ~/.lnd/lnd.conf ~/.lnd/lnd.conf.bak-$(date +%F)
```

```
printf '\n# clearnet through the relay (ops/relay), added %s\nexternalip=<VPS_IP>:9735\nlisten=0.0.0.0:9735\n' "$(date +%F)" >> ~/.lnd/lnd.conf
```

```
diff ~/.lnd/lnd.conf.bak-$(date +%F) ~/.lnd/lnd.conf
```

If the file already had a `listen=` line, LND takes both; if it already had an `externalip=`, both are advertised. Restart LND the way your box does (`sudo systemctl restart lnd` on a plain node). From anywhere — **[DESK]**:

```
nc -vz <VPS_IP> 9735
```

`succeeded` = peers can reach your node over clearnet. To put the clearnet address first in your record, append `NODE_HOST=<VPS_IP>:9735` to the adapter's `.env` the same way (§7g) and restart the adapter.

---

## 8. The operator console

The adapter's own monitor, on port 7004, bound to the box's loopback (and a Tailscale interface if the box has one) — never the tunnel. Login is a six-digit TOTP code. Make the secret — **[NODE]**:

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml run --rm --no-deps lijox-adapter node /app/lij-adapter.js --totp-enroll
```

It prints a `CONSOLE_TOTP_SECRET=…` line and a setup key for your authenticator app (FreeOTP, Aegis: "enter a setup key", SHA1, 6 digits, 30 s). Append the line to `.env` (dated copy, append, diff — as in §7g), restart, then from your desk:

```
ssh -L 7004:127.0.0.1:7004 <user>@<node-lan-address>
```

and open `http://127.0.0.1:7004/console` in a browser. Panes: Guardrails (fees, the JIT guard, the lease), Front doors (0.108.0 — each route and its reach as registered), Node, Channels, Wallets served, Registry, PL, Settings (read-only).

---

## 9. Things that differ under Docker

- **The lease and recover-close shell out to `lncli`** (`LEASE_LNCLI`), and there is no `lncli` inside the image. The lease is off by default (`LEASE_ENABLE=false`) — leave it off on a Docker install for now. `recover-close` (a wallet back with only its words asks you to force-close its channels) also needs it; on a Docker install that route answers `close_failed` until a way to reach `lncli` is settled. On an Umbrel the systemd install used `LEASE_LNCLI=docker exec lightning_lnd_1 lncli`; from inside a container that needs the Docker socket mounted, which is a large permission — not in this kit. Open item; ask before enabling.
- **No systemd watchdog.** The unit's `WatchdogSec=90` restarts a stalled adapter on a systemd install. Under Docker the `HEALTHCHECK` marks the container unhealthy but Docker does not restart on that by itself; `ops/docker/README.md` names `autoheal` if you want it.
- **Logs** are Docker's (`docker compose logs`), capped at 10 × 20 MB, not journald.
- **Tatara's lnd.conf reader** (`TATARA_LND_CONF`) needs the file mounted into the container; not needed unless Mix pools are on.

---

## 10. Updating

**[NODE]**:

```
git -C /opt/lijox fetch --tags
```

```
git -C /opt/lijox checkout v<NEW>
```

```
sha256sum /opt/lijox/<each file the new RELEASES.md row names>
```

Compare with the row. Then build the new image and point compose at it (a dated copy of the compose file first):

```
docker build -f /opt/lijox/ops/docker/Dockerfile -t lijox-adapter:v<NEW> /opt/lijox
```

```
cp /opt/lijox/ops/docker/docker-compose.yml /opt/lijox/ops/docker/docker-compose.yml.bak-$(date +%F)
```

```
sed -i "s|image: lijox-adapter:v0.110.0|image: lijox-adapter:v<NEW>|" /opt/lijox/ops/docker/docker-compose.yml
```

```
diff /opt/lijox/ops/docker/docker-compose.yml.bak-$(date +%F) /opt/lijox/ops/docker/docker-compose.yml
```

```
docker compose -f /opt/lijox/ops/docker/docker-compose.yml up -d
```

Compose re-creates the container; `/opt/lijox-data` and `.env` are untouched. The banner in `docker compose logs` must show the new version. Never run from `main`. The old image can go: `docker image rm lijox-adapter:v<OLD>`.

---

## 11. What the provider sees and keeps

**What you see.** Every wallet on your node by its node pubkey; its channels and their balances (your side and the wallet's); the payment hashes you hold for it while a payment is in flight, and the forwards you make; the IP addresses wallets connect from — logged only if you set `LOG_CLIENT_IP=on` (off by default); the sealed Black start kits wallets leave with you (ciphertext you cannot read); with NWC on, the encrypted zap requests you hold for sleeping wallets (you cannot read them). Never a preimage before the wallet releases it, never a wallet's key, never its seed.

**What you keep, and where.** Everything is in `/opt/lijox-data` (the `/data` mount): the LNURL-pay name registry (`lnurlp-registry.json`), web-push subscriptions, the kits (`kits/`), the push-key locks, the NWC registry and held events (`nwc/`), the lease state and log, the PL ledger (`pl-events.ndjson`, `pl-daily.json`), the JIT counters and guard, the phones' uploaded tapes (`tapes/`), your console notes. It is per instance, never in git, and worth a nightly copy. Your `.env` is the other file to keep (mode 600; it holds the macaroon hex and the console secret). LND's own `channel.backup` is what saves channel funds if the box dies — copy it off the box on every change; the registry offers an off-site slot for it (`PUT /lsp-backup`, encrypted by LND under your seed).

**What wallets learn about you.** Everything in your registry record: your name, node pubkey, the three addresses of each door and its reach, fees, channel limits, which modules you offer (kits, push, NWC, filter server, Mix pools). And, when they use your chain bridge, your node's view of the chain.

**What the registry learns.** Your signed record and when you last re-registered. Nothing about your wallets.

**What Cloudflare learns (door one).** The plaintext of the wallet API calls that pass through the tunnel, and client addresses. Not the Lightning traffic.

**What the rented server learns (door two).** The TLS names asked for, client addresses, byte counts, that a Lightning node is behind it. Not the content.

**What is yours to set.** `FEE_PPM`, the open-fee knobs, the channel sizes, the on-chain reserve, which modules are on, which doors are registered. LIJOX has no membership and asks no permission; wallets choose by fees and behaviour.

---

## Sources read for §2 (2026-10-19)

- StartOS 0.4.0 release: github.com/Start9Labs/start-technologies, release `start-os/v0.4.0` ("LXC container runtime — replacing Docker/Podman"); the 0.4.0.1 follow-up; Start9's announcement on X, 2026-07-30; linuxstory.org/startos-0-4-0-released/ (2026-07-27).
- docs.start9.com/start-os/0.4.0.x/service-containers.html — "StartOS does not use Docker or Podman; standard container tooling will not work"; `start-cli package attach`; `lxc-attach`; `/media/startos/data/package-data/volumes/<PACKAGE>/data/<VOLUME>`.
- docs.start9.com/start-os/0.4.0.x/ssh.html — System → SSH → Add Key; user `start9`.
- docs.start9.com/start-os/0.4.0.x/cli-reference.html — `start-cli package host binding list`, `package stats`, `package attach`.
- docs.start9.com/start-os/0.4.0.x/architecture.html — "Every service on StartOS runs inside its own isolated LXC container"; `startd` / `start-cli` on the host.
- docs.start9.com/packaging/0.4.0.x/service-to-service.html — one bridge `lxcbr0`, the OS at `10.0.3.1`, "that external port is not guaranteed and can only be read at runtime", `<package-id>.startos` deprecated.
- docs.start9.com/start-os/0.4.0.x/update-040.html — 0.3.5.1 is the step before 0.4.0; no 0.3.6.
- docs.start9.com/start-os/0.4.0.x/faq.html — a host change: "after a StartOS update, check that it is still present and re-create it if needed".
- docs.start9.com/0.3.5.x/user-manual/container-access — 0.3.5.x: `sudo podman exec -it SERVICE-NAME COMMAND`.
- github.com/Start9Labs/lnd-startos README — the `main` volume at `/root/.lnd`; REST 8080 / gRPC 10009 / peer 9735; gRPC not TLS-rewrapped.
- community.start9.com thread 311 (2023) — the 0.3.x host path `/embassy-data/package-data/volumes/lnd/data/main/public/admin.macaroon`.
- community.start9.com thread 5281 (2026-06-23) — a dependent package on 0.4.0-beta.9 reading `/mnt/lnd/tls.cert` and `/mnt/lnd/data/chain/bitcoin/mainnet/admin.macaroon`; LND package 0.20.1-beta.
- community.start9.com thread 4062 (2025-09-12) — 0.4.0-alpha.10 "has replaced Podman"; "native linux containers … via start-cli".
- docs.lightning.engineering lnd.conf reference — `protocol.zero-conf`, `protocol.option-scid-alias`, `maxpendingchannels` (default 1), `restlisten`, `rpclisten`.
