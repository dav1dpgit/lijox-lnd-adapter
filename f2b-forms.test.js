'use strict';
// 0.145.0 (S72 Wed 2026-11-25, F2b — the wallet repo's docs/design/routes/f2b-r1.md): THE CHECKS A WALLET MAKES BEFORE
// IT CONNECTS, INSIDE A CHECK TUNNEL — a short Lightning connection under a key made for one start.
//   node f2b-forms.test.js
// s: the source — the five rows, what a check tunnel's peer is served, its limit by internet address, the tunnel's gate.
// n: the five registrations as the adapter writes them, on a stand-in for the web form: every body handed on AS SENT,
//    the wallet's real key and its signature inside it — never rewritten with the connection's key.
// r: lijox-rpc.js `serves`: a peer on a check tunnel is served the check methods and lijox.hello; any other method
//    answers as a method that does not exist.
// h: checkTunnelHandshake as written, with stand-ins for LND: a one-time key is noted with the tunnel's internet
//    address; a key that HOLDS A CHANNEL gets the tunnel closed; no peer found → nothing noted.
// m: movedWebForm — the web forms of the five never count as moved (they are never refused).
// The tunnel's own behaviour (the frame, the pass, the limit, the 20 seconds) is ws-tunnel.test.js k0–k6. The routes
// behind the five are not changed and keep their own tests (state-route, my-channels, recover-close, peer-storage).
// NOT RUN HERE: a check tunnel against LND; the engine's side (lij-core check_conn.rs has its own tests).
const fs = require('fs'); const path = require('path');
const { createLijoxRpc } = require('./lijox-rpc');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 700) : '')); } else console.log('  ok · ' + m); };
const lift = (head, tail) => { const a = src.indexOf(head); if (a < 0) return null; const b = src.indexOf(tail || '\n}\n', a); return b > a ? src.slice(a, b + (tail || '\n}\n').length) : null; };
const ONE = '02' + 'aa'.repeat(32), WALLET = '03' + 'bb'.repeat(32);   // ONE: the key on the check tunnel; WALLET: the wallet's real key
const J = (x) => JSON.stringify(x);
const FIVE = ['lijox.state', 'lijox.registry_challenge', 'lijox.state_file', 'lijox.my_channels', 'lijox.recover_close'];

