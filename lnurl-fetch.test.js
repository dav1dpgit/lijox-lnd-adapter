// 0.119.3 (S66 Mon 2026-11-02, DP's UX list — items 1, 2, 5, 6): THE FETCH FOR THE PHONE and the console's identifiers.
//   lnurl-fetch.js: the URL check (https on 443 to a public address only; .onion/.local/localhost refused; a private
//   address refused by its name or by what it resolves to; no redirects; 64 KiB; 10 s; the body verbatim; non-JSON told),
//   through a stand-in request; the route in lij-adapter.js (token, per-address limit, the counts, never the URL);
//   console.js: idc() and copyText(), every shortened identifier a tap-to-copy, the Pending pane's three columns, the
//   Balances pane's Pending box; lij-adapter.js: the snapshot carries full identifiers, the closing txid, the limbo.
//   node lnurl-fetch.test.js
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const L = require('./lnurl-fetch');
const src = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
const con = fs.readFileSync(path.join(__dirname, 'console.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

// ── the address check ──
for (const [a, priv] of [['8.8.8.8', false], ['104.21.62.127', false], ['127.0.0.1', true], ['10.1.2.3', true], ['192.168.1.10', true], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false],
  ['100.100.1.1', true], ['100.63.255.255', false], ['100.128.0.1', false], ['169.254.1.1', true], ['0.0.0.0', true], ['224.0.0.1', true], ['255.255.255.255', true],
  ['::1', true], ['::', true], ['fd12:3456:789a::1', true], ['fe80::1', true], ['ff02::1', true], ['2606:4700::1111', false], ['::ffff:127.0.0.1', true], ['::ffff:8.8.8.8', false], ['not-an-ip', true]]) {
  check(L.privateAddress(a) === priv, `${a} is ${priv ? 'not public' : 'public'}`);
}
// ── the URL check ──
check(L.checkUrl('https://pay.bitcoinjungle.app/.well-known/lnurlp/esneydervalencia').host === 'pay.bitcoinjungle.app', 'an https pay URL passes');
check(L.checkUrl('https://pay.example.test:443/x').host === 'pay.example.test', ':443 spelled out passes');
for (const [u, err] of [['http://pay.example.test/x', 'not_https'], ['https://pay.example.test:7000/x', 'port'], ['https://127.0.0.1/health', 'host'], ['https://localhost/x', 'host'], ['https://foo.onion/x', 'host'], ['https://box.local/x', 'host'], ['https://u:p@pay.example.test/x', 'bad_url'], ['nonsense', 'bad_url'], ['', 'bad_url'], ['ftp://x/y', 'not_https'], ['https://[::1]/x', 'host'], ['https://100.100.1.1/console', 'host']]) {
  check(L.checkUrl(u).error === err, `${JSON.stringify(u)} → ${err}`);
}
// ── the fetch, through a stand-in request ──
function standin(plan) {   // plan(opts) → { status, chunks } | 'error' | 'hang'
  const calls = [];
  const request = (opts, cb) => {
    calls.push(opts);
    const rq = new EventEmitter(); rq.destroy = () => {}; rq.end = () => {
      const p = plan(opts);
      if (p === 'error') return setImmediate(() => rq.emit('error', new Error('ECONNREFUSED')));
      if (p === 'hang') return setImmediate(() => rq.emit('timeout'));
      const rs = new EventEmitter(); rs.statusCode = p.status; rs.setEncoding = () => {}; rs.destroy = () => {};
      setImmediate(() => { cb(rs); for (const c of p.chunks) rs.emit('data', c); rs.emit('end'); });
    };
    return rq;
  };
  return { request, calls };
}
(async () => {
  const lookupPub = async () => ['104.21.62.127'];
  let st = standin(() => ({ status: 200, chunks: ['{"tag":"payRequest",', '"callback":"https://x"}'] }));
  let r = await L.fetchForWallet('https://pay.example.test/.well-known/lnurlp/alice?x=1', { lookup: lookupPub, request: st.request });
  check(r.ok === true && r.status === 200 && r.body === '{"tag":"payRequest","callback":"https://x"}', 'a JSON answer comes back verbatim');
  check(st.calls[0].host === '104.21.62.127' && st.calls[0].servername === 'pay.example.test' && st.calls[0].headers.host === 'pay.example.test' && st.calls[0].path === '/.well-known/lnurlp/alice?x=1' && st.calls[0].port === 443 && st.calls[0].method === 'GET', 'the socket goes to the checked ADDRESS with the name in SNI and Host; the path and query kept');
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: async () => ['127.0.0.1', '10.0.0.5'], request: st.request });
  check(r.ok === false && r.error === 'host', 'a public name that resolves only to private addresses is refused (DNS cannot aim it at the box)');
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: async () => ['127.0.0.1', '8.8.8.8'], request: st.request });
  check(r.ok === true && st.calls[st.calls.length - 1].host === '8.8.8.8', 'a name with a private and a public address: the public one is used');
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: async () => { throw new Error('ENOTFOUND'); }, request: st.request });
  check(r.ok === false && r.error === 'resolve', 'a name that does not resolve → resolve');
  st = standin(() => ({ status: 302, chunks: [] }));
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === false && r.error === 'redirect', 'a redirect is not followed → redirect');
  st = standin(() => ({ status: 200, chunks: ['<html>not json</html>'] }));
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === false && r.error === 'notjson', 'a non-JSON body → notjson');
  st = standin(() => ({ status: 200, chunks: ['x'.repeat(40000), 'y'.repeat(40000)] }));
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === false && r.error === 'too_big', 'a body over 64 KiB → too_big');
  st = standin(() => 'error');
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === false && r.error === 'unreachable', 'a refused connection → unreachable');
  st = standin(() => 'hang');
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === false && r.error === 'timeout', 'no answer in time → timeout');
  st = standin(() => ({ status: 404, chunks: ['{"status":"ERROR","reason":"no such name"}'] }));
  r = await L.fetchForWallet('https://pay.example.test/x', { lookup: lookupPub, request: st.request });
  check(r.ok === true && r.status === 404 && /no such name/.test(r.body), 'a JSON error answer is passed through with its status — the phone reads it');
  check(L.MAX_BYTES === 65536 && L.TIMEOUT_MS === 10000, 'the caps: 64 KiB, 10 s');

  // ── the route in the adapter ──
  check(/if \(method === 'POST' && path === '\/v1\/lnurl\/fetch'\) \{\n\s*if \(!authOk\(req\)\) return errResponse\(res, 'Unauthorized', 401\);/.test(src), 'the route is behind the route token');
  check(/const lim = lnurlFetchIpLimit\.hit\(ip\);\n\s*if \(!lim\.ok\) \{ lnurlFetchCounts\.refused\+\+; return errResponse\(res, 'Rate limit exceeded', 429\); \}/.test(src), 'a per-address limit, 429 over it');
  check(/LNURL_FETCH_IP_PER_MIN \|\| '30'/.test(src) && /lnurlFetchIpLimit\.sweep\(\);/.test(src), 'the limit is a box setting (30 a minute) and sweeps');
  check(/const out = await lnurlFetch\.fetchForWallet\(fbody && fbody\.url\);/.test(src) && /return jsonResponse\(res, out, out\.ok \? 200 :/.test(src), 'the answer is the module\'s, verbatim');
  check(/\[LNURL-FETCH\] \$\{lnurlFetchCounts\.asked\} asked/.test(src) && !/\[LNURL-FETCH\][^\n]*fbody\.url/.test(src) && !/console\.(log|warn)\([^\n]*fbody\.url/.test(src), 'the journal carries a count, never the URL');
  check(/lnurl_fetch:\s*\{ enabled: true \}/.test(src), '/health advertises lnurl_fetch');
  // ── the snapshot: full identifiers, the closing txid and the limbo, the Pending box ──
  check(/promises\.push\(\{ scid: scidHex, client: String\(pr\.client_pubkey \|\| ''\)/.test(src) && /held\.push\(\{ payment_hash: ph, kind: h\.kind \|\| 'jit', client: String\(h\.client_pubkey \|\| ''\)/.test(src) && /aggregating\.push\(\{ scid: scidHex, shards/.test(src), 'JIT · now sends full scids, keys and hashes (the console shortens them)');
  check(/closing_txid: String\(x\.closing_txid \|\| ''\), limbo: Number\(x\.limbo_balance \|\| 0\)/.test(src), 'the pending rows carry the closing txid and the limbo balance');
  check(/const limbo = Number\(pending\.total_limbo_balance \|\| 0\);/.test(src) && /const pendingBox = \{ total: Number\(wb\.unconfirmed_balance \|\| 0\) \+ sumUnsettled \+ pendingOpenLocal \+ limbo, onchain_unconfirmed:/.test(src) && /boxes\.pending = pendingBox;/.test(src) && /pending_open_local: pendingOpenLocal, limbo,/.test(src), 'the Pending box = unconfirmed + in flight + opening + closing (limbo); limbo in the balances');
  // ── the console ──
  check(/function idc\(full,n\)\{/.test(con) && /data-copy="'\+esc\(full\)\+'" title="'\+esc\(full\)\+'"/.test(con), 'idc(): the shortened identifier carries its full value in data-copy and title');
  check(/function copyText\(t\)\{/.test(con) && /navigator\.clipboard&&window\.isSecureContext/.test(con) && /document\.execCommand\('copy'\)/.test(con), 'copyText(): the clipboard API on a secure context, the old copy command otherwise (the phone over Tailscale)');
  check(/var cp=e\.target\.closest\?e\.target\.closest\('\.cp'\):null;if\(cp\)\{var full=cp\.getAttribute\('data-copy'\)\|\|'';copyText\(full\)/.test(con) && /cp\.classList\.add\('did'\)/.test(con), 'a tap on a .cp copies and flashes');
  check(/\.cp\{cursor:pointer/.test(con) && /\.cp\.did::after\{content:' copied'/.test(con), 'the style: a dotted underline, the "copied" flash');
  const sliced = (con.match(/esc\([^()]*\.slice\(0,\d+\)\)/g) || []);
  check(sliced.length === 1 && /lbl\.slice/.test(sliced[0]), 'every shortened identifier goes through idc() — only the label (not an identifier) is still cut plain');
  check((con.match(/idc\(/g) || []).length >= 12, 'twelve or more identifier sites copy');
  check(/<th>channel point<\/th><th>closing txid<\/th><th class="n">limbo \(sats\)<\/th>/.test(con) && /idc\(x\.channel_point,16\)/.test(con) && /x\.closing_txid\?idc\(x\.closing_txid,16\)/.test(con) && !/<th>txid<\/th><\/tr>'\+p\.map/.test(con), 'the Pending pane: channel point, closing txid and limbo columns (the "txid" header is gone)');
  check(/kpi\('Pending',fmt\(bx\.pending\.total\)\+' sats','unconfirmed '/.test(con) && /\['closing \(limbo\)',fmt\(b\.limbo\|\|0\)\+' sats'\]/.test(con), 'the Balances pane: the Pending box and the closing (limbo) line');
  check(!/\$\{/.test(con.slice(con.indexOf('function idc'), con.indexOf('function copyText') + 400)), 'the new console code has no ${ (it is served inside a template literal)');
  if (fails) { console.log('FAIL · ' + fails); process.exit(1); } else console.log('PASS · lnurl-fetch.test.js');
})().catch((e) => { console.log('FAIL · threw: ' + e.stack); process.exit(1); });
