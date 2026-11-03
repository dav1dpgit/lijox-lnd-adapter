'use strict';
// lnurl-fetch.js — 0.119.3 (S66 Mon 2026-11-02, DP's UX list item 2, the Bitcoin Jungle case): the provider fetches a
// payee's pay terms or invoice FOR the phone, when the payee's server refused the browser (no CORS header). The wallet
// (page v1079, lijPayeeFetch) tries the server directly first and asks here only on a refusal, and only when its
// Privacy switch "Ask the provider" is On. The LUD-06 description-hash check stays on the phone: this answers the
// server's body text verbatim, nothing is parsed, nothing is kept, nothing is logged but a count.
//
// What is refused, so the route cannot be turned on the box itself or the LAN: anything but https on its default port;
// a host whose EVERY resolved address is not a public one (loopback, link-local, the private ranges, the carrier-grade
// range Tailscale lives in, multicast, reserved, the v6 equivalents); .onion and .local names; redirects (not followed);
// a body over 64 KiB; an answer slower than 10 s; a method other than GET. The connection goes to the ADDRESS that
// passed the check (the name is not resolved a second time by the socket), with the name in SNI and the Host header.
const https = require('https');
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10000;

/** true when an address is not a public unicast one. */
function privateAddress(a) {
  const s = String(a || '').toLowerCase();
  if (!net.isIP(s)) return true;
  if (s.startsWith('::ffff:')) return privateAddress(s.slice(7));
  if (net.isIPv4(s)) {
    const [a1, a2] = s.split('.').map((x) => parseInt(x, 10));
    if (a1 === 0 || a1 === 10 || a1 === 127) return true;
    if (a1 === 169 && a2 === 254) return true;
    if (a1 === 172 && a2 >= 16 && a2 <= 31) return true;
    if (a1 === 192 && a2 === 168) return true;
    if (a1 === 100 && a2 >= 64 && a2 <= 127) return true;   // 100.64.0.0/10 — carrier-grade NAT, Tailscale's range
    if (a1 >= 224) return true;                             // multicast and reserved
    return false;
  }
  if (s === '::' || s === '::1') return true;
  if (/^f[cd]/.test(s)) return true;      // fc00::/7 unique local
  if (/^fe[89ab]/.test(s)) return true;   // fe80::/10 link-local
  if (/^ff/.test(s)) return true;         // multicast
  return false;
}

/** The URL as the route takes it, or a reason it does not. */
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch (e) { return { error: 'bad_url' }; }
  if (u.protocol !== 'https:') return { error: 'not_https' };
  if (u.port && u.port !== '443') return { error: 'port' };
  if (u.username || u.password) return { error: 'bad_url' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');   // a v6 literal comes bracketed
  if (!host || host.endsWith('.onion') || host.endsWith('.local') || host === 'localhost') return { error: 'host' };
  if (net.isIP(host) && privateAddress(host)) return { error: 'host' };
  return { url: u, host };
}

/**
 * Fetch the URL for a wallet. Answers { ok: true, status, body } (the body text verbatim) or
 * { ok: false, error } with error one of: bad_url · not_https · port · host · resolve · unreachable · redirect ·
 * too_big · timeout · notjson (the server answered, but its body is not JSON — told so the phone can say so).
 * deps.lookup(host) → [addresses] and deps.request(opts) are for the tests; the defaults are Node's.
 */
async function fetchForWallet(raw, deps = {}) {
  const c = checkUrl(raw);
  if (c.error) return { ok: false, error: c.error };
  const lookup = deps.lookup || (async (h) => (await dns.lookup(h, { all: true })).map((x) => x.address));
  let addrs = [];
  try { addrs = await lookup(c.host); } catch (e) { return { ok: false, error: 'resolve' }; }
  addrs = (addrs || []).filter((a) => !privateAddress(a));
  if (!addrs.length) return { ok: false, error: 'host' };
  const ip = addrs[0];
  const request = deps.request || https.request;
  return new Promise((resolve) => {
    let done = false; const end = (r) => { if (!done) { done = true; resolve(r); } };
    let rq;
    try {
      rq = request({
        host: ip, servername: c.host, port: 443, method: 'GET',
        path: c.url.pathname + c.url.search,
        headers: { host: c.host, accept: 'application/json', 'user-agent': 'lijox-adapter-lnurl-fetch' },
        timeout: TIMEOUT_MS,
      }, (rs) => {
        const status = Number(rs.statusCode || 0);
        if (status >= 300 && status < 400) { try { rs.destroy(); } catch (e) {} return end({ ok: false, error: 'redirect' }); }
        let body = ''; let size = 0;
        rs.setEncoding('utf8');
        rs.on('data', (chunk) => { size += Buffer.byteLength(chunk, 'utf8'); if (size > MAX_BYTES) { try { rs.destroy(); } catch (e) {} return end({ ok: false, error: 'too_big' }); } body += chunk; });
        rs.on('end', () => {
          try { JSON.parse(body); } catch (e) { return end({ ok: false, error: 'notjson' }); }
          end({ ok: true, status, body });
        });
        rs.on('error', () => end({ ok: false, error: 'unreachable' }));
      });
    } catch (e) { return end({ ok: false, error: 'unreachable' }); }
    rq.on('timeout', () => { try { rq.destroy(); } catch (e) {} end({ ok: false, error: 'timeout' }); });
    rq.on('error', () => end({ ok: false, error: 'unreachable' }));
    rq.end();
  });
}

module.exports = { fetchForWallet, checkUrl, privateAddress, MAX_BYTES, TIMEOUT_MS };
