# From zero to a listed LIJOX LSP

This is the standalone recipe: an LND node you already run becomes a Lightning service provider that any LiJ-class wallet can pick from the registry. Nothing here needs permission from anyone. Budget: an afternoon if the node and a domain exist; add an hour for the optional clearnet relay.

What you end up with:

- the adapter running beside LND under systemd, restarted by its own watchdog;
- an HTTPS front door for the wallet API and a WSS front door for the browser peer proxy, both at your domain;
- your node reachable for Lightning peers over Tor (and, if you take the relay option, over clearnet through a small VPS);
- your record in the LIJOX registry, signed by your node key, which every wallet reads.

## 0. What you need before starting

- **LND** (a current release; `MACAROON.md` tells you to check the permission URIs against your version) with REST and gRPC enabled, on a machine you control (bare metal, a mini PC, an Umbrel/Start9 box — the adapter runs on the same host). `bitcoind` behind it, fully synced.
- **Liquidity**: on-chain sats for JIT channel opens (the adapter refuses to open below `JIT_MIN_ONCHAIN_RESERVE_SATS`, default 2,000,000) and an outbound channel or two to the wider network so your wallets' payments route.
- **A domain** (any registrar; ~$10/year) — the adapter's public URLs are `https://…` and `wss://…` at names you own.
- **A Cloudflare account** (free tier) for the tunnel that gives you those URLs without opening a port at home. Alternatives exist (a reverse proxy on a VPS, Caddy with a public IP); this guide uses the tunnel because it needs no inbound port and no certificate handling.
- **Node.js 20+** on the LND host.
- Optional: **a VPS** ($4–6/month) if you want peers to open channels to you over clearnet. See §6.

## 1. Bake the least-privilege macaroon

The adapter never sees your admin macaroon. Follow `MACAROON.md` exactly — it lists the permissions the adapter needs and nothing more — and keep the resulting hex for step 3. If you later enable the delegate rail, `bake-permissions.json` (with delegate) or `bake-permissions-nodelegate.json` (without) is the file `lncli bakemacaroon` reads.

## 2. Install

```
sudo mkdir -p /opt/lijox && sudo chown $USER /opt/lijox
cd /opt/lijox
git clone https://github.com/dav1dpgit/lijox-lnd-adapter.git .
git checkout v0.70.1                      # always a tag; compare the file hash with RELEASES.md
sha256sum lij-adapter.js                  # must match the row for the tag
npm ci --omit=dev
cp config.env.example config.env
chmod 600 config.env
```

## 3. Configure

Edit `config.env`. The required lines:

| key | what it is |
|---|---|
| `ADAPTER_SECRET` | `openssl rand -hex 32`. Admin and route auth; the registry hands wallets a *route* token, never this. |
| `NODE_PUBKEY` | `lncli getinfo` → `identity_pubkey`. |
| `NODE_HOST` | how peers reach your node: `<onion>:9735` (Tor, §5) or `<vps-ip>:9735` (relay, §6). |
| `PUBLIC_HTTPS_URL` | `https://lsp.yourdomain.tld` — the tunnel hostname for the API (step 4). |
| `PUBLIC_WSS_URL` | `wss://lsp-ws.yourdomain.tld` — the tunnel hostname for the browser peer proxy. |
| `WS_ALLOWED_ORIGINS` | the wallet origins allowed to connect: `https://lightninginajar.xyz` (add your own if you host the wallet). |
| `LIJ_ADAPTER_MACAROON_HEX` | from step 1. |
| `LIJOX_REGISTRY` | `https://lij-worker.dp-a95.workers.dev` — or any registry you prefer; empty runs registry-free. |
| `NODE_NAME` | the name wallets see. |

Everything else has a working default. The ones operators change first: `FEE_PPM` (advertised routing fee), `CHANNEL_SIZE_SATS` / `MIN_CHANNEL_SATS` / `MAX_CHANNEL_SATS` (JIT channel sizes), `CHANNEL_OPEN_FEE_MIN_SATS` / `CHANNEL_OPEN_FEE_PPM` (what an open costs the wallet), `LEASE_ENABLE=true` once you've read the lease section in `README.md` (a silent wallet's channel is force-closed after `LEASE_DAYS`, its balance paid to the wallet's own address). Leave `CHAIN_BRIDGE_ENABLED=true`: wallets use your node as one of their chain-data sources.

