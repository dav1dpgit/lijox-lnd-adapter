# Public-surface fingerprint audit (P7, v0.53)

What an UNAUTHENTICATED stranger learns from each public route, and
the verdict applied. Principle: answer what wallets need; withhold
what merely profiles the operator's box. Detail returns with
HEALTH_DETAIL=on (operator's choice, off by default).

| route | fields | verdict |
|---|---|---|
| /health | ok, node pubkey, name, active_channels, synced, ws_proxy_port, channel_limits, bridge/interceptor enabled+connected | KEEP — wallets consume ok/active_channels/interceptor.connected; pubkey+name are the operator's published identity; limits are policy, not fingerprint |
| /health (detail withheld by default) | lnd_version, interceptor ops counters (holds/settles/trampoline/watchdogs), bridge registered_peers + stream counts | HIDE unless HEALTH_DETAIL=on — software-version fingerprint + per-wallet activity profiling |
| /health/jit | reserve figures, per-wallet hold detail, world-conduit state | ADMIN-GATED unless HEALTH_DETAIL=on — pure ops view |
| /info | pubkey, host, name, fee_ppm, channel count, synced, wss url, channel limits | KEEP — this is the provider's shop sign; wallets/registries need it |
| /rates | fiat rates via LSP proxy | KEEP — exists so wallet IPs never touch tickers |
| /lease/policy, /lease/status | declared expiry policy | KEEP — transparency the wallet is owed |
| /quorum/defaults | LSP-declared esplora set | KEEP — wallets verify against it |
| /.well-known/lnurlp/* | per-name pay metadata | KEEP — the point of hosting addresses |
| /attempts | payment forensics, HASH-SCOPED (must know the payment hash) | KEEP — scoping is the guard |
| /lsps/registry/*, /lsps2/push-subscribe | signed-challenge only | KEEP — already authenticated by design |
| /health → nwc, /lsps2/get_info → nwc (0.86.0) | enabled, the relay's wss address, ttl ceiling, caps; on /health the counts (connections, waiting, wakes today) | KEEP — the wallet's Dials → NWC reads enabled + relay; counts are the same order of detail push_key already gives; never a key |
| /v1/nwc/register, /v1/nwc/unregister (0.86.0) | route token + the wallet's node-key signature | KEEP — authenticated by design; a stranger learns only 401 |
| /nwc (websocket, 0.86.0) | NIP-01 relay: a REQ must name a key; requests only to the authenticated service key; replies by client key; info by author | KEEP — no listing of keys; an unauthenticated stranger gets EOSE and nothing else |

Not exposed anywhere unauthenticated: onchain balance, total/inactive
channel list, peer list, macaroon scope, data paths, version of this
adapter's dependencies.
