// 0.137.0 (S72 Tue 2026-11-24): A REQUEST INSIDE THE LIGHTNING CONNECTION, THROUGH THE REAL BRIDGE.
//   node bridge-lsps0.test.js
// The real cooperative-chain-bridge.js and the real lijox-rpc.js; lnd-grpc.js is stood in for (its custom-message
// stream hands the bridge what LND would, its send keeps what the bridge would hand LND). No LND, no network.
const path = require('path');
const grpcPath = require.resolve('./lnd-grpc');
const st = { onEvent: null, sent: [], blocks: null, gone: false };
require.cache[grpcPath] = { id: grpcPath, filename: grpcPath, loaded: true, exports: {
  subscribeCustomMessages: (client, onEvent) => { st.onEvent = onEvent; return { stop() { st.onEvent = null; } }; },
  sendCustomMessage: async (client, { peerHex, type, dataBase64 }) => { if (st.gone) throw new Error('peer is not connected'); st.sent.push({ peerHex, type, data: Buffer.from(dataBase64, 'base64') }); },
  subscribeBlockEpoch: (client, cb) => { st.blocks = cb; return { stop() {} }; },
  subscribeConfirmations: () => ({ stop() {} }), subscribeSpend: () => ({ stop() {} }), publishTransaction: async () => ({}),
} };
const { startBridge } = require('./cooperative-chain-bridge');
const { createLijoxRpc } = require('./lijox-rpc');
const m = require('./cooperative-chain-msg');
let fails = 0;
const ok = (x) => console.log('  ok · ' + x);
const check = (cond, x, extra) => { if (!cond) { fails++; console.log('FAIL · ' + x + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')); } else ok(x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PK = '02' + 'aa'.repeat(32);
const quiet = { log: console.log, warn: console.warn, error: console.error }; const seenLogs = [];
console.log = (...a) => seenLogs.push(a.join(' ')); console.warn = (...a) => seenLogs.push(a.join(' ')); console.error = (...a) => seenLogs.push(a.join(' '));

(async () => {
  let bridge = null; const activity = [];
  const rpc = createLijoxRpc({ version: '0.137.0', log: (x) => seenLogs.push(x), send: (peer, type, buf) => bridge.sendCustom(peer, type, buf) });
  rpc.register('lijox.prefs_set', (caller, params) => ({ status: 200, body: { ok: true, who: caller.pubkey, hold_ms: params.hold_ms } }));
  bridge = startBridge({ lightningClient: {}, chainNotifierClient: {}, walletKitClient: {}, hostname: '127.0.0.1', port: 1, macaroon: 'x',
    onPeerActivity: (peer, type) => activity.push(type), onLsps0: (peer, buf) => rpc.onMessage(peer, buf) });
  const ev = (type, obj) => st.onEvent({ peer: PK.toUpperCase(), type, data: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64') });

  ev(37913, { jsonrpc: '2.0', id: 'h1', method: 'lijox.hello', params: {} }); await sleep(20);
  const a = st.sent[0] && JSON.parse(st.sent[0].data.toString('utf8'));
  check(st.sent.length === 1 && st.sent[0].type === 37913 && st.sent[0].peerHex === PK && a.id === 'h1' && a.result.methods.includes('lijox.prefs_set'), 'g1 a 37913 message from LND\'s stream is answered through LND\'s send, as 37913, to the same peer (its key in lower case)', a);
  check(activity[0] === 37913, 'g2 it counts as contact from the wallet (the lease\'s proof of life), like every custom message');
  st.sent.length = 0;
  ev(37913, { jsonrpc: '2.0', id: 'p1', method: 'lijox.prefs_set', params: { hold_ms: 60000 } }); await sleep(20);
  const b = JSON.parse(st.sent[0].data.toString('utf8'));
  check(b.result.who === PK && b.result.hold_ms === 60000, 'g3 the method\'s function is called with the peer LND named as the caller', b);
  // the chain-data kinds still go where they went
  st.sent.length = 0;
  const sub = m.TYPE_SUBSCRIBE_CHAIN_DATA;
  st.onEvent({ peer: PK, type: sub, data: Buffer.from('00', 'hex').toString('base64') }); await sleep(20);
  check(seenLogs.some((l) => l.includes('[ChainBridge] decode failed type=' + sub) || l.includes('SubscribeChainData')), 'g4 a chain-data message type is still read by the bridge itself', seenLogs.slice(-3));
  st.onEvent({ peer: PK, type: 40001, data: '' }); await sleep(10);
  check(st.sent.length === 0, 'g5 any other type is ignored as before');
  // a peer that has gone: the answer is dropped, nothing throws out of the bridge
  st.gone = true; let threw = false;
  try { ev(37913, { jsonrpc: '2.0', id: 'h2', method: 'lijox.hello', params: {} }); await sleep(20); } catch (_) { threw = true; }
  check(!threw && rpc.stats().dropped_answers === 1, 'g6 an answer LND does not take (the peer has gone) is dropped');
  st.gone = false; bridge.stop();
  // a bridge that is given no path ignores the message
  const st2sent = st.sent.length;
  const b2 = startBridge({ lightningClient: {}, chainNotifierClient: {}, walletKitClient: {}, hostname: '127.0.0.1', port: 1, macaroon: 'x' });
  ev(37913, { jsonrpc: '2.0', id: 'h3', method: 'lijox.hello', params: {} }); await sleep(20);
  check(st.sent.length === st2sent, 'g7 a bridge started without the path ignores a 37913 message');
  b2.stop(); rpc.stop();
  console.log = quiet.log; console.warn = quiet.warn; console.error = quiet.error;
  console.log(fails ? 'FAIL · bridge-lsps0 · ' + fails + ' failed' : 'PASS · bridge-lsps0 (g1–g7)');
  process.exit(fails ? 1 : 0);
})();
