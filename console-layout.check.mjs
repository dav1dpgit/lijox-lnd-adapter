// console-layout.check.mjs — 0.133.2: THE CONSOLE'S CARDS, MEASURED IN A REAL BROWSER.
// DP 2026-11-19: "Make sure the pane stays its condensed size like all other panes until its header is clicked to
// expand … we had this problem in the past so want to avoid it." No test had looked at the Console in a browser; the
// first measurement found that 0.133.0's new Guardrails row had a 44-letter label — the label column of that pane grew
// from 158 px to 302 px and every value was left 70 px (26 px on a phone), the pane's content three to seven times as
// long. This check serves the real page (console.js, createConsole) with a fixed snapshot of a stand-in box — every
// pane filled; the new card filled by the real sent-watch.js from a stand-in LND with 43 HTLCs near their block — logs
// in, and measures, at a desk width and a phone width:
//   t  every card is one tile: all the same width, none wider than the window; the page does not scroll sideways
//   h  no card is taller than the condensed height (56 % of the window), however much it holds; what does not fit
//      scrolls inside the card
//   c  the card "Pending HTLCs" (0.133.3: it lists every pending HTLC): one table; it scrolls inside the card; with
//      nothing to list, and before its first read, it is smaller, never larger
//   g  Guardrails: its label column is as wide with the new row as without it; in Guardrails and in the new card the
//      value column is at least as wide as the label column
//   x  a click on the card's header expands it to the whole window; a second click puts it back to the size it had
//   r  a refresh (the page's 5-second event) changes no card's size
//   node console-layout.check.mjs
//   PLAYWRIGHT_MODULE = the path of playwright's index.mjs (a browser is needed; without one the check says so and
//   exits 2 — it never passes unseen)
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(HERE + '/');
const PW = process.env.PLAYWRIGHT_MODULE || '';
if (!PW || !existsSync(PW)) { console.log('NOT RUN: no browser — set PLAYWRIGHT_MODULE to playwright\'s index.mjs'); process.exit(2); }
const { chromium } = await import(PW);
const { createSentWatch } = require('./sent-watch.js');
let fails = 0; const fail = (m) => { fails++; console.log('FAIL · ' + m); }; const ok = (m) => console.log('  ok · ' + m);
const check = (c, m) => (c ? ok(m) : fail(m));
const FIX = JSON.parse(readFileSync(HERE + '/console-layout.fixture.json', 'utf8'));

// ── the new card's report, made by the real module from a stand-in LND ──
const W1 = '02' + 'a1'.repeat(32), W2 = '02' + 'b2'.repeat(32), X = '03' + 'c3'.repeat(32);
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const hx = (n) => ('0' + (n & 255).toString(16)).slice(-2).repeat(32);
async function report(nOut) {
  const chans = [
    { chan_id: '111', remote_pubkey: W1, active: false, private: true, channel_point: 'f7'.repeat(32) + ':0', pending_htlcs: [
      { incoming: true, amount: '421', hash_lock: b64(hx(0x11)), expiration_height: 976500, htlc_index: '3', forwarding_channel: '0', locked_in: true },
      { incoming: true, amount: '9', hash_lock: b64(hx(0x22)), expiration_height: 969900, htlc_index: '4', forwarding_channel: '0', locked_in: true }] },
    { chan_id: '333', remote_pubkey: W2, active: false, private: true, channel_point: 'd2'.repeat(32) + ':1', pending_htlcs: [
      { incoming: true, amount: '5000', hash_lock: b64(hx(0x44)), expiration_height: 976090, htlc_index: '7', forwarding_channel: '0', locked_in: true }] },
    { chan_id: '222', remote_pubkey: X, active: true, private: false, channel_point: 'e1'.repeat(32) + ':1', pending_htlcs: Array.from({ length: nOut }, (_, i) => ({ incoming: false, amount: String(1000 + i), hash_lock: b64(hx(0x50 + i)), expiration_height: 976010 + i, htlc_index: String(100 + i), forwarding_channel: '0', locked_in: true })) }];
  const sw = createSentWatch({ now: () => Date.now(), upSince: Date.now() - 999999, isWalletPeer: (pk) => pk === W1 || pk === W2, hasPushSub: () => true, sendWakePush: async () => true,
    lndPost: async () => ({ forwarding_events: [] }),
    lndGet: async (p) => p === '/v1/channels' ? { channels: nOut < 0 ? [] : chans } : (p === '/v1/getinfo' ? { block_height: 976000, version: '0.21.8-beta commit=v0.21.8-beta' } : (p === '/v1/invoice/' + hx(0x11) ? { state: 'CANCELED', htlcs: [{ chan_id: '111', htlc_index: '3', state: 'CANCELED' }] } : (p === '/v1/invoice/' + hx(0x44) ? { state: 'SETTLED', htlcs: [{ chan_id: '333', htlc_index: '7', state: 'SETTLED' }] } : { code: 2, message: 'there are no existing invoices' }))) });
  await sw.sweep(); await sw.sweep();
  return sw.report();
}
const STATES = { many: await report(40), few: await report(1), nothing: await report(-1), before: { ts: 0, height: 0, warn_blocks: 100, items: [], near: [], sweeps: 0, last_error: null, fwd_ids: null, up_grace_left_ms: 150000 }, absent: null };
check(STATES.many.htlcs.length === 43 && STATES.many.near.length === 42 && STATES.many.items.length === 2 && STATES.few.htlcs.length === 4 && STATES.few.near.length === 3 && STATES.nothing.htlcs.length === 0 && STATES.nothing.ts > 0, 'the stand-in reports: 43 pending HTLCs (42 near their block) and 2 sent payments; 4 (3 near) and 2; none');

