// tatara.js — 0.97.0 (S58, DP 2026-10-12 22:07 "Go ahead with the next steps now"). LIJOX's TATARA — THE PROVIDER'S
// PART OF THE MIX (joinstr v2 pools for LiJ wallets). Design: lightning-in-a-jar docs/design/mix/tatara-adapter-r1.md;
// spec LIJOX-tatara-v0.10.md (§2.1 the provider's 16 steps, §4 the waiting list, §11 the declared limits).
//
// The provider never signs a pool transaction, never holds a pool key or a coin, never reads a pool message, and
// cannot move or stop anyone's money. It keeps the waiting list, wakes the seats, runs (or finds) the pool's private
// relay, forwards other providers' wallets' payouts and coin checks, and keeps a backup copy of the finished
// transactions.
//
//   SWITCH      TATARA_ENABLED=true (default off). Off = every /tatara route answers 404 and the registry record carries
//               no tatara block. On with a value out of bounds = the module stays off and says which value (startup log,
//               Settings report) — it never runs on a value it refused.
//   SLICE 1     (0.97.0) the settings and their bounds; the `tatara` block of the signed registry record
//               (lijox-register:v3 — lij-worker 0.11.0 holds the twin); GET /tatara/info.
//   SLICES 2–3  (0.98.0) the waiting list (tatara-list.js) and its routes, in v0.8's arrangement (below three providers):
//               POST /tatara/seat — signed by the wallet's node key (LND VerifyMessage; the recovered key must be the
//                 claimed one) over "lij-tatara-seat:v1|route|size|seat_pk|ts"; names a fresh seat key;
//               POST /tatara/checkin · leave · pause · resume · open · announce · report — each signed by the seat key
//                 (BIP-340, schnorr.js) over sha256("lij-tatara-<action>:v1|" + the fields joined by "|");
//               every notice a seat is told comes as { body, sig }: the provider's node key (LND SignMessage) over
//                 "lij-tatara-notice:v1|" + seat_id + "|" + body — the phone checks it against the registry record;
//               the start wakes each seat's wallet through the existing web push ({t:"tatara"}, content-free);
//               the list on disk: DATA_DIR/tatara/state.json (written whole, temporary file then rename); after a
//                 restart everything in progress is ended, never continued.
//   SLICE 4     (0.99.0) the pool's private relay at /tatara/relay (tatara-relay.js): a room per attempt, opened at its
//               announcement with the pool's key and the posting token the opened seats were told; closed when the
//               attempt ends (10 minutes after a signed funding).
//   SLICE 5     (0.100.0) forwarding for other providers' pools — POST /tatara/forward/payout (to a relay a registered
//               provider declares; the event checked, sealed, posted with the pool's token), POST /tatara/forward/coin
//               (this provider's coin-check address, else a registered one's); POST /tatara/backup (a seat of the
//               attempt, signed over the funding and the exits) and the backup sender (tatara-forward.js).
//   SLICE 6     (0.103.0, Phase 1b — step 12) channel pools: TATARA_CHANNEL_POOLS=true with TATARA_CHANNEL_SIZES and room on
//               LND for a retry's channels (maxpendingchannels ≥ retries + 1, read from TATARA_LND_CONF); seats on the
//               channel route; the pending channels of channel pools watched and, when their pool can never fund, abandoned
//               (tatara-channels.js).
//   SLICE 7     (0.105.0, DP's item 20) the channel pools' sizes are the provider's own — no longer "one of TATARA_SIZES".
//               (0.105.0 also added TATARA_CLOSE_SIZES and a "close" route for a channel's coin after its close; DP ruled
//               the same day that such a coin sits in the on-chain pools, so 0.105.1 removed them — the record signs v3.)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const schnorr = require('./schnorr.js');
const { createList } = require('./tatara-list');
const { windowLimiter } = require('./wallet-limits');
const { createRelay } = require('./tatara-relay');
const { createForward } = require('./tatara-forward');
const { createRingStore } = require('./tatara-ringstore');
const { createChannelWatch } = require('./tatara-channels');   // 0.103.0
const { createHost } = require('./tatara-host');               // 0.106.0: the provider as host of a public room (Phase 2b)
const { createNostrClient } = require('./tatara-nostr');
const ringSig = require('./tatara-ring');
const secp = require('secp256k1');
const { checkEvent } = require('./nwc.js');

const RELAY_PATH = '/tatara/relay';
const int = (v, d) => { if (v === undefined || v === null || String(v).trim() === '') return d; const s = String(v).trim(); return /^-?[0-9]+$/.test(s) ? Number(s) : NaN; };
const bool = (v, d) => { if (v === undefined || v === null || String(v).trim() === '') return d; const s = String(v).trim().toLowerCase(); return s === 'true' ? true : s === 'false' ? false : null; };
const list = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const parts = String(v).split(',').map((x) => x.trim()).filter(Boolean);
  return parts.map((x) => (/^[0-9]+$/.test(x) ? Number(x) : NaN));
};
const HTTPS_RE = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;