(async () => {
  // ── s: the source ──
  const rA = src.indexOf('// (the end of the 0.141.0 registrations)\n'), rB = src.indexOf('// (the end of the 0.142.0 registrations)');
  const block = src.slice(rA, rB);
  const rows = (block.match(/^  \['lijox\.[a-z_]+',/gm) || []).map((x) => x.slice(4, -2));
  check(rows.length === 29 && new Set(rows).size === 29 && J(rows.slice(-5)) === J(FIVE), 's1 the table has 29 rows; the five checks are its last', rows.slice(-6));
  const rowOf = (m) => (block.match(new RegExp("^  \\['" + m.replace('.', '\\.') + "',[^\\n]*$", 'm')) || [''])[0];
  check(FIVE.every((m) => /open: true/.test(rowOf(m)) && !/key:|same:|qkey:|money:/.test(rowOf(m))), 's2 none of the five has a key rule: the body is handed on as the wallet made it, and its web form is never refused', FIVE.map(rowOf));
  check(src.includes("const CHECK_METHODS = new Set(['lijox.hello', 'lijox.state', 'lijox.registry_challenge', 'lijox.state_file', 'lijox.my_channels', 'lijox.recover_close']);") && src.includes("serves: (peerHex, method) => !checkPeerOf(peerHex) || CHECK_METHODS.has(method),"), 's3 a peer on a check tunnel is served the five and lijox.hello only');
  check(src.includes("const viaCheck = viaConn ? checkPeerOf(viaConn) : null;") && src.includes("const ip      = viaCheck ? viaCheck.ip : viaConn ? 'peer:' + viaConn : getClientIp(req);"), 's4 a request inside a check tunnel is limited by the tunnel\'s internet address, not by its key');
  check(src.includes("check: () => { const okc = checkTunnelLimit.hit(clientIp).ok;") && src.includes("if (local.check) { checkTunnelHandshake(local, clientIp)") && /const checkTunnelLimit = windowLimiter\(parseInt\(process\.env\.CHECK_TUNNELS_PER_MIN \|\| '12', 10\) \|\| 12, 60000\);/.test(src), 's5 the tunnel asks the gate (12 check tunnels a minute per internet address) and hands a check tunnel\'s handshake to its own function — no chain data is sent on it');
  for (const fn of ['handleState', 'handlePeerStorage', 'handleMyChannels', 'handleRecoverClose']) {
    const body = lift('async function ' + fn + '(', '\n}\n') || '';
    check(body.length > 200 && !/callerOf|viaConn|CALLER/.test(body), 's6 ' + fn + ' never reads the connection\'s mark: the wallet is the key the body proves');
  }
  check(src.includes("onServed: (peerHex, method) => { if (checkPeerOf(peerHex)) return;"), 's7 a check tunnel\'s key is not counted as a wallet');

  // ── n: the registrations, with a stand-in for the web form ──
  const calls = []; const sent = [];
  const stubForm = { call: async (pk, m, p, body, query) => { calls.push({ pk, m, p, body: body === undefined ? null : body, query: query || null }); return { status: 200, body: { ok: true, n: calls.length } }; } };
  const flagged = new Set();
  const rpc = createLijoxRpc({ version: '0.145.0', send: async (peer, type, buf) => { sent.push(JSON.parse(buf.toString('utf8'))); }, log() {}, serves: (peerHex, method) => !flagged.has(peerHex) || ['lijox.hello'].concat(FIVE).includes(method) });
  const plainParams = (p) => (p && typeof p === 'object' && !Array.isArray(p)) ? p : null; const BAD = (why) => ({ status: 400, body: { ok: false, error: why } });
  new Function('lijoxRpc', 'webForm', 'plainParams', 'BAD', 'nowS', 'moneyCall', 'pendingJitBuys', block)(rpc, stubForm, plainParams, BAD, () => 1800000000, async () => ({ status: 500, body: {} }), new Map());
  const ask = async (method, params, from) => { sent.length = 0; await rpc.onMessage(from || ONE, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'q', method, params }))); return sent[0]; };
  const last = () => calls[calls.length - 1];
  const st = (a) => !a ? null : (a.result !== undefined ? 200 : (a.error ? a.error.code : null));
  const STATE = { node_pubkey: WALLET, at: 1800000000000, signature: 'signed-by-the-wallets-key', channels: { ['a4'.repeat(32) + ':0']: 1788 }, want_pass: true };
  let a = await ask('lijox.state', STATE);
  check(st(a) === 200 && last().pk === ONE && last().m === 'POST' && last().p === '/v1/state' && J(last().body) === J(STATE), 'n1 the statement goes to its web route\'s code AS SENT: the wallet\'s real key and its signature, not the key on the tunnel', last());
  a = await ask('lijox.registry_challenge', { anything: 1 });
  check(st(a) === 200 && last().m === 'GET' && last().p === '/lsps/registry/challenge' && J(last().query) === '{}', 'n2 a challenge is fetched inside the tunnel', last());
  a = await ask('lijox.state_file', { id: 'meta', node_pubkey: WALLET, nonce: 'n1', signature: 's1' });
  check(st(a) === 200 && last().p === '/v1/peer-storage/meta' && J(last().body) === J({ node_pubkey: WALLET, nonce: 'n1', signature: 's1' }), 'n3 the state file: the action is the path\'s tail, the body as sent with its proof (the tail is not in it)', last());
  a = await ask('lijox.state_file', { id: 'put', node_pubkey: WALLET, nonce: 'n2', signature: 's2', version: 7, state_fp: 'f', file_b64: 'AAAA' });
  check(st(a) === 200 && last().p === '/v1/peer-storage/put' && last().body.file_b64 === 'AAAA' && last().body.version === 7 && last().body.id === undefined, 'n4 a put carries its file', last());
  let n0 = calls.length; a = await ask('lijox.state_file', { id: 'delete', node_pubkey: WALLET });
  const a2 = await ask('lijox.state_file', { id: '../state', node_pubkey: WALLET });
  check(st(a) === 400 && st(a2) === 400 && calls.length === n0, 'n5 an action that is not put, meta or get is refused before any route is asked', [a && a.error, a2 && a2.error]);
  a = await ask('lijox.my_channels', { node_pubkey: WALLET, nonce: 'n3', signature: 's3', session: 'x' });
  check(st(a) === 200 && last().p === '/lsps/registry/my-channels' && J(last().body) === J({ node_pubkey: WALLET, nonce: 'n3', signature: 's3', session: 'x' }), 'n6 the channel list: the body as sent', last());
  a = await ask('lijox.recover_close', { node_pubkey: WALLET, nonce: 'n4', signature: 's4' });
  check(st(a) === 200 && last().p === '/lsps/registry/recover-close' && J(last().body) === J({ node_pubkey: WALLET, nonce: 'n4', signature: 's4' }), 'n7 the close in a recovery: the body as sent', last());
  check(calls.every((c) => c.pk === ONE), 'n8 every one of them reached its route as a request inside the tunnel\'s connection (the route sees the mark of the one-time key, and does not use it)');

  // ── r: what a peer on a check tunnel is served ──
  flagged.add(ONE);
  n0 = calls.length;
  a = await ask('lijox.heartbeat', { client_pubkey: ONE });
  const b = await ask('lijox.lnurl_register', { name: 'shop', client_pubkey: ONE });
  const c = await ask('lijox.channel_record', { record: {} });
  check(st(a) === -32601 && st(b) === -32601 && st(c) === -32601 && calls.length === n0 && a.error.message === 'unknown method', 'r1 on a check tunnel any other method answers as a method that does not exist, and no route is asked', [a && a.error, b && b.error]);
  a = await ask('lijox.state', STATE); const hello = await ask('lijox.hello', {});
  check(st(a) === 200 && hello.result && FIVE.every((m) => hello.result.methods.includes(m)), 'r2 the check methods and lijox.hello are served there', hello.result && hello.result.methods.length);
  a = await ask('lijox.heartbeat', { client_pubkey: WALLET }, WALLET);
  check(st(a) === 200 && last().pk === WALLET, 'r3 a wallet\'s own connection is served as before');
  a = await ask('lijox.no_such_thing', {}, WALLET);
  check(st(a) === -32601, 'r4 a method that does not exist: the same answer');

  // ── h: the peer on a check tunnel ──
  const hs = lift('async function checkTunnelHandshake(local, clientIp) {', '\n}\n');
  check(!!hs, 'h0 checkTunnelHandshake is in the adapter');
  if (hs) {
    const mk = ({ found, holds }) => {
      const checkPeers = new Map(), checkCounts = { opened: 0, refused: 0, closed_for_a_channel: 0, not_found: 0 }, closed = [], lines = [];
      const findPeerOn = async () => found ? { peerHex: found, ms: 12 } : null;
      const fn = new Function('findPeerOn', 'lndGet', 'hasChannelWith', 'checkPeers', 'checkCounts', 'CHECK_PEER_MS', 'console', hs + '\nreturn checkTunnelHandshake;')(findPeerOn, async () => ({ peers: [] }), async (pk) => { if (holds === 'throws') throw new Error('LND down'); return !!holds; }, checkPeers, checkCounts, 30000, { log: (m) => lines.push(m), warn: (m) => lines.push(m) });
      const local = { address: '127.0.0.1', port: 50001, alive: () => true, check: true, close: (why) => closed.push(why) };
      return { run: () => fn(local, '203.0.113.9'), checkPeers, checkCounts, closed, lines };
    };
    let H = mk({ found: ONE, holds: false }); await H.run();
    const e = H.checkPeers.get(ONE);
    check(e && e.ip === 'check:203.0.113.9' && e.until > Date.now() + 20000 && H.closed.length === 0, 'h1 a one-time key is noted with the internet address its tunnel came from', e);
    H = mk({ found: WALLET, holds: true }); await H.run();
    check(H.checkPeers.size === 0 && H.closed.length === 1 && /holds a channel/.test(H.closed[0]) && H.checkCounts.closed_for_a_channel === 1 && H.lines.some((l) => /HOLDS A CHANNEL/.test(l)), 'h2 A KEY THAT HOLDS A CHANNEL WITH THIS NODE: the tunnel is closed, the key is not noted, the journal says so', { closed: H.closed, lines: H.lines });
    H = mk({ found: null }); await H.run();
    check(H.checkPeers.size === 0 && H.closed.length === 0 && H.checkCounts.not_found === 1, 'h3 no peer found on the tunnel\'s address: nothing is noted and nothing is closed');
    H = mk({ found: ONE, holds: 'throws' }); await H.run();
    check(H.checkPeers.has(ONE) && H.closed.length === 0, 'h4 LND cannot say whether the key holds a channel: the tunnel stays (a check must not fail because LND is busy)');
  }

  // ── m: movedWebForm ──
  const mvSrc = lift('const MOVED_WEB_BODY = {', "const REFUSE_WEB_FORMS = String(process.env.LIJOX_WEB_FORMS || '').trim().toLowerCase() === 'refuse';\n");
  const tblSrc = src.slice(src.indexOf('const REST142 = ['), src.indexOf('\n];\n', src.indexOf('const REST142 = [')) + 4);
  const before = src.slice(0, src.indexOf('const MOVED_WEB_BODY = {'));
  const maps = ['MOVED_WEB_UNNAMED', 'MOVED_WEB_QUERY_KEY', 'MOVED_WEB_QUERY_CLIENT'].map((nm) => { const i = before.lastIndexOf('const ' + nm + ' = '); return i < 0 ? 'const ' + nm + ' = {};' : before.slice(i, before.indexOf('\n', i) + 1); }).join('\n');
  let movedWebForm = null;
  try { movedWebForm = new Function(tblSrc + '\n' + maps + '\n' + mvSrc + '\nreturn movedWebForm;')(); } catch (e) { check(false, 'm0 movedWebForm could be lifted from the source', String(e.message)); }
  if (movedWebForm) {
    const sp = new URLSearchParams('');
    check(movedWebForm('POST', '/v1/state', sp) === null && movedWebForm('GET', '/lsps/registry/challenge', sp) === null && movedWebForm('POST', '/v1/peer-storage/meta', sp) === null && movedWebForm('POST', '/lsps/registry/my-channels', sp) === null && movedWebForm('POST', '/lsps/registry/recover-close', sp) === null, 'm1 the web forms of the five checks are never refused (LIJOX_WEB_FORMS=refuse leaves them alone)');
    check(movedWebForm('POST', '/lsps/registry/channels', sp) === 'lijox.channel_record', 'm2 the channel record\'s web form still counts as moved');
  }

  console.log(fails ? ('FAIL · f2b-forms · ' + fails) : 'PASS · f2b-forms (the checks before connecting, inside a check tunnel)');
  process.exit(fails ? 1 : 0);
})();
