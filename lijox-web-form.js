'use strict';
// lijox-web-form.js — 0.138.0 (S72 Tue 2026-11-24, DP "Go on building step 1, and finish F"; the wallet repo's
// docs/design/routes/f3a-r1.md): A REQUEST THAT CAME INSIDE THE LIGHTNING CONNECTION IS CARRIED OUT BY THE CODE THAT
// CARRIES OUT ITS WEB FORM.
//
// The adapter's web routes are one long handler (req, res). Rewriting each route as a function for two callers would
// touch every money path. Instead a request that came inside the connection is handed to that same handler as a
// request object the adapter makes itself, and the answer the handler writes is caught and sent back inside the
// connection. One piece of code per request, whichever form it came in: the same checks, the same limits, the same
// answer.
//
// WHAT STANDS IN FOR WHAT
//   the route token       the adapter puts its own on the request it makes (a wallet has it anyway: it is published)
//   the caller            req[CALLER] = the node key of the connection — LND proved that key at the handshake.
//                         CALLER is a Symbol: no JSON body, header or query string can set it, so no web request
//                         can claim to have come inside a connection
//   the signed proof      lnurlpAuthCheck passes when the key a request names IS its connection's key, and refuses
//                         when it is another key. The handshake's proof is stronger than a signature over a nonce
//   the client's address  "ln:" + the first 16 characters of the key, so every per-address limit becomes a
//                         per-wallet limit and the journal names the wallet where it used to name an address
//
// A route whose body is not read with readBody() does not carry the caller to the proof check, and is refused there
// ("signature required"). That is the safe way to fail; such a route is taught when it is moved.
const { Readable } = require('stream');

const CALLER = Symbol('lijox.caller');
const ANSWER_WAIT_MS = 25000;   // a handler that never answers: the wallet gets 504 and its own deadline is not the only guard

/// The key of the connection a request (or a body parsed from it) came inside; null for a web request.
function callerOf(x) { try { const c = x && x[CALLER]; return (typeof c === 'string' && /^[0-9a-f]{66}$/.test(c)) ? c : null; } catch (_) { return null; } }

/// readBody() calls this: a body parsed from a request that came inside a connection carries that connection's key.
function carry(req, parsed) {
  const c = callerOf(req);
  if (c && parsed && typeof parsed === 'object') { try { Object.defineProperty(parsed, CALLER, { value: c, enumerable: false, writable: false, configurable: false }); } catch (_) {} }
  return parsed;
}

function createWebForm({ handle, secret, log, waitMs }) {
  const say = typeof log === 'function' ? log : () => {};
  const wait = Number(waitMs) > 0 ? Number(waitMs) : ANSWER_WAIT_MS;
  /// Carry out `httpMethod path` for the wallet `pk` as the web handler does. → Promise<{ status, body }>.
  /// `body`: the JSON body (POST). `query`: an object of query-string fields (GET or POST).
  /// `o.waitMs` (0.140.0): this call's own limit, for a route that may take longer than the default (a Push claim
  /// delivers a payment before it answers); 5 minutes at most.
  function call(pk, httpMethod, path, body, query, o) {
    const waitThis = (o && Number(o.waitMs) > 0) ? Math.min(Number(o.waitMs), 300000) : wait;
    pk = String(pk || '').toLowerCase();
    if (!/^[0-9a-f]{66}$/.test(pk) || !/^\/[A-Za-z0-9/_.-]*$/.test(String(path))) return Promise.resolve({ status: 500, body: { ok: false, error: 'internal' } });
    return new Promise((resolve) => {
      let done = false, status = 200; const chunks = [];
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8'); let j;
        try { j = text ? JSON.parse(text) : {}; } catch (_) { j = { ok: false, error: 'the answer is not JSON' }; if (status < 400) status = 502; }
        resolve({ status, body: j });
      };
      const timer = setTimeout(() => { if (done) return; say(`[RPC] ${httpMethod} ${path} for ${pk.slice(0, 16)}… gave no answer in ${Math.round(waitThis / 1000)} s`); status = 504; chunks.length = 0; chunks.push(Buffer.from('{"ok":false,"error":"no answer"}')); finish(); }, waitThis);
      if (timer.unref) timer.unref();
      const qs = (query && typeof query === 'object' && Object.keys(query).length) ? '?' + new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : '';
      const text = (String(httpMethod).toUpperCase() === 'GET' || body === undefined || body === null) ? '' : JSON.stringify(body);
      const req = Readable.from(text ? [Buffer.from(text, 'utf8')] : []);
      req.method = String(httpMethod).toUpperCase();
      req.url = path + qs;
      req.headers = { 'x-adapter-secret': String((typeof secret === 'function' ? secret() : secret) || ''), 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) };
      req.socket = { remoteAddress: 'ln:' + pk.slice(0, 16) };
      Object.defineProperty(req, CALLER, { value: pk, enumerable: false, writable: false, configurable: false });
      const headers = {};
      const put = (d) => { if (d !== undefined && d !== null) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8')); };
      const res = {
        headersSent: false, statusCode: 200, writableEnded: false,
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        getHeader(k) { return headers[String(k).toLowerCase()]; },
        removeHeader(k) { delete headers[String(k).toLowerCase()]; },
        writeHead(s, h) { status = Number(s) || 500; this.statusCode = status; this.headersSent = true; if (h && typeof h === 'object') for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]; return this; },
        write(d) { if (!this.headersSent) { status = this.statusCode; this.headersSent = true; } put(d); return true; },
        end(d) { if (!this.headersSent) { status = this.statusCode; this.headersSent = true; } put(d); this.writableEnded = true; finish(); return this; },
        on() { return this; }, once() { return this; }, emit() { return false; },
      };
      Promise.resolve().then(() => handle(req, res)).catch((e) => {
        say(`[RPC] ${httpMethod} ${path} for ${pk.slice(0, 16)}… threw: ${e && e.message}`);
        if (!done) { status = 500; chunks.length = 0; chunks.push(Buffer.from('{"ok":false,"error":"internal"}')); finish(); }
      });
    });
  }
  return { call };
}

module.exports = { createWebForm, CALLER, callerOf, carry, ANSWER_WAIT_MS };
