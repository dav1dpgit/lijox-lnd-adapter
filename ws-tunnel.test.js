// 0.96.0 (S58, DP 2026-10-12 20:18 "Go on Proposals 1, 2, and 3"): THE WALLET'S TUNNEL TO LND (ws-tunnel.js).
//   node ws-tunnel.test.js
// Real sockets on this machine: a WebSocket server running the tunnel, and a TCP server standing in for LND's peer
// port that records what reaches it. Then findPeerOn against made-up ListPeers answers.
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');
const { tunnel, findPeerOn, sameAddress, HANDSHAKE_BYTES } = require('./ws-tunnel');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const bytes = (n, fill) => Buffer.alloc(n, fill);

(async () => {
  // the stand-in for LND's peer port
  const lnd = { conns: [] };
  const lndServer = net.createServer((sock) => {
    const c = { sock, got: [], remote: { address: sock.remoteAddress, port: sock.remotePort }, closed: false };
    sock.on('data', (d) => c.got.push(Buffer.from(d)));
    sock.on('close', () => { c.closed = true; });
    sock.on('error', () => {});
    lnd.conns.push(c);
  });
  await new Promise((r) => lndServer.listen(0, '127.0.0.1', r));
  const lndPort = lndServer.address().port;

  // the adapter's side: every WebSocket goes through tunnel()
  const told = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  const views = [];
  wss.on('connection', (ws) => {
    views.push(tunnel(ws, { host: '127.0.0.1', port: lndPort, log: quiet, quietMs: 700, onHandshake: (local) => told.push(local) }));
  });
  const wsUrl = 'ws://127.0.0.1:' + wss.address().port;
  const openWallet = () => new Promise((resolve, reject) => {
    const c = new WebSocket(wsUrl);
    c.binaryType = 'nodebuffer';
    c.got = [];
    c.on('message', (d) => c.got.push(Buffer.from(d)));
    c.on('open', () => resolve(c));
    c.on('error', reject);
  });

  // t1 — a socket opened early holds nothing at LND
  const w = await openWallet();
  await sleep(250);
  check(lnd.conns.length === 0, 't1 a wallet socket that has not spoken has opened no connection to LND');

  // t2 — the first bytes open the connection; they arrive whole
  w.send(bytes(50, 1));
  await sleep(150);
  check(lnd.conns.length === 1 && Buffer.concat(lnd.conns[0].got).equals(bytes(50, 1)), 't2 the wallet\'s first 50 bytes (act one) open the connection and reach LND whole');
  check(told.length === 0, 't2 the handshake is not over after act one: no peer lookup yet');

  // t3 — LND's answer reaches the wallet
  lnd.conns[0].sock.write(bytes(50, 2));
  await sleep(100);
  check(Buffer.concat(w.got).equals(bytes(50, 2)), 't3 LND\'s 50 bytes (act two) reach the wallet whole');

  // t4 — act three: 116 bytes from the wallet in all → the caller is told the tunnel's own address, once
  w.send(bytes(66, 3));
  await sleep(100);
  check(told.length === 1, 't4 after act three (116 bytes from the wallet) the caller is told, once');
  check(told[0] && told[0].port === lnd.conns[0].remote.port && told[0].address === lnd.conns[0].remote.address,
    't4 the address given is the one LND sees the peer come from (' + (told[0] && told[0].address) + ':' + (told[0] && told[0].port) + ')');
  check(told[0] && told[0].alive() === true, 't4 alive() while the tunnel is up');
  w.send(bytes(30, 4)); w.send(bytes(30, 5));
  await sleep(100);
  check(told.length === 1, 't5 more bytes (Init and the rest) never tell again');
  check(Buffer.concat(lnd.conns[0].got).equals(Buffer.concat([bytes(50, 1), bytes(66, 3), bytes(30, 4), bytes(30, 5)])), 't5 every byte reached LND in order');
  check(HANDSHAKE_BYTES === 116, 't5 the handshake is 116 bytes from the wallet (BOLT 8 acts one and three)');

  // t6 — the wallet closes: LND's side closes, alive() is false
  w.close();
  await sleep(150);
  check(lnd.conns[0].closed && told[0].alive() === false, 't6 the wallet closes: the connection to LND closes and alive() is false');

  // t7 — a burst before TCP has connected (act one, act three, Init in three messages at once) arrives in order
  const w2 = await openWallet();
  const burst = [bytes(50, 6), bytes(66, 7), bytes(40, 8)];
  for (const b of burst) w2.send(b);
  await sleep(200);
  const c2 = lnd.conns[1];
  check(c2 && Buffer.concat(c2.got).equals(Buffer.concat(burst)), 't7 bytes sent while the connection to LND was still opening arrive in order');
  check(told.length === 2 && told[1].port === c2.remote.port, 't7 told once the connection is up, with its address');

  // t8 — LND closes: the wallet's socket closes
  let w2closed = false; w2.on('close', () => { w2closed = true; });
  c2.sock.destroy();
  await sleep(150);
  check(w2closed && told[1].alive() === false, 't8 LND closes: the wallet\'s socket closes and alive() is false');

  // t9 — a socket that never speaks is closed after the quiet time, and LND never saw it
  const before = lnd.conns.length;
  const w3 = await openWallet();
  let w3closed = false; w3.on('close', () => { w3closed = true; });
  await sleep(450);
  check(!w3closed, 't9 still open before the quiet time');
  await sleep(500);
  check(w3closed && lnd.conns.length === before, 't9 closed after the quiet time; nothing reached LND');

  // t10 — finding the LND peer on the tunnel's address
  const PK = '02' + 'ab'.repeat(32);
  check(sameAddress('127.0.0.1:54321', { address: '127.0.0.1', port: 54321 }), 't10 an IPv4 address matches');
  check(sameAddress('[::1]:54321', { address: '::1', port: 54321 }), 't10 an IPv6 address in brackets matches');
  check(sameAddress('127.0.0.1:54321', { address: '::ffff:127.0.0.1', port: 54321 }), 't10 an IPv4 address written as IPv6 matches');
  check(!sameAddress('127.0.0.1:54322', { address: '127.0.0.1', port: 54321 }) && !sameAddress('10.0.0.1:54321', { address: '127.0.0.1', port: 54321 }) &&
        !sameAddress('', { address: '127.0.0.1', port: 54321 }) && !sameAddress('garbage', { address: '127.0.0.1', port: 54321 }),
        't10 another port, another host, nothing or garbage: no match');
  const local = { address: '127.0.0.1', port: 54321, alive: () => true };
  let asks = 0;
  const fast = { sleep: async () => {} };
  let found = await findPeerOn(local, async () => {
    asks++;
    if (asks === 1) throw new Error('LND busy');
    if (asks < 4) return [{ pub_key: '03' + 'cd'.repeat(32), address: '1.2.3.4:9735' }];
    return [{ pub_key: '03' + 'cd'.repeat(32), address: '1.2.3.4:9735' }, { pub_key: PK.toUpperCase(), address: '127.0.0.1:54321' }];
  }, fast);
  check(found && found.peerHex === PK && asks === 4, 't10 asked again until the peer shows (an error is asked again too); its key, lower case');
  asks = 0;
  found = await findPeerOn(local, async () => { asks++; return [{ pub_key: 'nope', address: '127.0.0.1:54321' }]; }, fast);
  check(found === null && asks === 14, 't10 a matching address without a real key is never used; gives up after the schedule (14 asks, ~2 s)');
  let up = true; asks = 0;
  found = await findPeerOn({ address: '127.0.0.1', port: 1, alive: () => up }, async () => { asks++; if (asks === 2) up = false; return []; }, fast);
  check(found === null && asks === 2, 't10 stops asking once the tunnel has closed');

  // t11 — the adapter's pushFirstBundle (read from lij-adapter.js, run with stand-ins): the peer found on the tunnel's
  // address gets one bundle; a refused send is tried again (3 at most); no bridge or no peer = nothing sent
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
    const s = src.indexOf('async function pushFirstBundle(');
    const e = src.indexOf('\n}\n', s) + 3;
    check(s > 0 && /wsTunnel\(ws, \{[\s\S]{0,600}onHandshake: \(local\) => \{ pushFirstBundle\(local\)/.test(src), 't11 the proxy runs every wallet socket through the tunnel and hands the handshake to pushFirstBundle');   // 0.136.0: the gate's lines stand between (600, was 200)
    const run = async (bridge, peers) => {
      const fn = new Function('chainBridge', 'findPeerOn', 'lndGet', 'console', src.slice(s, e) + '\n; return pushFirstBundle;')(
        bridge, (local, lp) => findPeerOn(local, lp, { sleep: async () => {} }), async () => ({ peers }), quiet);
      await fn({ address: '127.0.0.1', port: 40000, alive: () => true });
    };
    const sends = [];
    let refuse = 2;
    await run({ pushBundle: async (pk, label) => { sends.push([pk, label]); return refuse-- <= 0; } }, [{ pub_key: PK, address: '127.0.0.1:40000' }]);
    check(sends.length === 3 && sends.every(([pk, l]) => pk === PK && l === 'handshake'), 't11 refused twice, sent the third time, to the peer on the tunnel\'s address');
    sends.length = 0; refuse = 5;
    await run({ pushBundle: async (pk) => { sends.push(pk); return false; } }, [{ pub_key: PK, address: '127.0.0.1:40000' }]);
    check(sends.length === 3, 't11 three tries at most');
    sends.length = 0;
    await run({ pushBundle: async (pk) => { sends.push(pk); return true; } }, [{ pub_key: PK, address: '127.0.0.1:40001' }]);
    check(sends.length === 0, 't11 no peer on the tunnel\'s address: nothing sent');
    await run(null, [{ pub_key: PK, address: '127.0.0.1:40000' }]);
    ok('t11 no bridge: nothing tried, nothing thrown');
  }

  // ── 0.136.0: the pass at the tunnel's opening (state-marks.js keeps the passes; the real one is used here) ──
  {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { createStateMarks, PASS_FRAME: FRAME } = require('./state-marks');
    const { PASS_FRAME, CLOSE_PASS_REFUSED, CLOSE_PASS_REQUIRED } = require('./ws-tunnel');
    check(PASS_FRAME === FRAME && PASS_FRAME === 'lijox-pass:', 'g0 the tunnel and the marks name the same frame ("lijox-pass:")');
    const PKW = '02' + 'cd'.repeat(32);
    const marks = createStateMarks({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wst-')) });
    let clock = Date.now();
    const newPass = () => { clock += 5; const r = marks.state(PKW, {}, clock, true); if (!r.ok || !r.pass) throw new Error('no pass: ' + JSON.stringify(r)); return r.pass; };
    const serve = async (gate) => {
      const srv = new WebSocketServer({ port: 0, host: '127.0.0.1' });
      await new Promise((r) => srv.on('listening', r));
      const st = { told: [], views: [] };
      srv.on('connection', (ws) => { st.views.push(tunnel(ws, { host: '127.0.0.1', port: lndPort, log: quiet, quietMs: 700, gate, onHandshake: (local) => st.told.push(local) })); });
      st.open = () => new Promise((resolve, reject) => {
        const c = new WebSocket('ws://127.0.0.1:' + srv.address().port);
        c.binaryType = 'nodebuffer'; c.got = []; c.closedWith = null;
        c.on('message', (d) => c.got.push(Buffer.from(d)));
        c.on('close', (code, reason) => { c.closedWith = { code, reason: String(reason || '') }; });
        c.on('open', () => resolve(c)); c.on('error', reject);
      });
      st.close = () => srv.close();
      return st;
    };
    const lndNow = () => lnd.conns.length;

    // g1 — no gate (an adapter that asks nothing): the pass frame is kept back all the same; the bytes pass
    let S = await serve(undefined), n0 = lndNow();
    let c = await S.open();
    c.send(PASS_FRAME + 'ab'.repeat(32)); await sleep(80);
    check(lndNow() === n0, 'g1 a pass frame alone opens nothing to LND');
    c.send(bytes(50, 1)); await sleep(150);
    check(lndNow() === n0 + 1 && Buffer.concat(lnd.conns[n0].got).equals(bytes(50, 1)), 'g1 without a gate the first bytes pass, and the pass frame is NOT among the bytes LND got');
    c.close(); S.close(); await sleep(80);

    // g2 — a good pass: taken once, the bytes pass whole, the wallet key of the pass is told after the handshake
    const gate = { take: (h) => marks.takePass(h), required: () => false };
    S = await serve(gate); n0 = lndNow();
    const p1 = newPass();
    c = await S.open();
    c.send(PASS_FRAME + p1); c.send(bytes(50, 1)); await sleep(150);
    check(lndNow() === n0 + 1 && Buffer.concat(lnd.conns[n0].got).equals(bytes(50, 1)), 'g2 a good pass: the tunnel opens on the first bytes and LND gets exactly those bytes');
    c.send(bytes(66, 3)); await sleep(120);
    check(S.told.length === 1 && S.told[0].passKey === PKW && S.views[0].passKey() === PKW, 'g2 after the handshake the caller is told which wallet key the pass was made for');
    c.close(); await sleep(80);

    // g3 — the same pass a second time: refused, nothing opened to LND
    n0 = lndNow();
    c = await S.open();
    c.send(PASS_FRAME + p1); c.send(bytes(50, 1)); await sleep(200);
    check(lndNow() === n0 && c.closedWith && c.closedWith.code === CLOSE_PASS_REFUSED && /not good \(unknown\)/.test(c.closedWith.reason), 'g3 a pass is good once: the second use closes the WebSocket (4403) and NOTHING reaches LND');

    // g4 — a pass this box never made: refused
    n0 = lndNow();
    c = await S.open();
    c.send(PASS_FRAME + 'ef'.repeat(32)); c.send(bytes(50, 1)); await sleep(200);
    check(lndNow() === n0 && c.closedWith && c.closedWith.code === CLOSE_PASS_REFUSED, 'g4 a pass this box never made: closed (4403), nothing reaches LND');
    c = await S.open(); n0 = lndNow();
    c.send(PASS_FRAME + 'not hex'); c.send(bytes(50, 1)); await sleep(200);
    check(lndNow() === n0 && c.closedWith && c.closedWith.code === CLOSE_PASS_REFUSED && /bad_pass/.test(c.closedWith.reason), 'g4 a pass that is not 64 hex: closed (4403)');

    // g5 — no pass, passes not required: passed through as before (an older wallet)
    n0 = lndNow();
    c = await S.open();
    c.send(bytes(50, 7)); await sleep(150);
    check(lndNow() === n0 + 1 && Buffer.concat(lnd.conns[n0].got).equals(bytes(50, 7)), 'g5 no pass, not required: an older wallet is passed through as before');
    c.close(); S.close(); await sleep(80);

    // g6 — passes required: no pass closes (4401); a good pass passes; an expired one does not
    let t = Date.now();
    const marks2 = createStateMarks({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wst2-')), now: () => t, passTtlMs: 1000 });
    S = await serve({ take: (h) => marks2.takePass(h), required: () => true }); n0 = lndNow();
    c = await S.open();
    c.send(bytes(50, 1)); await sleep(200);
    check(lndNow() === n0 && c.closedWith && c.closedWith.code === CLOSE_PASS_REQUIRED && /a pass is required/.test(c.closedWith.reason), 'g6 passes required and none presented: closed (4401), nothing reaches LND');
    let r6 = marks2.state(PKW, {}, t, true);
    c = await S.open();
    c.send(PASS_FRAME + r6.pass); c.send(bytes(50, 1)); await sleep(150);
    check(lndNow() === n0 + 1, 'g6 passes required and a good one presented: passed through');
    c.close(); await sleep(60);
    t += 10; r6 = marks2.state(PKW, {}, t, true); t += 2000;   // the pass is 2 s old; it was good for 1 s
    n0 = lndNow();
    c = await S.open();
    c.send(PASS_FRAME + r6.pass); c.send(bytes(50, 1)); await sleep(200);
    check(lndNow() === n0 && c.closedWith && c.closedWith.code === CLOSE_PASS_REFUSED && /expired/.test(c.closedWith.reason), 'g6 an expired pass: closed (4403), nothing reaches LND');
    S.close(); await sleep(60);

    // g7 — a text frame AFTER the first bytes is not a pass (the stream is as it was before 0.136.0)
    S = await serve(gate); n0 = lndNow();
    c = await S.open();
    c.send(bytes(50, 1)); await sleep(120);
    c.send(PASS_FRAME + 'ab'.repeat(32)); await sleep(120);
    check(lndNow() === n0 + 1 && Buffer.concat(lnd.conns[n0].got).length === 50 + PASS_FRAME.length + 64, 'g7 after the first bytes nothing is read as a pass');
    c.close(); S.close(); await sleep(60);
  }

  wss.close(); lndServer.close();
  console.log(fails ? 'FAIL · ws-tunnel · ' + fails + ' failed' : 'PASS · ws-tunnel (t1–t11, g0–g7)');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL · ws-tunnel threw: ' + (e && e.stack || e)); process.exit(1); });