/// The adapter's settings (spec v0.10 §11.1), read and bounds-checked. Answers { enabled, ok, problems, s }: `enabled`
/// = the operator turned it on; `ok` = every value is within bounds (the module runs only when both hold).
/// `ctx` (0.103.0/0.103.2, from readLndRoom): { maxPendingChannels, minChanSize, maxChanSize, lndConf } — LND's own room and
/// channel limits as read from the lnd.conf TATARA_LND_CONF names (null = not read), and that path. MIN/MAX_CHANNEL_SATS
/// play no part since 0.103.2: they govern nothing live, and LND is what accepts or refuses a pool's channel.
function readSettings(env, ctx = {}) {
  const problems = [];
  const s = {
    enabled: bool(env.TATARA_ENABLED, false),
    sizes: list(env.TATARA_SIZES, [50000, 100000, 250000, 1000000]),
    min_people: int(env.TATARA_MIN_PEOPLE, 3),
    max_people: int(env.TATARA_MAX_PEOPLE, 6),
    countdown_s: int(env.TATARA_COUNTDOWN_S, 600),
    wake_window_s: int(env.TATARA_WAKE_WINDOW_S, 180),
    max_retries: int(env.TATARA_MAX_RETRIES, 2),
    strikes: int(env.TATARA_STRIKES, 4),
    max_pools_per_size: int(env.TATARA_MAX_POOLS_PER_SIZE, 3),
    max_pools_total: int(env.TATARA_MAX_POOLS_TOTAL, 10),
    max_list_per_size: int(env.TATARA_MAX_LIST_PER_SIZE, 60),
    max_fee_rate: int(env.TATARA_MAX_FEE_RATE, 20),
    channel_pools: bool(env.TATARA_CHANNEL_POOLS, false),
    channel_sizes: list(env.TATARA_CHANNEL_SIZES, []),
    forward_payouts: bool(env.TATARA_FORWARD_PAYOUTS, true),
    relay_for_others: bool(env.TATARA_RELAY_FOR_OTHERS, true),
    forward_coin_checks: bool(env.TATARA_FORWARD_COIN_CHECKS, true),
    coin_check_url: String(env.TATARA_COIN_CHECK_URL || '').trim(),
    // 0.106.0 (Phase 2b): a queue short of MIN_PEOPLE gets a room on the public Joinstr relay (docs/design/mix/tatara-public-r1.md)
    public_rooms: bool(env.TATARA_PUBLIC_ROOMS, true),
    public_relay: String(env.TATARA_PUBLIC_RELAY || 'wss://relay.primal.net').trim(),
    room_window_s: int(env.TATARA_ROOM_WINDOW_S, 1200),
  };
  const whole = (k, lo, hi, why) => { if (!Number.isSafeInteger(s[k]) || s[k] < lo || s[k] > hi) problems.push(`TATARA_${k.toUpperCase()}=${env['TATARA_' + k.toUpperCase()]} — ${why}`); };
  if (s.enabled === null) problems.push('TATARA_ENABLED must be true or false');
  whole('min_people', 3, 6, 'LiJ pools are 3 to 6 people');
  whole('max_people', 3, 6, 'LiJ pools are 3 to 6 people');
  if (Number.isSafeInteger(s.min_people) && Number.isSafeInteger(s.max_people) && s.min_people > s.max_people) problems.push('TATARA_MIN_PEOPLE is above TATARA_MAX_PEOPLE');
  whole('countdown_s', 60, 86400, 'a whole number of seconds from 60 to 86,400');
  whole('wake_window_s', 60, 3600, 'a whole number of seconds from 60 to 3,600');
  whole('max_retries', 0, 5, 'a whole number from 0 to 5');
  whole('strikes', 1, 20, 'a whole number from 1 to 20');
  whole('max_pools_per_size', 1, 100, 'a whole number from 1 to 100');
  whole('max_pools_total', 1, 1000, 'a whole number from 1 to 1,000');
  whole('max_list_per_size', 3, 10000, 'a whole number from 3 to 10,000');
  whole('max_fee_rate', 1, 1000, 'whole sat/vB from 1 to 1,000');
  if (Number.isSafeInteger(s.max_pools_per_size) && Number.isSafeInteger(s.max_pools_total) && s.max_pools_total < s.max_pools_per_size) problems.push('TATARA_MAX_POOLS_TOTAL is below TATARA_MAX_POOLS_PER_SIZE');
  if (Number.isSafeInteger(s.max_list_per_size) && Number.isSafeInteger(s.max_people) && s.max_list_per_size < s.max_people) problems.push('TATARA_MAX_LIST_PER_SIZE is below TATARA_MAX_PEOPLE');
  // 0.105.0: one rule for every list — whole sats, at least 10,000, at most 12, none twice; kept ascending (the record's order)
  const sizeList = (k, lo) => {
    const v = s[k];
    if (!Array.isArray(v) || v.length < lo || v.length > 12 || !v.every((x) => Number.isSafeInteger(x) && x >= 10000 && x <= 2100000000000000)) { problems.push(`TATARA_${k.toUpperCase()}=${env['TATARA_' + k.toUpperCase()]} — ${lo ? '1' : '0'} to 12 whole sat amounts, each at least 10,000`); return false; }
    const sorted = v.slice().sort((a, b) => a - b);
    if (sorted.some((x, i) => i > 0 && x === sorted[i - 1])) { problems.push(`TATARA_${k.toUpperCase()} names a size twice`); return false; }
    s[k] = sorted;
    return true;
  };
  const sizesOk = sizeList('sizes', 1);
  for (const k of ['channel_pools', 'forward_payouts', 'relay_for_others', 'forward_coin_checks']) if (s[k] === null) problems.push(`TATARA_${k.toUpperCase()} must be true or false`);
  if (!Array.isArray(s.channel_sizes) || s.channel_sizes.some((x) => !Number.isSafeInteger(x))) problems.push('TATARA_CHANNEL_SIZES must be whole sat amounts');
  else if (s.channel_pools !== true && s.channel_sizes.length) problems.push('TATARA_CHANNEL_SIZES is set but TATARA_CHANNEL_POOLS is not true');
  else if (s.channel_pools === true) {
    if (!s.channel_sizes.length) problems.push('TATARA_CHANNEL_POOLS=true needs TATARA_CHANNEL_SIZES');
    else sizeList('channel_sizes', 1);   // 0.105.0: its own list — no longer "one of TATARA_SIZES" (DP's item 20: the routes' pools are sized apart)
    const cs = s.channel_sizes.slice();
    // 0.103.2: the sizes against LND's OWN limits (minchansize / maxchansize from the lnd.conf, LND's defaults when the lines
    // are absent) — the only limits a pool's channel meets. Read with the room below; when the file was not read, the
    // room check speaks and this check stays quiet.
    const lo = ctx.minChanSize, hi = ctx.maxChanSize;
    if (Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && cs.some((x) => x < lo || x > hi)) problems.push(`a channel pool size is outside LND's channel limits (${lo}–${hi} sats: minchansize/maxchansize in ${ctx.lndConf || 'lnd.conf'}, LND's defaults where the line is absent)`);
    s.channel_sizes = cs;
    s.lnd_limits = (Number.isSafeInteger(lo) && Number.isSafeInteger(hi)) ? { min_chan_size: lo, max_chan_size: hi } : null;
    // 0.103.0 (§6.3.6): room for a retry's channels — LND holds one pending inbound channel per peer unless lnd.conf says more
    const need = (Number.isSafeInteger(s.max_retries) ? s.max_retries : 2) + 1;
    const mp = ctx.maxPendingChannels;
    if (!Number.isSafeInteger(mp)) problems.push(`TATARA_CHANNEL_POOLS=true needs LND's maxpendingchannels confirmed at ${need} or more — set TATARA_LND_CONF to the lnd.conf path so the adapter can read it${ctx.lndConf ? ` (${ctx.lndConf}: not readable, or no maxpendingchannels line)` : ''}`);
    else if (mp < need) problems.push(`TATARA_CHANNEL_POOLS=true needs maxpendingchannels ≥ ${need} (retries + 1) in lnd.conf — it is ${mp}`);
  }
  if (s.public_rooms === null) problems.push('TATARA_PUBLIC_ROOMS must be true or false');
  whole('room_window_s', 300, 3600, 'a whole number of seconds from 300 to 3,600');
  if (Number.isSafeInteger(s.room_window_s) && Number.isSafeInteger(s.wake_window_s) && s.room_window_s < 2 * s.wake_window_s) problems.push('TATARA_ROOM_WINDOW_S must be at least twice TATARA_WAKE_WINDOW_S');
  if (!/^wss:\/\/[a-z0-9.-]+(:[0-9]+)?(\/[^\s]*)?$/i.test(s.public_relay) || s.public_relay.length > 200) problems.push('TATARA_PUBLIC_RELAY must be a wss:// address');
  if (s.coin_check_url && (s.coin_check_url.length > 200 || s.coin_check_url.endsWith('/') || !HTTPS_RE.test(s.coin_check_url))) problems.push('TATARA_COIN_CHECK_URL must be a plain https:// address (no trailing slash), or empty');
  return { enabled: s.enabled === true, ok: problems.length === 0, problems, s };
}

