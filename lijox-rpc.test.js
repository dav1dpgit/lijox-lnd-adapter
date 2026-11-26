// 0.137.0 (S72 Tue 2026-11-24): REQUESTS INSIDE THE LIGHTNING CONNECTION, THE PROVIDER'S SIDE (lijox-rpc.js).
//   node lijox-rpc.test.js
// The real module with a stand-in for the bridge's send (every message it would hand LND is kept and read back), a
// temp directory for the rid store and a clock the test moves. No LND, no network.
const fs = require('fs'); const os = require('os'); const path = require('path');
const R = require('./lijox-rpc');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')); } else ok(m); };
const PK = '02' + 'aa'.repeat(32), PK2 = '03' + 'bb'.repeat(32);
let t = 1795000000000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-'));

function mk(extra) {
  const sent = [], logs = [], served = [];
  let gone = false;
  const rpc = R.createLijoxRpc(Object.assign({
    dataDir: dir, version: '0.137.0', now: () => t, log: (m) => logs.push(m),
    send: async (peer, type, buf) => { if (gone) throw new Error('peer is not connected'); sent.push({ peer, type, buf }); },
    onServed: (peer, method) => served.push(peer.slice(0, 4) + ':' + method),
  }, extra || {}));
  // the answers a wallet would read: whole messages as they are, parts put together by `of`
  const answers = () => {
    const out = [], held = {};
    for (const s of sent) {
      const j = JSON.parse(s.buf.toString('utf8'));
      if (j.method === 'lijox.part') {
        const k = s.peer + '|' + j.params.of; (held[k] = held[k] || []).push(j.params);
        if (held[k].length === j.params.total) { out.push(Object.assign(JSON.parse(Buffer.concat(held[k].sort((a, b) => a.n - b.n).map((p) => Buffer.from(p.data, 'base64'))).toString('utf8')), { _peer: s.peer, _parts: j.params.total })); delete held[k]; }
      } else out.push(Object.assign(j, { _peer: s.peer }));
    }
    return out;
  };
  const ask = async (peer, obj) => { const n = sent.length; await rpc.onMessage(peer, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')); return sent.slice(n).map((s) => JSON.parse(s.buf.toString('utf8'))); };
  const req = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
  return { rpc, sent, logs, served, answers, ask, req, setGone: (v) => { gone = v; } };
}

(async () => {
  // ── a: the form ──
  {
    const k = mk();
    let a = await k.ask(PK, k.req('a1', 'lijox.hello', {}));
    check(a.length === 1 && a[0].id === 'a1' && a[0].jsonrpc === '2.0' && a[0].result && a[0].result.v === 1 && a[0].result.adapter === '0.137.0' && a[0].result.max_parts === 32 && a[0].result.part_bytes === 44000, 'a1 lijox.hello answers the version, the limits of parts', a);
    check(JSON.stringify(a[0].result.methods) === JSON.stringify(['lijox.hello', 'lijox.what_became', 'lsps0.list_protocols']), 'a2 and the methods this provider serves, sorted (three before any is registered by the adapter)', a[0].result.methods);
    check(k.sent[0].type === 37913 && k.sent[0].peer === PK, 'a3 the answer goes to the peer that asked, as message 37913');
    a = await k.ask(PK, k.req('a4', 'lsps0.list_protocols', {}));
    check(a[0].result && Array.isArray(a[0].result.protocols) && a[0].result.protocols.length === 0, 'a4 LSPS0\'s own method answers an empty list of protocols');
    a = await k.ask(PK, 'not json {');
    check(a.length === 1 && a[0].id === null && a[0].error.code === -32700, 'a5 bytes that are not JSON: −32700 with a null id', a);
    a = await k.ask(PK, { jsonrpc: '1.0', id: 'x', method: 'lijox.hello' });
    check(a[0].error.code === -32600 && a[0].id === 'x', 'a6 not JSON-RPC 2.0: −32600', a);
    a = await k.ask(PK, k.req(7, 'lijox.hello', {}));
    check(a[0].error.code === -32600 && a[0].id === null, 'a7 an id that is not a string: −32600', a);
    a = await k.ask(PK, k.req('a8', 'lijox.nothing', {}));
    check(a[0].error.code === -32601 && a[0].id === 'a8', 'a8 an unknown method: −32601', a);
    a = await k.ask(PK, { jsonrpc: '2.0', id: 'a9', method: 'lijox.hello', params: [1, 2] });
    check(a[0].error.code === -32602, 'a9 params that are not an object: −32602', a);
    a = await k.ask(PK, { jsonrpc: '2.0', id: 'a10', method: 'lijox.hello' });
    check(a[0].result && a[0].result.v === 1, 'a10 params left out are taken as an empty object');
    a = await k.ask(PK, { jsonrpc: '2.0', id: 'a11', result: { x: 1 } });
    check(a.length === 0, 'a11 an answer sent to the provider is not answered (this side asks nothing)');
    a = await k.ask('zz', k.req('a12', 'lijox.hello', {}));
    check(a.length === 0, 'a12 a peer key that is not a key: nothing is done');
    check(k.served.length === 3 && k.served.every((s) => s.startsWith('02aa:')), 'a13 each served request is told to the counter with the caller\'s key', k.served);
  }

  // ── b: both forms give the same answer; the caller is the connection's key ──
  {
    const k = mk();
    const seen = [];
    k.rpc.register('lijox.prefs_set', (caller, params) => { seen.push({ caller, params }); return params.zaps === true ? { status: 409, body: { ok: false, error: 'not_offered', zaps: false, zaps_offered: false } } : { status: 200, body: { ok: true, hold_ms_effective: 180000 } }; });
    let a = await k.ask(PK, k.req('b1', 'lijox.prefs_set', { hold_ms: 21600000, client_pubkey: PK2 }));
    check(a[0].result && a[0].result.ok === true && a[0].result.hold_ms_effective === 180000, 'b1 a 2xx body comes back as the result, unchanged', a);
    check(seen[0].caller.pubkey === PK && Object.keys(seen[0].caller).length === 1, 'b2 the function is called with the CONNECTION\'s key as the caller — a key named in the params is not the caller', seen[0]);
    a = await k.ask(PK, k.req('b3', 'lijox.prefs_set', { zaps: true }));
    check(a[0].error && a[0].error.code === 409 && a[0].error.message === 'not_offered' && a[0].error.data && a[0].error.data.zaps_offered === false && a[0].id === 'b3', 'b3 a refusal comes back as an error: the web status as the code, the body\'s error as the message, the whole body as data', a);
    k.rpc.register('lijox.boom', () => { throw new Error('secret detail'); });
    a = await k.ask(PK, k.req('b4', 'lijox.boom', {}));
    check(a[0].error.code === -32603 && !JSON.stringify(a).includes('secret detail') && k.logs.some((l) => l.includes('failed inside')), 'b4 a function that throws: −32603, its message stays in the journal', a);
    check(JSON.stringify(k.rpc.methodNames()) === JSON.stringify(['lijox.boom', 'lijox.hello', 'lijox.prefs_set', 'lijox.what_became', 'lsps0.list_protocols']), 'b5 a registered method is named by lijox.hello', k.rpc.methodNames());
    let threw = false; try { k.rpc.register('Bad Name', () => 0); } catch (_) { threw = true; }
    check(threw, 'b6 a method name outside word.word is refused at registration');
    const line = k.logs.find((l) => l.includes('lijox.prefs_set'));
    check(!!line && line.includes(PK.slice(0, 16)) && !line.includes(PK) && !line.includes('21600000'), 'b7 the journal line names the method, 16 characters of the key and the status — no params', line);
  }

  // ── c: parts ──
  {
    const k = mk();
    let got = null;
    k.rpc.register('lijox.echo', (caller, params) => { got = params; return { status: 200, body: { len: String(params.blob || '').length, back: params.back ? 'y'.repeat(params.back) : '' } }; });
    const big = k.req('c1', 'lijox.echo', { blob: 'x'.repeat(100000) });
    const fr = R.frames('c1', JSON.stringify(big));
    check(fr.length === 3 && fr.every((f) => f.length < 65533), 'c1 a 100,000-byte request is three parts, each within one Lightning message', fr.map((f) => f.length));
    for (const f of [fr[0], fr[1]]) await k.rpc.onMessage(PK, f);
    check(k.sent.length === 0 && got === null, 'c2 nothing runs and nothing is answered while a part is missing');
    await k.rpc.onMessage(PK, fr[2]);
    check(got && got.blob.length === 100000 && k.answers()[0].result.len === 100000, 'c3 with the last part the request runs once and is answered', k.answers()[0]);
    got = null; k.sent.length = 0;
    const fr2 = R.frames('c4', JSON.stringify(k.req('c4', 'lijox.echo', { blob: 'é'.repeat(60000) })));
    for (const f of [fr2[2], fr2[0], fr2[1]]) await k.rpc.onMessage(PK, f);
    check(got && got.blob === 'é'.repeat(60000), 'c4 parts out of order, cut inside two-byte characters, make the same request');
    k.sent.length = 0;
    await k.ask(PK, k.req('c5', 'lijox.echo', { back: 150000 }));
    const ans = k.answers();
    check(ans.length === 1 && ans[0]._parts === 4 && ans[0].result.back.length === 150000 && ans[0].id === 'c5', 'c5 a long answer goes back in parts and reads whole', { n: ans.length, parts: ans[0] && ans[0]._parts });
    k.sent.length = 0;
    await k.ask(PK, k.req('c6', 'lijox.echo', { back: 1500000 }));
    check(k.answers().length === 1 && k.answers()[0].error.code === -32002, 'c6 an answer that would need more than 32 parts: −32002 in its place', k.answers()[0] && k.answers()[0].error);
    const part = (of, n, total, data) => ({ jsonrpc: '2.0', method: 'lijox.part', params: { of, n, total, data } });
    const D = Buffer.from('abc').toString('base64');
    let a = await k.ask(PK, part('c7', 1, 33, D)); check(a[0].error.code === -32003 && a[0].id === 'c7', 'c7 more than 32 parts: −32003 naming the request', a);
    a = await k.ask(PK, part('c8', 3, 2, D)); check(a[0].error.code === -32003, 'c8 n outside 1 to total: −32003');
    a = await k.ask(PK, part('c9', 1, 2, '***')); check(a[0].error.code === -32003, 'c9 data that is not base64: −32003');
    await k.ask(PK, part('c10', 1, 3, D)); a = await k.ask(PK, part('c10', 1, 3, D));
    check(a[0].error.code === -32003 && !(k.rpc._parts.get(PK) || new Map()).has('c10'), 'c10 the same part twice: −32003 and the request is let go', a);
    await k.ask(PK, part('c11', 1, 3, D)); a = await k.ask(PK, part('c11', 2, 4, D));
    check(a[0].error.code === -32003, 'c11 total changed between parts: −32003');
    await k.ask(PK, part('c12', 1, 2, D)); t += R.PART_GAP_MS + 1; a = await k.ask(PK, part('c12', 2, 2, D));
    check(a.length === 0 && (k.rpc._parts.get(PK) || new Map()).get('c12').got.size === 1, 'c12 a part that comes later than 30 s after the one before: the old parts are let go, this one starts over', a);
    t += R.PART_GAP_MS + 1;
    a = await k.ask(PK, part('c13', 1, 2, Buffer.alloc(R.PART_BYTES_ACCEPTED + 1).toString('base64')));
    check(a[0].error.code === -32003, 'c13 a part over the size a part may carry: −32003');
    // the parts do not make the request they name
    const wrong = R.frames('c14x', JSON.stringify(k.req('c14x', 'lijox.echo', { blob: 'x'.repeat(70000) }))).map((f) => { const j = JSON.parse(f.toString('utf8')); j.params.of = 'c14'; return Buffer.from(JSON.stringify(j)); });
    k.sent.length = 0; for (const f of wrong) await k.rpc.onMessage(PK, f);
    check(k.answers().length === 1 && k.answers()[0].error.code === -32600 && k.answers()[0].id === 'c14', 'c14 parts that put together a request with another id: −32600', k.answers()[0]);
    // held bytes and held requests per peer
    k.sent.length = 0; t += 60000;   // past the parts' gap and into a new minute of the request limit
    const fat = Buffer.alloc(R.PART_BYTES_ACCEPTED, 1).toString('base64');
    for (let i = 1; i <= R.PEER_PART_REQS; i++) await k.ask(PK, part('h' + i, 1, 32, fat));
    a = await k.ask(PK, part('h5', 1, 2, D));
    check(a[0].error.code === -32003 && /too many requests in parts/.test(a[0].error.message), 'c15 a fifth request in parts at once from one peer: −32003', a);
    let last = null;   // h1 and h2 are filled toward 32 parts each, never completed: 48,000 bytes a part reaches 2,000,000 in the second
    for (const h of ['h1', 'h2']) for (let n = 2; n <= 31 && !last; n++) { const x = await k.ask(PK, part(h, n, 32, fat)); if (x.length) last = x[0]; }
    check(last && last.error.code === -32003 && /too many bytes/.test(last.error.message), 'c16 more than 2,000,000 bytes held in parts for one peer: −32003', last);
    a = await k.ask(PK2, part('o1', 1, 2, D));
    check(a.length === 0, 'c17 another peer\'s parts are counted apart');
  }

  // ── d: the limit per peer ──
  {
    const k = mk({ perMin: 5 });
    let codes = [];
    for (let i = 0; i < 7; i++) { const a = await k.ask(PK, k.req('d' + i, 'lijox.hello', {})); codes.push(a[0].error ? a[0].error.code : 200); }
    check(JSON.stringify(codes) === JSON.stringify([200, 200, 200, 200, 200, -32001, -32001]), 'd1 the sixth request inside a minute from one peer: −32001', codes);
    const b = await k.ask(PK2, k.req('d7', 'lijox.hello', {}));
    check(!!b[0].result, 'd2 another peer is not held back by it');
    t += 60000;
    const c = await k.ask(PK, k.req('d8', 'lijox.hello', {}));
    check(!!c[0].result, 'd3 a minute later the first peer is served again');
  }

  // ── e: once — a request that transfers money is never carried out twice ──
  {
    const k = mk();
    let ran = 0, hang = null;
    k.rpc.register('lijox.pay_test', async (caller, params) => { ran++; if (params.hang) await new Promise((r) => { hang = r; }); if (params.boom) throw new Error('lnd went away'); return { status: params.refuse ? 402 : 200, body: params.refuse ? { ok: false, error: 'no room' } : { ok: true, n: ran } }; }, { money: true });
    const rid = (c) => c.repeat(32);
    let a = await k.ask(PK, k.req('e1', 'lijox.pay_test', {}));
    check(a[0].error.code === 400 && ran === 0, 'e1 a money request without rid is refused and nothing runs', a);
    a = await k.ask(PK, k.req('e2', 'lijox.pay_test', { rid: rid('a') }));
    check(a[0].result.n === 1 && ran === 1, 'e2 with a new rid it runs');
    a = await k.ask(PK, k.req('e3', 'lijox.pay_test', { rid: rid('a') }));
    check(a[0].result.n === 1 && ran === 1 && a[0].id === 'e3' && k.logs.some((l) => l.includes('a repeat')), 'e3 the same rid again: the stored answer, nothing runs, the journal says it was a repeat', a);
    a = await k.ask(PK2, k.req('e4', 'lijox.pay_test', { rid: rid('a') }));
    check(a[0].result.n === 2 && ran === 2, 'e4 the same rid from ANOTHER peer is that peer\'s own request');
    a = await k.ask(PK, k.req('e5', 'lijox.pay_test', { rid: rid('b'), refuse: true }));
    const b = await k.ask(PK, k.req('e6', 'lijox.pay_test', { rid: rid('b'), refuse: true }));
    check(a[0].error.code === 402 && b[0].error.code === 402 && ran === 3, 'e5 a refusal is stored and repeated too');
    a = await k.ask(PK, k.req('e7', 'lijox.what_became', { rid: rid('a') }));
    check(a[0].result.known === true && a[0].result.state === 'done' && a[0].result.status === 200 && a[0].result.body.n === 1, 'e6 lijox.what_became answers what was done with a rid', a);
    a = await k.ask(PK, k.req('e8', 'lijox.what_became', { rid: rid('f') }));
    check(a[0].result.known === false, 'e7 and says so for one it never saw');
    a = await k.ask(PK2, k.req('e9', 'lijox.what_became', { rid: rid('b') }));
    check(a[0].result.known === false, 'e8 a peer is told nothing about another peer\'s rid');
    // started and not finished
    const p1 = k.rpc.onMessage(PK, Buffer.from(JSON.stringify(k.req('e10', 'lijox.pay_test', { rid: rid('c'), hang: true }))));
    await new Promise((r) => setTimeout(r, 20));
    a = await k.ask(PK, k.req('e11', 'lijox.pay_test', { rid: rid('c') }));
    check(a[0].error.code === 409 && a[0].error.message === 'in_progress' && ran === 4, 'e9 a rid whose first run is still going: 409 in_progress, no second run', a);
    a = await k.ask(PK, k.req('e12', 'lijox.what_became', { rid: rid('c') }));
    check(a[0].result.state === 'started', 'e10 and lijox.what_became says started');
    hang(); await p1;
    a = await k.ask(PK, k.req('e13', 'lijox.what_became', { rid: rid('c') }));
    check(a[0].result.state === 'done', 'e11 once it has finished: done');
    // a throw leaves it started — what was done is not known
    a = await k.ask(PK, k.req('e14', 'lijox.pay_test', { rid: rid('d'), boom: true }));
    const again = await k.ask(PK, k.req('e15', 'lijox.pay_test', { rid: rid('d') }));
    check(a[0].error.code === -32603 && again[0].error.code === 409 && ran === 5, 'e12 a function that throws leaves its rid started: a retry runs nothing', [a[0].error, again[0].error]);
    // across a restart: a new module on the same directory
    const k2 = mk();
    let ran2 = 0; k2.rpc.register('lijox.pay_test', () => { ran2++; return { status: 200, body: { ok: true } }; }, { money: true });
    a = await k2.ask(PK, k2.req('e16', 'lijox.pay_test', { rid: rid('a') }));
    const c = await k2.ask(PK, k2.req('e17', 'lijox.pay_test', { rid: rid('d') }));
    check(a[0].result.n === 1 && c[0].error.code === 409 && ran2 === 0, 'e13 after a restart the stored answer is given and a started rid stays started', [a[0], c[0]]);
    check(fs.existsSync(path.join(dir, 'lijox-rid', PK + '.json')), 'e14 the rids are in DATA_DIR/lijox-rid/, one file a peer');
    // 24 hours
    t += R.RID_TTL_MS + 1;
    a = await k2.ask(PK, k2.req('e18', 'lijox.what_became', { rid: rid('a') }));
    check(a[0].result.known === false, 'e15 24 hours later the rid is forgotten');
    k2.rpc.pruneRids();
    check(!fs.existsSync(path.join(dir, 'lijox-rid', PK2 + '.json')), 'e16 the sweep removes a file with nothing left in it');
    a = await k2.ask(PK, k2.req('e19', 'lijox.what_became', { rid: 'XYZ' }));
    check(a[0].error.code === 400, 'e17 a rid that is not 32 hex characters is refused');
  }

  // ── f: a peer that has gone ──
  {
    const k = mk();
    k.setGone(true);
    let threw = false;
    try { await k.rpc.onMessage(PK, Buffer.from(JSON.stringify(k.req('f1', 'lijox.hello', {})))); } catch (_) { threw = true; }
    check(!threw && k.rpc.stats().dropped_answers === 1, 'f1 an answer for a peer that has gone is dropped and counted; nothing throws');
    let noSend = false; try { R.createLijoxRpc({}); } catch (_) { noSend = true; }
    check(noSend, 'f2 the module refuses to start without a way to send');
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fails ? 'FAIL · lijox-rpc · ' + fails + ' failed' : 'PASS · lijox-rpc (a1–a13, b1–b7, c1–c17, d1–d3, e1–e17, f1–f2)');
  process.exit(fails ? 1 : 0);
})();
