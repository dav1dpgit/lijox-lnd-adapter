'use strict';

/**
 * cooperative-chain-bridge.js — v0.3.3
 *
 * The LSP-side handler for the LiJ cooperative chain-data protocol.
 *
 * v0.3.3 patch (adapter v0.12 — stale subscriber eviction):
 *
 *   - The registry Map previously grew without bound. Peers were added on
 *     SubscribeChainData / RegisterWatchTx / RegisterWatchOutput but never
 *     removed until bridge stop(). Every block, BlockHeightUpdate was sent
 *     to every peer that had ever subscribed, including long-disconnected
 *     wallets. Logs showed repeated "BlockHeightUpdate to … failed: 5
 *     NOT_FOUND: peer is not connected" for the same 9 dead pubkeys.
 *
 *   - v0.3.3 adds per-peer consecutive_failures tracking. Each fan-out
 *     send (BlockHeightUpdate, FundingTxConfirmed, ChannelStateUpdate)
 *     classifies its catch path: "peer is not connected" / "NOT_FOUND"
 *     errors increment the peer's counter; any other error is treated as
 *     transient and logged without incrementing. A successful send resets
 *     the counter to 0. When a peer's counter reaches 3, evictPeer()
 *     removes them from the registry and walks confStreams / spendStreams
 *     to remove them from peerSubscribers sets; any stream with zero
 *     remaining subscribers is stopped and dropped.
 *
 *   - Worst-case eviction latency is ~3 blocks (~30 min) for a wallet
 *     that was actively subscribed and then disappeared. Active wallets
 *     are unaffected: any successful send during the window resets the
 *     counter back to 0.
 *
 * v0.3.2 patch (Step 3 — script pairing fix):
 *
 *   - LND's chainnotifier RegisterConfirmationsNtfn requires a non-empty
 *     script field (LND scans blocks by script, uses txid as secondary
 *     match). Empty script returns "an output script must be provided"
 *     and the stream errors immediately.
 *
 *   - v0.3.1 used empty script when watch_txids.length != watch_scripts.length.
 *     But the wallet's chain_filter registers the same funding script TWICE
 *     (once via register_tx, once via register_output), so the typical
 *     1-channel payload is 1 txid + 2 (identical) scripts → pairedScripts
 *     was false → empty script → stream rejected.
 *
 *   - v0.3.2 fix: pair watch_txids[i] with watch_scripts[min(i, scripts.length-1)].
 *     For 1 txid + N scripts, scripts[0] is the funding output script. For
 *     N txids + N scripts, paired index-wise. For txids without any scripts,
 *     skip (LND can't open a conf stream without a script anyway — emit
 *     a warning and continue).
 *
 * v0.3.1 patch (Step 3 — inline watch list handling):
 *
 *   - handleSubscribeChainData now opens confirmation streams for each
 *     watch_txid carried in the SubscribeChainData payload itself, in
 *     addition to recording the watch list in the per-peer registry.
 *
 *   - This fixes a delivery gap where the wallet's separate RegisterWatchTx
 *     (32813) messages get silently dropped by LDK's PeerManager because
 *     they're enqueued at wallet boot — before the BOLT peer connection is
 *     established. The Step 2 retry mechanism re-issues SubscribeChainData
 *     after peer connect (so 32801 reliably arrives), but does NOT re-issue
 *     RegisterWatchTx, so 32813 stays dropped. By treating SubscribeChainData
 *     as canonical for the initial watch list (which it carries inline),
 *     the LSP stops depending on RegisterWatchTx for first-time setup.
 *
 *   - Subsequent RegisterWatchTx messages for the same txid are still
 *     handled correctly: ensureConfStream is idempotent, so the second
 *     registration just joins the existing stream's peerSubscribers set.
 *
 *   - SPEND streams are NOT opened from SubscribeChainData — its payload
 *     carries only watch_txids and watch_scripts, no outpoint.output_index.
 *     RegisterWatchOutput remains the only path for spend streams. This
 *     means force-close detection still depends on 32815 reaching the LSP.
 *     Wallet-side retry for 32813/32815 will be added as part of Step 3.6
 *     (security hardening pass).
 *
 * v0.3 base (Step 3 — chainnotifier integration):
 *
 *   - Block epoch stream (RegisterBlockEpochNtfn) opens at startup. Each new
 *     block fans out as BlockHeightUpdate (32805) to every registered peer.
 *     The last 6 blockhashes are cached in a rolling buffer for inclusion in
 *     subsequent ChainDataBundle responses (reorg detection).
 *
 *   - Per-watch confirmation streams (RegisterConfirmationsNtfn) opened on
 *     first RegisterWatchTx for a given txid. Multiple peers watching the
 *     same txid share one upstream stream (peerSubscribers set). When LND
 *     reports the tx confirmed, FundingTxConfirmed (32807) is sent to each
 *     subscriber.
 *
 *   - Per-outpoint spend streams (RegisterSpendNtfn) opened on first
 *     RegisterWatchOutput for a given outpoint. When LND reports the
 *     outpoint spent, ChannelStateUpdate (32811, state=ForceCloseInitiated)
 *     is sent to each subscriber.
 *
 *   - Real BroadcastTx handler. Calls walletrpc.PublishTransaction,
 *     classifies the response into Relayed / Rejected / Unavailable, and
 *     replies with BroadcastAck (32819).
 *
 *   - Stream lifecycle: streams are reference-counted by peerSubscribers
 *     set. On peer expiry / bridge shutdown, sets are cleared and streams
 *     with no remaining subscribers are stopped. No orphan streams remain
 *     after a clean stop().
 *
 *   - Tip cache: ChainDataBundle now reads tip from the live block-stream
 *     cache when available, falling back to /v1/getinfo only if the stream
 *     hasn't fired yet. recent_blockhashes populated from rolling buffer.
 *
 * Inbound message coverage (full):
 *   32801 SubscribeChainData    → record peer registry, send ChainDataBundle
 *   32813 RegisterWatchTx       → record + ensure confStream
 *   32815 RegisterWatchOutput   → record + ensure spendStream
 *   32817 BroadcastTx           → publishTransaction + send BroadcastAck
 *
 * Outbound messages produced:
 *   32803 ChainDataBundle       (in response to SubscribeChainData)
 *   32805 BlockHeightUpdate     (per new block, fan out to all peers)
 *   32807 FundingTxConfirmed    (per confirmation event)
 *   32811 ChannelStateUpdate    (per spend event, ForceCloseInitiated)
 *   32819 BroadcastAck          (in response to BroadcastTx)
 *
 * Step 4+ deferred: cooperative-close detection (requires correlating spend
 * with peer-disclosed close intent), watchtower extension via BOLT 13.
 */

