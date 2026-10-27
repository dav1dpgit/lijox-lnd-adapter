// 0.115.0 (S63, Kimi round 2 F17 — DP "256MiB total with the oldest past 30 days deleted first"): tapesSweep bounds the
// tape store — at the cap the oldest tapes PAST the keep window go first, oldest first, until the new tape fits; a tape
// younger than the window is never deleted; a store full of young tapes refuses the drop. Run: node tapes-cap.test.js
'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const src = fs.readFileSync(__dirname + '/lij-adapter.js', 'utf8');
const m = src.match(/function tapesSweep\([\s\S]*?\n}\n/); assert(m, 'tapesSweep found');
const tapesSweep = new Function('require', m[0] + '; return tapesSweep;')(require);
let passed = 0, failed = 0; const t = (n, ok, extra) => { if (ok) { passed++; console.log('  ok · ' + n); } else { failed++; console.log('  FAIL · ' + n + (extra ? ' — ' + extra : '')); } };
const DAY = 86400000, NOW = 1_790_000_000_000, KEEP = 30 * DAY;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapes-'));
const put = (ageDays, bytes, tag) => fs.writeFileSync(path.join(dir, (NOW - ageDays * DAY) + '-' + tag + '.json'), 'x'.repeat(bytes));
const names = () => fs.readdirSync(dir).sort();
// a 1,000-byte cap; four tapes: 40 d old (300), 35 d (300), 10 d (300), 2 d (50) = 950 bytes
put(40, 300, 'a'); put(35, 300, 'b'); put(10, 300, 'c'); put(2, 50, 'd');
let r = tapesSweep(dir, 40, 1000, KEEP, NOW);
t('under the cap: nothing unlinked, ok', r.ok === true && r.unlinked === 0 && r.total === 950 && names().length === 4, JSON.stringify(r));
r = tapesSweep(dir, 100, 1000, KEEP, NOW);
t('over the cap by 50: the OLDEST tape past 30 days goes (a, 40 d), the 35-d one stays — ok', r.ok === true && r.unlinked === 1 && r.total === 650 && !names().some((n) => n.endsWith('-a.json')) && names().some((n) => n.endsWith('-b.json')), JSON.stringify(r) + ' ' + names().join(','));
r = tapesSweep(dir, 400, 1000, KEEP, NOW);
t('over by more: the next oldest past 30 days goes too (b); the 10-d and 2-d tapes stay — ok', r.ok === true && r.unlinked === 1 && r.total === 350 && names().length === 2 && names().every((n) => /-(c|d)\.json$/.test(n)), JSON.stringify(r));
r = tapesSweep(dir, 700, 1000, KEEP, NOW);
t('still over with only young tapes left: NOTHING deleted, the drop refused (ok false)', r.ok === false && r.unlinked === 0 && r.total === 350 && names().length === 2, JSON.stringify(r));
// an empty or missing dir is fine
r = tapesSweep(path.join(dir, 'nope'), 10, 1000, KEEP, NOW);
t('a missing dir: ok, total 0', r.ok === true && r.total === 0);
// the default settings in the source: 256 MiB, 30 days, both box settings
t('the defaults: TAPES_MAX_BYTES 256 MiB, TAPES_KEEP_DAYS 30, from the environment', /TAPES_MAX_BYTES = parseInt\(process\.env\.TAPES_MAX_BYTES \|\| String\(256 \* 1024 \* 1024\)/.test(src) && /TAPES_KEEP_DAYS = parseInt\(process\.env\.TAPES_KEEP_DAYS \|\| '30'/.test(src));
t('handleTapeDrop sweeps before the write and refuses 507 TAPES_FULL', /const sw = tapesSweep\(TAPES_DIR, Buffer\.byteLength\(payload\), TAPES_MAX_BYTES, TAPES_KEEP_DAYS \* 86400000, Date\.now\(\)\);[\s\S]{0,600}reply\(507, \{ ok: false, code: 'TAPES_FULL' \}\);[\s\S]{0,80}writeFileSync\(fname, payload\)/.test(src));
console.log((failed ? 'FAIL' : 'PASS') + ' · tapes-cap · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
