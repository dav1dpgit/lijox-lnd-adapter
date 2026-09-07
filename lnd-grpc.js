'use strict';

// lnd-grpc.js v0.4
//
// v0.4 (adapter v0.18 — LSPS2 Phase D.2):
//   - openChannelSync(opts, params) — synchronous channel-open. Loads a
//     dedicated lightning-openchannel.proto (sibling of lnd-grpc.js) for
//     just the OpenChannelSync RPC. Separate from the custom-message
//     Lightning client to avoid touching the v0.1 stub. Caller supplies
//     timeout via gRPC deadline.
//   - sendToRouteV2(client, payment_hash, route) — caller-specified route
//     + payment_hash via Router service. Used for the trampoline outbound
//     leg of LSPS2 JIT (send to wallet over the newly-opened channel
//     using the SAME payment hash as the inbound HTLC).
//   - subscribeHtlcInterceptor wrapper accepts async handlers. If
//     onRequest returns a Promise, the wrapper awaits before writing the
//     response. Synchronous returns still work (backwards compatible).
//     On a Promise rejection, default to RESUME for safety.
//
// v0.3 (adapter v0.17 — LSPS2 Phase D.1):
//
// v0.3 (adapter v0.17 — LSPS2 Phase D.1):
//   - Router client + HtlcInterceptor bidirectional streaming wrapper.
//     Router.HtlcInterceptor is the only RPC the adapter uses; we expose
//     it via subscribeHtlcInterceptor(client, onRequest) where onRequest
//     receives each ForwardHtlcInterceptRequest and must synchronously
//     return a ForwardHtlcInterceptResponse to write back on the stream.
//
// v0.2.1 (adapter v0.12 cleanup):
//
// Native gRPC clients for LND.
//
// v0.1 (Step 2):
//   - Lightning client + SubscribeCustomMessages + SendCustomMessage
//
// v0.2 (Step 3):
//   - ChainNotifier client + RegisterBlockEpochNtfn (single shared block stream)
//                          + RegisterConfirmationsNtfn (per-watch)
//                          + RegisterSpendNtfn         (per-outpoint)
//   - WalletKit client + PublishTransaction (raw tx broadcast)
//
// v0.2.1 (adapter v0.12 cleanup):
//   - Bumped grpc.keepalive_time_ms from 30s to 10min. LND's
//     serverKeepaliveEnforcementPolicy.min_time defaults to 5 minutes,
//     so 30s pings were triggering repeated GOAWAY responses logged as
//     "rejected by server because of excess pings. Increasing ping
//     interval to 60000 ms" every 2-3 minutes. 10min is safely above
//     LND's 5-minute floor while still giving timely detection of a
//     half-dead connection (TCP keepalive remains the first-line check).
//   - Bumped grpc.keepalive_timeout_ms from 10s to 30s. With less
//     frequent pings, a slightly more lenient pong window costs nothing
//     and avoids spurious disconnects under transient gRPC stream load.
//
// All clients share the same TLS cert + macaroon credentials. The
// lij-adapter-v2 macaroon already covers all four RPC scope sets:
//   info:read, peers:read+write, offchain:read+write, onchain:read+write.

if (!process.env.GRPC_SSL_CIPHER_SUITES) {
  process.env.GRPC_SSL_CIPHER_SUITES = 'HIGH+ECDSA';
}

const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const LIGHTNING_PROTO_PATH      = path.resolve(__dirname, 'lightning.proto');
const CHAINNOTIFIER_PROTO_PATH  = path.resolve(__dirname, 'chainnotifier.proto');
const WALLETKIT_PROTO_PATH      = path.resolve(__dirname, 'walletkit.proto');
const ROUTER_PROTO_PATH                 = path.resolve(__dirname, 'router.proto');
const LIGHTNING_OPENCHANNEL_PROTO_PATH  = path.resolve(__dirname, 'lightning-openchannel.proto');

const PROTO_LOADER_OPTS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const CHANNEL_OPTS = {
  'grpc.max_receive_message_length': 50 * 1024 * 1024,
  'grpc.max_send_message_length':    50 * 1024 * 1024,
  'grpc.keepalive_time_ms':          10 * 60 * 1000,
  'grpc.keepalive_timeout_ms':       30 * 1000,
  'grpc.keepalive_permit_without_calls': 1,
};

