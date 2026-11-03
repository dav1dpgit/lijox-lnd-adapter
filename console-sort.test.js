// 0.119.1 (S65, DP 2026-10-28): the console's Channels and Wallets tables sort their time columns by real values —
// the lease by the milliseconds left, opened on / first seen / last heard by the stamp — through data-sort on the cell,
// which cellKey prefers over the cell's words. The client script is a template literal in console.js; this evaluates
// it to its text and lifts the two pure functions. Run: node console-sort.test.js
'use strict';
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/console.js', 'utf8');
let passed = 0, failed = 0; const t = (n, ok) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n); } };
const i0 = src.indexOf('const JS = `'); const i1 = src.indexOf('\n`;', i0);
const js = new Function('return `' + src.slice(i0 + 'const JS = `'.length, i1) + '`')();
const lift = (name) => { const m = js.match(new RegExp('function ' + name + '\\(([^)]*)\\)\\{[\\s\\S]*?\\n')); if (!m) return null; const body = m[0].slice(0, m[0].lastIndexOf('}') + 1); return new Function(body + '; return ' + name + ';')(); };
const cellKey = lift('cellKey'), leaseKey = lift('leaseKey');
t('cellKey and leaseKey are in the client script', !!cellKey && !!leaseKey);
const td = (text, ds) => ({ textContent: text, getAttribute: (k) => (k === 'data-sort' && ds !== undefined) ? String(ds) : null });
// the words alone (the 0.119.0 way) — what went wrong
const k58 = cellKey(td('58 d leftcontact · 3.2 h ago'));
t('the old key read "58 d left · contact 3.2 h ago" as 583.2 (the defect)', k58.n === 583.2);
// data-sort wins
t('a data-sort number is the key whatever the words say', cellKey(td('58 d leftcontact · 3.2 h ago', 5011200000)).n === 5011200000);
t('an empty data-sort falls back to the words', cellKey(td('12 min ago', '')).n === 12);
t('a non-numeric data-sort falls back to the words', cellKey(td('7', 'abc')).n === 7);
// leaseKey: milliseconds left; past ttl negative; no stamp / excluded last
const now = Date.now();
const a = leaseKey({ lease_ttl_days: 60, last_seen_ms: now - 2 * 86400000 });
const b = leaseKey({ lease_ttl_days: 60, last_seen_ms: now - 58 * 86400000 });
const past = leaseKey({ lease_ttl_days: 60, last_seen_ms: now - 61 * 86400000 });
t('58 days left sorts above 2 days left (ascending = soonest first)', b < a && Math.abs(a - 58 * 86400000) < 5000 && Math.abs(b - 2 * 86400000) < 5000);
t('past ttl is negative — before every live lease', past < 0 && past < b);
t('no stamp sorts after every lease; excluded after that', leaseKey({ lease_ttl_days: 60, last_seen_ms: 0 }) === 9e15 && leaseKey({ excluded: true, lease_ttl_days: 60, last_seen_ms: now }) === 9e15 + 1);
// the markup carries the keys
t('the Channels row: opened on and lease cells carry data-sort', src.indexOf(`<td data-sort="'+(c.opened_ms||0)+'">'+(c.opened_ms?`) !== -1 && src.indexOf(`<td data-sort="'+leaseKey(c)+'">'+(c.excluded?`) !== -1);
t('the Wallets row: first seen and last heard cells carry data-sort', src.indexOf(`<td data-sort="'+(x.first_seen_ms||0)+'">`) !== -1 && src.indexOf(`<td data-sort="'+(x.last_heard_ms||0)+'">`) !== -1);
t('the template has no ${ (a template literal expression would run at module load)', js.indexOf('${') === -1 || src.slice(i0, i1).indexOf('${') === -1);
console.log((failed ? 'FAIL' : 'PASS') + ' · console-sort · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