const https = require('https');
const m = require('./cooperative-chain-msg');
const {
  subscribeCustomMessages,
  sendCustomMessage,
  subscribeBlockEpoch,
  subscribeConfirmations,
  subscribeSpend,
  publishTransaction,
} = require('./lnd-grpc');

// Hardcoded fee fallbacks (sat/vB) used if LND's fee estimator is unreachable.
const FALLBACK_FEE_FAST_SAT_PER_VB   = 30;
const FALLBACK_FEE_MEDIUM_SAT_PER_VB = 15;
const FALLBACK_FEE_SLOW_SAT_PER_VB   = 5;

// Rolling history depth for recent_blockhashes in ChainDataBundle.
// 6 covers the standard 6-confirmation reorg window. LDK uses these to
// detect reorgs that invalidate previously-confirmed channel funding.
const RECENT_BLOCKHASHES_DEPTH = 6;

// Default num_confs if RegisterWatchTx doesn't specify one. LDK channels
// typically want 3-6 confirmations before is_usable; we default to 1 and
// let the wallet decide if it wants to keep watching after the first.
const DEFAULT_NUM_CONFS = 1;

// Height-hint backoff for confirmation/spend searches. Setting this too far
// back makes LND scan more blocks; too recent and we miss already-confirmed
// txs. 1000 blocks ≈ 1 week — wide enough for typical reorg/lookback needs.
const HEIGHT_HINT_LOOKBACK = 1000;


/**
 * Start the cooperative chain-data bridge.
 *
 * @param {Object} opts
 * @param {Object} opts.lightningClient        gRPC Lightning client (custom messages)
 * @param {Object} opts.chainNotifierClient    gRPC ChainNotifier client (Step 3)
 * @param {Object} opts.walletKitClient        gRPC WalletKit client (Step 3)
 * @param {string} opts.hostname               LND REST host (for getinfo/estimatefee)
 * @param {number} opts.port                   LND REST port
 * @param {string} opts.macaroon               Hex-encoded macaroon (REST + gRPC use same one)
 * @returns {{stop, registrySize, registrySnapshot, streamCounts}}
 */
