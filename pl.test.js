const { createPL } = require(require('path').join(__dirname,'pl.js')); const fs = require('fs'); const os = require('os'); const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')); const day = (ms) => new Date(ms);
const now = Date.now(); const yday = now - 86400000; const lastMonth = now - 40 * 86400000;
const S = (ms) => String(Math.floor(ms / 1000));
const fwd = [{ timestamp: S(now - 3600e3), fee_msat: '1500', chan_id_out: '111', chan_id_in: '222' }, { timestamp: S(yday), fee_msat: '2500', chan_id_out: '111' }, { timestamp: S(lastMonth), fee_msat: '7000', chan_id_out: '333' }];
const payments = [{ status: 'SUCCEEDED', creation_date: S(yday), fee_msat: '300', htlcs: [{ route: { hops: [{ pub_key: 'wallet1' }] } }] }, { status: 'SUCCEEDED', creation_date: S(now - 60e3), fee_msat: '900', htlcs: [{ route: { hops: [{ pub_key: 'other' }] } }] }, { status: 'FAILED', creation_date: S(now), fee_msat: '99999' }];
const txs = [{ tx_hash: 'open1', time_stamp: S(yday), total_fees: '1200', label: '' }, { tx_hash: 'close1', time_stamp: S(now - 30e3), total_fees: '800', label: '' }, { tx_hash: 'sw', time_stamp: S(now), total_fees: '150', label: 'sweep' }, { tx_hash: 'recv', time_stamp: S(now), total_fees: '0', label: '' }];
let denyFwd = false;
const pl = createPL({ dataDir: dir, log: () => {},
  lndPost: async (p, b) => { if (denyFwd) return { message: 'permission denied' }; return { forwarding_events: fwd, last_offset_index: 3 }; },
  lndGet: async (p) => p.startsWith('/v1/payments') ? { payments, last_index_offset: 3 } : p === '/v1/transactions' ? { transactions: txs } : p === '/v1/channels/closed' ? { channels: [{ closing_tx_hash: 'close1' }] } : {},
  isWalletPubkey: (pk) => pk === 'wallet1', channelPoints: () => new Set(['open1']), rates: () => ({ USD: 100000 }) });
pl.record('open_fee', { msat: 20000000, wallet: 'wallet1' }); pl.record('hold_fee', { msat: 0, wallet: 'wallet1' });
(async () => {
  let pass = 0, fail = 0; const t = (n, ok) => { (ok ? pass++ : fail++); console.log((ok ? 'PASS ' : 'FAIL ') + n); };
  const r = await pl.report(pl.dayKey(now));
  const d = r.periods.day, l = r.periods.ltd, m = r.periods.mtd;
  t('day: routing fee = today only', d.routing_fee_msat === 1500 && d.routing_count === 1);
  t('day: open fee from the ledger', d.open_fee_msat === 20000000 && d.open_count === 1 && d.hold_count === 1);
  t('day: payment fee counts only succeeded, today', d.payment_fee_msat === 900 && d.payment_count === 1 && d.delivery_count === 0);
  t('day: chain fees classified close + sweep, received tx ignored', d.chain_fee_close_sats === 800 && d.chain_fee_sweep_sats === 150 && d.chain_fee_open_sats === 0 && d.chain_tx_count === 2);
  t('mtd includes yesterday', m.routing_fee_msat === 4000 && m.chain_fee_open_sats === 1200 && m.delivery_count === 1);
  t('ltd includes last month', l.routing_fee_msat === 11000 && Object.keys(l.routing_by_chan).length === 2 && l.routing_by_chan['333'].fee_msat === 7000);
  t('rates carried', r.rates_usd === 100000 && r.missing.length === 0);
  t('finished days snapshotted', Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'pl-daily.json')))).length >= 2);
  denyFwd = true; const pl2 = createPL({ dataDir: dir, lndPost: async () => ({ message: 'permission denied' }), lndGet: async () => ({}), rates: () => null });
  const r2 = await pl2.report(pl.dayKey(now));
  t('missing permission is named, not guessed', r2.missing.some((x) => /ForwardingHistory/.test(x)));
  t('snapshots survive a restart (yesterday still there)', r2.periods.mtd.chain_fee_open_sats === 1200);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