// Cached singletons keyed by (service, endpoint). Multiple service clients
// can share TLS credentials transparently — gRPC handles internal channel
// pooling under the hood.
const cachedClients = new Map();

// ── Credential builder (shared) ──────────────────────────────────────────────

function buildCredentials({ tlsCertPath, macaroonHex }) {
  const tlsCert = fs.readFileSync(tlsCertPath);
  const sslCreds = grpc.credentials.createSsl(tlsCert);
  const macaroonCreds = grpc.credentials.createFromMetadataGenerator(
    (_params, callback) => {
      const metadata = new grpc.Metadata();
      metadata.add('macaroon', macaroonHex);
      callback(null, metadata);
    }
  );
  return grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
}

// ── Client factories ─────────────────────────────────────────────────────────

function makeLightningClient({ grpcEndpoint, tlsCertPath, macaroonHex }) {
  const cacheKey = `lightning:${grpcEndpoint}`;
  if (cachedClients.has(cacheKey)) return cachedClients.get(cacheKey);

  if (!grpcEndpoint || !tlsCertPath || !macaroonHex) {
    throw new Error('makeLightningClient: grpcEndpoint, tlsCertPath, macaroonHex required');
  }

  const credentials = buildCredentials({ tlsCertPath, macaroonHex });
  const packageDef = protoLoader.loadSync(LIGHTNING_PROTO_PATH, PROTO_LOADER_OPTS);
  const Lightning = grpc.loadPackageDefinition(packageDef).lnrpc.Lightning;

  const client = new Lightning(grpcEndpoint, credentials, CHANNEL_OPTS);
  cachedClients.set(cacheKey, client);
  return client;
}

function makeChainNotifierClient({ grpcEndpoint, tlsCertPath, macaroonHex }) {
  const cacheKey = `chainnotifier:${grpcEndpoint}`;
  if (cachedClients.has(cacheKey)) return cachedClients.get(cacheKey);

  if (!grpcEndpoint || !tlsCertPath || !macaroonHex) {
    throw new Error('makeChainNotifierClient: grpcEndpoint, tlsCertPath, macaroonHex required');
  }

  const credentials = buildCredentials({ tlsCertPath, macaroonHex });
  const packageDef = protoLoader.loadSync(CHAINNOTIFIER_PROTO_PATH, PROTO_LOADER_OPTS);
  const ChainNotifier = grpc.loadPackageDefinition(packageDef).chainrpc.ChainNotifier;

  const client = new ChainNotifier(grpcEndpoint, credentials, CHANNEL_OPTS);
  cachedClients.set(cacheKey, client);
  return client;
}

function makeWalletKitClient({ grpcEndpoint, tlsCertPath, macaroonHex }) {
  const cacheKey = `walletkit:${grpcEndpoint}`;
  if (cachedClients.has(cacheKey)) return cachedClients.get(cacheKey);

  if (!grpcEndpoint || !tlsCertPath || !macaroonHex) {
    throw new Error('makeWalletKitClient: grpcEndpoint, tlsCertPath, macaroonHex required');
  }

  const credentials = buildCredentials({ tlsCertPath, macaroonHex });
  const packageDef = protoLoader.loadSync(WALLETKIT_PROTO_PATH, PROTO_LOADER_OPTS);
  const WalletKit = grpc.loadPackageDefinition(packageDef).walletrpc.WalletKit;

  const client = new WalletKit(grpcEndpoint, credentials, CHANNEL_OPTS);
  cachedClients.set(cacheKey, client);
  return client;
}

// v0.3: Router client for HtlcInterceptor (LSPS2 Phase D.1).
function makeRouterClient({ grpcEndpoint, tlsCertPath, macaroonHex }) {
  const cacheKey = `router:${grpcEndpoint}`;
  if (cachedClients.has(cacheKey)) return cachedClients.get(cacheKey);

  if (!grpcEndpoint || !tlsCertPath || !macaroonHex) {
    throw new Error('makeRouterClient: grpcEndpoint, tlsCertPath, macaroonHex required');
  }

  const credentials = buildCredentials({ tlsCertPath, macaroonHex });
  const packageDef = protoLoader.loadSync(ROUTER_PROTO_PATH, PROTO_LOADER_OPTS);
  const Router = grpc.loadPackageDefinition(packageDef).routerrpc.Router;

  const client = new Router(grpcEndpoint, credentials, CHANNEL_OPTS);
  cachedClients.set(cacheKey, client);
  return client;
}