function startBridge(opts) {
  const {
    lightningClient,
    chainNotifierClient,
    walletKitClient,
    hostname,
    port,
    macaroon,
  } = opts;
  if (!lightningClient)     throw new Error('startBridge: lightningClient required');
  if (!chainNotifierClient) throw new Error('startBridge: chainNotifierClient required');
  if (!walletKitClient)     throw new Error('startBridge: walletKitClient required');
  if (!hostname || !port || !macaroon) {
    throw new Error('startBridge: hostname/port/macaroon required for REST helpers');
  }

  // ── State ──────────────────────────────────────────────────────────────────

  // Per-peer subscription registry.
  // peerHex -> {txids: Set<hex>, scripts: Set<hex>, outpoints: Set<txidHex:idx>, subscribed_at: number}
  const registry = new Map();

  // Per-txid confirmation streams. Multiple peers watching the same txid
  // share a single upstream gRPC stream — saves LND-side resources.
  // txidHex -> {handle, peerSubscribers: Set<peerHex>, scriptHex, num_confs}
  const confStreams = new Map();

  // Per-outpoint spend streams. Same sharing model as confStreams.
  // outpointKey ("txidHex:index") -> {handle, peerSubscribers: Set<peerHex>}
  const spendStreams = new Map();

  // Block tip state, populated by the block epoch stream.
  let currentTipHeight = 0;
  let currentTipHash = null;                  // 32-byte buffer or null until first block
  const recentBlockhashes = [];               // newest first, max RECENT_BLOCKHASHES_DEPTH

  // Block stream handle (single, shared across all peers).
  let blockStream = null;

  // Custom message stream handle.
  let customMessageStream = null;

  // ── LND REST helpers (one-shot, not streaming) ─────────────────────────────
  // REST works fine for non-streaming endpoints in this LND build.

  function lndRequest(reqPath, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const headers = {
        'Grpc-Metadata-macaroon': macaroon,
        'Content-Type': 'application/json',
      };
      let payload = null;
      if (body) {
        payload = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const options = { hostname, port, path: reqPath, method, rejectUnauthorized: false, headers };
      const req = https.request(options, (res) => {
        let respBody = '';
        res.on('data', (c) => { respBody += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(respBody)); }
            catch (e) { reject(new Error(`parse error: ${respBody.slice(0, 200)}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${respBody.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  function sendToPeer(peerHex, typeId, encodedBytes) {
    return sendCustomMessage(lightningClient, {
      peerHex,
      type: typeId,
      dataBase64: encodedBytes.toString('base64'),
    });
  }

  // ── v0.3.3: Stale subscriber eviction ──────────────────────────────────────
  // A peer that has dropped its BOLT connection (e.g., wallet closed, NAT
  // expired, browser tab closed) lingers in registry indefinitely without
  // these helpers, accumulating "peer is not connected" log spam every block.

  const MAX_CONSECUTIVE_SEND_FAILURES = 3;

  function evictPeer(peerHex, reason) {
    if (!registry.has(peerHex)) return;
    registry.delete(peerHex);

    // Walk conf streams: drop this peer from each subscriber set, stop any
    // stream that no peer is watching anymore.
    for (const [txidHex, stream] of confStreams) {
      if (stream.peerSubscribers.delete(peerHex)) {
        if (stream.peerSubscribers.size === 0) {
          try { stream.handle.stop(); } catch (_) {}
          confStreams.delete(txidHex);
          console.log(`[ChainBridge] -conf stream txid=${txidHex.slice(0, 16)}… (no subscribers)`);
        }
      }
    }

    // Walk spend streams: same pattern.
    for (const [key, stream] of spendStreams) {
      if (stream.peerSubscribers.delete(peerHex)) {
        if (stream.peerSubscribers.size === 0) {
          try { stream.handle.stop(); } catch (_) {}
          spendStreams.delete(key);
          console.log(`[ChainBridge] -spend stream outpoint=${key} (no subscribers)`);
        }
      }
    }

    console.log(`[ChainBridge] evicted peer ${shortPeer(peerHex)}: ${reason}`);
  }

  function recordSendSuccess(peerHex) {
    const entry = registry.get(peerHex);
    if (entry) entry.consecutive_failures = 0;
  }

  function recordSendFailure(peerHex, label, e) {
    const entry = registry.get(peerHex);
    if (!entry) return;  // already evicted

    // Only "peer is not connected" / NOT_FOUND counts toward eviction. Other
    // errors (transient gRPC issues, encoding failures, etc.) get logged but
    // don't push toward eviction — they're not signals that the peer is gone.
    const isPeerGone = e && e.message && /peer is not connected|NOT_FOUND/i.test(e.message);
    if (isPeerGone) {
      entry.consecutive_failures = (entry.consecutive_failures || 0) + 1;
      console.warn(`[ChainBridge] ${label} to ${shortPeer(peerHex)} failed (${entry.consecutive_failures}/${MAX_CONSECUTIVE_SEND_FAILURES}): ${e.message}`);
      if (entry.consecutive_failures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        evictPeer(peerHex, `${entry.consecutive_failures} consecutive 'peer not connected' failures`);
      }
    } else {
      console.warn(`[ChainBridge] ${label} to ${shortPeer(peerHex)} failed (transient): ${e.message}`);
    }
  }


  // ── Block epoch stream ─────────────────────────────────────────────────────
  // Single shared stream. Populates tip cache + recent_blockhashes, fans out
  // BlockHeightUpdate to all registered peers.

  function startBlockEpochStream() {
    blockStream = subscribeBlockEpoch(chainNotifierClient, (event) => {
      // event = {hash: Buffer<32>, height: u32}
      if (!Buffer.isBuffer(event.hash) || event.hash.length !== 32) {
        console.error(`[ChainBridge] block epoch event has invalid hash: ${event.hash}`);
        return;
      }
      currentTipHeight = event.height;
      currentTipHash = event.hash;

      // Update rolling history (newest first)
      recentBlockhashes.unshift(event.hash);
      while (recentBlockhashes.length > RECENT_BLOCKHASHES_DEPTH) {
        recentBlockhashes.pop();
      }

      console.log(`[ChainBridge] block ${event.height} ${event.hash.toString('hex').slice(0, 16)}…`);

      // Fan out BlockHeightUpdate to every registered peer.
      if (registry.size === 0) return;
      const update = m.encodeBlockHeightUpdate({
        new_height: event.height,
        new_blockhash: event.hash,
      });
      for (const peerHex of registry.keys()) {
        sendToPeer(peerHex, m.TYPE_BLOCK_HEIGHT_UPDATE, update)
          .then(() => recordSendSuccess(peerHex))
          .catch((e) => recordSendFailure(peerHex, 'BlockHeightUpdate', e));
      }

      // v0.18.5: ALSO push a fresh ChainDataBundle on every new block.
      // BlockHeightUpdate alone wasn't keeping the wallet's `bridge` tip
      // cache current (observed: 8-block lag at the wallet while LSP
      // continued seeing new blocks). Sending the bundle on every block
      // means the wallet's bridge tip stays current independent of which
      // message type it derives the cache from. Small bandwidth cost
      // (~few hundred bytes per peer per block ≈ once per 10 minutes).
      // Best-effort, errors logged inside sendBundleTo.
      for (const peerHex of registry.keys()) {
        sendBundleTo(peerHex, `block ${event.height}`).catch(() => { /* logged */ });
      }
    }, 'BlockEpoch');
  }

  // ── Confirmation stream lifecycle ──────────────────────────────────────────

  function ensureConfStream(txidHex, scriptHex, numConfs) {
    const existing = confStreams.get(txidHex);
    if (existing) return existing;

    const txid = Buffer.from(txidHex, 'hex');
    const script = scriptHex ? Buffer.from(scriptHex, 'hex') : Buffer.alloc(0);
    const heightHint = Math.max(0, currentTipHeight - HEIGHT_HINT_LOOKBACK);

    const handle = subscribeConfirmations(
      chainNotifierClient,
      { txid, script, numConfs, heightHint },
      (event) => {
        if (event.conf) {
          handleConfEvent(txidHex, event.conf);
        } else if (event.reorg) {
          console.warn(`[ChainBridge] tx ${txidHex.slice(0, 16)}… reorged — watch continues`);
          // Stream stays open per LND semantics. Wallet uses recent_blockhashes
          // (in next BlockHeightUpdate or next ChainDataBundle) to detect.
        }
      },
      `Conf:${txidHex.slice(0, 8)}…`
    );

    const entry = {
      handle,
      peerSubscribers: new Set(),
      scriptHex,
      num_confs: numConfs,
    };
    confStreams.set(txidHex, entry);
    console.log(`[ChainBridge] +conf stream txid=${txidHex.slice(0, 16)}… num_confs=${numConfs}`);
    return entry;
  }

  function handleConfEvent(txidHex, conf) {
    // conf = {raw_tx: Buffer, block_hash: Buffer<32>, block_height: u32, tx_index: u32, raw_block: Buffer}
    const stream = confStreams.get(txidHex);
    if (!stream) {
      console.warn(`[ChainBridge] conf event for txid ${txidHex.slice(0, 16)}… but no stream record`);
      return;
    }

    console.log(`[ChainBridge] tx ${txidHex.slice(0, 16)}… confirmed at ${conf.block_height} (${stream.peerSubscribers.size} subscribers)`);

    // Phase 3.7.D - cache the conf payload on the stream entry so late
    // subscribers (e.g., wallet that disconnected mid-confirmation) can
    // be replayed via handleSubscribeChainData.
    const confPayload = {
      txid: Buffer.from(txidHex, 'hex'),
      confirmed_at_height: Number(conf.block_height),
      blockhash_of_confirmation: conf.block_hash,
      confirmations: stream.num_confs,
      raw_tx_bytes: conf.raw_tx || Buffer.alloc(0),
      tx_index: Number(conf.tx_index) || 0,  // Step 3.6 (SCID fix)
    };
    stream.cachedConf = confPayload;
    let encoded;
    try {
      encoded = m.encodeFundingTxConfirmed(confPayload);
    } catch (e) {
      console.error(`[ChainBridge] encodeFundingTxConfirmed failed: ${e.message}`);
      return;
    }

    for (const peerHex of stream.peerSubscribers) {
      sendToPeer(peerHex, m.TYPE_FUNDING_TX_CONFIRMED, encoded)
        .then(() => recordSendSuccess(peerHex))
        .catch((e) => recordSendFailure(peerHex, 'FundingTxConfirmed', e));
    }
  }

  // ── Spend stream lifecycle ─────────────────────────────────────────────────

  function ensureSpendStream(fundingTxidHex, outputIndex, scriptHex) {
    const key = `${fundingTxidHex}:${outputIndex}`;
    const existing = spendStreams.get(key);
    if (existing) return existing;

    const hash = Buffer.from(fundingTxidHex, 'hex');
    const script = scriptHex ? Buffer.from(scriptHex, 'hex') : Buffer.alloc(0);
    const heightHint = Math.max(0, currentTipHeight - HEIGHT_HINT_LOOKBACK);

    const handle = subscribeSpend(
      chainNotifierClient,
      { outpoint: { hash, index: outputIndex }, script, heightHint },
      (event) => {
        if (event.spend) {
          handleSpendEvent(fundingTxidHex, outputIndex, event.spend);
        } else if (event.reorg) {
          console.warn(`[ChainBridge] spend of ${fundingTxidHex.slice(0, 16)}…:${outputIndex} reorged — watch continues`);
        }
      },
      `Spend:${fundingTxidHex.slice(0, 8)}…:${outputIndex}`
    );

    const entry = {
      handle,
      peerSubscribers: new Set(),
    };
    spendStreams.set(key, entry);
    console.log(`[ChainBridge] +spend stream outpoint=${fundingTxidHex.slice(0, 16)}…:${outputIndex}`);
    return entry;
  }

  function handleSpendEvent(fundingTxidHex, outputIndex, spend) {
    // spend = {spending_outpoint, raw_spending_tx, spending_tx_hash, spending_input_index, spending_height}
    const key = `${fundingTxidHex}:${outputIndex}`;
    const stream = spendStreams.get(key);
    if (!stream) return;

    const observedAtHeight = Number(spend.spending_height);
    console.log(`[ChainBridge] outpoint ${fundingTxidHex.slice(0, 16)}…:${outputIndex} SPENT at height ${observedAtHeight} (${stream.peerSubscribers.size} subscribers)`);

    // Send ChannelStateUpdate to each subscriber. The state we report is
    // ForceCloseInitiated by default — chain data alone can't distinguish
    // force-close from cooperative-close. The wallet correlates this with
    // its own pending-close intent (if any) to refine the state. If the
    // wallet had no pending coop-close, ForceCloseInitiated is correct.
    const fundingTxid = Buffer.from(fundingTxidHex, 'hex');

    for (const peerHex of stream.peerSubscribers) {
      let encoded;
      try {
        // counterparty_pubkey field carries the LSP's view: from the wallet's
        // perspective WE are the counterparty, so we send the wallet's own
        // pubkey here (peerHex) — that's the channel's counterparty from the
        // recipient wallet's perspective, mirroring what they'd find locally.
        encoded = m.encodeChannelStateUpdate({
          counterparty_pubkey: Buffer.from(peerHex, 'hex'),
          funding_txid: fundingTxid,
          state: 'ForceCloseInitiated',
          observed_at_height: observedAtHeight,
        });
      } catch (e) {
        console.error(`[ChainBridge] encodeChannelStateUpdate failed: ${e.message}`);
        continue;
      }
      sendToPeer(peerHex, m.TYPE_CHANNEL_STATE_UPDATE, encoded)
        .then(() => recordSendSuccess(peerHex))
        .catch((e) => recordSendFailure(peerHex, 'ChannelStateUpdate', e));
    }
  }

  // ── ChainDataBundle assembly ───────────────────────────────────────────────

  async function estimateFee(targetConf, fallbackSatPerVb) {
    try {
      const res = await lndRequest(`/v2/wallet/estimatefee/${targetConf}`);
      const satPerKw = parseInt(res.sat_per_kw, 10);
      if (!Number.isFinite(satPerKw) || satPerKw <= 0) return fallbackSatPerVb;
      return Math.max(4, Math.ceil(satPerKw / 250));
    } catch (e) {
      console.warn(`[ChainBridge] fee estimate (conf=${targetConf}) failed: ${e.message} — using fallback ${fallbackSatPerVb} sat/vB`);
      return fallbackSatPerVb;
    }
  }

  async function buildChainDataBundle() {
    // Prefer the live block-stream cache. Fall back to /v1/getinfo only if
    // the stream hasn't fired yet (early bridge startup, before the next block).
    let tipHeight = currentTipHeight;
    let tipHash = currentTipHash;

    if (!tipHeight || !tipHash) {
      const info = await lndRequest('/v1/getinfo');
      tipHeight = parseInt(info.block_height, 10);
      tipHash = Buffer.from(info.block_hash, 'hex');
      if (!Number.isFinite(tipHeight) || tipHash.length !== 32) {
        throw new Error(`getinfo returned invalid tip: height=${info.block_height} hash_len=${tipHash.length}`);
      }
      // Seed the cache so subsequent ChainDataBundles don't re-fetch.
      currentTipHeight = tipHeight;
      currentTipHash = tipHash;
      if (recentBlockhashes.length === 0) {
        recentBlockhashes.push(tipHash);
      }
    }

    const fast   = await estimateFee(1,   FALLBACK_FEE_FAST_SAT_PER_VB);
    const medium = await estimateFee(6,   FALLBACK_FEE_MEDIUM_SAT_PER_VB);
    const slow   = await estimateFee(144, FALLBACK_FEE_SLOW_SAT_PER_VB);

    return {
      tip_height: tipHeight,
      tip_blockhash: tipHash,
      // Pass a copy so encoder can't mutate our rolling buffer.
      recent_blockhashes: recentBlockhashes.slice(),
      fee_sat_per_vb_fast: fast,
      fee_sat_per_vb_medium: medium,
      fee_sat_per_vb_slow: slow,
    };
  }

  // v0.18.5: Helper to build + send a ChainDataBundle to a single peer.
  // Extracted from handleSubscribeChainData so the block-epoch handler can
  // also push fresh bundles on every new block (addresses bridge-tip staleness
  // observed at the wallet — BlockHeightUpdate alone wasn't keeping the
  // wallet's bridge tip cache current). Used both for subscription-time
  // initial bundles AND on every new block fan-out.
  // Errors are logged but not propagated; bundle delivery is best-effort.
  async function sendBundleTo(peerHex, contextLabel) {
    try {
      const bundle = await buildChainDataBundle();
      const encoded = m.encodeChainDataBundle(bundle);
      await sendToPeer(peerHex, m.TYPE_CHAIN_DATA_BUNDLE, encoded);
      console.log(`[ChainBridge] sent ChainDataBundle to ${shortPeer(peerHex)} (${contextLabel}): tip=${bundle.tip_height} fees=${bundle.fee_sat_per_vb_fast}/${bundle.fee_sat_per_vb_medium}/${bundle.fee_sat_per_vb_slow} sat/vB recent_blocks=${bundle.recent_blockhashes.length}`);
      recordSendSuccess(peerHex);
    } catch (e) {
      console.error(`[ChainBridge] failed to send ChainDataBundle to ${shortPeer(peerHex)} (${contextLabel}): ${e.message}`);
      recordSendFailure(peerHex, 'ChainDataBundle', e);
    }
  }

  // ── Inbound message handlers ───────────────────────────────────────────────

  async function handleSubscribeChainData(peerHex, msg) {
    const txids = new Set();
    const scripts = new Set();
    for (const t of msg.watch_txids) txids.add(t.toString('hex'));
    for (const s of msg.watch_scripts) scripts.add(s.toString('hex'));

    registry.set(peerHex, {
      txids,
      scripts,
      outpoints: new Set(),
      subscribed_at: Date.now(),
      consecutive_failures: 0,
    });

    console.log(`[ChainBridge] SubscribeChainData peer=${shortPeer(peerHex)} txids=${txids.size} scripts=${scripts.size}`);

    // v0.3.1: Open confirmation streams for each txid in the inline watch list.
    // SubscribeChainData carries the wallet's initial watch list as part of
    // its payload; the LSP treats this as canonical. The wallet ALSO sends
    // separate RegisterWatchTx messages, but those can be dropped by LDK if
    // the BOLT peer connection isn't yet established when LDK's chain_filter
    // callbacks fire (which happens at wallet boot, before connect). By
    // opening streams from SubscribeChainData's payload directly, the LSP
    // stops depending on RegisterWatchTx for first-time stream setup.
    //
    // v0.3.2: Script pairing. LND's RegisterConfirmationsNtfn requires a
    // non-empty script (LND scans blocks by script, uses txid as secondary
    // match). The wallet's chain_filter registers the same funding script
    // TWICE per channel (once for register_tx, once for register_output),
    // so the typical 1-channel payload is 1 txid + 2 (identical) scripts.
    // We pair index-wise, capping at scripts.length-1 so over-indexed txids
    // fall back to the last script. Skip txids that have no scripts at all
    // (LND would reject the stream).
    const txidArr   = msg.watch_txids;
    const scriptArr = msg.watch_scripts;
    for (let i = 0; i < txidArr.length; i++) {
      const txidHex = txidArr[i].toString('hex');
      if (scriptArr.length === 0) {
        console.warn(`[ChainBridge] cannot open conf stream for txid ${txidHex.slice(0, 16)}…: no scripts in SubscribeChainData payload`);
        continue;
      }
      const scriptIdx = Math.min(i, scriptArr.length - 1);
      const scriptHex = scriptArr[scriptIdx].toString('hex');
      const stream = ensureConfStream(txidHex, scriptHex, DEFAULT_NUM_CONFS);
      stream.peerSubscribers.add(peerHex);
      // Phase 3.7.D - replay cached conf to late subscribers (e.g., wallet
      // reconnected after disconnect mid-confirmation). Without this, the
      // FundingTxConfirmed message is lost forever and the channel deadlocks.
      if (stream.cachedConf) {
        try {
          const replayEncoded = m.encodeFundingTxConfirmed(stream.cachedConf);
          sendToPeer(peerHex, m.TYPE_FUNDING_TX_CONFIRMED, replayEncoded).catch((e) =>
            console.warn(`[ChainBridge] replayed FundingTxConfirmed to ${shortPeer(peerHex)} failed: ${e.message}`));
          console.log(`[ChainBridge] replayed cached FundingTxConfirmed to ${shortPeer(peerHex)} for txid=${txidHex.slice(0, 16)}`);
        } catch (e) {
          console.error(`[ChainBridge] replay encode failed for txid ${txidHex.slice(0, 16)}: ${e.message}`);
        }
      }
    }

    try {
      await sendBundleTo(peerHex, 'subscribe');
    } catch (_) { /* already logged inside sendBundleTo */ }
  }

  function handleRegisterWatchTx(peerHex, msg) {
    let entry = registry.get(peerHex);
    if (!entry) {
      console.warn(`[ChainBridge] RegisterWatchTx from ${shortPeer(peerHex)} before SubscribeChainData — creating entry`);
      entry = { txids: new Set(), scripts: new Set(), outpoints: new Set(), subscribed_at: Date.now(), consecutive_failures: 0 };
      registry.set(peerHex, entry);
    }
    const txidHex   = msg.txid.toString('hex');
    const scriptHex = msg.script_pubkey.toString('hex');
    entry.txids.add(txidHex);
    entry.scripts.add(scriptHex);

    // Open or join the conf stream for this txid. v0.3 NEW.
    // Note: msg has no num_confs field in our wire format — use default.
    // If different peers want different conf depths for the same txid,
    // we use whichever peer asked first (since the stream is shared).
    const stream = ensureConfStream(txidHex, scriptHex, DEFAULT_NUM_CONFS);
    stream.peerSubscribers.add(peerHex);

    console.log(`[ChainBridge] +watch_tx peer=${shortPeer(peerHex)} txid=${txidHex.slice(0, 16)}…`);
  }

  function handleRegisterWatchOutput(peerHex, msg) {
    let entry = registry.get(peerHex);
    if (!entry) {
      console.warn(`[ChainBridge] RegisterWatchOutput from ${shortPeer(peerHex)} before SubscribeChainData — creating entry`);
      entry = { txids: new Set(), scripts: new Set(), outpoints: new Set(), subscribed_at: Date.now(), consecutive_failures: 0 };
      registry.set(peerHex, entry);
    }
    const fundingTxidHex = msg.funding_txid.toString('hex');
    const outputIndex    = Number(msg.output_index);
    const key            = `${fundingTxidHex}:${outputIndex}`;
    const scriptHex      = msg.script_pubkey.toString('hex');
    entry.outpoints.add(key);
    entry.scripts.add(scriptHex);

    // Open or join the spend stream for this outpoint. v0.3 NEW.
    const stream = ensureSpendStream(fundingTxidHex, outputIndex, scriptHex);
    stream.peerSubscribers.add(peerHex);

    console.log(`[ChainBridge] +watch_output peer=${shortPeer(peerHex)} outpoint=${fundingTxidHex.slice(0, 16)}…:${outputIndex}`);
  }

  async function handleBroadcastTx(peerHex, msg) {
    const requestId = msg.request_id;
    const rawTx     = msg.raw_tx;
    console.log(`[ChainBridge] BroadcastTx peer=${shortPeer(peerHex)} request_id=${requestId} raw_tx_len=${rawTx.length}`);

    // v0.3 NEW: real broadcast via PublishTransaction. Classify result
    // into BroadcastAck Relayed/Rejected/Unavailable per Decision 5.
    let result, detail;
    try {
      const response = await publishTransaction(walletKitClient, rawTx, `lij-broadcast:${requestId}`);
      const publishError = (response && response.publish_error) || '';

      if (!publishError) {
        result = 'Relayed';
        detail = '';
      } else if (/already in mempool|already known|already confirmed|transaction already exists/i.test(publishError)) {
        // Idempotent re-broadcast — treat as success since the tx is already on the network.
        result = 'Relayed';
        detail = `idempotent: ${publishError}`.slice(0, 200);
      } else if (/insufficient fee|min relay fee|absurdly low fee|dust|min fee not met/i.test(publishError)) {
        result = 'Rejected';
        detail = publishError.slice(0, 200);
      } else if (/non-final|bad-txns-inputs-missingorspent|missing inputs/i.test(publishError)) {
        result = 'Rejected';
        detail = publishError.slice(0, 200);
      } else {
        // Unknown error class — Unavailable, suggesting wallet should retry later.
        result = 'Unavailable';
        detail = publishError.slice(0, 200);
      }
    } catch (e) {
      result = 'Unavailable';
      detail = `gRPC error: ${e.message || 'unknown'}`.slice(0, 200);
    }

    console.log(`[ChainBridge] BroadcastAck request_id=${requestId} result=${result}${detail ? ' detail=' + detail : ''}`);
    try {
      const ack = m.encodeBroadcastAck({ request_id: requestId, result, detail });
      await sendToPeer(peerHex, m.TYPE_BROADCAST_ACK, ack);
    } catch (e) {
      console.error(`[ChainBridge] failed to send BroadcastAck to ${shortPeer(peerHex)}: ${e.message}`);
    }
  }

  // ── Inbound dispatch ───────────────────────────────────────────────────────

  function onCustomMessage(event) {
    const peerHex = event.peer;
    const typeId  = parseInt(event.type, 10);
    // 0.73.0: a custom message from a peer is contact — the lease's proof of life.
    try { if (typeof opts.onPeerActivity === 'function') opts.onPeerActivity(peerHex, typeId); } catch (_) {}

    // Filter to LiJ-reserved range (32801..=32819).
    if (!Number.isFinite(typeId) || typeId < 32801 || typeId > 32819) {
      return;
    }

    let bytes;
    try { bytes = Buffer.from(event.data, 'base64'); }
    catch (e) {
      console.error(`[ChainBridge] base64 decode failed for type=${typeId}: ${e.message}`);
      return;
    }

    let decoded;
    try { decoded = m.decodeByType(typeId, bytes); }
    catch (e) {
      console.error(`[ChainBridge] decode failed type=${typeId} peer=${shortPeer(peerHex)}: ${e.message}`);
      return;
    }
    if (!decoded) {
      console.warn(`[ChainBridge] no decoder for type ${typeId}`);
      return;
    }

    switch (decoded.name) {
      case 'SubscribeChainData':
        handleSubscribeChainData(peerHex, decoded.msg).catch((e) =>
          console.error(`[ChainBridge] handleSubscribeChainData error: ${e.message}`));
        break;
      case 'RegisterWatchTx':
        handleRegisterWatchTx(peerHex, decoded.msg);
        break;
      case 'RegisterWatchOutput':
        handleRegisterWatchOutput(peerHex, decoded.msg);
        break;
      case 'BroadcastTx':
        handleBroadcastTx(peerHex, decoded.msg).catch((e) =>
          console.error(`[ChainBridge] handleBroadcastTx error: ${e.message}`));
        break;
      // The remaining LiJ types (ChainDataBundle, BlockHeightUpdate,
      // FundingTxConfirmed, FeeScheduleUpdate, ChannelStateUpdate, BroadcastAck)
      // are LSP→wallet messages. Should never arrive here at the LSP.
      default:
        console.warn(`[ChainBridge] received unexpected LSP→wallet message at LSP: ${decoded.name}`);
    }
  }

  // ── Wire up streams ────────────────────────────────────────────────────────

  customMessageStream = subscribeCustomMessages(lightningClient, onCustomMessage, 'CustomMessage');
  startBlockEpochStream();

  console.log('[ChainBridge] started — block epoch stream + custom message stream + waiting for inbound LiJ messages');

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    stop: () => {
      // Stop all streams. peerSubscribers are cleared as a side effect of
      // forgetting the maps, no per-stream cleanup needed.
      if (customMessageStream) {
        try { customMessageStream.stop(); } catch (_) {}
        customMessageStream = null;
      }
      if (blockStream) {
        try { blockStream.stop(); } catch (_) {}
        blockStream = null;
      }
      for (const [, entry] of confStreams) {
        try { entry.handle.stop(); } catch (_) {}
      }
      confStreams.clear();
      for (const [, entry] of spendStreams) {
        try { entry.handle.stop(); } catch (_) {}
      }
      spendStreams.clear();
      registry.clear();
      console.log('[ChainBridge] stopped, all streams torn down, registry cleared');
    },
    registrySize: () => registry.size,
    registrySnapshot: () => {
      const out = [];
      for (const [peer, entry] of registry.entries()) {
        out.push({
          peer: shortPeer(peer),
          txid_count: entry.txids.size,
          script_count: entry.scripts.size,
          outpoint_count: entry.outpoints.size,
          subscribed_ago_seconds: Math.floor((Date.now() - entry.subscribed_at) / 1000),
        });
      }
      return out;
    },
    streamCounts: () => ({
      block_stream:    blockStream ? 1 : 0,
      conf_streams:    confStreams.size,
      spend_streams:   spendStreams.size,
      tip_height:      currentTipHeight,
      tip_blockhash:   currentTipHash ? currentTipHash.toString('hex') : null,
      recent_blockhashes_cached: recentBlockhashes.length,
    }),
  };
}

// Truncate a 66-char pubkey hex for log readability.
function shortPeer(hex) {
  if (typeof hex !== 'string') return String(hex);
  if (hex.length <= 20) return hex;
  return hex.slice(0, 16) + '…';
}

module.exports = { startBridge };
