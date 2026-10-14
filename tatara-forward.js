// tatara-forward.js — 0.100.0 (S58 — LIJOX's Tatara step 5, slice 5; design tatara-adapter-r1.md §6–§7): WHAT A PROVIDER
// DOES FOR OTHER PROVIDERS' POOLS, AND THE BACKUP SENDER.
//
//  FORWARDING A PAYOUT (spec v0.10 §5.1). A phone posts its payout registration through a provider that is neither its
//    own nor the pool's relay. Here: { relay_url, token, event } — the relay must be one a registered provider declares
//    in its signed record (never this provider's own), the event a kind-4 nostr event whose id and signature hold and
//    that is tagged with a pool key. It is posted to that relay with the token and the relay's OK is the answer. The
//    content is sealed to the pool key: this provider reads nothing and can change nothing.
//  FORWARDING A COIN CHECK (§7). { txid, vout } answered from this provider's own filter server when it declares one,
//    else from a registered provider's declared coin-check address. The answering server sees this provider, not the
//    wallet. The answer is passed on as it came; the phone checks the proof itself (lij-core tatara::coin).
//  THE BACKUP SENDER (§5.5). The last phone to sign hands this provider the funding transaction and every exit, signed by
//    its seat key. If no member has sent them within 3 minutes this provider sends them (LND PublishTransaction — "already
//    known" counts as sent), retrying every minute; the copy is deleted once the last exit is 6 deep (asked of the
//    provider's own coin-check address), or after 14 days.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocket } = require('ws');
const { checkEvent } = require('./nwc.js');

const isHex = (x, n) => typeof x === 'string' && x.length === n && /^[0-9a-f]+$/.test(x);
const BACKUP_DELAY_S = 180;
const BACKUP_KEEP_S = 14 * 86400;
const SETTLED_CONFS = 6;
const MAX_TX_HEX = 2 * 400000;
const MAX_EXITS = 64;
const txidOf = (hex) => { try { return crypto.createHash('sha256').update(crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest()).digest().reverse().toString('hex'); } catch (_) { return ''; } };
/// The txid of a raw transaction (its witness-free serialization's double hash). Segwit transactions: strip the marker,
/// the flag and the witnesses.
function txid(hex) {
  const b = Buffer.from(hex, 'hex');
  if (b.length > 6 && b[4] === 0x00 && b[5] === 0x01) {
    try {
      let o = 6;
      const varint = () => { const f = b[o++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(o); o += 2; return v; } if (f === 0xfe) { const v = b.readUInt32LE(o); o += 4; return v; } const v = Number(b.readBigUInt64LE(o)); o += 8; return v; };
      const startIns = o;
      const nIn = varint();
      for (let i = 0; i < nIn; i++) { o += 36; const l = varint(); o += l + 4; }
      const nOut = varint();
      for (let i = 0; i < nOut; i++) { o += 8; const l = varint(); o += l; }
      const endOuts = o;
      for (let i = 0; i < nIn; i++) { const items = varint(); for (let j = 0; j < items; j++) { const l = varint(); o += l; } }
      if (o + 4 !== b.length) return '';
      const stripped = Buffer.concat([b.slice(0, 4), b.slice(startIns, endOuts), b.slice(o, o + 4)]);
      return txidOf(stripped.toString('hex'));
    } catch (_) { return ''; }
  }
  return txidOf(hex);
}