// v0.4: Lightning client for OpenChannelSync (LSPS2 Phase D.2). Separate
// proto + cache key from the v0.1 custom-message Lightning client so
// neither touches the other. Same package name (lnrpc.Lightning), so
// the underlying gRPC service is shared — only the proto definition
// differs (we declare just OpenChannelSync here).
function makeLightningOpenChannelClient({ grpcEndpoint, tlsCertPath, macaroonHex }) {
  const cacheKey = `lightning-openchannel:${grpcEndpoint}`;
  if (cachedClients.has(cacheKey)) return cachedClients.get(cacheKey);

  if (!grpcEndpoint || !tlsCertPath || !macaroonHex) {
    throw new Error('makeLightningOpenChannelClient: grpcEndpoint, tlsCertPath, macaroonHex required');
  }

  const credentials = buildCredentials({ tlsCertPath, macaroonHex });
  const packageDef = protoLoader.loadSync(LIGHTNING_OPENCHANNEL_PROTO_PATH, PROTO_LOADER_OPTS);
  const Lightning = grpc.loadPackageDefinition(packageDef).lnrpc.Lightning;

  const client = new Lightning(grpcEndpoint, credentials, CHANNEL_OPTS);
  cachedClients.set(cacheKey, client);
  return client;
}

// ── Generic streaming subscription helper ────────────────────────────────────
// Reconnect-with-backoff pattern shared across all four streaming wrappers.