/// 0.103.1 (§6.3.6): LND's room for pending inbound channels, read from the lnd.conf at `path` — { maxPendingChannels (null
/// when the path is empty, the file is not readable or has no maxpendingchannels line), lndConf }.
/// 0.103.2: and LND's own channel limits from the same file — { minChanSize, maxChanSize } (null when the file was not
/// read): minchansize, else LND's default 20,000 (funding.MinChanFundingSize); maxchansize, else 16,777,215
/// (funding.MaxBtcFundingAmount, BOLT 2) or 1,000,000,000 when protocol.wumbo-channels=true (MaxBtcFundingAmountWumbo) —
/// lnd v0.21.4-beta config.go ValidateConfig. A maxchansize of 0 means "not set", as in LND.
const LND_MIN_CHAN_SIZE_DEFAULT = 20000, LND_MAX_CHAN_SIZE_DEFAULT = 16777215, LND_MAX_CHAN_SIZE_WUMBO = 1000000000;
function readLndRoom(path) {
  const p = String(path || '').trim();
  const none = { maxPendingChannels: null, minChanSize: null, maxChanSize: null, lndConf: p };
  if (!p) return none;
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const line = (key) => { const m = new RegExp('^\\s*' + key.replace(/[.-]/g, '\\$&') + '\\s*=\\s*([^\\s;#]+)\\s*$', 'mi').exec(txt); return m ? m[1] : null; };
    const num = (v) => (v !== null && /^[0-9]+$/.test(v)) ? Number(v) : null;
    const mp = num(line('maxpendingchannels'));
    const minc = num(line('minchansize')), maxc = num(line('maxchansize'));
    const wumbo = /^(true|1)$/i.test(line('protocol.wumbo-channels') || '');
    return {
      maxPendingChannels: mp,
      minChanSize: minc !== null ? minc : LND_MIN_CHAN_SIZE_DEFAULT,
      maxChanSize: (maxc !== null && maxc > 0) ? maxc : (wumbo ? LND_MAX_CHAN_SIZE_WUMBO : LND_MAX_CHAN_SIZE_DEFAULT),
      lndConf: p,
    };
  } catch (_) { return none; }
}

