'use strict';
// state-kit-status.test.js — 0.123.0 (S66 Wed 2026-11-04, the box recovery v0.1): the state kit's receipts as the Console's
// Backups pane reads them — the manifest and the two legs' status files exactly as ops/um890-scb/lij-state-kit.sh writes
// them (the wallet repo's gate-state-kit.py proves the writer; this proves the reader).
//   node state-kit-status.test.js
const fs = require('fs'), os = require('os'), path = require('path');
const { readStateKit, LEG_WORDS, WHAT_WORDS, STALE_S } = require('./state-kit-status');
let n = 0, bad = 0;
const check = (c, m) => { n++; if (c) console.log('  ok · ' + m); else { bad++; console.log('  FAIL · ' + m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-kit-status-'));
const W = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
const NOW = 1762300000000;   // ms
const nowS = Math.floor(NOW / 1000);

// 1. nothing on the box: null (the pane says "not set up")
check(readStateKit(dir, NOW) === null, '1 no manifest, no status file: null');

// 2. the manifest alone (the first run died before the legs): what, no legs
W('state-kit.manifest.json', { kit: 'state-kit:v1', built_at: nowS - 600, host: 'um890', node_pubkey: '02' + 'ab'.repeat(32), versions: { lnd: '0.20.1-beta', core: '/Satoshi:31.2.0/', adapter_sha: 'ed049c8', adapter: '0.123.0', age: 'v1.1.1' },
  age_recipient: 'age1xyz', pieces: [{ path: 'adapter/env', bytes: 1200, sha256: 'a'.repeat(64) }, { path: 'float-wallet/descriptors.json', bytes: 2200, sha256: 'b'.repeat(64) }, { path: 'manifest.json', bytes: 900, sha256: 'c'.repeat(64) }],
  groups: { adapter: 1200, 'float-wallet': 2200, manifest: 900 }, total_bytes: 4300, missing: ['units/tailscaled.txt'], not_in_it: ['the LND seed (your custody)'] });
let r = readStateKit(dir, NOW);
check(r && r.what && r.what.pieces === 3 && r.what.bytes === 4300 && r.what.built_ms === (nowS - 600) * 1000 && r.what.kit === 'state-kit:v1' && r.what.host === 'um890', '2 the manifest: the piece count, the size, the build time, the kit version, the host');
check(r.what.versions.adapter_sha === 'ed049c8' && r.what.versions.core === '/Satoshi:31.2.0/' && r.what.missing.length === 1 && r.what.missing[0] === 'units/tailscaled.txt' && r.what.groups['float-wallet'] === 2200, '2 the versions, the missing list, the groups');
check(r.what.words === WHAT_WORDS && /float wallet/.test(WHAT_WORDS) && /age-encrypted/.test(WHAT_WORDS) && Object.keys(r.legs).length === 0, '2 the words; no legs yet');
check(!JSON.stringify(r).includes('age_recipient') && !JSON.stringify(r).includes('node_pubkey'), '2 the recipient and the node key are not repeated to the pane (the manifest stays on the box)');

// 3. both legs ok, fresh: shipped = last_ok; the archive's name, size and sha
W('status-state-local.json', { last_attempt: nowS - 500, ok: true, err: '', last_ok: nowS - 500, built_at: nowS - 600, name: 'state-kit-20261104-002017.tar.age', bytes: 61640, sha256: 'd'.repeat(64) });
W('status-state-cloud.json', { last_attempt: nowS - 490, ok: true, err: '', last_ok: nowS - 490, built_at: nowS - 600, name: 'state-kit-20261104-002017.tar.age', bytes: 61640, sha256: 'd'.repeat(64) });
r = readStateKit(dir, NOW);
check(r.legs.local && r.legs.local.ok === true && r.legs.local.stale === false && r.legs.local.shipped_ms === (nowS - 500) * 1000 && r.legs.local.at_ms === (nowS - 500) * 1000 && r.legs.local.bytes === 61640 && r.legs.local.sha256 === 'd'.repeat(64) && r.legs.local.name === 'state-kit-20261104-002017.tar.age', '3 the LAN leg: ok, fresh, shipped at last_ok, the archive\'s name, size and sha256');
check(r.legs.cloud && r.legs.cloud.ok === true && r.legs.cloud.where === LEG_WORDS.cloud && /20 MB/.test(LEG_WORDS.cloud) && r.legs.local.where === LEG_WORDS.local && /seven days/.test(LEG_WORDS.local), '3 the cloud leg ok; each leg\'s "where" words');

// 4. the cloud leg failed today after a good run yesterday: ok false, the note, shipped = yesterday's last_ok, not stale yet
W('status-state-cloud.json', { last_attempt: nowS - 100, ok: false, err: 'archive is 22000000 bytes — over the 20 MB line for the worker’s KV; the LAN leg carries it; move the cloud leg to R2', last_ok: nowS - 20 * 3600, built_at: nowS - 20 * 3600, name: 'state-kit-20261103-002011.tar.age', bytes: 61000, sha256: 'e'.repeat(64) });
r = readStateKit(dir, NOW);
check(r.legs.cloud.ok === false && /20 MB line/.test(r.legs.cloud.note) && r.legs.cloud.shipped_ms === (nowS - 20 * 3600) * 1000 && r.legs.cloud.attempt_ms === (nowS - 100) * 1000 && r.legs.cloud.stale === false, '4 a failed cloud leg: ok false, the words, shipped = the last good run, not yet stale (20 h)');

// 5. stale: a last_ok past 26 h; never ok: stale too
W('status-state-local.json', { last_attempt: nowS - 100, ok: true, err: '', last_ok: nowS - 27 * 3600, name: 'x', bytes: 1, sha256: 'f'.repeat(64) });
W('status-state-cloud.json', { last_attempt: nowS - 100, ok: false, err: 'ssh/rsync failed' });
r = readStateKit(dir, NOW);
check(r.legs.local.stale === true && STALE_S === 26 * 3600, '5 a leg whose last good run is 27 h old is stale');
check(r.legs.cloud.stale === true && r.legs.cloud.shipped_ms === 0 && r.legs.cloud.at_ms === (nowS - 100) * 1000 && r.legs.cloud.sha256 === '' && r.legs.cloud.bytes === 0, '5 a leg never ok: stale, shipped never, at = the attempt');

// 6. a status file alone (no manifest): legs, what null; a broken file is skipped, not thrown
fs.unlinkSync(path.join(dir, 'state-kit.manifest.json'));
fs.writeFileSync(path.join(dir, 'status-state-cloud.json'), '{not json');
r = readStateKit(dir, NOW);
check(r && r.what === null && r.legs.local && !r.legs.cloud, '6 no manifest: what null; a broken status file is skipped');

fs.rmSync(dir, { recursive: true, force: true });
console.log((bad ? 'FAIL' : 'PASS') + ' · state-kit-status: ' + (n - bad) + ' passed, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