function makeStreamingSubscription({ name, openCall, onData }) {
  let stopped = false;
  let backoffMs = 1000;
  let currentCall = null;
  let reconnectTimer = null;

  const connect = () => {
    if (stopped) return;

    let connectedLogged = false;
    const call = openCall();
    currentCall = call;

    call.on('metadata', () => {
      if (!connectedLogged) {
        connectedLogged = true;
        backoffMs = 1000;
        console.log(`[${name}] connected (gRPC stream)`);
      }
    });

    call.on('data', (msg) => {
      try {
        onData(msg);
      } catch (e) {
        console.error(`[${name}] handler error: ${e.message}`);
      }
    });

    call.on('error', (err) => {
      if (err && err.code === grpc.status.CANCELLED) {
        console.log(`[${name}] gRPC stream cancelled`);
        return;
      }
      console.error(`[${name}] gRPC error (code=${err && err.code}): ${err && err.message}`);
      scheduleReconnect();
    });

    call.on('end', () => {
      console.log(`[${name}] gRPC stream ended`);
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) return;
    console.log(`[${name}] reconnecting in ${backoffMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      connect();
    }, backoffMs);
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentCall) {
        try { currentCall.cancel(); } catch (_) { /* ignore */ }
        currentCall = null;
      }
      console.log(`[${name}] stopped`);
    },
  };
}

// ── Lightning streaming wrappers (v0.1 — unchanged) ──────────────────────────

function subscribeCustomMessages(client, onEvent, name = 'CustomMessage') {
  return makeStreamingSubscription({
    name,
    openCall: () => client.subscribeCustomMessages({}),
    onData: (msg) => {
      onEvent({
        peer: msg.peer.toString('hex'),
        type: Number(msg.type),
        data: msg.data.toString('base64'),
      });
    },
  });
}

function sendCustomMessage(client, { peerHex, type, dataBase64 }) {
  return new Promise((resolve, reject) => {
    if (!peerHex || peerHex.length !== 66) {
      reject(new Error(`sendCustomMessage: peerHex must be 66 hex chars, got ${peerHex && peerHex.length}`));
      return;
    }
    client.sendCustomMessage(
      {
        peer: Buffer.from(peerHex, 'hex'),
        type: type,
        data: Buffer.from(dataBase64 || '', 'base64'),
      },
      (err, _response) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

// ── ChainNotifier streaming wrappers (v0.2 NEW) ──────────────────────────────

/**
 * Subscribe to new block events. Single shared stream — bridge fans out to
 * all registered peers internally. Empty BlockEpoch request = "start from
 * current tip, emit each new block as it arrives."
 */
function subscribeBlockEpoch(client, onEvent, name = 'BlockEpoch') {
  return makeStreamingSubscription({
    name,
    openCall: () => client.registerBlockEpochNtfn({}),
    onData: (msg) => {
      onEvent({
        hash: msg.hash,
        height: Number(msg.height),
      });
    },
  });
}

/**
 * Subscribe to confirmations of a specific txid. Stream emits ConfDetails
 * when txid reaches num_confs depth, or Reorg if the confirming block is
 * reorged out. Stays open through reorgs.
 *
 * @param req  {txid: Buffer<32>, script: Buffer, numConfs: u32, heightHint: u32}
 */
function subscribeConfirmations(client, { txid, script, numConfs, heightHint }, onEvent, name = 'Conf') {
  return makeStreamingSubscription({
    name,
    openCall: () => client.registerConfirmationsNtfn({
      txid: txid,
      script: script || Buffer.alloc(0),
      num_confs: numConfs || 1,
      height_hint: heightHint || 0,
      include_block: false,
    }),
    onData: (msg) => {
      // proto oneof exposes both keys; only one populated per event.
      onEvent({
        conf: msg.conf || null,
        reorg: msg.reorg || null,
      });
    },
  });
}

/**
 * Subscribe to spend of a specific outpoint. Emits SpendDetails when spent
 * on chain, or Reorg if the spending block is reorged out.
 *
 * @param req  {outpoint: {hash: Buffer<32>, index: u32}, script: Buffer, heightHint: u32}
 */
function subscribeSpend(client, { outpoint, script, heightHint }, onEvent, name = 'Spend') {
  return makeStreamingSubscription({
    name,
    openCall: () => client.registerSpendNtfn({
      outpoint: {
        hash: outpoint.hash,
        index: outpoint.index || 0,
      },
      script: script || Buffer.alloc(0),
      height_hint: heightHint || 0,
    }),
    onData: (msg) => {
      onEvent({
        spend: msg.spend || null,
        reorg: msg.reorg || null,
      });
    },
  });
}

// ── WalletKit unary wrapper (v0.2 NEW) ───────────────────────────────────────

/**
 * Submit a raw transaction to LND for broadcast to the Bitcoin network.
 *
 * @returns Promise<{publish_error: string}>  empty string = success
 */
function publishTransaction(client, rawTx, label = '') {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(rawTx) || rawTx.length === 0) {
      reject(new Error('publishTransaction: rawTx must be a non-empty Buffer'));
      return;
    }
    client.publishTransaction(
      { tx_hex: rawTx, label: label || '' },
      (err, response) => {
        if (err) reject(err);
        else resolve(response || { publish_error: '' });
      }
    );
  });
}

// ── Lightning (OpenChannelSync) unary wrapper (v0.4 NEW) ─────────────────────

/**
 * Open a Lightning channel synchronously via LND's OpenChannelSync RPC.
 * Returns a ChannelPoint on success. Suitable for LSPS2 zero-conf opens.
 *
 * @param client          Lightning client from makeLightningOpenChannelClient()
 * @param params          OpenChannelRequest fields (see proto)
 * @param timeoutMs       Optional deadline (default 30s)
 * @returns Promise<ChannelPoint>
 */
function openChannelSync(client, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!client) { reject(new Error('openChannelSync: client required')); return; }
    if (!params || !params.node_pubkey_string) {
      reject(new Error('openChannelSync: params.node_pubkey_string required'));
      return;
    }
    const deadline = new Date(Date.now() + (timeoutMs || 30_000));
    client.openChannelSync(params, { deadline }, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

// ── Router (SendToRouteV2) unary wrapper (v0.4 NEW) ──────────────────────────

/**
 * Send a payment along a caller-specified route with a caller-specified
 * payment_hash. Returns HTLCAttempt on response (success or failure).
 *
 * Used by LSPS2 Phase D.2 trampoline-via-interceptor: after the adapter
 * opens a JIT channel to the wallet, it calls this to forward the held
 * inbound HTLC's amount to the wallet using the SAME payment_hash. On
 * success, the wallet's LDK releases the preimage (because the hash
 * matches a pending invoice); the adapter then uses that preimage to
 * SETTLE the original inbound HTLC via the interceptor.
 *
 * @param client          Router client from makeRouterClient()
 * @param paymentHash     Buffer<32> — must match a pending wallet invoice
 * @param route           Route proto: hops = [single hop to wallet]
 * @param timeoutMs       Optional deadline (default 30s)
 * @returns Promise<HTLCAttempt>
 */
function sendToRouteV2(client, paymentHash, route, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!client) { reject(new Error('sendToRouteV2: client required')); return; }
    if (!Buffer.isBuffer(paymentHash) || paymentHash.length !== 32) {
      reject(new Error('sendToRouteV2: paymentHash must be a 32-byte Buffer'));
      return;
    }
    if (!route || !Array.isArray(route.hops) || route.hops.length === 0) {
      reject(new Error('sendToRouteV2: route.hops must be non-empty array'));
      return;
    }
    const deadline = new Date(Date.now() + (timeoutMs || 30_000));
    client.sendToRouteV2(
      { payment_hash: paymentHash, route: route, skip_temp_err: false },
      { deadline },
      (err, response) => {
        if (err) reject(err);
        else resolve(response);
      }
    );
  });
}

// ── Router bidirectional streaming wrapper (v0.3 NEW) ────────────────────────

/**
 * Subscribe to LND's HtlcInterceptor bidirectional stream. For each
 * ForwardHtlcInterceptRequest the server emits, the caller's onRequest
 * handler must return a ForwardHtlcInterceptResponse (synchronous) which
 * the wrapper writes back on the same stream.
 *
 * Different from makeStreamingSubscription because:
 *   1. The RPC is bidirectional — we must initiate by calling .write()
 *   2. Each request demands exactly one response message
 *   3. Per LND docs, NOT responding blocks the HTLC indefinitely
 *
 * The onRequest handler MUST be synchronous and MUST NOT throw. The
 * wrapper catches throws and responds RESUME as a safety default, but
 * synchronous correctness is the caller's responsibility.
 *
 * Reconnect-with-backoff matches the unidirectional wrapper.
 *
 * Returns: { stop(), getCounters() } where counters is
 * { connected, htlcs_seen, reconnects, errors, last_error }.
 *
 * @param client       Router gRPC client from makeRouterClient()
 * @param onRequest    (req: ForwardHtlcInterceptRequest) => ForwardHtlcInterceptResponse
 * @param name         log prefix, default 'Interceptor'
 */
function subscribeHtlcInterceptor(client, onRequest, name = 'Interceptor') {
  let stopped = false;
  let backoffMs = 1000;
  let currentCall = null;
  let reconnectTimer = null;
  let counters = {
    connected: false,
    htlcs_seen: 0,
    reconnects: 0,
    errors: 0,
    last_error: null,
  };
  // v0.54.2 (f, correctly scoped): resolutions written while the interceptor
  // stream is down wait here and flush on reconnect. Previously the write
  // helper was re-created per incoming HTLC and stayed bound to whichever
  // stream existed then — after a reconnect it pointed at a dead stream and
  // writes vanished silently. (0.54.1 placed this in the generic streaming
  // helper by anchor mistake, breaking bridge + interceptor init — repaired.)
  const pendingResolutions = [];
  counters._lastWrite = (resp) => {
    if (currentCall) {
      try { currentCall.write(resp); return true; }
      catch (e) { console.error(`[${name}] live-stream write failed: ${e && e.message} — queueing`); }
    } else {
      console.warn(`[${name}] stream down — queueing resolution action=${resp && resp.action}`);
    }
    pendingResolutions.push(resp);
    return 'queued';
  };

  const connect = () => {
    if (stopped) return;

    // Bidirectional: call returns a DuplexStream — we read AND write.
    const call = client.htlcInterceptor();
    counters.connected = true;
    currentCall = call;
    // v0.54.1 (f): flush any resolutions (SETTLE/FAIL/RESUME) that were
    // generated while the stream was down. Ordering: queued first.
    if (pendingResolutions.length) {
      console.warn(`[${name}] stream back — flushing ${pendingResolutions.length} queued resolution(s)`);
      const _q = pendingResolutions.splice(0, pendingResolutions.length);
      for (const _r of _q) {
        try { call.write(_r); }
        catch (e) { console.error(`[${name}] queued-resolution flush failed: ${e && e.message} — re-queueing`); pendingResolutions.push(_r); break; }
      }
    }
    let connectedLogged = false;

    call.on('metadata', () => {
      if (!connectedLogged) {
        connectedLogged = true;
        backoffMs = 1000;
        counters.connected = true;
        console.log(`[${name}] connected (bidi gRPC stream)`);
      }
    });

    call.on('data', (req) => {
      counters.htlcs_seen += 1;

      // v0.4: handler may return a value OR a Promise. Promise.resolve()
      // normalizes both cases. We write the response back on the stream
      // after the (possibly-async) handler completes.
      //
      // If the handler returns null/undefined (D.2 offline-HTLC case where
      // we deliberately hold the HTLC without responding), we do NOT call
      // call.write() — the HTLC stays open until either the handler
      // eventually writes via a deferred path or a watchdog FAILs it.
      let result;
      try {
        result = Promise.resolve(onRequest(req));
      } catch (e) {
        // Synchronous throw from handler — log + RESUME
        counters.errors += 1;
        counters.last_error = e && e.message;
        console.error(`[${name}] onRequest threw sync: ${e && e.message}; RESUME`);
        try {
          call.write({ incoming_circuit_key: req.incoming_circuit_key, action: 'RESUME' });
        } catch (we) {
          console.error(`[${name}] sync-fallback write failed: ${we && we.message}`);
        }
        return;
      }

      result
        .then((resp) => {
          // Handler explicitly chose to hold the HTLC (no response now).
          if (resp === null || resp === undefined) return;

          // Validate response shape — RESUME-fallback on anything malformed.
          if (typeof resp !== 'object' || !resp.incoming_circuit_key) {
            counters.errors += 1;
            counters.last_error = 'onRequest returned malformed response';
            console.error(`[${name}] onRequest returned malformed; RESUME`);
            resp = { incoming_circuit_key: req.incoming_circuit_key, action: 'RESUME' };
          }
          try {
            call.write(resp);
          } catch (e) {
            counters.errors += 1;
            counters.last_error = `write failed: ${e && e.message}`;
            console.error(`[${name}] write back failed: ${e && e.message}`);
          }
        })
        .catch((e) => {
          counters.errors += 1;
          counters.last_error = e && e.message;
          console.error(`[${name}] onRequest rejected: ${e && e.message}; RESUME`);
          try {
            call.write({ incoming_circuit_key: req.incoming_circuit_key, action: 'RESUME' });
          } catch (we) {
            console.error(`[${name}] reject-fallback write failed: ${we && we.message}`);
          }
        });

    });

    call.on('error', (err) => {
      counters.connected = false;
      if (currentCall === call) currentCall = null;  /* v0.54.1 (f) */
      if (err && err.code === grpc.status.CANCELLED) {
        console.log(`[${name}] gRPC stream cancelled`);
        return;
      }
      counters.errors += 1;
      counters.last_error = err && err.message;
      console.error(`[${name}] gRPC error (code=${err && err.code}): ${err && err.message}`);
      scheduleReconnect();
    });

    call.on('end', () => {
      counters.connected = false;
      if (currentCall === call) currentCall = null;  /* v0.54.1 (f) */
      console.log(`[${name}] gRPC stream ended`);
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    if (reconnectTimer) return;
    counters.reconnects += 1;
    console.log(`[${name}] reconnecting in ${backoffMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, 30_000);
      connect();
    }, backoffMs);
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentCall) {
        try { currentCall.end(); } catch (_) { /* ignore */ }
        try { currentCall.cancel(); } catch (_) { /* ignore */ }
        currentCall = null;
      }
      counters.connected = false;
      console.log(`[${name}] stopped`);
    },
    getCounters: () => ({ ...counters }),
  };
}

module.exports = {
  // Client factories
  makeLightningClient,
  makeChainNotifierClient,
  makeWalletKitClient,
  makeRouterClient,
  makeLightningOpenChannelClient,
  // Lightning wrappers (v0.1)
  subscribeCustomMessages,
  sendCustomMessage,
  // ChainNotifier wrappers (v0.2)
  subscribeBlockEpoch,
  subscribeConfirmations,
  subscribeSpend,
  // WalletKit wrappers (v0.2)
  publishTransaction,
  // Router wrappers (v0.3)
  subscribeHtlcInterceptor,
  // OpenChannelSync + SendToRouteV2 (v0.4 — LSPS2 Phase D.2)
  openChannelSync,
  sendToRouteV2,
};
