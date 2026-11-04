'use strict';
// core-rpc.test.js — 0.120.0: the float wallet's door against a stand-in Bitcoin Core (an http server that answers
// like Core does: basic auth, JSON-RPC 1.0, HTTP 403 for a command outside the whitelist, an error object for a bad call).
//   node core-rpc.test.js
const http = require('http');
const { createCoreRpc, FLOAT_COMMANDS } = require('./core-rpc');
let n = 0, bad = 0;
const check = (c, m) => { n++; if (c) console.log('  ok · ' + m); else { bad++; console.log('  FAIL · ' + m); } };

const seen = [];
const WHITELIST = new Set(FLOAT_COMMANDS);
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (auth !== 'Basic ' + Buffer.from('lijpay:secretpw').toString('base64')) { res.writeHead(401); res.end(); return; }
    let j = null; try { j = JSON.parse(body); } catch (e) {}
    seen.push({ path: req.url, method: j && j.method, params: j && j.params });
    if (!j || !WHITELIST.has(j.method)) { res.writeHead(403); res.end(); return; }   // Core: outside the user's whitelist → 403
    if (j.method === 'getbalances') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { mine: { trusted: 0.02, untrusted_pending: 0.001 } }, error: null, id: j.id })); return; }
    if (j.method === 'estimatesmartfee') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { feerate: 0.00005, blocks: 1 }, error: null, id: j.id })); return; }
    if (j.method === 'sendtoaddress' && j.params[0] === 'bc1qbad') { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: null, error: { code: -5, message: 'Invalid address' }, id: j.id })); return; }
    if (j.method === 'gettransaction' && j.params[0] === 'slow') { setTimeout(() => { try { res.writeHead(200); res.end('{}'); } catch (e) {} }, 1500); return; }
    if (j.method === 'getwalletinfo') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: 'ok:' + j.method, error: null, id: j.id }));
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const rpc = createCoreRpc({ url: 'http://127.0.0.1:' + port + '/wallet/lij-onchain-pay', user: 'lijpay', pass: 'secretpw', timeoutMs: 500 });
  check(rpc.walletPath === '/wallet/lij-onchain-pay', 'the wallet path rides the URL');
  const b = await rpc.call('getbalances');
  check(b && b.mine && b.mine.trusted === 0.02, 'a whitelisted call answers its result');
  check(seen[seen.length - 1].path === '/wallet/lij-onchain-pay' && seen[seen.length - 1].method === 'getbalances', 'posted to the wallet path with the method');
  const f = await rpc.call('estimatesmartfee', [1, 'conservative']);
  check(f.feerate === 0.00005 && seen[seen.length - 1].params[1] === 'conservative', 'params travel');
  let e = null; try { await rpc.call('sendtoaddress', ['bc1qbad', 0.001]); } catch (x) { e = x; }
  check(e && e.code === -5 && /Invalid address/.test(e.message), 'Core\'s JSON error becomes {code, message}: ' + (e && e.message));
  e = null; try { await rpc.call('getnetworkinfo'); } catch (x) { e = x; }
  check(e && e.code === 'forbidden' && e.http === 403, 'a command outside the whitelist: forbidden (403)');
  check((await rpc.probeFence()) === 'ok', 'the fence probe reads "ok" when Core refuses the probe');
  e = null; try { await rpc.call('listtransactions'); } catch (x) { e = x; }
  check(e && e.code === 'not_allowed', 'a command this client does not know is refused before it is sent: ' + (e && e.code));
  check(seen.filter((s) => s.method === 'listtransactions').length === 0, '…and never reached the server');
  e = null; try { await rpc.call('gettransaction', ['slow']); } catch (x) { e = x; }
  check(e && e.code === 'timeout', 'a slow answer times out: ' + (e && e.code));
  e = null; try { await rpc.call('getwalletinfo'); } catch (x) { e = x; }
  check(e && e.code === 'notjson', 'a non-JSON answer is told: ' + (e && e.code));
  const wrong = createCoreRpc({ url: 'http://127.0.0.1:' + port + '/wallet/lij-onchain-pay', user: 'lijpay', pass: 'nope', timeoutMs: 500 });
  e = null; try { await wrong.call('getbalances'); } catch (x) { e = x; }
  check(e && e.code === 'unauthorized', 'a wrong password: unauthorized');
  check((await wrong.probeFence()) === 'down', 'the fence probe reads "down" when the door cannot be asked');
  // an open fence: a server that answers the probe
  const open = http.createServer((req, res) => { let body = ''; req.on('data', (c) => body += c); req.on('end', () => { const j = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: { version: 290500 }, error: null, id: j.id })); }); });
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  const rpcOpen = createCoreRpc({ url: 'http://127.0.0.1:' + open.address().port + '/wallet/x', user: 'a', pass: 'b', timeoutMs: 500 });
  check((await rpcOpen.probeFence()) === 'open', 'the fence probe reads "open" when Core answers a command outside the list');
  const down = createCoreRpc({ url: 'http://127.0.0.1:1/wallet/x', user: 'a', pass: 'b', timeoutMs: 500 });
  check((await down.probeFence()) === 'down', 'no server: down');
  let threw = false; try { createCoreRpc({ url: 'ftp://x' }); } catch (x) { threw = true; } check(threw, 'a non-http URL is refused at creation');
  check(FLOAT_COMMANDS.length === 12 && !FLOAT_COMMANDS.includes('signrawtransactionwithwallet') && !FLOAT_COMMANDS.includes('importdescriptors'), 'the list is the twelve of v0.6 §9.1 — no signing, no imports');
  srv.close(); open.close();
  console.log((bad ? 'FAIL' : 'PASS') + ' · core-rpc.test.js · ' + (n - bad) + ' passed, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})();
