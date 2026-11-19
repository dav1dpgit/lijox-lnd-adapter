// The Console's card "Pending HTLCs" and its Guardrails row (console.js sentWatchPane, sentWatchGuard), run as written
// in the page's script. 0.133.0: the card; 0.133.1: nothing said before the first read; 0.133.2: one table, a short
// Guardrails label; 0.133.3 (DP 2026-11-19 09:43 "Go"): EVERY pending HTLC is listed — the 100 blocks only marks the
// warning — so the card holds what the Channels pane counts. Report only: no button and no form.
//   node console-sent-watch.test.js
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'console.js'), 'utf8');
let fails = 0; const check = (c, m) => { if (!c) { fails++; console.log('FAIL · ' + m); } else console.log('  ok · ' + m); };
const grab = (name) => { const m = src.match(new RegExp('function ' + name + '\\(sw\\)\\{[\\s\\S]*?\\n')); check(!!m, name + ' is in the page script'); return eval('`' + m[0].replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'); };
const body = grab('sentWatchPane') + grab('sentWatchGuard');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (rows) => '<div class="kv">' + rows.map((r) => '<div>' + esc(r[0]) + '</div><div>' + (r[2] ? r[1] : esc(r[1])) + '</div>').join('') + '</div>';
const idc = (full, n) => '<span class="mono cp" data-copy="' + esc(full) + '">' + esc(String(full).slice(0, n || 99)) + '</span>';
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const { sentWatchPane, sentWatchGuard } = new Function('kv', 'idc', 'ago', 'esc', 'fmt', body + '; return { sentWatchPane, sentWatchGuard };')(kv, idc, () => '1 min ago', esc, fmt);
const labels = (h) => ((h.match(/<div class="kv">([\s\S]*?)<\/div>(?:<div class="tbl"|$)/) || ['', ''])[1]).split('</div><div>').filter((x, i) => i % 2 === 0).map((x) => x.replace(/<[^>]+>/g, ''));

// ── no report; before the first read ──
check(/no report/.test(sentWatchPane(null)) && sentWatchGuard(null).length === 0, 'no report: the card says so and Guardrails shows no row');
const quiet = { ts: 1, height: 976000, warn_blocks: 100, items: [], htlcs: [], near: [], last_error: null, fwd_ids: null, up_grace_left_ms: 0 };
let h = sentWatchPane(Object.assign({}, quiet, { ts: 0, up_grace_left_ms: 169500 }));
check(/first read 170 s from now \(after a start\)/.test(h) && /nothing is said about any HTLC before it/.test(h), 'in the first minutes after a start the card says when the first read comes');
check(!/pending HTLCs|sent payments waiting|<table/.test(h) && sentWatchGuard(Object.assign({}, quiet, { ts: 0 })).length === 0, '0.133.1: … and NOTHING ELSE — no count, no table, no Guardrails row: LND has not been read yet');
check(/last read error/.test(sentWatchPane(Object.assign({}, quiet, { ts: 0, up_grace_left_ms: 0, last_error: 'LND down' }))) && /first read in a moment/.test(sentWatchPane(Object.assign({}, quiet, { ts: 0, up_grace_left_ms: 0 }))), '0.133.1: a read that failed before any succeeded is shown as its error');

// ── nothing pending ──
h = sentWatchPane(quiet);
check(/block 976,000/.test(h) && /<div>pending HTLCs<\/div><div>0 <span class="dim">— none on any channel<\/span><\/div>/.test(h) && !/<table/.test(h), 'nothing pending: the count 0 in words, no table');
let g = sentWatchGuard(quiet);
check(g.length === 1 && g[0][0] === 'HTLCs near a close' && /class="ok">none within 100 blocks of an on-chain close<\/span> <span class="dim">— 0 pending in all; the list is in the next card</.test(g[0][1]), 'Guardrails: "none", shown as clear, with the count of all pending');
check(g[0][0].length <= 23, '0.133.2: the Guardrails row\'s label is no longer than the longest label that pane already had (23 letters) — a longer one widens the label column for the whole pane and leaves every value 70 px');

// ── DP's box at block 976,516 (2026-11-19): four pending HTLCs, one within 100 blocks of its block ──
const W = '02' + '4c'.repeat(32), W2 = '02' + 'f1'.repeat(32), ACQ = '03' + '86'.repeat(32), X = '03' + 'c3'.repeat(32);
const HZ = '2a'.repeat(32), HF = 'bb'.repeat(32), HX = 'cc'.repeat(32), CP = 'f7'.repeat(32) + ':0';
const zombie = { dir: 'in', near: true, cls: 'returned', peer: W, chan_point: CP, active: false, wallet: true, sats: 421, hash: HZ, expiry: 970221, block: 970224, left: -6292, what: 'failed here, the wallet is offline — a wallet engine before v376 closes its channel when it returns past this block (v376 and newer wait 4,032 blocks)', why: 'this node\'s invoice refused this HTLC (CANCELED)', wakes: 0, nosub: false, lead: true, last_wake_ms: 0, confirmed: true };
const fwdOut = { dir: 'out', near: false, peer: ACQ, chan_point: 'e1'.repeat(32) + ':1', active: true, sats: 3499, hash: HF, expiry: 976708, block: 976708, left: 192, what: 'outgoing — LND closes this channel on-chain at this block if the peer has not answered' };
const fwdIn = { dir: 'in', near: false, cls: 'flight', why: 'forwarded, the outgoing half is still on its channel', peer: W2, chan_point: 'd2'.repeat(32) + ':0', active: false, wallet: true, sats: 3502, hash: HF, expiry: 976788, block: 976778, left: 262, what: 'still in flight — if this box comes to hold its preimage, LND closes this channel on-chain at this block to collect it' };
const fourth = { dir: 'in', near: false, cls: 'undecided', why: 'not held, not forwarded, no invoice — LND refused it, or it waits to be handed to this adapter again', peer: X, chan_point: 'a9'.repeat(32) + ':2', active: true, wallet: false, sats: 50, hash: HX, expiry: 977400, block: 977390, left: 874, what: 'not sorted — if this box settled it, LND closes this channel on-chain at this block' };
const box = Object.assign({}, quiet, { height: 976516, htlcs: [zombie, fwdOut, fwdIn, fourth], near: [zombie],
  items: [{ hash: HZ, peer: W, chan_point: CP, cls: 'returned', why: zombie.why, what: zombie.what, sats: 421, expiry: 970221, deadline: 970224, left: -6292, wakes: 0, last_wake_ms: 0, nosub: false, confirmed: true, lead: true }] });
h = sentWatchPane(box);
check(/<div>pending HTLCs<\/div><div>4 · <span class="warn">1 within 100 blocks of its on-chain block<\/span><\/div>/.test(h), '0.133.3: the head counts EVERY pending HTLC (4) and, of them, the ones within 100 blocks (1)');
check((h.match(/<tr><td>/g) || []).length === 4 && (h.match(/<div class="tbl">/g) || []).length === 1 && (h.match(/<table>/g) || []).length === 1, '0.133.3: all four are rows of the ONE table — what the Channels pane counts is what the card lists');
check(h.indexOf('data-copy="' + HZ + '"') < h.indexOf('data-copy="' + ACQ + '"') && h.indexOf('data-copy="' + ACQ + '"') < h.indexOf('data-copy="' + W2 + '"') && h.indexOf('data-copy="' + W2 + '"') < h.indexOf('data-copy="' + HX + '"'), 'the rows stand in the order given — the fewest blocks left first');
check(/incoming · returned here/.test(h) && />outgoing</.test(h) && /incoming · in flight/.test(h) && /incoming · not sorted/.test(h), 'each row says which way the HTLC runs and its sorting');
check(/class="bad">6,292 past</.test(h) && /class="">192</.test(h) && /class="">262</.test(h) && /class="">874</.test(h), 'blocks left: past its block in red; further than 100 blocks plain — the 100 blocks is the warning, not the list');
check(/<div>sent payments waiting<\/div><div>1 · 0 completed, 1 returned <span class="dim">— settled or failed here while the wallet that sent them is offline<\/span><\/div>/.test(h), 'the count of sent payments settled or failed here, by kind');
check(h.includes('data-copy="' + HZ + '"') && h.includes('data-copy="' + W + '"') && h.includes('data-copy="' + CP + '"') && h.includes('data-copy="' + HF + '"'), 'every identifier (hash, peer, channel point) is tap-to-copy, whole');
check(/970,221/.test(h) && /970,224/.test(h) && /976,708/.test(h) && /LND closes this channel on-chain at this block if the peer has not answered/.test(h), 'each row gives the expiry, the on-chain block and, in words, what happens at it');
check(/<th>what happens at that block<\/th><th>how it was sorted<\/th><\/tr>/.test(h) && /<td>this node&#39;s invoice refused this HTLC \(CANCELED\)<\/td><\/tr>/.test(h) && /<td>forwarded, the outgoing half is still on its channel<\/td><\/tr>/.test(h) && /<td><span class="dim">—<\/span><\/td><\/tr>/.test(h), 'how each row was sorted has its own column, the last; an outgoing HTLC has none');
check((h.match(/class="warn">offline</g) || []).length === 2, '"offline" marks the two peers that are not connected');
check(/<td>0<\/td><td>failed here/.test(h) && (h.match(/<td><span class="dim">—<\/span><\/td><td>(outgoing|still in flight|not sorted)/g) || []).length === 3, 'wakes sent: a count for a sorted sent payment; none for the other rows — and before the long sentence, so it is seen without scrolling sideways');
check(Math.max(...labels(h).map((x) => x.length)) <= 24 && labels(h).join('|') === 'read|pending HTLCs|sent payments waiting', 'every label in the card\'s head is short (a long label takes the whole row and leaves the value no width)');
check(!/<button|<input|<form|data-act|onclick/i.test(h), 'report only: no button, no field, no action in the card');
check(!/style=/.test(h) && /\.gap\{margin:6px 0\}/.test(src), 'no inline style in the card (the Console\'s own CSP refuses them)');
check(/<h2>Pending HTLCs<\/h2><div id="sentwatch"/.test(src) && !/HTLCs near their on-chain block/.test(src.replace(/^\/\/.*$/gm, '')), '0.133.3: the card is titled "Pending HTLCs" — it lists them all');
g = sentWatchGuard(box);
check(/class="warn">1 within 100 blocks of an on-chain close · 1 past its block<\/span> <span class="dim">— 4 pending in all; the list is in the next card</.test(g[0][1]) && g[0][2] === 1, 'Guardrails for that box: one near (past its block: amber, not red), four pending in all');

// ── colours, wakes, the other states ──
const mk = (o) => Object.assign({ dir: 'out', near: true, peer: X, chan_point: 'e1'.repeat(32) + ':1', active: true, sats: 9, hash: HX, expiry: 976600, block: 976600, left: 84, what: 'outgoing — LND closes this channel on-chain at this block if the peer has not answered' }, o);
const comp = { dir: 'in', near: true, cls: 'completed', peer: W, chan_point: CP, active: false, wallet: true, sats: 5000, hash: 'aa'.repeat(32), expiry: 976100, block: 976090, left: 90, what: 'settled here, the wallet is offline — LND closes this channel on-chain at this block to collect it', why: 'this adapter settled it', wakes: 2, nosub: false, lead: true, last_wake_ms: 5, confirmed: true };
h = sentWatchPane(Object.assign({}, quiet, { htlcs: [mk({ left: 3 }), mk({ left: 30 }), comp, mk({ left: 100 }), mk({ left: 101, near: false }), Object.assign({}, comp, { cls: 'returned', left: 150, near: false, wakes: 0, lead: false, last_wake_ms: 0, confirmed: false }), Object.assign({}, comp, { left: 400, near: false, nosub: true })] }));
check(/class="bad">3</.test(h) && /class="warn">30</.test(h) && /class="warn">90</.test(h) && /class="warn">100</.test(h) && /class="">101</.test(h), 'blocks left: 6 or fewer in red; up to the 100 blocks of the warning in amber; beyond it plain');
check(/<td>2 <span class="dim">· last 1 min ago<\/span><\/td>/.test(h) && /0 <span class="dim">\(another payment of this wallet leads\)<\/span>/.test(h) && /returned here <span class="dim">\(first read\)<\/span>/.test(h) && /no push subscription/.test(h), 'wakes sent: the count and when the last one left; a payment that is not the wallet\'s lead says so; "first read" until a second read agrees; a missing push subscription');
check(/<div>pending HTLCs<\/div><div>7 · <span class="warn">4 within 100 blocks of their on-chain block<\/span><\/div>/.test(h), 'the head: 7 pending, 4 within 100 blocks');
h = sentWatchPane(Object.assign({}, quiet, { htlcs: [mk({ left: 300, near: false })] }));
check(/<div>pending HTLCs<\/div><div>1 · none within 100 blocks of its on-chain block<\/div>/.test(h) && (h.match(/<tr><td>/g) || []).length === 1, 'one pending HTLC far from its block: listed, and the head says none is within 100 blocks');
g = sentWatchGuard(Object.assign({}, quiet, { htlcs: [mk({ left: 30 }), mk({ left: -97 }), comp, mk({ left: 500, near: false })] }));
check(/class="bad">3 within 100 blocks of an on-chain close · nearest 30 blocks left · 1 past its block<\/span> <span class="dim">— 4 pending in all/.test(g[0][1]), 'Guardrails: the count of the near ones, the nearest block still ahead, how many are past theirs — red when the nearest ahead is 36 blocks or fewer');
g = sentWatchGuard(Object.assign({}, quiet, { htlcs: [comp, mk({ left: 500, near: false })] }));
check(/class="warn">1 within 100 blocks of an on-chain close · nearest 90 blocks left<\/span>/.test(g[0][1]), 'Guardrails: amber when the nearest is further than 36 blocks');
g = sentWatchGuard(Object.assign({}, quiet, { htlcs: [mk({ left: 500, near: false }), mk({ left: 900, near: false })] }));
check(/class="ok">none within 100 blocks of an on-chain close<\/span> <span class="dim">— 2 pending in all/.test(g[0][1]), 'Guardrails: pending HTLCs that are all far from their block leave the row clear — and counted');
h = sentWatchPane(Object.assign({}, quiet, { last_error: 'forwarding history: <x>', fwd_ids: false }));
check(/last read error/.test(h) && /forwarding history: &lt;x&gt;/.test(h) && /carry no HTLC numbers/.test(h), 'a read error is shown (escaped); an LND without HTLC numbers in its forwarding records is named');
console.log(fails ? `\n${fails} FAILED` : '\nall sent-watch Console checks pass'); process.exit(fails ? 1 : 0);
