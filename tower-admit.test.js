// tower-admit.test.js — 0.130.0: who may use the tower (the voucher), and the provider's side that gives one.
//   node tower-admit.test.js
const A = require('./tower-admit.js'); const schnorr = require('./schnorr.js');
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
let pass = 0, fail = 0; const t = (n, ok, extra) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra && !ok ? ' — ' + extra : '')); };
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const kp = (name) => { const sk = sha('k:' + name); return { sk, pk: schnorr.pubkey(sk).toString('hex') }; };
const node = (c) => '02' + c.repeat(32);

const TOWER = node('aa'), TOWER2 = node('bb'), PROV = node('c1'), PROV2 = node('c2'), FAKE = node('ee'), NOTOWER = node('dd');
// a stand-in for LND's message signature: "sig of <issuer> over <text>"; verifyNode gives the issuer back only for the text it signed
const nodeSig = (issuer, text) => 'z' + sha(issuer + '|' + text).toString('hex') + issuer.slice(2, 12);
const sigBook = new Map();
const signAs = (issuer, text) => { const s = nodeSig(issuer, text); sigBook.set(s + '|' + text, issuer); return s; };
const verifyNode = async (text, sig) => sigBook.get(sig + '|' + text) || null;
const voucherFor = (issuer, v, towerNode, towerKey) => ({ key: v.pk, issuer, issuer_sig: signAs(issuer, A.voucherText(v.pk)), use_sig: A.signUse(v.sk, towerNode, towerKey) });
const LISTED = [{ pubkey: PROV, tower: { offered: true } }, { pubkey: PROV2, tower: { offered: true } }, { pubkey: NOTOWER, tower: { offered: false } }, { pubkey: FAKE, tower: { offered: true } }, { pubkey: TOWER2, tower: { offered: true } }];
const CAP = { [PROV]: 30000000, [PROV2]: 2000000, [FAKE]: 0, [TOWER2]: 9000000 };

function make(over) {
  const o = Object.assign({ mode: 'voucher', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'adm-')), self: TOWER, cap: (pk) => (pk in CAP ? CAP[pk] : 0), heldSet: new Set(), clock: { t: 1800000000000 }, lines: [] }, over || {});
  const a = A.createAdmit({ dataDir: o.dir, mode: o.mode, self: () => o.self, listed: async () => LISTED, verifyNode, capacity: async (pk) => o.cap(pk), held: (k) => o.heldSet.has(k),
    issuerMaxKeys: o.maxKeys, issuerNewPerDay: o.perDay, minCapacitySats: o.minCap, allow: o.allow, keepDays: 400, now: () => o.clock.t, log: (l) => o.lines.push(l) });
  return Object.assign(o, { a });
}

