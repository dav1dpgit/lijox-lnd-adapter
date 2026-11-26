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
// ── 0.143.0 (found 2026-11-20: "the tape store is at its 256 MiB cap"): what the store
//    holds and how much room a new tape can still get is READ and SHOWN. The store sits at its cap by design once it
//    has filled — each new tape pushes out tapes past the keep window. The number that matters is the room a new tape
//    can still get: the free bytes plus the bytes held by tapes past the keep window. At zero, a tape is refused. ──
const ms = src.match(/function tapesState\([\s\S]*?\n}\n/); t('tapesState found in the source', !!ms);
const tapesState = ms ? new Function('require', ms[0] + '; return tapesState;')(require) : () => ({});
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tapes2-'));
const put2 = (ageDays, bytes, tag, pre) => fs.writeFileSync(path.join(dir2, (pre || '') + (NOW - ageDays * DAY) + '-' + tag + '.json'), 'x'.repeat(bytes));
put2(40, 300, 'a'); put2(35, 200, 'b'); put2(10, 300, 'c'); put2(2, 50, 'd');
let st = tapesState(dir2, 1000, KEEP, NOW);
t('state: 4 tapes, 850 bytes, the oldest 40 days, the newest 2 days', st.count === 4 && st.total === 850 && st.oldest_at === NOW - 40 * DAY && st.newest_at === NOW - 2 * DAY, JSON.stringify(st));
t('state: 2 tapes (500 bytes) are past the 30 days — the bytes the sweep may still delete', st.past_keep_count === 2 && st.past_keep_bytes === 500, JSON.stringify(st));
t('state: the room a new tape can still get = 150 free + 500 past the window = 650', st.room_bytes === 650, JSON.stringify(st));
// the agreement, on fresh copies so the first sweep's deletions do not help the second
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tapes3-')), dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'tapes4-'));
for (const d of [dir3, dir4]) for (const [age, b, tag] of [[40, 300, 'a'], [35, 200, 'b'], [10, 300, 'c'], [2, 50, 'd']]) fs.writeFileSync(path.join(d, (NOW - age * DAY) + '-' + tag + '.json'), 'x'.repeat(b));
t('the room is exact: a tape of room_bytes is taken', tapesSweep(dir3, 650, 1000, KEEP, NOW).ok === true);
t('the room is exact: one byte more is refused', tapesSweep(dir4, 651, 1000, KEEP, NOW).ok === false);
st = tapesState(dir3, 1000, KEEP, NOW);
t('after that sweep: only young tapes, 350 bytes, nothing past the window, room = the free bytes only (650)', st.count === 2 && st.total === 350 && st.past_keep_bytes === 0 && st.room_bytes === 650, JSON.stringify(st));
st = tapesState(dir3, 300, KEEP, NOW);
t('a store over its cap with only young tapes: room 0 — the next tape is refused', st.room_bytes === 0, JSON.stringify(st));
st = tapesState(path.join(dir2, 'nope'), 1000, KEEP, NOW);
t('a missing dir: 0 tapes, the whole cap is room', st.count === 0 && st.total === 0 && st.room_bytes === 1000, JSON.stringify(st));
put2(1, 20, 'e', 'claimed-');
st = tapesState(dir2, 1000, KEEP, NOW);
t('an unsigned tape’s file ("claimed-…") is counted by its file time, as the sweep does', st.count === 5 && st.total === 870, JSON.stringify(st));
// the drop handler: a refusal is counted and written loudly; a routine sweep is written as routine, both with the room
t('handleTapeDrop notes the sweep and the refusal through tapesNote, before the 507', /const sw = tapesSweep\([^\n]*\n  tapesNote\(sw, pk\);[^\n]*\n  if \(!sw\.ok\) return reply\(507, \{ ok: false, code: 'TAPES_FULL' \}\);/.test(src));
const mn = (src.match(/function tapesNote\([\s\S]*?\n}\n/) || [''])[0];
t('tapesNote: a refusal is counted (tapesRefused) and its line says the tape was REFUSED and is not kept', /tapesRefused\.n \+= 1; tapesRefused\.last_ms = Date\.now\(\);/.test(mn) && /console\.warn\(`\[TapeDrop\] STORE FULL \\u2014 the tape from \$\{pk\.slice\(0, 16\)\}\\u2026 was REFUSED and is not kept/.test(mn));
t('tapesNote: a routine sweep says so and states the room a new tape can still get', /deleted to make room, as set; \$\{tapesRoomWords\(st\)\}/.test(mn) && /function tapesRoomWords\(st\) \{[\s\S]{0,200}room a new tape can still get: /.test(src));
t('/v1/status carries the store’s state and the refusals', /tape_store: tapeStoreReport\(\),/.test(src) && /function tapeStoreReport\(\)/.test(src));
t('the box says the store’s state once at start-up', /\[TapeDrop\] the tape store: /.test(src));
const csrc = fs.readFileSync(__dirname + '/console.js', 'utf8');
t('the Console shows the store: size against the cap, the oldest tape, the room, the refusals', /d\.tape_store/.test(csrc) && /room for new tapes/.test(csrc) && /REFUSED/.test(csrc));
console.log((failed ? 'FAIL' : 'PASS') + ' · tapes-cap · ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
