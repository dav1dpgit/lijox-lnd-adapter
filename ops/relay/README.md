# Clearnet inbound through a WireGuard relay — the kit

**Optional.** Tor-only is enough to operate a LIJOX LSP; wallets never need clearnet, they reach the LSP through its HTTPS/WSS front door. This kit is for operators who also want *other Lightning nodes* to reach them over clearnet.

For a node that can only be reached over Tor (home connection, no fixed public
address, or a provider that blocks inbound ports), this kit makes the node reachable
over clearnet for Lightning peers by renting a small server with a public address and
forwarding its port 9735 through an encrypted tunnel to the node.

It is plumbing beside the adapter, not adapter code: two WireGuard config files and
one script. The adapter only advertises the resulting address. Everything in these
files is an example; replace every value in angle brackets.

What the rented server can see: that a Lightning node is behind it, and the
encrypted Noise stream between peers. No keys, no channel data, no plaintext. What it
costs if it dies: inbound clearnet connections until you replace it; existing channels
are untouched (peers reconnect over Tor or when the relay returns).

## Files

- `vps-setup.sh` — run once on the rented server as root. Installs WireGuard, makes
  the server's key pair, writes `/etc/wireguard/wg0.conf` from `wg0-vps.conf`, opens
  the forwarding, starts the tunnel. Prints the server's public key for step 3.
- `wg0-vps.conf` — the rented server's tunnel config (template).
- `wg0-node.conf` — the home node's tunnel config (template).

## Steps

1. Rent a server with a fixed IPv4 (Ubuntu 24.04, the smallest size is enough). Put
   your SSH public key on it at creation. Note its address: `<VPS_IP>`.
2. On the **home node**, make its key pair and note the public key:
   ```
   sudo apt install -y wireguard
   umask 077; wg genkey | sudo tee /etc/wireguard/node.key | wg pubkey | sudo tee /etc/wireguard/node.pub
   cat /etc/wireguard/node.pub
   ```
3. On the **rented server** (`ssh root@<VPS_IP>`), copy `vps-setup.sh` there and run
   it with the home node's public key:
   ```
   bash vps-setup.sh <NODE_PUBLIC_KEY>
   ```
   It prints `VPS public key: <VPS_PUBLIC_KEY>`.
4. On the **home node**, write `/etc/wireguard/wg0.conf` from `wg0-node.conf`, filling
   `<NODE_PRIVATE_KEY>` (the contents of `/etc/wireguard/node.key`), `<VPS_PUBLIC_KEY>`
   and `<VPS_IP>`, then:
   ```
   sudo systemctl enable --now wg-quick@wg0
   ping -c 2 10.9.0.1
   ```
5. Tell LND about the address: in `lnd.conf`, `externalip=<VPS_IP>:9735` (keep the Tor
   lines; both addresses are advertised), `listen=0.0.0.0:9735`. Restart LND.
6. Check from anywhere: `nc -vz <VPS_IP> 9735` connects. `lncli getinfo` shows both
   URIs. If you want the registry record to show clearnet first, set
   `NODE_HOST=<VPS_IP>:9735` in the adapter's config and restart it.

## Addresses used inside the tunnel

`10.9.0.1` = the rented server, `10.9.0.2` = the home node. Change both files
together if that range is already in use on your network.
