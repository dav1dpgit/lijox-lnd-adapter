# LIJOX Adapter on Umbrel

Makes your Umbrel's LND a LIJOX Lightning service provider: wallets that speak the LIJOX standard (LiJ and others)
open channels with it, receive while offline, and keep their Black start kits with it.

**Status: second release. Steps 1–9 were run on a Raspberry Pi Umbrel on 2026-11-11 with LND (Terminus) 0.21.6; on
2026-11-12 the same Pi took the 0.21.8 image below (over the 0.21.6 one), a LiJ wallet received into a new channel there
(private, static remote key, zero-conf) and paid out over it. Not yet run on a PC.** Do it with the publisher on a call.

## Before you start

1. **LND (Terminus)**, not the Lightning app's stock LND. It is LND 0.21.8 with one patch that opens the channels
   LIJOX wallets ask for (zero-conf, no anchors): [the patch, 62 lines](https://github.com/dav1dpgit/lnd/commit/cf8f0d2cbdf380e038f180aa9adb5c4377f95f83).
   It keeps your data and your channels. Your Lightning app must be on LND 0.21.6 first. 0.21.8 does not change LND's
   database, so going back to the app's stock 0.21.6 stays possible.
2. **Bitcoin on-chain in LND's wallet**, plus public channels with room to send out.
3. **A way in.** LiJ is a web wallet, so the adapter needs a public `https://` and `wss://` address. With Cloudflare:
   a tunnel with two public names — one to `http://localhost:7000`, one to `http://localhost:7001`.

## Install LND (Terminus)

1. Check the Lightning app is on `v0.21.6-beta`.
```
grep -n "lnd:" ~/umbrel/app-data/lightning/docker-compose.yml
```
2. Pull the image.
```
sudo docker pull ghcr.io/dav1dpgit/lnd-terminus:v0.21.8-beta@sha256:467e29656f9133dc196c87bcbcdd4c555bb00485063a58037c3de0f0ce904df3
```
3. Stop the Lightning app.
```
umbreld client apps.stop.mutate --appId lightning
```
4. Back up its file.
```
sudo cp -p ~/umbrel/app-data/lightning/docker-compose.yml ~/umbrel/app-data/lightning/docker-compose.yml.bak-stock
```
5. Change the LND line.
```
sudo sed -i 's|lightninglabs/lnd:v0.21.6-beta@sha256:54b3c87ad0bc3fea3fab8af23ace6421147ea97e6b56bf3911592d7853c185b8|ghcr.io/dav1dpgit/lnd-terminus:v0.21.8-beta@sha256:467e29656f9133dc196c87bcbcdd4c555bb00485063a58037c3de0f0ce904df3|' ~/umbrel/app-data/lightning/docker-compose.yml
```
6. Check: exactly one line differs.
```
diff ~/umbrel/app-data/lightning/docker-compose.yml.bak-stock ~/umbrel/app-data/lightning/docker-compose.yml
```
7. Turn on zero-conf and scid-alias (the app copies this file into LND's settings).
```
printf 'protocol.option-scid-alias=true\nprotocol.zero-conf=true\n' | sudo tee -a ~/umbrel/app-data/lightning/data/lnd/lnd.conf
```
8. Start the app, twice.
```
umbreld client apps.restart.mutate --appId lightning
```
```
umbreld client apps.restart.mutate --appId lightning
```
9. After two minutes, check. lnd's `version` is `0.21.8-beta` and its `commit_hash` is `f3ed44e71a2d62867570a59ea838187a7bb68676`, and both features are listed.
```
sudo docker exec lightning_lnd_1 lncli version
```
```
sudo docker exec lightning_lnd_1 lncli getinfo | grep -E "zero-conf|scid-alias|synced_to_chain|num_active"
```

To go back to stock LND: copy `docker-compose.yml.bak-stock` over `docker-compose.yml` and restart the app.

## Install the adapter

1. Follow the repository's [README](../README.md), steps 1–6, in a folder in your home (`~/lij-adapter`), not `/opt`.
2. On an Umbrel, `lncli` is `sudo docker exec lightning_lnd_1 lncli`. Use it for the key ([MACAROON.md](../MACAROON.md)).
3. In `.env`, these lines differ from the example:
```
LND_ENDPOINT=https://127.0.0.1:8080
LND_GRPC_ENDPOINT=127.0.0.1:10009
LND_TLS_CERT_PATH=/home/umbrel/umbrel/app-data/lightning/data/lnd/tls.cert
LSPS2_COMMITMENT_TYPE=STATIC_REMOTE_KEY
LEASE_LNCLI=docker exec lightning_lnd_1 lncli
```
4. Run the service as user `umbrel`, with `ExecStart=/bin/bash -lc 'exec node /home/umbrel/lij-adapter/lij-adapter.js'`.

## After install

1. Check what the adapter tells wallets: `STATIC_REMOTE_KEY` and `true`.
```
curl -s -H "x-adapter-secret: $(grep -m1 -oP '^ADAPTER_SECRET=\K\S+' ~/lij-adapter/.env)" http://127.0.0.1:7000/lsps2/get_info | grep -oE '"(channel_type|words_recoverable)":[^,}]*'
```
2. Tell the publisher your node's name. A first receive from a LiJ wallet is tested together.
3. In the Lightning app's Advanced settings, raise "max pending channels per peer" above 1.

## Updates

- **Do not update the Lightning app until LND (Terminus) for that version is published.** The app's update puts stock
  LND back — nothing is lost, and LiJ wallets stop taking new channels until you do steps 2–6 again with the new image.
- After an umbrelOS update, check the adapter still runs: `systemctl status lijox-adapter`.
- Back up `~/lij-adapter` (`.env` and the data folder) off the box.

## Stay online

While this box is off, its wallets cannot pay or be paid, and after 24 hours the LIJOX registry marks it stale.

Security reports: dp@modulo.network.
