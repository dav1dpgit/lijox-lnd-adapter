// 0.146.0 (the operator, 2026-11-25: "When not going through lightning I want to know as both the wallet user and the
// LSP user"): ONE OF THE FIVE CHECKS THAT CAME AS A WEB REQUEST IS COUNTED WITH ITS WALLET — for a wallet that holds a
// channel with this node, and only then.   node not-inside.test.js
// The adapter's own checkCameAsWeb and its path list, cut from lij-adapter.js, with stand-ins for what they call.
const fs = require('fs'); const path = require('path');
const A = fs.readFileSync(path.join(__dirname, 'lij-adapter.js'), 'utf8');
let fails = 0;
const check = (c, m, x) => { if (!c) { fails++; console.log('FAIL · ' + m + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } else console.log('  ok · ' + m); };
const i0 = A.indexOf('const CHECK_WEB_PATHS = ['), i1 = A.indexOf('async function hasChannelWith(pubkey) {');
check(i0 > 0 && i1 > i0, 'n0 the block is where it was');
const OWN = '02' + 'aa'.repeat(32), OTHER = '03' + 'bb'.repeat(32), INSIDE = Symbol('inside');
const counted = []; let asked = 0;
const fn = new Function('webFormLib', 'hasChannelWith', 'formCounts', A.slice(i0, i1) + '\nreturn checkCameAsWeb;')(
  { callerOf: (req) => (req && req[INSIDE]) || null },
  async (pk) => { asked++; return pk === OWN; },
  { web: (pk, m) => counted.push(m + ' ' + pk.slice(0, 6)) });
const tick = () => new Promise((r) => setImmediate(r));
(async () => {
  fn({ url: '/v1/state' }, { node_pubkey: OWN }); await tick();
  fn({ url: '/v1/peer-storage/meta?x=1' }, { node_pubkey: OWN }); await tick();
  fn({ url: '/lsps/registry/my-channels' }, { node_pubkey: OWN.toUpperCase() }); await tick();
  fn({ url: '/lsps/registry/recover-close' }, { node_pubkey: OWN }); await tick();
  check(counted.join(' | ') === 'lijox.state 02aaaa | lijox.state_file 02aaaa | lijox.my_channels 02aaaa | lijox.recover_close 02aaaa', 'n1 each of the four routes that name a wallet is counted under its method, for a wallet that holds a channel here', counted);
  const n = counted.length;
  fn({ url: '/v1/state' }, { node_pubkey: OTHER }); await tick();
  check(counted.length === n && asked === 5, 'n2 a wallet of another provider (no channel here) asks the same as a web request BY DESIGN: not counted', { counted: counted.length, asked });
  fn({ url: '/v1/state', [INSIDE]: OWN }, { node_pubkey: OWN }); await tick();
  check(counted.length === n && asked === 5, 'n3 the same request inside a connection is not counted, and LND is not asked');
  fn({ url: '/v1/heartbeat' }, { node_pubkey: OWN }); fn({ url: '/v1/peer-storage/' }, { node_pubkey: OWN }); fn({ url: '/v1/state' }, { node_pubkey: 'not a key' }); fn({ url: '/v1/state' }, {}); fn({ url: '/v1/state' }, null); await tick();
  check(counted.length === n && asked === 5, 'n4 another path, the bare folder, a body with no key or a malformed one: nothing counted, LND not asked');
  console.log(fails ? 'FAIL · not-inside · ' + fails + ' failed' : 'PASS · not-inside (n0–n4)');
  process.exit(fails ? 1 : 0);
})();