(async () => {
  t('the provider signs "lijox-voucher-v1|tower|<voucher key>"', A.voucherText('ab'.repeat(32)) === 'lijox-voucher-v1|tower|' + 'ab'.repeat(32));
  t('the voucher key signs "lijox-voucher-use-v1|<tower node key>|<tower key>"', A.useText(TOWER, 'cd'.repeat(32)) === 'lijox-voucher-use-v1|' + TOWER + '|' + 'cd'.repeat(32));

  const w = kp('wallet 1 voucher'), tk = kp('wallet 1 at the tower').pk, good = voucherFor(PROV, w, TOWER, tk);
  let h = make();
  let r = await h.a.admit(tk, undefined);
  t('voucher required: a key with no voucher is refused (voucher_needed) and nothing is written', !r.ok && r.code === 'voucher_needed' && h.a.standing(tk) === null && !fs.existsSync(path.join(h.dir, 'tower', 'admitted.json')));
  r = await h.a.admit(tk, good);
  t('a good voucher admits the key', r.ok && r.admitted === 'voucher' && r.issuer === PROV && h.a.standing(tk) === 'voucher');
  t('…and the journal names 8 characters of the key and 12 of the provider, no more', h.lines.length === 1 && h.lines[0].includes(tk.slice(0, 8)) && !h.lines[0].includes(tk.slice(0, 9)) && !h.lines[0].includes(PROV.slice(0, 13)));
  r = await h.a.admit(tk, undefined);
  t('admitted for good: the next request needs no voucher', r.ok && r.admitted === 'voucher');
  const h2 = make({ dir: h.dir });
  t('the admission is on disk (a restart keeps it)', h2.a.standing(tk) === 'voucher');

  // a copied voucher is useless
  const thiefKey = kp('thief').pk;
  r = await h.a.admit(thiefKey, good);
  t('the same voucher shown for ANOTHER key: refused (use_signature — the use line names the first key)', !r.ok && (r.code === 'use_signature' || r.code === 'voucher_used'));
  const other = make({ self: TOWER2 });
  r = await other.a.admit(tk, good);
  t('the same voucher shown at ANOTHER tower: refused (use_signature — the use line names the first tower)', !r.ok && r.code === 'use_signature');
  r = await other.a.admit(thiefKey, Object.assign({}, good, { use_sig: A.signUse(kp('not the voucher key').sk, TOWER2, thiefKey) }));
  t('a new use line made without the voucher key: refused', !r.ok && r.code === 'use_signature');
  r = await other.a.admit(tk, voucherFor(PROV, w, TOWER2, tk));
  t('the WALLET itself at another tower: the same voucher with a new use line is taken', r.ok && r.admitted === 'voucher');
  const tk2 = kp('wallet 1 second key').pk;
  r = await h.a.admit(tk2, voucherFor(PROV, w, TOWER, tk2));
  t('one tower key per voucher at a tower: a second key under the same voucher is refused (voucher_used)', !r.ok && r.code === 'voucher_used');

  // the provider behind the voucher
  const mk = (issuer, name, hh) => { const v = kp('v ' + name), k = kp('k ' + name).pk; return { k, v: voucherFor(issuer, v, (hh || h).self, k) }; };
  let x = mk(node('99'), 'unlisted'); r = await h.a.admit(x.k, x.v);
  t('a provider that is not on the registry list: issuer_unknown', !r.ok && r.code === 'issuer_unknown');
  x = mk(NOTOWER, 'no tower'); r = await h.a.admit(x.k, x.v);
  t('a listed provider that offers no tower itself: issuer_no_tower', !r.ok && r.code === 'issuer_no_tower');
  x = mk(FAKE, 'fake'); r = await h.a.admit(x.k, x.v);
  t('a listed provider this node sees with no public channels: issuer_unproven', !r.ok && r.code === 'issuer_unproven');
  x = mk(PROV2, 'at the floor'); r = await h.a.admit(x.k, x.v);
  t('a provider exactly at the capacity floor (2,000,000 sats) is taken', r.ok && r.admitted === 'voucher');
  x = mk(PROV, 'forged'); x.v.issuer_sig = signAs(FAKE, A.voucherText(x.v.key)); r = await h.a.admit(x.k, x.v);
  t('a signature that is not the named provider\'s: issuer_signature', !r.ok && r.code === 'issuer_signature');
  x = mk(PROV, 'shape'); delete x.v.use_sig; r = await h.a.admit(x.k, x.v);
  t('a voucher with a part missing: bad_voucher', !r.ok && r.code === 'bad_voucher');
  let hh = make({ cap: () => null });
  x = mk(PROV, 'unread', hh); r = await hh.a.admit(x.k, x.v);
  t('the graph cannot be read (the key lacks it): another provider\'s voucher is refused (issuer_unproven)', !r.ok && r.code === 'issuer_unproven');
  hh = make({ cap: () => null, allow: [PROV] });
  x = mk(PROV, 'named', hh); r = await hh.a.admit(x.k, x.v);
  t('…unless the operator named that provider (TOWER_ISSUERS_ALLOW)', r.ok && r.admitted === 'voucher');
  hh = make({ minCap: 0 });
  x = mk(FAKE, 'no floor', hh); r = await hh.a.admit(x.k, x.v);
  t('a floor of 0 asks no capacity', r.ok);
  hh = make({ cap: () => { throw new Error('never asked'); } });
  x = mk(TOWER, 'own wallet', hh); r = await hh.a.admit(x.k, x.v);
  t('the tower\'s own vouchers (its own wallets) need no list and no capacity', r.ok && r.issuer === TOWER);

  // per vouching provider
  hh = make({ maxKeys: 2, perDay: 50 });
  for (const nm of ['a', 'b']) { x = mk(PROV, 'max ' + nm, hh); r = await hh.a.admit(x.k, x.v); }
  x = mk(PROV, 'max c', hh); r = await hh.a.admit(x.k, x.v);
  t('the ceiling per vouching provider: the third key of two is refused (issuer_full)', !r.ok && r.code === 'issuer_full');
  x = mk(PROV2, 'max other', hh); r = await hh.a.admit(x.k, x.v);
  t('…another provider\'s wallets are not affected', r.ok);
  hh = make({ maxKeys: 2000, perDay: 2 });
  for (const nm of ['a', 'b']) { x = mk(PROV, 'day ' + nm, hh); r = await hh.a.admit(x.k, x.v); }
  x = mk(PROV, 'day c', hh); r = await hh.a.admit(x.k, x.v);
  t('new keys a day per vouching provider: the third in a day is refused (issuer_rate)', !r.ok && r.code === 'issuer_rate');
  hh.clock.t += 86400001; r = await hh.a.admit(x.k, x.v);
  t('…and taken a day later', r.ok);
  let s = hh.a.summary((k) => 506);
  t('the summary counts keys, bytes and refusals per vouching provider', s.mode === 'voucher' && s.admitted === 3 && s.by_voucher === 3 && s.issuers.length === 1 && s.issuers[0].issuer === PROV && s.issuers[0].keys === 3 && s.issuers[0].bytes === 1518 && s.issuers[0].new_24h === 1 && s.refused.issuer_rate === 1);

  // while keys are still taken without a voucher
  hh = make({ mode: 'open' });
  const ok1 = kp('open 1').pk;
  r = await hh.a.admit(ok1, undefined);
  t('open: a key with no voucher is taken — and written only once something is kept for it', r.ok && r.admitted === 'open' && hh.a.standing(ok1) === null);
  hh.a.noteHeld(ok1);
  t('…noteHeld writes it', hh.a.standing(ok1) === 'open');
  x = mk(FAKE, 'open bad', hh); r = await hh.a.admit(x.k, x.v);
  t('open: a voucher that fails is still served, and told why (voucher_refused)', r.ok && r.admitted === 'open' && r.voucher_refused === 'issuer_unproven' && hh.a.standing(x.k) === null);
  const wv = kp('open then voucher'); r = await hh.a.admit(ok1, voucherFor(PROV, wv, TOWER, ok1));
  t('a key held without a voucher that shows a good one becomes "by voucher"', r.ok && r.admitted === 'voucher' && hh.a.standing(ok1) === 'voucher' && hh.lines.some((l) => l.includes('it was held without one')));

  // keys from before, and the keeping time
  hh = make();
  const old1 = kp('before 1').pk, old2 = kp('before 2').pk;
  t('keys the holder has from before vouchers stay admitted', hh.a.seed([old1, old2]) === 2 && hh.a.standing(old1) === 'open' && hh.a.seed([old1, old2]) === 0);
  r = await hh.a.admit(old1, undefined);
  t('…and are served with no voucher even where one is required', r.ok && r.admitted === 'open');
  x = mk(FAKE, 'kept bad', hh); x.k = old2; x.v = voucherFor(FAKE, kp('v kept bad'), TOWER, old2); r = await hh.a.admit(old2, x.v);
  t('…a failed voucher does not put a kept key out', r.ok && r.admitted === 'open' && r.voucher_refused === 'issuer_unproven');
  hh.heldSet.add(old1); hh.clock.t += 401 * 86400000;
  t('silent longer than the keeping time with nothing held: forgotten; with something held: kept', hh.a.forgetSilent() === 1 && hh.a.standing(old1) === 'open' && hh.a.standing(old2) === null);
  hh = make({ self: '' });
  x = mk(PROV, 'no self', hh); r = await hh.a.admit(x.k, x.v);
  t('a box that does not know its own node key yet admits nothing (not_ready)', !r.ok && r.code === 'not_ready');

  // ── the provider's side ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-')); const lines = []; let paid = new Set(), signs = 0;
  const WAL = node('71'), WAL2 = node('72');
  const desk = () => A.createDesk({ dataDir: dir, log: (l) => lines.push(l), now: () => 1800000000000, sign: async (text) => { signs++; return signAs(PROV, text); },
    eligible: async (wk) => (paid.has(wk) ? { ok: true, why: 'its channel has carried a payment' } : { ok: false, why: 'no fee from this wallet yet' }) });
  let d = desk(); const v1 = kp('desk voucher 1').pk;
  r = await d.issue(WAL, v1);
  t('no fee from the wallet yet: no voucher (not_yet), nothing signed', !r.ok && r.code === 'not_yet' && signs === 0);
  paid.add(WAL); r = await d.issue(WAL, v1);
  t('after its first fee the provider signs the wallet\'s voucher key', r.ok && r.voucher_key === v1 && r.again === false && (await verifyNode(A.voucherText(v1), r.issuer_sig)) === PROV && signs === 1);
  const first = r.issuer_sig; r = await d.issue(WAL, v1);
  t('asked again: the same voucher, nothing signed anew', r.ok && r.again === true && r.issuer_sig === first && signs === 1);
  r = await d.issue(WAL, kp('desk voucher other').pk);
  t('ONE voucher a wallet: another voucher key for the same wallet is refused (already_issued)', !r.ok && r.code === 'already_issued' && signs === 1);
  d = desk(); r = await d.issue(WAL, v1);
  t('the record is on disk (a restart gives the same voucher)', r.ok && r.again === true && r.issuer_sig === first);
  r = await d.issue('nonsense', v1); const r2 = await d.issue(WAL2, 'zz');
  t('a bad wallet key or voucher key: bad_request', !r.ok && r.code === 'bad_request' && !r2.ok && r2.code === 'bad_request');
  t('the journal names 16 characters of the wallet\'s node key and no voucher key', lines.length === 1 && lines[0].includes(WAL.slice(0, 16)) && !lines[0].includes(WAL.slice(0, 17)) && !lines[0].includes(v1.slice(0, 8)));
  t('the desk counts what it gave', d.summary().given === 1);
  // the two sides together: the voucher the desk gave is taken by a tower
  const vk = kp('end to end'); paid.add(WAL2); r = await d.issue(WAL2, vk.pk);
  const tkey = kp('end to end tower key').pk; h = make();
  const rr = await h.a.admit(tkey, { key: vk.pk, issuer: PROV, issuer_sig: r.issuer_sig, use_sig: A.signUse(vk.sk, TOWER, tkey) });
  t('end to end: the desk\'s voucher, with the wallet\'s use line, admits the wallet\'s key at a tower', rr.ok && rr.admitted === 'voucher' && rr.issuer === PROV);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
