'use strict';
// 0.126.0 (S68 Wed 2026-11-11, DP "Continue/go" — the wallet repo's docs/design/recovery/peer-storage-and-recovery-v0.4.md §2):
// THE CHANNEL STATE FILE'S HOLDER. A wallet keeps one encrypted file here — at most 65,531 bytes, the size BOLT #1110
// (peer storage) allows — and gets it back when it asks. This is #1110's file carried over HTTPS, because LND has no
// peer storage messages in any release; the bytes are the same ones a #1110 node would hold.
//   · the latest only: a new file replaces the one before it;
//   · a lower number is refused (the wallet's number is its clock in milliseconds, raised above the held one);
//   · the same number with the same fingerprint is the same file sent twice — accepted, nothing written;
//   · the holder cannot read the file (AES-256-GCM under the wallet's key); `state_fp` is the wallet's own fingerprint of
//     its channel state, kept beside the file so a reconnecting wallet can ask for it alone and fetch the file only
//     when it differs from its own;
//   · held for ANY wallet that proves its node key — not only this provider's own (LIJOX: MUST; #1110: MAY).
// No network and no LND in this file: the routes in lij-adapter.js prove the key, this keeps the bytes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_MAX = 65531;
const MAX_RECORDS_DEFAULT = 20000;
const DOMAIN = 'lij-peer-storage-v1:';

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
// what the node key signs: the action, the one-time nonce and — for a put — the number and the file's own hash
function signedText(action, nonce, version, fileSha) {
  return DOMAIN + action + ':' + nonce + (action === 'put' ? ':' + String(version) + ':' + fileSha : '');
}

function createPeerStorage(opts) {
  const dir = path.join(opts.dataDir, 'peer-storage');
  const maxRecords = opts.maxRecords || MAX_RECORDS_DEFAULT;
  const log = opts.log || function () {};
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const okPk = (pk) => /^0[23][0-9a-f]{64}$/.test(pk);
  const metaFile = (pk) => path.join(dir, pk + '.json');
  const binFile = (pk) => path.join(dir, pk + '.bin');
  function meta(pk) {
    if (!okPk(pk)) return null;
    try { const m = JSON.parse(fs.readFileSync(metaFile(pk), 'utf8')); return (m && Number.isSafeInteger(m.version)) ? m : null; } catch (e) { return null; }
  }
  function count() { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch (e) { return 0; } }
  function writeAtomic(f, data) { const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, data); fs.renameSync(t, f); }
  function put(pk, version, stateFp, file) {
    if (!okPk(pk)) return { ok: false, code: 'bad_key' };
    if (!Number.isSafeInteger(version) || version <= 0) return { ok: false, code: 'bad_version' };
    if (!/^[0-9a-f]{64}$/.test(String(stateFp))) return { ok: false, code: 'bad_fingerprint' };
    if (!Buffer.isBuffer(file) || file.length === 0) return { ok: false, code: 'bad_file' };
    if (file.length > FILE_MAX) return { ok: false, code: 'too_large', max_bytes: FILE_MAX };
    const had = meta(pk);
    if (had) {
      if (version < had.version) return { ok: false, code: 'lower_version', held_version: had.version };
      if (version === had.version) return had.state_fp === stateFp ? { ok: true, version: had.version, same: true } : { ok: false, code: 'lower_version', held_version: had.version };
    } else if (count() >= maxRecords) return { ok: false, code: 'full' };
    // the file first, then its line: a stop in between leaves the old line over the new file — the next put repairs it,
    // and a get in between is caught by the hash kept in the line
    writeAtomic(binFile(pk), file);
    const m = { version: version, state_fp: stateFp, at: Date.now(), bytes: file.length, sha256: sha256hex(file) };
    writeAtomic(metaFile(pk), JSON.stringify(m));
    log(`[PeerStorage] kept ${file.length} bytes for ${pk.slice(0, 16)} — no. ${version}` + (had ? ` (was no. ${had.version})` : ' (first)'));
    return { ok: true, version: version };
  }
  function get(pk) {
    const m = meta(pk); if (!m) return null;
    let file = null; try { file = fs.readFileSync(binFile(pk)); } catch (e) { return null; }
    if (sha256hex(file) !== m.sha256) return null;   // the line and the file do not belong together: nothing is handed back
    return { version: m.version, state_fp: m.state_fp, at: m.at, file: file };
  }
  return { put, get, meta, count, capability: { v: 1, max_bytes: FILE_MAX } };
}

module.exports = { createPeerStorage, signedText, sha256hex, FILE_MAX, DOMAIN };
