'use strict';
// chanconfs.test.js (0.135.0): what the provider states about the confirmations its LND asks for.
const fs = require('fs'), os = require('os'), path = require('path');
const { chanConfs, parseStated, readDefaultChanConfs, bootLine, words } = require('./chanconfs');
let pass = 0, fail = 0;
const t = (name, ok) => { if (ok) pass++; else { fail++; console.log('FAIL ' + name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chanconfs-'));
const conf = (name, txt) => { const p = path.join(d, name); fs.writeFileSync(p, txt); return p; };

// c1 — the operator's own statement
t('c1 one number', eq(parseStated('3'), { min: 3, max: 3 }) && eq(parseStated(' 1 '), { min: 1, max: 1 }));
t('c1 a range', eq(parseStated('3-6'), { min: 3, max: 6 }) && eq(parseStated('3 - 6'), { min: 3, max: 6 }));
t('c1 not set', parseStated('') === null && parseStated(undefined) === null && parseStated('   ') === null);
t('c1 refused, with the reason', ['0', '6-3', '145', '3-145', 'three', '3,6', '-3', '3-', '1.5'].every((x) => { const r = parseStated(x); return r && typeof r.problem === 'string' && r.problem.includes('CHAN_CONFS'); }));

// c2 — LND's settings file
const one = conf('one.conf', '[Application Options]\nalias=x\n[Bitcoin]\nbitcoin.mainnet=true\nbitcoin.defaultchanconfs=1\n');
const none = conf('none.conf', '[Bitcoin]\nbitcoin.mainnet=true\n; bitcoin.defaultchanconfs=2\n# bitcoin.defaultchanconfs=4\n');
const zero = conf('zero.conf', 'bitcoin.defaultchanconfs = 0\n');
const tail = conf('tail.conf', '  Bitcoin.DefaultChanConfs = 2   \n');
t('c2 the line as written', readDefaultChanConfs(one) === 1 && readDefaultChanConfs(tail) === 2);
t('c2 a commented line is not the setting', readDefaultChanConfs(none) === 0);
t('c2 zero is LND\'s "not set"', readDefaultChanConfs(zero) === 0);
t('c2 no path, or a file that is not there', readDefaultChanConfs('') === null && readDefaultChanConfs(undefined) === null && readDefaultChanConfs(path.join(d, 'absent.conf')) === null);

// c3 — the statement, first source that holds
let c = chanConfs({ CHAN_CONFS: '2', TATARA_LND_CONF: one });
t('c3 the operator\'s statement comes first', c.min === 2 && c.max === 2 && c.from === 'CHAN_CONFS' && c.problem === '');
c = chanConfs({ TATARA_LND_CONF: one });
t('c3 then lnd.conf', c.min === 1 && c.max === 1 && c.from.startsWith('bitcoin.defaultchanconfs in ') && c.from.endsWith('one.conf'));
c = chanConfs({ TATARA_LND_CONF: none });
t('c3 lnd.conf read, the setting absent: LND\'s own rule', c.min === 3 && c.max === 6 && c.from.startsWith("LND's own rule (") && !c.from.includes('assumed'));
c = chanConfs({});
t('c3 nothing to read: LND\'s own rule, said to be assumed', c.min === 3 && c.max === 6 && c.from.includes('assumed') && c.from.includes('set CHAN_CONFS'));
c = chanConfs({ CHAN_CONFS: 'six', TATARA_LND_CONF: one });
t('c3 a statement that cannot be read is not used, and the line says so', c.min === 1 && c.max === 1 && c.problem.includes('CHAN_CONFS="six"') && bootLine(c).includes('NOT USED'));
c = chanConfs({ TATARA_LND_CONF: path.join(d, 'absent.conf') });
t('c3 a path that cannot be read: assumed', c.min === 3 && c.max === 6 && c.from.includes('assumed'));

// c4 — the words
t('c4 one, a number, a range', words({ min: 1, max: 1 }) === '1 confirmation' && words({ min: 3, max: 3 }) === '3 confirmations' && words({ min: 3, max: 6 }) === '3 to 6 confirmations');
t('c4 the boot line', bootLine(chanConfs({ CHAN_CONFS: '3-6' })) === '[ChanConfs] a channel a wallet funds is usable after 3 to 6 confirmations · from: CHAN_CONFS');

fs.rmSync(d, { recursive: true, force: true });
console.log(fail ? `\n${pass} passed, ${fail} failed` : `PASS · chanconfs (c1–c4, ${pass})`);
process.exit(fail ? 1 : 0);