// ── the real page, served by the real Console ──
const consoleJs = require('./console.js');
const enroll = consoleJs.totpEnroll('layout-check');
process.env.CONSOLE_TOTP_SECRET = enroll.secret; process.env.CONSOLE_PORT = process.env.LAYOUT_PORT || '17044'; process.env.CONSOLE_TAILSCALE = 'false';
let state = 'many';
const con = consoleJs.createConsole({ version: 'layout-check', snapshot: async () => Object.assign({}, FIX, { sent_watch: STATES[state], ts: Date.now(), session_until: Date.now() + 3600000, state_name: state }),
  routeToken: () => 'x', leaseStatus: () => ({ ok: true, channels: [] }), setLeaseTtl: async () => ({ ok: false }), releaseJitWallet: async () => ({ ok: false }) });
const servers = con.start();
const URL0 = 'http://127.0.0.1:' + process.env.CONSOLE_PORT + '/console';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
await p.goto(URL0);
await p.fill('#code', consoleJs.totpCode(consoleJs.base32Decode(enroll.secret), Math.floor(Date.now() / 1000 / 30)));
await p.keyboard.press('Enter');
await p.waitForSelector('#sentwatch', { timeout: 20000 });
const measure = () => p.evaluate(() => {
  const vh = window.innerHeight, vw = window.innerWidth;
  const kvCols = (id) => { const g = document.querySelector('#' + id + ' .kv'); if (!g || g.children.length < 2) return null; return [Math.round(g.children[0].getBoundingClientRect().width), Math.round(g.children[1].getBoundingClientRect().width)]; };
  const cards = [...document.querySelectorAll('section.card')].filter((s) => !s.hidden && !s.classList.contains('placeholder')).map((s) => { const r = s.getBoundingClientRect(); const pane = s.querySelector(':scope > div[id]');
    return { id: (pane && pane.id) || s.id, w: Math.round(r.width), h: Math.round(r.height), full: s.classList.contains('full'), tbls: s.querySelectorAll('.tbl').length, tblScrollW: Math.max(0, ...[...s.querySelectorAll('.tbl')].map((t) => t.scrollWidth)), tblClientW: Math.max(0, ...[...s.querySelectorAll('.tbl')].map((t) => t.clientWidth)), paneScrollH: pane ? pane.scrollHeight : 0, paneClientH: pane ? pane.clientHeight : 0 }; });
  return { vw, vh, cap: Math.round(vh * 0.56), docScrollW: document.documentElement.scrollWidth, cards, guard: kvCols('guard'), head: kvCols('sentwatch'), rows: document.querySelectorAll('#sentwatch tr').length };
});
// the page repaints from its 5-second event: wait until the card shows the state asked for
async function show(name) {
  state = name;
  const want = name === 'many' ? 44 : (name === 'few' ? 5 : 0);   // table rows: the header, the near ones, the one sent payment further out
  // the wait takes a band of row counts, not one number: a build with a second table is still measured, and fails on the count below — not on a wait
  await p.waitForFunction(([w, n]) => { const e = document.getElementById('sentwatch'); const g = document.getElementById('guard'); if (!e || !g || /^…$/.test(g.textContent.trim())) return false; const rows = e.querySelectorAll('tr').length; const t = e.textContent;
    if (n === 'absent') return /no report/.test(t); if (n === 'before') return /first read/.test(t); if (n === 'nothing') return /none on any channel/.test(t) && rows === 0; return n === 'few' ? (rows >= w && rows <= w + 3) : rows >= w; }, [want, name], { timeout: 20000 });
  await p.waitForTimeout(300);
  return measure();
}
for (const [label, vp] of [['desk 1280×900', { width: 1280, height: 900 }], ['phone 390×844', { width: 390, height: 844 }]]) {
  await p.setViewportSize(vp); await p.waitForTimeout(200);
  const m = await show('many');
  const mine = m.cards.find((c) => c.id === 'sentwatch'), guard = m.cards.find((c) => c.id === 'guard');
  const widths = [...new Set(m.cards.map((c) => c.w))];
  check(m.cards.length >= 19 && Math.max(...widths) - Math.min(...widths) <= 1 && Math.max(...widths) <= m.vw && m.docScrollW <= m.vw, `${label} · t every card is one tile — ${m.cards.length} cards, all ${widths[0]} px wide in a ${m.vw} px window; the page does not scroll sideways` + (m.docScrollW <= m.vw && Math.max(...widths) - Math.min(...widths) <= 1 ? '' : ` — widths ${JSON.stringify(widths)}, page ${m.docScrollW}`));
  const tall = m.cards.filter((c) => c.h > m.cap + 1).map((c) => c.id + ' ' + c.h);
  check(tall.length === 0, `${label} · h no card is taller than the condensed height (${m.cap} px = 56 % of the window)` + (tall.length ? ' — ' + tall.join(', ') : ''));
  check(mine.w === guard.w && mine.h <= m.cap + 1 && mine.tbls === 1 && m.rows === 44 && mine.tblScrollW > mine.tblClientW && mine.tblClientW <= mine.w, `${label} · c the new card with 43 rows: the same tile (${mine.w} × ${mine.h}), one table, and the table (${mine.tblScrollW} px) scrolls inside the card (${mine.tblClientW} px)`);
  check(m.guard && m.guard[1] >= m.guard[0] && m.head && m.head[1] >= m.head[0], `${label} · g the value column is at least as wide as the label column — Guardrails ${JSON.stringify(m.guard)}, the new card ${JSON.stringify(m.head)}`);
  // x: expand by the header, back by the header
  await p.click('#sentwatch >> xpath=../h2'); await p.waitForTimeout(900);
  const e1 = (await measure()).cards.find((c) => c.id === 'sentwatch');
  await p.click('#sentwatch >> xpath=../h2'); await p.waitForTimeout(900);
  const e2 = (await measure()).cards.find((c) => c.id === 'sentwatch');
  check(e1.full && e1.w === m.vw && e1.h === m.vh && !e2.full && e2.w === mine.w && e2.h === mine.h, `${label} · x a click on its header expands the card to the whole window (${e1.w} × ${e1.h}); a second click puts it back (${e2.w} × ${e2.h})`);
  // r: two refreshes later nothing has moved
  await p.waitForTimeout(10500);
  const m2 = await measure();
  check(JSON.stringify(m2.cards.map((c) => [c.id, c.w, c.h, c.full])) === JSON.stringify(m.cards.map((c) => [c.id, c.w, c.h, c.full])), `${label} · r two refreshes later every card has the size it had`);
  // the other states of the new card: never larger, and the rest of the page unmoved in width
  const few = await show('few'); const fMine = few.cards.find((c) => c.id === 'sentwatch');
  check(fMine.w === mine.w && fMine.h <= m.cap + 1 && fMine.tbls === 1 && few.rows === 5, `${label} · c with 4 rows: the same tile (${fMine.w} × ${fMine.h}), one table`);
  const nothing = await show('nothing'); const nMine = nothing.cards.find((c) => c.id === 'sentwatch');
  const before = await show('before'); const bMine = before.cards.find((c) => c.id === 'sentwatch');
  check(nMine.w === mine.w && bMine.w === mine.w && nMine.tbls === 0 && bMine.tbls === 0 && nMine.h <= m.cap + 1 && bMine.h <= m.cap + 1 && nMine.paneScrollH <= nMine.paneClientH + 1 && bMine.paneScrollH <= bMine.paneClientH + 1, `${label} · c with nothing to list, and before its first read: the same tile, no table, nothing to scroll (${nMine.w} × ${nMine.h}; ${bMine.w} × ${bMine.h})`);
  const absent = await show('absent');
  const withRow = m.guard, without = absent.guard, bg = before.guard;
  check(without && withRow[0] === without[0] && withRow[1] === without[1] && bg[0] === without[0], `${label} · g Guardrails' label column is as wide WITH the new row as without it (${withRow[0]} px; the value column ${withRow[1]} px)` + (without && withRow[0] === without[0] ? '' : ` — with ${JSON.stringify(withRow)}, without ${JSON.stringify(without)}`));
}
check(errs.length === 0, 'no page error' + (errs.length ? ' — ' + errs.join(' | ') : ''));
if (process.env.SHOT) { await p.setViewportSize({ width: 1280, height: 900 }); await show('many'); await p.screenshot({ path: process.env.SHOT }); }
await browser.close(); servers.forEach((s) => s.close());
console.log(fails ? `\n${fails} FAILED` : '\nconsole layout: all checks passed');
process.exit(fails ? 1 : 0);
