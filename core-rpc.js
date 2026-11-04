'use strict';
// core-rpc.js — 0.120.0 (S66, Lightning pays on-chain — docs/design/onchain-pay/lightning-paying-onchain-v0.6.md §9.1):
// the door to THE FLOAT WALLET, a wallet inside the box's own Bitcoin Core under an RPC user whose command list is
// whitelisted (rpcwhitelist). This client speaks only to that door: JSON-RPC 1.0 over plain http on the box, basic
// auth, one call at a time, a timeout. Bitcoin Core answers a command outside the user's list with HTTP 403 — the
// fence probe asks one harmless command outside the list (getnetworkinfo) and expects exactly that.
const http = require('http');
const https = require('https');

/** The float wallet's whitelist (v0.6 §9.1) — the only commands this box may ever call on it. */
const FLOAT_COMMANDS = ['estimatesmartfee', 'sendtoaddress', 'bumpfee', 'getnewaddress', 'getaddressinfo', 'sendrawtransaction', 'testmempoolaccept', 'getbalances', 'listunspent', 'gettransaction', 'getwalletinfo', 'getblockcount'];
const FENCE_PROBE = 'getnetworkinfo';   // harmless, outside the list

function createCoreRpc({ url, user, pass, timeoutMs = 20000, request = null } = {}) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { throw new Error('ONCHAIN_PAY_RPC_URL is not a URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('ONCHAIN_PAY_RPC_URL must be http(s)');
  const lib = u.protocol === 'https:' ? https : http;
  const doRequest = request || lib.request;
  const auth = 'Basic ' + Buffer.from(String(user || '') + ':' + String(pass || ''), 'utf8').toString('base64');
  let seq = 0;

  /** One call. Resolves the result; rejects with { code, message, http } — code is Core's JSON-RPC code when there is one. */
  function call(method, params = []) {
    if (!FLOAT_COMMANDS.includes(method) && method !== FENCE_PROBE) return Promise.reject(Object.assign(new Error('not a float wallet command: ' + method), { code: 'not_allowed' }));
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'lij-' + (++seq), method, params });
    return new Promise((resolve, reject) => {
      let done = false; const end = (f, v) => { if (!done) { done = true; f(v); } };
      const err = (message, code, httpStatus) => Object.assign(new Error(message), { code, http: httpStatus });
      let rq;
      try {
        rq = doRequest({
          hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: auth },
          timeout: timeoutMs,
        }, (rs) => {
          const status = Number(rs.statusCode || 0); let text = '';
          rs.setEncoding('utf8'); rs.on('data', (c) => { text += c; if (text.length > 8 * 1024 * 1024) { try { rs.destroy(); } catch (e) {} end(reject, err('answer too big', 'too_big', status)); } });
          rs.on('end', () => {
            if (status === 403) return end(reject, err('forbidden — the command is outside the RPC user\'s whitelist', 'forbidden', 403));
            if (status === 401) return end(reject, err('unauthorized — the RPC user or password is wrong', 'unauthorized', 401));
            let j = null; try { j = JSON.parse(text); } catch (e) {}
            if (!j || typeof j !== 'object') return end(reject, err('no JSON answer (HTTP ' + status + ')', 'notjson', status));
            if (j.error) return end(reject, err(String(j.error.message || 'rpc error'), (j.error.code == null ? 'rpc' : j.error.code), status));
            end(resolve, j.result);
          });
          rs.on('error', () => end(reject, err('connection lost', 'unreachable', status)));
        });
      } catch (e) { return end(reject, err(String(e.message || e), 'unreachable')); }
      rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} end(reject, err('timed out after ' + timeoutMs + ' ms', 'timeout')); });
      rq.on('error', (e) => end(reject, err('unreachable: ' + String(e && e.message || e), 'unreachable')));
      rq.end(body);
    });
  }

  /** The fence: 'ok' when Core refuses a command outside the list (403), 'open' when it answers it, 'down' when it cannot be asked. */
  async function probeFence() {
    try { await call(FENCE_PROBE); return 'open'; }
    catch (e) { if (e && e.code === 'forbidden') return 'ok'; if (e && (e.code === 'unauthorized' || e.code === 'unreachable' || e.code === 'timeout' || e.code === 'notjson')) return 'down'; return 'open'; }
  }

  return { call, probeFence, FLOAT_COMMANDS, walletPath: u.pathname };
}

module.exports = { createCoreRpc, FLOAT_COMMANDS, FENCE_PROBE };
