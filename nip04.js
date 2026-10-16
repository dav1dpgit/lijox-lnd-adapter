// nip04.js — 0.106.0 (S59 Thu, Phase 2b: the provider as host of a public room). NIP-04 (the pool channel's encryption:
// AES-256-CBC under the ECDH x-coordinate, base64 "?iv=" base64) and NIP-01 event signing, for the host's own messages —
// the announcement (kind 2022, signed by the room's key), the credentials and "pool is full" answers (kind 4, sealed from
// the room's key to the asker), and reading the room (kind 4, sealed to the room's key). The engine's nwc.rs is the
// reference; the bytes must match it (the engine's wire::open / wire::seal).
'use strict';
const crypto = require('crypto');
const secp = require('secp256k1');
const schnorr = require('./schnorr.js');
const { eventId } = require('./nwc.js');

const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);

/// The ECDH x-coordinate between a secret key (32-byte hex) and an x-only public key (the even-y point, as nostr).
function sharedX(skHex, xonlyHex) {
  if (!isHex(skHex, 64) || !isHex(xonlyHex, 64)) throw new Error('sharedX: keys are 32-byte hex');
  const pub = Buffer.concat([Buffer.from([2]), Buffer.from(xonlyHex, 'hex')]);
  if (!secp.publicKeyVerify(pub)) throw new Error('sharedX: not a point');
  return Buffer.from(secp.ecdh(pub, Buffer.from(skHex, 'hex'), { hashfn: (x) => x }, Buffer.alloc(32)));
}

function encrypt(shared, text, iv) {
  const ivb = iv || crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', shared, ivb);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return enc.toString('base64') + '?iv=' + ivb.toString('base64');
}

function decrypt(shared, content) {
  const s = String(content || '');
  const i = s.indexOf('?iv=');
  if (i < 0) throw new Error('nip04: no iv');
  const ct = Buffer.from(s.slice(0, i), 'base64'), ivb = Buffer.from(s.slice(i + 4), 'base64');
  if (ivb.length !== 16) throw new Error('nip04: bad iv');
  const d = crypto.createDecipheriv('aes-256-cbc', shared, ivb);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/// A signed NIP-01 event from a 32-byte hex secret key.
function signEvent(skHex, createdAt, kind, tags, content) {
  const pubkey = schnorr.pubkey(Buffer.from(skHex, 'hex')).toString('hex');
  const ev = { pubkey, created_at: createdAt, kind, tags, content };
  ev.id = eventId(ev);
  ev.sig = schnorr.sign(Buffer.from(skHex, 'hex'), ev.id, crypto.randomBytes(32)).toString('hex');
  return ev;
}

/// A pool message sealed from `authorSk` to `toXonly` (kind 4, tagged p = the receiver), as the engine's wire::seal.
function seal(authorSk, toXonly, json, createdAt) {
  return signEvent(authorSk, createdAt, 4, [['p', toXonly]], encrypt(sharedX(authorSk, toXonly), json));
}

module.exports = { sharedX, encrypt, decrypt, signEvent, seal, isHex };
