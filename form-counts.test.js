// 0.137.0 (S72 Tue 2026-11-24): HOW MANY WALLETS STILL USE THE OLDER FORMS (form-counts.js).
//   node form-counts.test.js
// The real store in a temp directory with a clock the test moves.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createFormCounts, KEEP_DAYS, UNKNOWN } = require('./form-counts');
let fails = 0;
const ok = (m) => console.log('  ok · ' + m);
const check = (cond, m, extra) => { if (!cond) { fails++; console.log('FAIL · ' + m + (extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 400) : '')); } else ok(m); };
const A = '02' + 'aa'.repeat(32), B = '03' + 'bb'.repeat(32), C = '02' + 'cc'.repeat(32);
const DAY = 86400000;
let t = Date.UTC(2026, 10, 24, 3, 0, 0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'));
const mk = () => createFormCounts({ dataDir: dir, now: () => t });

let f = mk();
f.tunnel(A, true); f.tunnel(A, true); f.tunnel(B, false); f.tunnel(null, false);
f.web(B, 'lijox.prefs_set'); f.web(B, 'lijox.prefs_set'); f.rpc(A, 'lijox.prefs_set'); f.rpc(C, 'lijox.prefs_set');
f.web(B, 'not a method'); f.rpc(A, '');
let r = f.report(30);
check(r.wallets_seen === 3 && r.days === 30 && r.to === '2026-11-24', 'c1 three wallet keys seen; the tunnel whose wallet was not named is counted apart', r);
check(r.wallets_without_a_pass.length === 1 && r.wallets_without_a_pass[0].wallet === B.slice(0, 16) && r.wallets_without_a_pass[0].openings_without === 1 && r.wallets_without_a_pass[0].last_day_without === '2026-11-24', 'c2 the wallet that opened a tunnel without a pass is named by 16 characters of its key, with the day', r.wallets_without_a_pass);
check(r.wallets_with_web_requests_for_moved_methods.length === 1 && r.wallets_with_web_requests_for_moved_methods[0].web_requests === 2 && r.wallets_with_web_requests_for_moved_methods[0].methods['lijox.prefs_set'] === 2, 'c3 the wallet that sent a moved request as a web request, and how often', r.wallets_with_web_requests_for_moved_methods);
check(r.wallets_only_inside_the_connection === 2 && r.tunnels_whose_wallet_was_not_named === 1, 'c4 two wallets used only the form inside the connection');
check(!JSON.stringify(r).includes(B) && !JSON.stringify(r).includes(A), 'c5 no whole key is in the report');
check(f.flush() === true && f.flush() === false && fs.existsSync(path.join(dir, 'form-counts.json')), 'c6 written when something changed, and only then');
const raw = fs.readFileSync(path.join(dir, 'form-counts.json'), 'utf8');
check(!/hold_ms|zaps|127\.0\.0\.1|http/.test(raw) && JSON.parse(raw).days['2026-11-24'][UNKNOWN].tn === 1, 'c7 the file holds counts by day and key — no request contents, no address');

// a restart, the next day
t += DAY; f = mk();
f.tunnel(B, true); f.rpc(B, 'lijox.prefs_set');
r = f.report(30);
check(r.wallets_seen === 3 && r.wallets_without_a_pass[0].openings_with === 1 && r.wallets_without_a_pass[0].last_day_without === '2026-11-24' && r.wallets_with_web_requests_for_moved_methods[0].inside_the_connection === 1 && r.wallets_with_web_requests_for_moved_methods[0].last_day_web === '2026-11-24', 'c8 after a restart the earlier days are still counted; "last day" is the last day the older form was used', r);
check(f.report(1).wallets_seen === 1 && f.report(1).wallets_without_a_pass.length === 0, 'c9 a report of one day holds today alone');
const txt = f.reportText(30);
check(/Wallets seen, 2026-10-27 to 2026-11-25 \(30 days\): 3/.test(txt) && /Opened a tunnel WITHOUT a pass: 1/.test(txt) && /Sent a moved request as a WEB request: 1/.test(txt) && txt.includes(B.slice(0, 16) + '…'), 'c10 the lines for a terminal', txt);

// 40 days kept
t += (KEEP_DAYS + 1) * DAY; f.tunnel(C, true); f.flush();
check(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'form-counts.json'), 'utf8')).days).length === 1 && f.report(40).wallets_seen === 1, 'c11 days older than ' + KEEP_DAYS + ' are removed at the next write');
// 0.138.0: a moved request whose WEB form names no wallet (the route request, the outcome check)
f.web(null, 'lijox.route_build'); f.web(null, 'lijox.route_build'); f.web(undefined, 'lijox.outcome');
const r12 = f.report(1), t12 = f.reportText(1);
check(r12.web_requests_that_name_no_wallet['lijox.route_build'] === 2 && r12.web_requests_that_name_no_wallet['lijox.outcome'] === 1 && r12.wallets_seen === 1 && /Moved requests that came as WEB requests and name no wallet: .*lijox\.route_build 2/.test(t12),
  'c12 a web request of a moved method that names no wallet is counted by method, apart from the wallets', { r: r12.web_requests_that_name_no_wallet, t12 });
f.stop();

// 0.146.0: each moved request that came as a web request is SAID — once an hour for a wallet and a method — and today's
// counts are there for the Console
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fc2-')); const said = []; let t2 = Date.UTC(2026, 10, 25, 12, 0, 0);
  const g = createFormCounts({ dataDir: dir2, now: () => t2, log: (m) => said.push(String(m)) });
  g.web(A, 'lijox.state'); g.web(A, 'lijox.state'); g.web(A, 'lijox.state');
  check(said.length === 1 && /^\[RPC\] NOT INSIDE LIGHTNING: lijox\.state came as a web request from 02aaaaaaaaaaaaaa… /.test(said[0]) && !said[0].includes(A), 'c13 three web requests of one method from one wallet: ONE journal line, with the method and the key cut to 16 characters', said);
  g.web(A, 'lijox.my_channels'); g.web(B, 'lijox.state'); g.web(null, 'lijox.outcome'); g.web(null, 'lijox.outcome');
  check(said.length === 4 && /lijox\.my_channels/.test(said[1]) && /03bbbbbbbbbbbbbb…/.test(said[2]) && /from a wallet the request does not name/.test(said[3]), 'c14 another method, another wallet, and a request that names no wallet are each said once', said.slice(1));
  t2 += 59 * 60 * 1000; g.web(A, 'lijox.state');
  const n59 = said.length;
  t2 += 2 * 60 * 1000; g.web(A, 'lijox.state');
  check(n59 === 4 && said.length === 5, 'c15 the same wallet and method again: nothing within the hour, one line after it', { n59, n: said.length });
  g.rpc(A, 'lijox.heartbeat'); g.rpc(C, 'lijox.pending'); g.web(B, 'not a method');
  const td = g.today();
  check(td.day === '2026-11-25' && td.web_requests === 9 && td.wallets === 2 && td.inside_requests === 2 && td.methods['lijox.state'] === 6 && td.methods['lijox.my_channels'] === 1 && td.methods['lijox.outcome'] === 2 && !JSON.stringify(td).includes(A), 'c16 today for the Console: 9 web requests naming 2 wallets, by method; 2 requests inside the connection; no key in it', td);
  g.stop(); try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log(fails ? 'FAIL · form-counts · ' + fails + ' failed' : 'PASS · form-counts (c1–c16)');
process.exit(fails ? 1 : 0);
