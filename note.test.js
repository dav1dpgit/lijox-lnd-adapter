// 0.81.0 (S49) — the payer's note (LUD-12) and the per-wallet contact stamp.
//   node note.test.js
// Reads the source (the adapter starts servers on require): lnurlpCleanNote and walletContactTouch /
// walletContactMs are evaluated as written, with a stubbed fs; the routes are checked for shape.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m) => { if (!cond) { fails++; console.log('FAIL · ' + m); } else ok(m); };

// ── lnurlpCleanNote as written ──
const mClean = src.match(/const LNURLP_COMMENT_MAX = 120;[\s\S]*?function lnurlpCleanNote\(raw\) \{[\s\S]*?\n\}/);
check(!!mClean, 'lnurlpCleanNote is defined with LNURLP_COMMENT_MAX 120');
const clean = new Function(mClean[0] + '; return lnurlpCleanNote;')();
check(clean('Thanks for lunch!') === 'Thanks for lunch!', 'plain text passes');
check(clean('  many    spaces \n and\tnewlines ') === 'many spaces and newlines', 'whitespace collapses, ends trimmed');
check(clean('a\u0000b\u001fc\u007fd\u009fe') === 'abcde', 'C0/C1 control characters removed');
check(clean('x​y‏z‮w﻿v⁦u') === 'xyzwvu', 'zero-width, bidi overrides, isolates and BOM removed');
check(clean('é') === 'é', 'NFC normalised (e + combining acute → é)');
check(Array.from(clean('🍕'.repeat(130))).length === 120, '120 code points, not UTF-16 units (emoji)');
check(clean(null) === '' && clean(undefined) === '' && clean('') === '' && clean('   ') === '', 'empty in, empty out');
check(clean('<b>hi</b>') === '<b>hi</b>', 'markup is kept as text — the page escapes it (never rendered)');

// ── the payRequest, the callback, the route ──
check(/commentAllowed: LNURLP_COMMENT_MAX,/.test(src) && !/commentAllowed: 0,/.test(src), 'the payRequest advertises commentAllowed 120');
check(/const _note = lnurlpCleanNote\(parsed\.searchParams\.get\('comment'\)\);\s*\n\s*if \(_note\) \{ entry\.note = _note; entry\.note_ts = Date\.now\(\); \} else \{ delete entry\.note; delete entry\.note_ts; \}/.test(src), 'the callback keeps the cleaned note on the hash entry (or clears a stale one)');
check(/' note=' \+ Array\.from\(entry\.note\)\.length \+ ' chars'/.test(src) && !/note=\$\{entry\.note\}/.test(src) && !/' note=' \+ entry\.note\b/.test(src), 'the mint log says how long the note is, never what it says');
const route = src.slice(src.indexOf("if (method === 'GET' && path.startsWith('/lnurl/note/')) {"), src.indexOf("if (method === 'GET' && path === '/quorum/defaults') {"));
check(route.length > 100 && /if \(!authOk\(req\)\)/.test(route), 'the note route is token-gated');
check(/if \(owner !== who\) return jsonResponse\(res, \{ ok: false, error: 'not yours' \}, 403\);/.test(route), 'the note route answers only the hash\'s owner');
check(/note: hit\.note \|\| null, ts: hit\.note_ts \|\| null, status: hit\.status \|\| null/.test(route), 'the answer carries note, ts, status');
check(/function lnurlpPruneNotes\(\)/.test(src) && /try \{ lnurlpPruneNotes\(\); \} catch \(_\) \{\}\s*\n\s*try \{ require\('fs'\)\.writeFileSync\(LNURLP_PATH/.test(src), 'notes older than a week are pruned on every persist');

// ── the contact stamp as written, with a stubbed fs ──
const mStore = src.match(/let walletContact = \{\};[\s\S]*?function walletContactMs\(pubkeyHex\) \{[\s\S]*?\n\}/);
check(!!mStore, 'the contact store is defined');
const writes = [];
const fake = { writeFileSync: (p, s) => writes.push([p, s]), readFileSync: () => { throw new Error('none'); } };
const body = mStore[0].replace("try { walletContact = JSON.parse(require('fs').readFileSync(WALLET_CONTACT_PATH, 'utf8')) || {}; } catch (e) { walletContact = {}; }", '');
const store = new Function('require', 'WALLET_CONTACT_PATH', 'LEASE_SESSION_GAP_MS', body + '; return { touch: walletContactTouch, ms: walletContactMs, get: () => walletContact };')((n) => fake, '/tmp/x.json', 600000);
const PK = '02' + 'ab'.repeat(32);
const t0 = Date.now();
store.touch(PK, 'http');
check(store.ms(PK) >= t0 && writes.length === 1, 'first contact stamps and persists (a new session)');
store.touch(PK, 'peer');
check(writes.length === 1 && store.get()[PK].source === 'http', 'a second contact within the gap stamps in memory only; the session keeps its first source');
store.touch('not a pubkey', 'http'); store.touch('', 'http');
check(Object.keys(store.get()).length === 1, 'a bad pubkey is ignored');
check(store.ms('03' + 'cd'.repeat(32)) === 0, 'an unheard wallet reads 0');
check(/walletContactTouch\(pubkeyHex, 'http'\);/.test(src) && /walletContactTouch\(k, source\);\s*\/\/ 0\.81\.0/.test(src), 'touchWalletActive and leaseTouch both stamp it');
check(/last_heard_ms: Math\.max\(heardByPeer\[rec\.client_pubkey\] \|\| 0, act, walletContactMs\(rec\.client_pubkey\)\)/.test(src) && /last_heard_ms: Math\.max\(heardByPeer\[k\] \|\| 0, walletContactMs\(k\)\)/.test(src), 'the Wallets pane reads the stamp for registry and channel-only wallets');

if (fails) { console.log('GATE FAIL · ' + fails); process.exit(1); }
console.log('GATE PASS: 0.81.0 — the note is advertised, kept clean, handed to its owner only, pruned in a week; the contact stamp is durable and read by the pane');