Then start it once in the foreground to read the boot lines (`node lij-adapter.js`, Ctrl-C to stop): the loaded config, LND's identity, the JIT policy in effect, and the registry result if `LIJOX_REGISTRY` is set. Fix anything it complains about before step 4.

## 4. The front doors (Cloudflare tunnel)

1. Cloudflare dashboard → *Add a site* → your domain; change the nameservers at your registrar to the two Cloudflare gives you (propagation minutes to hours).
2. *Zero Trust* → *Networks* → *Tunnels* → *Create a tunnel* → name it `lijox` → pick *Debian/Ubuntu* and run the two commands it shows on the LND host (installs `cloudflared` and its systemd service with the tunnel token).
3. In the tunnel's *Public Hostnames* add two entries:
   - `lsp.yourdomain.tld` → `http://localhost:7000` (the adapter API; `ADAPTER_PORT`)
   - `lsp-ws.yourdomain.tld` → `http://localhost:7001` (the WS proxy; `WS_PROXY_PORT`). Under *Additional settings → TLS* nothing special is needed; WebSockets are on by default.
4. `curl -s https://lsp.yourdomain.tld/health` once the adapter runs (step 7) must answer.

Cloudflare sees the plaintext of the wallet API (it terminates TLS). Lightning traffic is not on this path: peers talk to LND directly (§5/§6), and the browser peer proxy carries the Noise-encrypted Lightning transport, which Cloudflare cannot read.

## 5. Lightning inbound over Tor (the default)

In `lnd.conf`:

```
[Application Options]
listen=0.0.0.0:9735
[tor]
tor.active=true
tor.v3=true
tor.streamisolation=true
```

with `tor` installed and its control port enabled (`ControlPort 9051`, `CookieAuthentication 1` in `torrc`). Restart LND; `lncli getinfo` shows a `…onion:9735` URI. That is `NODE_HOST`. Peers and other LSPs can open channels to it; wallets never need it (they reach you through the WSS proxy).

## 6. Optional: clearnet inbound through a VPS relay (the relay decision)

Tor-only is enough to operate. Clearnet reachability helps in one place: other nodes deciding whether to open channels *to* you, and wallets' JIT opens confirming faster when your peers connect without Tor latency. The decision taken for LiJ's own nodes: the relay is **infrastructure, not adapter code** — two WireGuard configs and two firewall lines. The adapter only advertises the resulting address. Do this if you want it; skip it if you don't.

**a. Get the VPS.** Any provider with a fixed IPv4. Example, Hetzner: hetzner.com → *Cloud* → sign up (e-mail, card; identity check is sometimes asked for) → *New project* → *Add server* → location near you → image *Ubuntu 24.04* → type CX22 (2 vCPU, 4 GB; ~€4/month) → *SSH key*: paste your public key (`cat ~/.ssh/id_ed25519.pub` on the LND host; `ssh-keygen -t ed25519` if you have none) → *Create*. Note the IPv4.

**b. On the VPS** (`ssh root@<vps-ip>`):

```
apt update && apt install -y wireguard
umask 077; wg genkey | tee /etc/wireguard/vps.key | wg pubkey > /etc/wireguard/vps.pub
cat /etc/wireguard/vps.pub        # → VPS_PUB
```

`/etc/wireguard/wg0.conf`:

```
[Interface]
Address = 10.9.0.1/24
ListenPort = 51820
PrivateKey = <contents of vps.key>
# forward Lightning's port to the home node over the tunnel, and let replies return
PostUp   = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A PREROUTING -i eth0 -p tcp --dport 9735 -j DNAT --to-destination 10.9.0.2:9735; iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE
PostDown = iptables -t nat -D PREROUTING -i eth0 -p tcp --dport 9735 -j DNAT --to-destination 10.9.0.2:9735; iptables -t nat -D POSTROUTING -o wg0 -j MASQUERADE

[Peer]
PublicKey = <HOME_PUB, from step c>
AllowedIPs = 10.9.0.2/32
```

