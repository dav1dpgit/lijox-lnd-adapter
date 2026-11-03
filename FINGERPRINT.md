# Public-surface fingerprint audit (P7, v0.53)

What an UNAUTHENTICATED stranger learns from each public route, and
the verdict applied. Principle: answer what wallets need; withhold
what merely profiles the operator's box. Detail returns with
HEALTH_DETAIL=on (operator's choice, off by default).

| route | fields | verdict |
|---|---|---|
| /health | ok, node pubkey, name, active_channels, synced, ws_proxy_port, channel_limits, bridge/interceptor enabled+connected | KEEP — wallets consume ok/active_channels/interceptor.connected; pubkey+name are the operator's published identity; limits are policy, not fingerprint |
| /health (detail withheld by default) | lnd_version, interceptor ops counters (holds/settles/trampoline/watchdogs), bridge registered_peers + stream counts | HIDE unless HEALTH_DETAIL=on — software-version fingerprint + per-wallet activity profiling |
| /health/jit | (retired 0.111.0 — 410) | MOVED to the console: the JIT · now pane. It had answered the published route token, i.e. anyone |
| /info | pubkey, host, name, fee_ppm, channel count, synced, wss url, channel limits | KEEP — this is the provider's shop sign; wallets/registries need it |
| /rates | fiat rates via LSP proxy | KEEP — exists so wallet IPs never touch tickers |
| /lease/policy | declared expiry policy | KEEP — transparency the wallet is owed |
| /lease/status, /lease/ttl, /ops/loops | (retired 0.111.0 — 410) | MOVED to the console (GET /console/lease, the lease setter on the channel row, the Loops and Backups panes). /lease/ttl behind the published token let anyone set a channel's lease to a fraction of a day and have the next hourly cycle force-close it |
| /quorum/defaults | LSP-declared esplora set | KEEP — wallets verify against it |
| /.well-known/lnurlp/* | per-name pay metadata | KEEP — the point of hosting addresses |
| /attempts | payment forensics, HASH-SCOPED (must know the payment hash) | KEEP — scoping is the guard |
| /v1/lnurl/fetch (0.119.3) | route token; the body of a payee's https pay URL fetched for the phone, verbatim; a refused URL answers its reason (not_https, port, host, redirect, too_big, timeout, resolve, unreachable, notjson); per-address limit | KEEP — nothing about the box is reachable through it (https on 443 to a public address only, pinned to the checked address; no redirect); the operator never sees the URL |
| /lsps2/buy (0.119.2) | route token; a refused ask (the provider's total cap, or a wallet whose every live promise is busy) answers 429 with a plain sentence and no count | KEEP — the caps are a governor, not an identity check; nothing about other wallets is said |
| /lsps/registry/*, /lsps2/push-subscribe | signed-challenge only; since 0.119.0 the proof binds the whole record / the subscription (F13) | KEEP — already authenticated by design |
| /tapedrop | the node key's proof over the tape text (0.119.0, F24); an unsigned drop through the old peer check this one release, filed as claimed-… | KEEP — evidence filed under the key that signed it |
| /health → nwc, /lsps2/get_info → nwc (0.86.0) | enabled, the relay's wss address, ttl ceiling, caps; on /health the counts (connections, waiting, wakes today) | KEEP — the wallet's Dials → NWC reads enabled + relay; counts are the same order of detail push_key already gives; never a key |
| /v1/route/report (0.113.0) | route token + the wallet's node-key signature over a single-use challenge and the report's record (the payment hash, the count and a digest of the refusals) | KEEP — a wallet's own signed report of the nodes that refused its payment; this node writes only the temporary refusals that sat on routes it handed out for that hash (15 min) into its own LND routing memory, at most 20 pairs an hour per wallet; a route ask's own exclusions never write (docs/design/pathfinding in the wallet repo) |
| /lnurl/register, /lnurl/release (0.112.0) | route token + the wallet's node-key signature over a single-use challenge and the record asked for (the name, the count and a digest of the hashes; the name alone to release) | KEEP — authenticated by design from 0.112.0; before it, anyone holding the published route token could release a wallet's Lightning address and re-register it under his own key (the external review's F7) |
| /lnurl/display (0.119.1) | route token + the name owner's node-key signature over a single-use challenge and the record (display:<name>:<sha256 of the text>); the text itself is public the moment it is filed — it is the pay terms' text/plain | KEEP — a shop's own name on every payer's screen is the point; only the name's owner can set or clear it |
| /v1/nwc/register, /v1/nwc/unregister (0.86.0) | route token + the wallet's node-key signature | KEEP — authenticated by design; a stranger learns only 401 |
| /nwc (websocket, 0.86.0) | NIP-01 relay: a REQ must name a key; requests only to the authenticated service key; replies by client key; info by author | KEEP — no listing of keys; an unauthenticated stranger gets EOSE and nothing else |

Not exposed anywhere unauthenticated: onchain balance, total/inactive
channel list, peer list, macaroon scope, data paths, version of this
adapter's dependencies.