/// The relay's address: the API server's public host, path /tatara/relay (no new ingress — as /nwc).
function relayUrlOf(publicHttpsUrl) {
  const u = String(publicHttpsUrl || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//.test(u)) return '';
  return u.replace(/^https:/, 'wss:') + RELAY_PATH;
}

/// The `tatara` block of the signed registry record (lijox-register:v3; field order = the worker's TATARA_FIELDS),
/// or null when the module is off or refused. `ringHash`: the current ring's hash (doors, 5a), null until then.
function recordBlock(st, publicHttpsUrl, ringHash = null) {
  if (!st || !st.enabled || !st.ok) return null;
  const s = st.s;
  const relay = relayUrlOf(publicHttpsUrl);
  if (!relay) return null;
  return {
    v: 1, sizes: s.sizes.slice(), min_people: s.min_people, max_people: s.max_people, countdown_s: s.countdown_s,
    wake_window_s: s.wake_window_s, max_retries: s.max_retries, strikes: s.strikes, max_pools_per_size: s.max_pools_per_size,
    max_pools_total: s.max_pools_total, max_list_per_size: s.max_list_per_size, max_fee_rate: s.max_fee_rate,
    channel_pools: !!s.channel_pools, channel_sizes: s.channel_pools ? s.channel_sizes.slice() : [], relay_url: relay,   // 0.103.0: the channel route, when offered
    relay_for_others: !!s.relay_for_others, forward_payouts: !!s.forward_payouts, forward_coin_checks: !!s.forward_coin_checks,
    coin_check_url: s.coin_check_url || null, ring_hash: ringHash || null,
    // 0.106.0: the public rooms are NOT in the record (the worker signs this block field by field — lij-worker 0.12.1's
    // TATARA_FIELDS); a seat learns the room's relay from its wake notice. A record field waits for a worker release.
  };
}

const SKEW_S = 600;
const isHex = (x, n) => typeof x === 'string' && x.length === n && /^[0-9a-f]+$/.test(x);
const sha256 = (str) => crypto.createHash('sha256').update(str, 'utf8').digest();
/// The seat key's signature over an action: BIP-340 over sha256("lij-tatara-<action>:v1|" + fields joined by "|").
function seatMsg(action, fields) { return sha256(`lij-tatara-${action}:v1|` + fields.map(String).join('|')); }
function seatSigOk(seatPk, action, fields, sig) { return isHex(sig, 128) && schnorr.verify(sig, seatMsg(action, fields), seatPk); }
const seatSignedMsg = (route, size, seatPk, ts) => `lij-tatara-seat:v1|${route}|${size}|${seatPk}|${ts}`;
// 0.106.0 (engine v344): a seat that may take a hosted room signs the provider it is for, its switch and its fee cap (thousandths)
const seatSignedMsgV3 = (providerPk, route, size, seatPk, publicOk, feeCapMilli, ts) => `lij-tatara-seat:v3|${providerPk}|${route}|${size}|${seatPk}|${publicOk ? 'true' : 'false'}|${feeCapMilli}|${ts}`;
const noticeMsg = (seatId, body) => `lij-tatara-notice:v1|${seatId}|${body}`;

function createTatara(deps) {
  const {
    env = process.env, log = () => {}, publicHttpsUrl = '', channelLimits = () => ({}),
    dataDir = null, now = () => Date.now(),
    verifyWalletSig = async () => '',      // (msgUtf8, zbase32) → the recovered node key (66 hex) or ''
    signNotice = async () => '',           // (msgUtf8) → the provider node key's zbase32 signature (LND SignMessage)
    sendWakePush = async () => {},         // (walletPubkey, kind) → the existing web push
    listProviders = async () => [],        // 0.100.0: the registry's records (forwarding checks a relay is declared)
    getJson = async () => ({ status: 0, json: null }),   // 0.100.0: an https GET (coin checks; settlement)
    publishTx = async () => ({ ok: false, error: 'no LND' }),   // 0.100.0: LND PublishTransaction (the backup sender)
    sendToSubscription = async () => {},   // 0.101.0: (pushSubscription, payload) → web push to a seat's own wake address (door 1, (b))
    postJson = async () => ({ status: 0, json: null }),   // 0.101.0: an https POST (provider ↔ provider)
    selfPubkey = () => '',                 // 0.101.0: this provider's node key
    onRecordChanged = () => {},            // 0.101.0: the record's ring hash changed (a new week) — register again
    lndRoom = () => ({}),                  // 0.103.0: { maxPendingChannels, lndConf } — LND's room for pending channels, from lnd.conf; 0.103.2: + { minChanSize, maxChanSize }
    pendingChannels = null,                // 0.103.0: async () => ["txid:vout"…] — LND's pending open channels
    abandonChannel = null,                 // 0.103.0: async (txid, vout) → { ok, error } — LND AbandonChannel (i_know_what_i_am_doing)
    watchSpend = null,                     // 0.103.0: ({ txid, vout }, cb) → handle — a ChainNotifier spend stream
    tipHeight = null,                      // 0.103.0: async () => the chain tip
    feeRateSatVb = async () => null,       // 0.106.0: the node's fee estimate (sat/vB, fractions allowed) for a hosted room's rate
    connectPublicRelay = null,             // 0.106.0: (url) → a nostr client (tatara-nostr.js unless the tests hand one in)
  } = deps || {};
  const httpsUrl = () => { try { return String((typeof publicHttpsUrl === 'function' ? publicHttpsUrl() : publicHttpsUrl) || ''); } catch (_) { return ''; } };
  let st = readSettings(env, Object.assign({}, channelLimits() || {}, lndRoom() || {}));
  const on = () => st.enabled && st.ok;
  const nowS = () => Math.floor(now() / 1000);
  const limiter = windowLimiter(600, 600000, now);   // per address: 600 tatara requests per 10 minutes (check-ins run every 2–15 s)
  const ringSeatLimiter = windowLimiter(20, 600000, now);   // 0.101.0: ring-signed seats per address (each costs a walk of the ring — review S58 #3)
  const fwdLimiter = windowLimiter(200, 600000, now);   // 0.100.0: per address: 200 forwards per 10 minutes (a pool's coin checks and one payout)

  // the list, on disk (only when the module runs)
  const DIR = dataDir ? path.join(dataDir, 'tatara') : null;
  const FILE = DIR ? path.join(DIR, 'state.json') : null;
  let list = null;
  if (on()) {
    if (DIR) { try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {} }
    list = createList({
      settings: st.s, now, log,
      newId: () => crypto.randomBytes(16).toString('hex'),
      save: (state) => { if (!FILE) return; const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, FILE); },
      load: () => { if (!FILE) return null; try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return null; } },
    });
  }

  // 0.99.0: the pool's private relay (v0.8's arrangement: this provider's own; tatara-relay.js)
  const relay = createRelay({ path: RELAY_PATH, log, now, enabled: on });
  const ROOM_GRACE_S = 600;   // a room stays 10 minutes after its funding is signed, then goes
  // 0.100.0: forwarding for other providers' pools, and the backup sender (tatara-forward.js)
  const fwd = createForward({ log, now, dataDir: on() ? dataDir : null, settings: () => st.s, ownRelayUrl: () => relayUrlOf(httpsUrl()), listProviders, getJson, publishTx, postJson, selfPubkey });
  // 0.103.0 (Phase 1b, §6.3.4): the pending channels of channel pools — watched, abandoned when their pool can never fund
  const channels = on() && st.s.channel_pools && pendingChannels && abandonChannel && watchSpend && tipHeight
    ? createChannelWatch({ log, now, dataDir, backups: () => fwd.backupsFull(), pendingChannels, abandonChannel, watchSpend, tipHeight })
    : null;
  let lastChannelTick = 0;
  // 0.101.0 (door 1): the Mix-on wallets' Tatara keys and the week's ring
  const RING_MAX = 1000;
  const rings = createRingStore({ dataDir: on() ? dataDir : null, now, max: RING_MAX, log });
  let lastWeek = ringSig.isoWeek(now()).label;
  // 0.101.0: which arrangement — doors when at least three registered providers declare every role (this one included)
  let arr = { at: 0, mode: 'v0.8', providers: [] };
  async function refreshArrangement() {
    arr.at = now();   // in flight: the one-second tick does not start another
    try {
      const rs = await listProviders();
      const full = (rs || []).filter((r) => r && r.tatara && r.tatara.relay_for_others && r.tatara.forward_payouts && (r.tatara.coin_check_url || r.tatara.forward_coin_checks));
      const mode = full.length >= 3 ? 'doors' : 'v0.8';
      if (mode !== arr.mode) log(`[Tatara] arrangement: ${mode === 'doors' ? 'doors 1 and 2 (' + full.length + ' providers declare every role)' : "v0.8's (fewer than three providers declare every role)"}`);
      arr = { at: now(), mode, providers: rs || [] };
    } catch (e) { log(`[Tatara] the registry could not be read for the arrangement: ${e.message}`); arr.at = now(); }
  }
  // 0.101.0 (door 2): an attempt's relay at a random other provider, chosen when its first notice is signed
  const attemptRelay = new Map();   // attempt id → { relay_url, endpoint, pubkey }
  const extRooms = new Map();       // token → expires_at (rooms other providers registered here)
  function relayFor(attemptId) {
    if (arr.mode !== 'doors' || !attemptId) return null;
    if (!attemptRelay.has(attemptId)) {
      const self = String(selfPubkey() || '').toLowerCase();
      const cands = arr.providers.filter((r) => r && r.tatara && r.tatara.relay_for_others && r.tatara.relay_url && r.endpoint && String(r.pubkey || '').toLowerCase() !== self);
      if (!cands.length) return null;
      const pick = cands[crypto.randomInt(cands.length)];
      attemptRelay.set(attemptId, { relay_url: pick.tatara.relay_url, endpoint: String(pick.endpoint).replace(/\/+$/, ''), pubkey: pick.pubkey });
    }
    return attemptRelay.get(attemptId);
  }
  let lastBackupTick = 0;
  // 0.106.0 (Phase 2b): the host of public rooms — a queue short of MIN_PEOPLE announces a room on the public relay
  const host = on() && st.s.public_rooms && list
    ? createHost({ settings: () => st.s, now, log, list, publicRelayUrl: st.s.public_relay, feeRateSatVb, network: 'mainnet',   // 0.106.1: the public joinstr v2 code's word for Bitcoin (peer.rs network_name); 'bitcoin' was refused by it as another network
        coinCheck: async (q) => { const r = await fwd.forwardCoin(q); return r && r.code === 200 ? r.body : null; },   // the provider's own coin check (its filter server, or a registered provider's)
        connect: (url) => (connectPublicRelay ? connectPublicRelay(url) : createNostrClient({ url, log, now })) })
    : null;

  /// The pool's public key from the creator's announcement: a signed nostr event (its author), or the bare pool event.
  function poolKeyOf(announcement) {
    let j; try { j = JSON.parse(announcement); } catch (_) { return null; }
    if (j && typeof j === 'object' && typeof j.sig === 'string') return checkEvent(j) ? null : j.pubkey;
    return j && typeof j.public_key === 'string' && isHex(j.public_key, 64) ? j.public_key : null;
  }

  /// Advance the list's timers and send the wakes. Run every second by the adapter.
  async function tick() {
    if (!list) return { wakes: 0 };
    const { wakes } = list.tick();
    if (now() - lastBackupTick >= 60000) { lastBackupTick = now(); fwd.backupTick().catch((e) => log(`[Tatara] backup sender: ${e.message}`)); }
    if (channels && now() - lastChannelTick >= 60000) { lastChannelTick = now(); channels.tick().catch((e) => log(`[Tatara] channel watch: ${e.message}`)); }   // 0.103.0
    if (now() - arr.at >= 300000) await refreshArrangement();
    // 0.101.0: the week changes — its ring is taken, last week's ring-signed seats end, the record names the new ring
    const wk = ringSig.isoWeek(now()).label;
    if (wk !== lastWeek) { lastWeek = wk; rings.ringOf(wk); list.endWeek(wk); try { onRecordChanged(); } catch (_) {} }
    for (const [tk, exp] of extRooms) if (nowS() > exp) { relay.close(tk, 'its time ran out'); extRooms.delete(tk); }
    for (const aid of Array.from(attemptRelay.keys())) if (!list.attemptOf(aid) && !Object.values(list.state().starts).some((x) => x.attempt_id === aid)) attemptRelay.delete(aid);
    // a room goes when its attempt is over (or 10 minutes after its funding was signed)
    for (const token of relay.tokens()) {
      if (extRooms.has(token)) continue;   // another provider's room: it ends at its time
      const a = list.attemptOf(relay.attemptOfToken(token));
      if (!a) relay.close(token, 'the attempt ended');
      else if (a.phase === 'signed' && nowS() - (a.signed_at || 0) > ROOM_GRACE_S) relay.close(token, 'funding signed');
    }
    if (host) { try { const hw = await host.tick(); if (hw && hw.wakes) wakes.push(...hw.wakes); } catch (e) { log(`[Tatara] the host: ${e.message}`); } }   // 0.106.0
    for (const w of wakes) {
      try {
        if (w.wake && w.wake.kind === 'node') await sendWakePush(w.wake.pk, 'tatara');
        else if (w.wake && w.wake.kind === 'sub') await sendToSubscription(w.wake.sub, { t: 'tatara' });   // 0.101.0: the seat's own wake address
      } catch (e) { log(`[Tatara] wake failed: ${e.message}`); }
    }
    return { wakes: wakes.length };
  }

  // notices are signed with the provider's node key at delivery; a failed signature delivers none (the phone asks again)
  async function signed(seatId, notices) {
    const out = [];
    for (const n of notices) {
      if (n.token) { const ext = relayFor(n.attempt_id); n.relay = ext ? ext.relay_url : relayUrlOf(httpsUrl()); }   // 0.99.0 / 0.101.0: here, or a random other provider's (door 2)
      const body = JSON.stringify(Object.assign({ seat_id: seatId }, n));
      const sig = await signNotice(noticeMsg(seatId, body));
      if (!sig) throw new Error('the provider could not sign a notice');
      out.push({ body, sig });
    }
    return out;
  }

  function startupLines() {
    if (!st.enabled) return ['[Tatara] off (TATARA_ENABLED is not true) — no pools offered, no tatara block in the registry record'];
    if (!st.ok) return ['[Tatara] REFUSED — the module stays off until these are fixed:'].concat(st.problems.map((p) => '[Tatara]   ' + p));
    const s = st.s;
    if (!relayUrlOf(httpsUrl())) return ['[Tatara] REFUSED — PUBLIC_HTTPS_URL is not an https:// address, so there is no relay address to declare'];
    return [`[Tatara] on (the arrangement follows the registry: v0.8's below three providers, doors 1 and 2 at three; ring signatures checked by ${ringSig.backend()}) — sizes ${s.sizes.join(', ')} sats · ${s.min_people}–${s.max_people} people · countdown ${s.countdown_s} s · wake window ${s.wake_window_s} s · retries ${s.max_retries} · strikes ${s.strikes} · fee cap ${s.max_fee_rate} sat/vB · relay ${relayUrlOf(httpsUrl())}` +
      (s.channel_pools ? ` · channel pools ${s.channel_sizes.join(', ')} sats${s.lnd_limits ? ` (LND allows ${s.lnd_limits.min_chan_size}–${s.lnd_limits.max_chan_size})` : ''}` : '') + (s.public_rooms ? ` · public rooms on ${s.public_relay} (${s.room_window_s} s each)` : ' · no public rooms') + ` · forwards payouts ${s.forward_payouts ? 'yes' : 'no'}, coin checks ${s.forward_coin_checks ? 'yes' : 'no'} · relays for others ${s.relay_for_others ? 'yes' : 'no'} · coin checks answered ${s.coin_check_url ? 'at ' + s.coin_check_url : 'no'}`];
  }

  const ACTIONS = { leave: (id) => list.leave(id), pause: (id) => list.pause(id), resume: (id) => list.resume(id) };
  /// 0.103.0: a channel pool of this size is offered.
  const channelOffered = (size) => !!(st.s.channel_pools && Array.isArray(st.s.channel_sizes) && st.s.channel_sizes.includes(size));
  /// 0.105.0: a pool of this size and route is offered — "chain" among TATARA_SIZES, "channel" among the channel sizes
  /// (a channel's coin after its close is an on-chain coin: it seats on the chain route — DP 2026-10-14 16:19).
  const ROUTES = ['chain', 'channel'];
  const routeOffered = (route, size) => route === 'chain' ? st.s.sizes.includes(size) : route === 'channel' ? channelOffered(size) : false;

  /// The routes. GET /tatara/info is public; every POST is signed (the seat by the node key, the rest by the seat key).
  async function handle(req, res, pathname, method, ip, readBody, jsonResponse) {
    if (!pathname.startsWith('/tatara/') && pathname !== '/tatara') return false;
    if (!on()) { jsonResponse(res, { ok: false, reason: 'tatara_off' }, 404); return true; }
    if (pathname === '/tatara/info' && method === 'GET') {
      const r0 = rings.ringOf();
      const block = recordBlock(st, httpsUrl(), r0 ? r0.hash : null);
      jsonResponse(res, { ok: true, slice: '5a', arrangement: arr.mode, week: ringSig.isoWeek(now()).label, settings: block, queues: list ? list.counts() : [] });
      return true;
    }
    // 0.101.0 (door 1): this week's ring — the sorted Tatara keys of this provider's Mix-on wallets
    if (pathname === '/tatara/ring' && method === 'GET') {
      const r0 = rings.ringOf();
      const wk = ringSig.isoWeek(now()).label;
      jsonResponse(res, { ok: true, week: wk, tag: 'lij/tatara/seat/v1/' + wk, keys: r0 ? r0.list : [], hash: r0 ? r0.hash : null });
      return true;
    }
    if (method !== 'POST') { jsonResponse(res, { ok: false, reason: 'not_found' }, 404); return true; }
    // 0.100.0: forwarding for other providers' wallets — unsigned (anyone's phone may ask), rate-limited, never this
    // provider's own pools' business: the payout is sealed, the coin check answered as it came
    if (pathname === '/tatara/forward/payout' || pathname === '/tatara/forward/coin') {
      if (!fwdLimiter.hit(ip).ok) { jsonResponse(res, { ok: false, reason: 'rate_limited' }, 429); return true; }
      let fb; try { fb = await readBody(req); } catch (_) { jsonResponse(res, { ok: false, reason: 'bad_json' }, 400); return true; }
      const out = pathname.endsWith('/payout') ? await fwd.forwardPayout(fb || {}) : await fwd.forwardCoin(fb || {});
      jsonResponse(res, out.body, out.code);
      return true;
    }
    // 0.101.0 (door 2): a phone's seat traffic to its own provider, through this one
    if (pathname === '/tatara/forward/provider') {
      if (!fwdLimiter.hit(ip).ok) { jsonResponse(res, { ok: false, reason: 'rate_limited' }, 429); return true; }
      let fb; try { fb = await readBody(req); } catch (_) { jsonResponse(res, { ok: false, reason: 'bad_json' }, 400); return true; }
      const out = await fwd.forwardProvider(fb || {});
      jsonResponse(res, out.body, out.code);
      return true;
    }
    const action = pathname.slice('/tatara/'.length);
    if (['ring/join', 'ring/leave', 'relay/register'].includes(action)) {
      if (!limiter.hit(ip).ok) { jsonResponse(res, { ok: false, reason: 'rate_limited' }, 429); return true; }
      let rb; try { rb = await readBody(req); } catch (_) { jsonResponse(res, { ok: false, reason: 'bad_json' }, 400); return true; }
      rb = rb || {};
      const rts = Number(rb.ts);
      if (!Number.isSafeInteger(rts) || Math.abs(nowS() - rts) > SKEW_S) { jsonResponse(res, { ok: false, reason: 'stale' }, 400); return true; }
      const pk = String(rb.node_pubkey || '').toLowerCase();
      if (!/^0[23][0-9a-f]{64}$/.test(pk) || !rb.signature) { jsonResponse(res, { ok: false, reason: 'bad_request' }, 400); return true; }
      let msg;
      if (action === 'ring/join') {
        const tk = String(rb.tatara_pk || '');
        let okKey = false; try { okKey = /^0[23][0-9a-f]{64}$/.test(tk) && secp.publicKeyVerify(Buffer.from(tk, 'hex')); } catch (_) {}
        if (!okKey) { jsonResponse(res, { ok: false, reason: 'bad_tatara_key' }, 400); return true; }
        msg = `lij-tatara-ring:v1|join|${tk}|${rts}`;
      } else if (action === 'ring/leave') msg = `lij-tatara-ring:v1|leave|${rts}`;
      else {
        if (!st.s.relay_for_others) { jsonResponse(res, { ok: false, reason: 'not_relaying_for_others' }, 404); return true; }
        const tok = String(rb.token || ''), ppk = String(rb.pool_pk || ''), aid = String(rb.attempt_id || ''), exp = Number(rb.expires_at);
        if (!isHex(tok, 64) || !isHex(ppk, 64) || !isHex(aid, 32) || !Number.isSafeInteger(exp) || exp <= nowS() || exp > nowS() + 7200) { jsonResponse(res, { ok: false, reason: 'bad_request' }, 400); return true; }
        if (!arr.providers.some((r) => r && r.tatara && String(r.pubkey || '').toLowerCase() === pk) || pk === String(selfPubkey() || '').toLowerCase()) { jsonResponse(res, { ok: false, reason: 'not_a_registered_provider' }, 403); return true; }
        msg = `lij-tatara-relay:v1|register|${tok}|${ppk}|${aid}|${exp}|${rts}`;
      }
      let recovered = '';
      try { recovered = await verifyWalletSig(msg, String(rb.signature)); } catch (e) { jsonResponse(res, { ok: false, reason: 'verify_unavailable' }, 503); return true; }
      if (!recovered || recovered !== pk) { jsonResponse(res, { ok: false, reason: 'bad_signature' }, 401); return true; }
      if (action === 'ring/join') { const r = rings.join(pk, String(rb.tatara_pk)); if (r.ok) log(`[Tatara] Mix on for ${pk.slice(0, 8)} (in the ring from ${r.from_week})`); jsonResponse(res, r, r.ok ? 200 : 409); return true; }
      if (action === 'ring/leave') { jsonResponse(res, rings.leave(pk)); return true; }
      relay.open(String(rb.token), String(rb.pool_pk), String(rb.attempt_id));
      extRooms.set(String(rb.token), Number(rb.expires_at));
      log(`[Tatara] a relay room for another provider's pool (${pk.slice(0, 8)}), until ${new Date(Number(rb.expires_at) * 1000).toISOString().slice(11, 16)} UTC`);
      jsonResponse(res, { ok: true });
      return true;
    }
    if (!['seat', 'checkin', 'leave', 'pause', 'resume', 'open', 'announce', 'report', 'backup'].includes(action)) { jsonResponse(res, { ok: false, reason: 'not_found' }, 404); return true; }
    if (!limiter.hit(ip).ok) { jsonResponse(res, { ok: false, reason: 'rate_limited' }, 429); return true; }
    let b;
    try { b = await readBody(req, action === 'backup' ? 2 * 1024 * 1024 : undefined); } catch (_) { jsonResponse(res, { ok: false, reason: 'bad_json' }, 400); return true; }   // 0.105.2 (H1): the backup carries the pool's transactions; every other seat action is small
    b = b || {};
    const ts = Number(b.ts);
    if (!Number.isSafeInteger(ts) || Math.abs(nowS() - ts) > SKEW_S) { jsonResponse(res, { ok: false, reason: 'stale' }, 400); return true; }

    // 0.101.0 (door 1): a ring-signed seat — one of this provider's Mix-on wallets, never which
    if (action === 'seat' && b.ring_sig !== undefined) {
      if (arr.mode !== 'doors') { jsonResponse(res, { ok: false, reason: 'arrangement_v0.8' }, 409); return true; }
      if (!ringSeatLimiter.hit(ip).ok) { jsonResponse(res, { ok: false, reason: 'rate_limited' }, 429); return true; }
      const size = Number(b.size), seatPk = String(b.seat_pk || ''), wakeJson = String(b.wake_json || ''), ringHash = String(b.ring_hash || '');
      let sub = null; try { sub = JSON.parse(wakeJson); } catch (_) {}
      const route = String(b.route || '');
      if (!ROUTES.includes(route) || !Number.isSafeInteger(size) || !isHex(seatPk, 64) || !isHex(ringHash, 64) || !sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || wakeJson.length > 2048) { jsonResponse(res, { ok: false, reason: 'bad_request' }, 400); return true; }
      if (!routeOffered(route, size)) { jsonResponse(res, { ok: false, reason: route === 'chain' ? 'size_not_offered' : 'route_not_offered' }, 409); return true; }   // 0.103.0 · 0.105.0: each route by its own list
      const rf = rings.ringForSeat(ringHash, ts * 1000);
      if (!rf.ok) { jsonResponse(res, rf, 409); return true; }
      const wakeHash = crypto.createHash('sha256').update(wakeJson, 'utf8').digest('hex');
      const m = crypto.createHash('sha256').update(`lij-tatara-seat:v2|${route}|${size}|${seatPk}|${wakeHash}|${ringHash}|${ts}`, 'utf8').digest();   // 0.103.0: the route signed
      let image;
      try { image = ringSig.verify(rf.ring, m, b.ring_sig); } catch (e) { jsonResponse(res, { ok: false, reason: 'bad_ring_signature' }, 401); return true; }
      const r = list.seat({ owner: 'img:' + image, size, route, seatPk, wake: { kind: 'sub', sub }, week: rf.week });
      if (r.ok) log(`[Tatara] ring-signed seat ${r.seat_id.slice(0, 8)} · ${size} sats${route === 'chain' ? '' : ' · ' + route} · one of ${rf.ring.list.length} Mix-on wallets (${rf.week})`);
      jsonResponse(res, r, r.ok ? 200 : 409);
      return true;
    }
    if (action === 'seat') {
      if (arr.mode === 'doors') { jsonResponse(res, { ok: false, reason: 'arrangement_doors' }, 409); return true; }
      const route = String(b.route || ''), size = Number(b.size), seatPk = String(b.seat_pk || ''), pk = String(b.node_pubkey || '').toLowerCase();
      if (!ROUTES.includes(route) || !Number.isSafeInteger(size) || !isHex(seatPk, 64) || !/^0[23][0-9a-f]{64}$/.test(pk) || !b.signature) { jsonResponse(res, { ok: false, reason: 'bad_request' }, 400); return true; }
      if (!routeOffered(route, size)) { jsonResponse(res, { ok: false, reason: route === 'chain' ? 'size_not_offered' : 'route_not_offered' }, 409); return true; }   // 0.103.0 · 0.105.0
      // 0.106.0 (engine v344): a body with `public` signs the v3 message — the provider it is for (this one, or the request
      // was made for another: review 2b #7), the switch and the fee cap (thousandths) are the wallet's word, not the request's
      const v3 = b.public !== undefined || b.fee_cap_milli !== undefined || b.provider_pk !== undefined;
      const publicOk = b.public === true, feeCap = Number(b.fee_cap_milli), forPk = String(b.provider_pk || '').toLowerCase();
      if (v3 && (typeof b.public !== 'boolean' || !Number.isSafeInteger(feeCap) || feeCap < 1000 || feeCap > 100000000 || forPk !== String(selfPubkey() || '').toLowerCase())) { jsonResponse(res, { ok: false, reason: forPk && forPk !== String(selfPubkey() || '').toLowerCase() ? 'for_another_provider' : 'bad_request' }, 400); return true; }
      let recovered = '';
      try { recovered = await verifyWalletSig(v3 ? seatSignedMsgV3(forPk, route, size, seatPk, publicOk, feeCap, ts) : seatSignedMsg(route, size, seatPk, ts), String(b.signature)); } catch (e) { jsonResponse(res, { ok: false, reason: 'verify_unavailable' }, 503); return true; }
      if (!recovered || recovered !== pk) { jsonResponse(res, { ok: false, reason: 'bad_signature' }, 401); return true; }
      const r = list.seat({ owner: pk, size, route, seatPk, wake: { kind: 'node', pk }, publicOk: v3 && publicOk, feeCap: v3 ? feeCap : null });
      if (r.ok) log(`[Tatara] seat ${r.seat_id.slice(0, 8)} · ${size} sats${route === 'chain' ? '' : ' · ' + route} · wallet ${pk.slice(0, 8)}${v3 && publicOk ? ' · public rooms ok (cap ' + (feeCap / 1000) + ' sat/vB)' : ''}`);
      jsonResponse(res, r, r.ok ? 200 : 409);
      return true;
    }

    // 0.100.0: the backup — from a seat of one of this provider's attempts (its key kept with the attempt), signed over the
    // funding and the exits
    if (action === 'backup') {
      const seatId = String(b.seat_id || ''), attemptId = String(b.attempt_id || '');
      const a = list.attemptOf(attemptId);
      const seatPk = a && a.seat_pks ? a.seat_pks[seatId] : null;
      if (!seatPk) { jsonResponse(res, { ok: false, reason: 'not_in_this_attempt' }, 404); return true; }
      const funding = String(b.funding_hex || ''), exits = Array.isArray(b.exits) ? b.exits.map(String) : [];
      const digest = crypto.createHash('sha256').update(funding + '|' + exits.join('|'), 'utf8').digest('hex');
      if (!seatSigOk(seatPk, 'backup', [seatId, attemptId, digest, ts], String(b.sig || ''))) { jsonResponse(res, { ok: false, reason: 'bad_signature' }, 401); return true; }
      const kr = fwd.keepBackup(attemptId, funding, exits);
      jsonResponse(res, kr, kr.ok ? 200 : 400);
      return true;
    }

    // every other action: a seat, its key's signature
    const seatId = String(b.seat_id || '');
    const seat = isHex(seatId, 32) ? list.seatOf(seatId) : null;
    if (!seat) { jsonResponse(res, { ok: false, reason: 'no_such_seat' }, 404); return true; }
    const attemptId = String(b.attempt_id || '');
    const fields = action === 'open' || action === 'report' || action === 'announce' ? [seatId, attemptId] : [seatId];
    const joinPk = action === 'open' && b.join_pk !== undefined ? String(b.join_pk || '') : null;   // 0.106.0: a room's open names the join key, signed
    if (joinPk !== null) { if (!isHex(joinPk, 64)) { jsonResponse(res, { ok: false, reason: 'bad_request' }, 400); return true; } fields.push(joinPk); }
    if (action === 'report') fields.push(String(b.outcome || ''));
    if (action === 'announce') fields.push(crypto.createHash('sha256').update(String(b.announcement || ''), 'utf8').digest('hex'));
    fields.push(ts);
    if (!seatSigOk(seat.seat_pk, action, fields, String(b.sig || ''))) { jsonResponse(res, { ok: false, reason: 'bad_signature' }, 401); return true; }
    if (seat.last_ts && ts < seat.last_ts) { jsonResponse(res, { ok: false, reason: 'stale' }, 400); return true; }
    seat.last_ts = ts;

    let r;
    if (action === 'checkin') {
      r = list.checkin(seatId);
      // 0.107.0 (DP 20:48): the seat's queue's public room, when this node hosts one — strangers in, N, the seconds left —
      // so the phone's seat view can say who is in it (the room's joins are sealed to the room's key; only the host reads them)
      if (r.ok && host && seat && (seat.route || 'chain') === 'chain') { try { const ro = host.roomOf('chain', seat.size); if (ro) r.room = ro; } catch (e) { log(`[Tatara] roomOf: ${e.message}`); } }
      if (r.ok && r.notices && r.notices.length) {
        try { r.notices = await signed(seatId, r.notices); }
        catch (e) { log(`[Tatara] ${e.message} — notices kept for the next check-in`); for (const n of r.notices.reverse()) seat.notices.unshift(n); r.notices = []; r.retry_s = 2; }
      }
    } else if (ACTIONS[action]) r = ACTIONS[action](seatId);
    else if (action === 'open') { r = list.open(seatId, attemptId, joinPk); if (r.ok && joinPk && host) host.noteJoinKey(attemptId, joinPk); }   // 0.106.0: the host answers that key
    else if (action === 'announce') {
      const ann = String(b.announcement || '');
      const poolPk = poolKeyOf(ann);
      if (!poolPk) { jsonResponse(res, { ok: false, reason: 'bad_announcement' }, 400); return true; }
      const a0 = list.attemptOf(attemptId);
      const ext = a0 && a0.creator === seatId ? attemptRelay.get(attemptId) : null;
      if (ext) {
        // 0.101.0 (door 2): the room at the other provider first — no room there, no announcement passed on
        const exp = nowS() + 7200, rts = nowS();
        const sig2 = await signNotice(`lij-tatara-relay:v1|register|${a0.token}|${poolPk}|${attemptId}|${exp}|${rts}`);
        const reg = sig2 ? await postJson(ext.endpoint + '/tatara/relay/register', { token: a0.token, pool_pk: poolPk, attempt_id: attemptId, expires_at: exp, node_pubkey: String(selfPubkey() || '').toLowerCase(), ts: rts, signature: sig2 }) : null;
        if (!reg || reg.status !== 200 || !reg.json || !reg.json.ok) { log(`[Tatara] the relay at ${ext.endpoint} refused the room (${reg ? reg.status : 'no signature'}) — the announcement waits`); jsonResponse(res, { ok: false, reason: 'relay_registration_failed' }, 502); return true; }
      }
      r = list.announce(seatId, attemptId, ann);
      if (r.ok && !ext) { const a = list.attemptOf(attemptId); relay.open(a.token, poolPk, attemptId); }
    }
    else if (action === 'report') r = list.report(seatId, attemptId, String(b.outcome || ''));
    jsonResponse(res, r, r && r.ok ? 200 : 409);
    return true;
  }

  return {
    settings: () => Object.assign({ enabled: st.enabled, ok: st.ok, problems: st.problems.slice(), relay: relayUrlOf(httpsUrl()) }, st.s),
    on,
    recordBlock: () => { if (!on()) return null; const r0 = rings.ringOf(); return recordBlock(st, httpsUrl(), r0 ? r0.hash : null); },
    arrangement: () => arr.mode,
    refreshArrangement,
    startupLines,
    handle,
    tick,
    handleUpgrade: (req, socket, head) => relay.handleUpgrade(req, socket, head),   // 0.99.0: /tatara/relay
    relayRooms: () => relay.rooms(),
    backups: () => fwd.backups(),
    channelWatch: () => (channels ? channels.watched() : null),   // 0.103.0
    summary: () => (list ? { queues: list.counts(), attempts: Object.keys(list.state().attempts).length, starts: Object.keys(list.state().starts).length, rooms: host ? host.summary() : [] } : null),
    rooms: () => (host ? host.summary() : []),   // 0.106.0
    publicRelay: () => (host ? host.relayStats() : null),
  };
}

module.exports = { createTatara, readSettings, readLndRoom, recordBlock, relayUrlOf, seatMsg, seatSignedMsg, seatSignedMsgV3, noticeMsg, RELAY_PATH };
