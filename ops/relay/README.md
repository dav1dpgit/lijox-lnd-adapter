# Clearnet inbound through a rented relay — the kit

**Optional.** Tor-only is enough to operate a LIJOX LSP. This kit is for an operator whose node sits on a home
connection (no fixed public address, or inbound ports blocked) and who wants to be reachable over clearnet
**without a third party in the middle of the traffic** — not Cloudflare's proxy, not a hosted tunnel that ends
TLS for you.

The shape: a small rented server with a public address (a VPS) and a WireGuard tunnel from it to the node. On the
server, HAProxy passes two TCP ports down the tunnel as raw bytes: **443** (the LSP's HTTPS/WSS front door — the
API, the wallet websocket, the block-filter and silent-payment index server) and **9735** (Lightning peers). **TLS
ends on the node**, in Caddy, with certificates the node gets itself from Let's Encrypt through the same relay. The
PROXY protocol between HAProxy and Caddy carries each client's real address, so the adapter's per-IP limits keep
working.

What the rented server can see: the names clients ask for (the TLS SNI), client addresses, byte counts and timing,
and that a Lightning node is behind it. Not the content: the HTTPS is ciphertext to it, and Lightning peers carry
their own encryption. It keeps no logs of connections (errors only). What it costs if it dies: inbound clearnet
until you replace it; existing channels are untouched (peers reconnect over Tor or when the relay returns).

Wallets never need clearnet to reach an LSP that only serves Tor; what this kit changes is who else can reach you
and through whom.

## Files

- `vps-setup.sh` — run once on the rented server as root. Installs WireGuard and HAProxy, makes the server's key
  pair, writes `/etc/wireguard/wg0.conf` from `wg0-vps.conf`, installs `haproxy.cfg`, starts both. Prints the
  server's public key for step 4.
- `wg0-vps.conf` — the rented server's tunnel (template). No NAT, no forwarding: HAProxy connects to the node
  itself, over the tunnel.
- `haproxy.cfg` — the two blind relays. `:443 → 10.9.0.2:443` with PROXY protocol v2; `:9735 → 10.9.0.2:9735`
  plain. A commented block shows how to put several nodes behind one server, routed by the TLS name.
- `wg0-node.conf` — the home node's tunnel (template). Keeps the tunnel up from behind NAT.
- `Caddyfile.node` — Caddy on the home node: three names (`<LSP_HOST>`, `<WS_HOST>`, `<FILTERS_HOST>`) to the
  adapter's 7000, the websocket's 7001 and the filter server's 7002; listens on the tunnel address only; reads the
  PROXY protocol from the relay only; strips `cf-connecting-ip` from what clients send.

Everything in these files is an example; replace every value in angle brackets.

## Steps

1. Rent a server with a fixed IPv4 (Ubuntu 24.04 or newer; the smallest size is enough). Put your SSH public key
   on it at creation. Its firewall (the provider's, if it has one): inbound 22/tcp from where you work, 443/tcp,
   9735/tcp, 51820/udp, and ICMP. Note its address: `<VPS_IP>`.
2. DNS: three names of your choosing (the LSP API, the websocket, the filter server — say `lsp.`, `ws.`,
   `filters.` under your domain) as plain A records to `<VPS_IP>` — **not proxied** (at
   Cloudflare DNS that is the grey cloud; a proxied record would put their edge back in the middle). New names
   beside the old ones let you test before any cut-over.
3. On the **home node**, make its key pair and note the public key:
   ```
   sudo apt install -y wireguard
   ```
   ```
   umask 077; wg genkey | sudo tee /etc/wireguard/node.key | wg pubkey | sudo tee /etc/wireguard/node.pub
   ```
4. On the **rented server** (`ssh root@<VPS_IP>`), copy this folder there and run the script with the node's
   public key:
   ```
   bash vps-setup.sh <NODE_PUBLIC_KEY>
   ```
   It prints `VPS public key: <VPS_PUBLIC_KEY>`.
5. On the **home node**, write `/etc/wireguard/wg0.conf` from `wg0-node.conf` (fill `<NODE_PRIVATE_KEY>` from
   `/etc/wireguard/node.key`, `<VPS_PUBLIC_KEY>`, `<VPS_IP>`), then:
   ```
   sudo systemctl enable --now wg-quick@wg0
   ```
   ```
   ping -c 2 10.9.0.1
   ```
6. On the **home node**, install Caddy (the apt repository at caddyserver.com/docs/install), write
   `/etc/caddy/Caddyfile` from `Caddyfile.node` with your three names, `caddy validate`, restart. Within a minute Caddy
   holds certificates for the three names (the ACME TLS-ALPN challenge arrives through the relay like any other
   client). Check from anywhere:
   ```
   curl -sS https://<LSP_HOST>/health
   ```
7. The adapter: `TRUST_FORWARDED_FOR=true` in its config (Caddy writes the real client address into
   `x-forwarded-for`; the relay's own address is never what the adapter sees), restart it. Then switch the
   advertised URLs to the new names when you are ready (the registry record follows the adapter's config); the
   Cloudflare names can stay up beside them as long as you like, or go.
8. Lightning: in `lnd.conf`, `externalip=<VPS_IP>:9735` (keep the Tor lines; both addresses are advertised) and a
   `listen=` that includes the tunnel address (`listen=0.0.0.0:9735` or `listen=10.9.0.2:9735`). Restart LND.
   `nc -vz <VPS_IP> 9735` connects from anywhere; `lncli getinfo` shows both URIs. For the registry record to lead
   with clearnet, `NODE_HOST=<VPS_IP>:9735` in the adapter's config.

## Addresses used inside the tunnel

`10.9.0.1` = the rented server, `10.9.0.2` = the home node. Change every file together if that range is already in
use on your network. A second node is `10.9.0.3` with its own `[Peer]` on the server, its own names in HAProxy's
SNI routing, and a second Lightning port.

## Why not just port-forward 9735 with NAT?

The earlier form of this kit did (it is still in `wg0-vps.conf` as a comment): fine for Lightning alone, but NAT
hides the client's address from the node, and it cannot carry the HTTPS front door without the server either
ending TLS (the thing this kit avoids) or passing bytes blind — which is what HAProxy does here, for both ports,
with the client's address preserved.