(`eth0` is the public interface on Hetzner; check with `ip -br a` and adjust.)

**c. On the LND host:**

```
sudo apt install -y wireguard
umask 077; wg genkey | sudo tee /etc/wireguard/home.key | wg pubkey | sudo tee /etc/wireguard/home.pub
cat /etc/wireguard/home.pub       # → HOME_PUB, paste into the VPS [Peer]
```

`/etc/wireguard/wg0.conf`:

```
[Interface]
Address = 10.9.0.2/24
PrivateKey = <contents of home.key>

[Peer]
PublicKey = <VPS_PUB>
Endpoint = <vps-ip>:51820
AllowedIPs = 10.9.0.1/32
PersistentKeepalive = 25
```

Bring both up: `systemctl enable --now wg-quick@wg0` on each. Check from the LND host: `ping 10.9.0.1`.

**d. LND advertises the relay.** In `lnd.conf` add `externalip=<vps-ip>:9735` (keep the Tor lines — both addresses are advertised). Restart LND. From anywhere: `nc -vz <vps-ip> 9735` connects. `NODE_HOST=<vps-ip>:9735` in `config.env` if you want the registry record to show clearnet first.

What the VPS can see: that a Lightning node is behind it, and the encrypted Noise stream — no keys, no channel data, no plaintext. What it costs if it dies: inbound clearnet connections until you replace it; existing channels are unaffected (peers reconnect over Tor or when the relay returns).

## 7. Run it

`lijox-adapter.service` is the systemd unit (edit `User=`, `WorkingDirectory=/opt/lijox` and `EnvironmentFile=/opt/lijox/config.env`; the unit's `WatchdogSec=90` is the petting interval the adapter honours):

```
sudo cp lijox-adapter.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lijox-adapter
journalctl -u lijox-adapter -f
```

The boot lines are the same as the foreground run; systemd restarts the adapter if it stops petting the watchdog.

## 8. Verify you are listed

```
curl -s https://lij-worker.dp-a95.workers.dev/lsps | python3 -m json.tool | grep -A12 "<your NODE_NAME>"
```

Your record shows `endpoint`, `wss_url`, fees and limits. Registration happens once at boot; change a field → restart the adapter → the record updates. The registry keeps records until removed; there is no liveness check yet (a signed unregister route and a re-registration cadence are on the list).

Then the real test: in a LiJ wallet, Connections → Switch LSP → pick yourself → receive a small payment. The JIT open lands from your node; the tape on your box shows the whole exchange.

## 9. Operating it

- **Updates**: `git fetch --tags && git checkout vX.Y.Z`, compare `sha256sum lij-adapter.js` with `RELEASES.md`, `systemctl restart lijox-adapter`. Never run from `main`.
- **Backups**: LND's `channel.backup` is what saves your channel funds if the box dies. Copy it off the box on every change (LND rewrites the file; `inotifywait` or a timer plus `scp`/`rclone` is enough). The registry also offers an off-site slot for it — `PUT /lsp-backup`, `lijox-scb:v1`, the file is encrypted by LND under your seed and the request is signed by your node key; the push script for that slot is a few lines and LiJ's own is not yet in this repository (on the list). The adapter shows the state of both legs on its dashboard when the status files exist. The adapter's `DATA_DIR` (registry names, delegate, lease state) is worth a nightly copy too.
- **What wallets learn about you**: everything in your registry record, plus your node's chain view when they use your bridge. What you learn about wallets: their node pubkeys, their channel balances, the hashes you hold for them — never a preimage, never a key.
- **Fees and policy are yours**: `FEE_PPM`, the open-fee knobs and the JIT ladder are the only governors the standard expects. LIJOX has no membership; wallets choose by fees and behaviour.

## Where the standard's LSP-side obligations are

`/lsps/registry/recover-close` (a wallet back with only its words asks you to force-close its channels — all or nothing while any HTLC is in flight), the LNURL-pay rail at your host (`/.well-known/lnurlp/<name>`), the SCB push, the lease. All in `lij-adapter.js`, each with its version note. The obligations still being decided — holding wallets' sealed state blobs, the reciprocal watchtower, the silent-payment tweak index — are in the LIJOX repository's docs as they are ruled.