function createForward(deps) {
  const {
    log = () => {}, now = () => Date.now(), dataDir = null,
    settings = () => ({}),                 // the module's settings (forward_payouts, forward_coin_checks, coin_check_url)
    ownRelayUrl = () => '',
    listProviders = async () => [],        // the registry's records (v3 ones carry `tatara`)
    getJson = async () => ({ status: 0, json: null }),   // (url) → { status, json } — an https GET, 10 s
    publishTx = async () => ({ ok: false, error: 'no LND' }),   // (hex) → { ok, error }
    wsConnect = (url) => new WebSocket(url),
    postJson = async () => ({ status: 0, json: null }),   // 0.101.0: (url, body) → { status, json } — an https POST, 10 s
    selfPubkey = () => '',                                 // 0.101.0: this provider's node key (never forwarded to itself)
  } = deps || {};
  const nowS = () => Math.floor(now() / 1000);

  // ── the registry's declared relays and coin-check addresses (5-minute copy) ──
  let reg = { at: 0, relays: new Set(), coin: [] };
  async function registry() {
    if (now() - reg.at < 300000 && reg.at) return reg;
    try {
      const rs = await listProviders();
      const relays = new Set(), coin = [];
      for (const r of rs || []) {
        const t = r && r.tatara;
        if (!t) continue;
        if (typeof t.relay_url === 'string' && t.relay_for_others) relays.add(t.relay_url);
        if (typeof t.coin_check_url === 'string' && t.coin_check_url) coin.push(t.coin_check_url);
      }
      reg = { at: now(), relays, coin };
    } catch (e) { log(`[Tatara] the registry could not be read: ${e.message}`); }
    return reg;
  }

  /// Post one event to a relay with a token; answers the relay's OK. 10 s at most.
  function postToRelay(relayUrl, token, ev) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); try { ws.close(); } catch (_) {} resolve(v); } };
      let ws;
      try { ws = wsConnect(relayUrl + '?token=' + token); } catch (e) { resolve({ ok: false, reason: 'relay_unreachable' }); return; }
      const t = setTimeout(() => finish({ ok: false, reason: 'relay_timeout' }), 10000);
      ws.on('open', () => { try { ws.send(JSON.stringify(['EVENT', ev])); } catch (_) { finish({ ok: false, reason: 'relay_unreachable' }); } });
      ws.on('message', (d) => { let m; try { m = JSON.parse(d.toString()); } catch (_) { return; } if (Array.isArray(m) && m[0] === 'OK' && m[1] === ev.id) finish({ ok: m[2] === true, relay_said: String(m[3] || '') }); });
      ws.on('unexpected-response', () => finish({ ok: false, reason: 'relay_refused' }));
      ws.on('error', () => finish({ ok: false, reason: 'relay_unreachable' }));
      ws.on('close', () => finish({ ok: false, reason: 'relay_closed' }));
    });
  }

  async function forwardPayout(b) {
    const s = settings();
    if (!s.forward_payouts) return { code: 404, body: { ok: false, reason: 'not_forwarding' } };
    const relayUrl = String(b.relay_url || ''), token = String(b.token || ''), ev = b.event;
    if (!/^wss:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?\/[A-Za-z0-9._~\/-]*$/.test(relayUrl) || !isHex(token, 64)) return { code: 400, body: { ok: false, reason: 'bad_request' } };
    if (relayUrl === ownRelayUrl()) return { code: 409, body: { ok: false, reason: 'own_relay' } };
    const bad = checkEvent(ev);
    if (bad || ev.kind !== 4 || !ev.tags.some((x) => x.length >= 2 && x[0] === 'p' && isHex(x[1], 64))) return { code: 400, body: { ok: false, reason: 'bad_event' } };
    const r = await registry();
    if (!r.relays.has(relayUrl)) return { code: 409, body: { ok: false, reason: 'relay_not_declared' } };
    const out = await postToRelay(relayUrl, token, ev);
    log(`[Tatara] forwarded a payout to ${relayUrl.replace(/^wss:\/\//, '').split('/')[0]}: ${out.ok ? 'accepted' : 'refused (' + (out.reason || out.relay_said) + ')'}`);
    return { code: out.ok ? 200 : 502, body: out };
  }

  async function forwardCoin(b) {
    const s = settings();
    if (!s.forward_coin_checks) return { code: 404, body: { ok: false, reason: 'not_forwarding' } };
    const tx = String(b.txid || ''), vout = Number(b.vout);
    if (!isHex(tx, 64) || !Number.isSafeInteger(vout) || vout < 0 || vout > 999999) return { code: 400, body: { ok: false, reason: 'bad_request' } };
    let urls = [];
    if (s.coin_check_url) urls = [s.coin_check_url];
    else { const r = await registry(); urls = r.coin.slice().sort(() => Math.random() - 0.5); }
    if (!urls.length) return { code: 503, body: { ok: false, reason: 'no_coin_check_answerer' } };
    for (const u of urls.slice(0, 3)) {
      const a = await getJson(u + '?txid=' + tx + '&vout=' + vout);
      if (a.status === 200 && a.json && a.json.txid === tx) return { code: 200, body: Object.assign({ ok: true }, a.json) };
    }
    return { code: 502, body: { ok: false, reason: 'no_answer' } };
  }

  // ── the backup sender ──
  const DIR = dataDir ? path.join(dataDir, 'tatara', 'backups') : null;
  if (DIR) { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
  const fileOf = (attemptId) => path.join(DIR, attemptId + '.json');
  const readAll = () => { if (!DIR) return []; try { return fs.readdirSync(DIR).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
  const write = (bk) => { if (!DIR) return; const tmp = fileOf(bk.attempt_id) + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(bk)); fs.renameSync(tmp, fileOf(bk.attempt_id)); };

  function keepBackup(attemptId, fundingHex, exits) {
    if (!DIR) return { ok: false, reason: 'no_storage' };
    if (!isHex(attemptId, 32) || typeof fundingHex !== 'string' || !/^[0-9a-f]+$/.test(fundingHex) || fundingHex.length > MAX_TX_HEX) return { ok: false, reason: 'bad_backup' };
    if (!Array.isArray(exits) || !exits.length || exits.length > MAX_EXITS || exits.some((x) => typeof x !== 'string' || !/^[0-9a-f]+$/.test(x) || x.length > MAX_TX_HEX)) return { ok: false, reason: 'bad_backup' };
    const ids = [fundingHex].concat(exits).map(txid);
    if (ids.some((x) => !x)) return { ok: false, reason: 'bad_backup' };
    if (fs.existsSync(fileOf(attemptId))) return { ok: true, kept: 'already' };
    write({ attempt_id: attemptId, received_at: nowS(), txs: [{ hex: fundingHex, txid: ids[0], sent: false }].concat(exits.map((h, i) => ({ hex: h, txid: ids[i + 1], sent: false }))), done: false });
    log(`[Tatara] backup kept for attempt ${attemptId.slice(0, 8)}: the funding ${ids[0].slice(0, 12)}… and ${exits.length} exit(s)`);
    return { ok: true };
  }

  /// Every minute: send what is due; delete what is settled or old.
  async function backupTick() {
    const t = nowS();
    for (const bk of readAll()) {
      if (t - bk.received_at > BACKUP_KEEP_S) { try { fs.unlinkSync(fileOf(bk.attempt_id)); } catch (_) {} log(`[Tatara] backup for ${bk.attempt_id.slice(0, 8)} deleted after 14 days`); continue; }
      if (!bk.done && t - bk.received_at >= BACKUP_DELAY_S) {
        for (const tx of bk.txs) {
          if (tx.sent) continue;
          const r = await publishTx(tx.hex);
          if (r.ok || /already|known|exists|in mempool|confirmed|duplicate/i.test(String(r.error || ''))) tx.sent = true;
          else break;   // the next ones spend this one: wait for it
        }
        if (bk.txs.every((x) => x.sent)) { bk.done = true; log(`[Tatara] backup for ${bk.attempt_id.slice(0, 8)}: the funding and every exit are out (sent or already known)`); }
        write(bk);
      }
      const coinUrl = (settings() || {}).coin_check_url;
      if (bk.done && coinUrl) {
        const last = bk.txs[bk.txs.length - 1];
        const a = await getJson(coinUrl + '?txid=' + last.txid + '&vout=0');
        if (a.status === 200 && a.json && Number(a.json.confirmations) >= SETTLED_CONFS) { try { fs.unlinkSync(fileOf(bk.attempt_id)); } catch (_) {} log(`[Tatara] backup for ${bk.attempt_id.slice(0, 8)}: settled (6 deep) — deleted`); }
      }
    }
  }

  // 0.101.0 (door 2, tatara-adapter-r2.md §3): a phone's seat traffic passed to its waiting-list provider, so that provider
  // sees this one and not the phone. Only to a registered provider whose record offers Tatara, never to itself; the body
  // is passed as it came (each message is signed by the seat's key) and the answer as it came back.
  const PROVIDER_ACTIONS = ['seat', 'checkin', 'leave', 'pause', 'resume', 'open', 'announce', 'report', 'backup'];
  async function forwardProvider(b) {
    const s = settings();
    if (!s.forward_payouts) return { code: 404, body: { ok: false, reason: 'not_forwarding' } };
    const endpoint = String(b.endpoint || '').replace(/\/+$/, ''), action = String(b.action || '');
    if (!/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(endpoint) || !PROVIDER_ACTIONS.includes(action) || !b.body || typeof b.body !== 'object') return { code: 400, body: { ok: false, reason: 'bad_request' } };
    let rs = [];
    try { rs = await listProviders(); } catch (_) {}
    const p = (rs || []).find((r) => r && r.tatara && String(r.endpoint || '').replace(/\/+$/, '') === endpoint);
    if (!p) return { code: 409, body: { ok: false, reason: 'provider_not_declared' } };
    if (String(p.pubkey || '').toLowerCase() === String(selfPubkey() || '').toLowerCase()) return { code: 409, body: { ok: false, reason: 'own_provider' } };
    const a = await postJson(endpoint + '/tatara/' + action, b.body);
    if (!a || !a.status) return { code: 502, body: { ok: false, reason: 'provider_unreachable' } };
    return { code: a.status, body: a.json || { ok: false, reason: 'no_answer' } };
  }

  // 0.103.0: the kept backups with their transactions — the channel watch reads a pool's funding inputs and exit txids
  const backupsFull = () => readAll().map((b) => ({ attempt_id: b.attempt_id, funding_hex: b.txs[0].hex, funding_txid: b.txs[0].txid, exit_txids: b.txs.slice(1).map((x) => x.txid), received_at: b.received_at }));
  return { forwardPayout, forwardCoin, forwardProvider, keepBackup, backupTick, txid, backupsFull, backups: () => readAll().map((b) => ({ attempt_id: b.attempt_id, done: b.done, sent: b.txs.filter((x) => x.sent).length, of: b.txs.length })) };
}

module.exports = { createForward, txid, BACKUP_DELAY_S, BACKUP_KEEP_S };
