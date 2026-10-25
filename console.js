'use strict';
// console.js — the operator's monitor INSIDE the adapter (0.71.0, S45 #6+#10).
//
// What it is: one HTML page served by the adapter itself, live through
// server-sent events, reachable only from loopback and the Tailscale interface
// (never through the public tunnel), behind a six-digit TOTP code and nothing
// else. It replaces the box-local lij-console (a separate service shelling out
// to lncli) with panes that read the adapter's own state and LND's REST API.
//
// Access, exactly:
//   - BIND: 127.0.0.1 always; every address of an interface named tailscale0
//     (CONSOLE_TAILSCALE=true, default) ; plus CONSOLE_BIND extras. Nothing else.
//   - LOGIN: TOTP (RFC 6238, 30s, 6 digits, ±1 step, a code accepted ONCE).
//     Secret in CONSOLE_TOTP_SECRET (base32), enrolled with `--totp-enroll`
//     on the box's terminal. No token, no password, no username.
//   - SESSION: a correct code sets an HttpOnly SameSite=Strict cookie for
//     CONSOLE_SESSION_HOURS (12) bound to the remote address; expiry asks for
//     the code again. Five wrong codes from one address lock it for 10 min.
//   - AUDIT: every login attempt (ok / bad / locked) and every action is one
//     journal line, `[Console] …`.
//   - OUTBOUND: none. The page loads nothing from anywhere; CSP default-src
//     'none', script/style by hash, connect-src 'self' for the event stream.
//
// 0.111.0 (S63): the four operator routes that left the public API live here — /console/lease (the lease's figures;
// loopback + the route token for the box-local dashboard, or a session), /console/lease-ttl (a channel's lease length,
// floor one day), /console/jit-release-wallet (one blocked wallet back in); the snapshot carries jit_now and the lease.
// Phase 1 panes: node, balances, channels (with Tor/clearnet per peer), wallets
// served (LNURL names, holds, lease clocks), pending channels, registry status,
// SCB backup legs, loops/watchdog, version. PL (day/MTD/YTD/LTD) and the
// phase-2 actions (peer/open/close, dials) ride later cuts.

const http   = require('http');
const os     = require('os');
const crypto = require('crypto');

// ── TOTP (RFC 6238) and base32 (RFC 4648), stdlib only ─────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, acc = 0, out = '';
  for (const b of buf) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; } }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const s = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, acc = 0; const out = [];
  for (const ch of s) { const v = B32.indexOf(ch); if (v < 0) return null; acc = (acc << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); } }
  return Buffer.from(out);
}
function totpCode(secretBuf, counter) {
  const msg = Buffer.alloc(8); msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0); msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}
function totpVerify(secretBuf, code, nowMs, usedCounters) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) return null;
  const step = Math.floor(nowMs / 1000 / 30);
  for (const k of [0, -1, 1]) {
    const counter = step + k;
    if (usedCounters.has(counter)) continue;                // a code is accepted once
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secretBuf, counter)), Buffer.from(c))) return counter;
  }
  return null;
}

// ── the page (inline; hashed into the CSP at module load) ──────────────────────
const CSS = `
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #30363d;position:sticky;top:0;background:#0d1117}
header h1{font-size:16px;margin:0;font-weight:600}header .sub{color:#8b949e;font-size:12px}header .sp{flex:1}
button{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}button:hover{background:#30363d}
main{padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 12px 0;min-width:0;overflow:hidden;display:flex;flex-direction:column;max-height:56vh}.card.wide{grid-column:1/-1}.card[hidden]{display:none}.card>div{min-width:0;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch}.card>div>*{flex:0 0 auto}.card>div>.tbl{flex:1 1 auto;min-height:0}.card>div:last-child{padding-bottom:12px}.card>div:last-child:has(>.tbl:last-child){padding-bottom:0}.card .tbl{overflow:auto;-webkit-overflow-scrolling:touch;margin:0;padding:0}
td button{padding:1px 6px;font-size:11px;line-height:1.3;border-radius:5px;white-space:nowrap}td{line-height:1.3}
input.note{background:transparent;color:#e6edf3;border:1px solid transparent;border-radius:4px;padding:1px 4px;font:inherit;font-size:12px;width:16em;max-width:100%}input.note:hover,input.note:focus{border-color:#30363d;background:#0d1117;outline:none}
textarea.note{width:100%;min-height:2.6em;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px;resize:vertical;margin-bottom:8px}
tr.grp td{background:#1c2129;font-weight:600}tr.grp td .tri{display:inline-block;width:1em;color:#8b949e}tr.sub td:first-child{padding-left:22px}.card h2{font-size:13px;margin:0 0 8px;color:#8b949e;text-transform:uppercase;letter-spacing:.04em;cursor:pointer;user-select:none}.card h2:after{content:' ⤢';opacity:.35;font-size:12px}.card.full h2:after{content:' ⤡'}.card h2:hover{color:#e6edf3}
.card.full{position:fixed;z-index:50;margin:0;border-radius:0;box-shadow:0 0 0 100vmax #0d1117;overflow:auto;transition:top .32s cubic-bezier(.2,.7,.2,1),left .32s cubic-bezier(.2,.7,.2,1),width .32s cubic-bezier(.2,.7,.2,1),height .32s cubic-bezier(.2,.7,.2,1),border-radius .32s}.card.full{max-height:none}.card.placeholder{visibility:hidden}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:10px}.kpi{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 10px;min-width:0}.kpi .t{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.04em}.kpi .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin:2px 0;overflow-wrap:anywhere}.kpi .s{font-size:11px;color:#8b949e}.kpi.warn .v{color:#d29922}.kpi.bad .v{color:#f85149}.kpi.good .v{color:#3fb950}
.flow{display:block;margin:4px 0 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px}.flow .fb{fill:#161b22;stroke:#30363d}.flow .fb.hub{stroke:#8b949e}.flow .ft{fill:#8b949e;font-size:10px;letter-spacing:.04em}.flow .fv{fill:#e6edf3;font-size:12px;font-weight:600}.flow .fs{fill:#8b949e;font-size:10px}.flow .fl{fill:#e6edf3;font-size:11px}.flow .fl.off{fill:#8b949e}.flow .fn{fill:#8b949e;font-size:10px;font-variant-numeric:tabular-nums}.flow .fe{fill:none;stroke-linecap:butt}.flow .fe.them{stroke:#3d3a5c}.flow .fe.us{stroke:#7c6cf0}.flow .fe.dash{stroke:#8b949e;stroke-width:2;stroke-dasharray:4 6}
.kv{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:4px 12px}.kv div{min-width:0;overflow-wrap:anywhere;word-break:break-word}.kv div:nth-child(odd){color:#8b949e}.kv div:nth-child(even){font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:max-content}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #21262d;vertical-align:top}th{color:#8b949e;font-weight:500;cursor:pointer;user-select:none;white-space:nowrap}th.sorted:after{content:' ▴';opacity:.7}th.sorted.desc:after{content:' ▾'}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.ok{color:#3fb950}.warn{color:#d29922}.bad{color:#f85149}.dim{color:#8b949e}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere;word-break:break-all}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid #30363d}.tor{border-color:#8957e5;color:#c297ff}.clear{border-color:#1f6feb;color:#79c0ff}
#login{max-width:340px;margin:18vh auto;text-align:center}#login input{font:28px ui-monospace,Menlo,monospace;letter-spacing:.35em;text-align:center;width:100%;padding:12px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;margin:14px 0}
#pl .ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}#pl input[type=date]{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:5px 8px;font:inherit}#pl .per button{padding:4px 9px}#pl .per button.on{background:#1f6feb;border-color:#1f6feb;color:#fff}#pl td.h,#pl th.h{color:#8b949e;font-weight:500}#pl tr.tot td{border-top:1px solid #30363d;font-weight:600}
#login p{color:#8b949e}#msg{min-height:1.3em}@media(max-width:480px){main{grid-template-columns:1fr}header .sub{display:none}}
`;
const JS = `
(function(){
var $=function(id){return document.getElementById(id)};
function fmt(n){n=Number(n||0);return n.toLocaleString('en-US')}
function ago(ms){if(!ms)return '\\u2014';var s=Math.max(0,(Date.now()-ms)/1000);if(s<90)return Math.round(s)+' s ago';if(s<5400)return Math.round(s/60)+' min ago';if(s<172800)return (s/3600).toFixed(1)+' h ago';return (s/86400).toFixed(1)+' d ago'}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function jitGuardLine(j){if(!j)return '<span class="dim">no report</span>';var nw=Number(j.failed_wallets_24h||0),n=Number(j.failed_24h||0),lv=Number(j.level||0);var w=nw+' wallet'+(nw===1?'':'s')+' with a funded-but-failed JIT open in the last 24 h ('+n+' open'+(n===1?'':'s')+')';var tail=' <span class="dim">a channel opened and the payment then failed \u00b7 counted per wallet: red at 1, armed at '+j.arm_at+', JIT off at '+j.halt_at+' wallets; one wallet is blocked on its own at '+(j.wallet_at||0)+' failures \u00b7 JIT_GUARD_ARM_AT / JIT_GUARD_HALT_AT / JIT_GUARD_WALLET_AT</span>';var blocked=(j.blocked_wallets||[]);var bl=blocked.length?'<br><span class="warn">'+blocked.length+' wallet'+(blocked.length===1?'':'s')+' blocked from JIT opens</span> <span class="dim">(their own failures; a block clears 24 h after the last, or here)</span>'+blocked.map(function(b){return '<br><span class="mono">'+esc(String(b.wallet).slice(0,20))+'\u2026</span> '+b.failures+' failed \u00b7 last '+ago(b.last_at)+' '+esc(b.last_code||'')+' <button class="jrw" data-w="'+esc(b.wallet)+'">release this wallet</button>'}).join(''):'';if(j.halted){return '<span class="bad">JIT OFF since '+new Date(j.halted.at).toLocaleString()+' \u2014 '+(j.halted.wallets||j.halted.count)+' wallets\u2019 funded-but-failed opens in 24 h ('+j.halted.count+' opens)</span>'+(j.last_failed?'<br><span class="dim">last: '+esc(String(j.last_failed.cp||'').slice(0,20))+'\u2026 '+esc(j.last_failed.code||'')+' '+ago(j.last_failed.at)+'</span>':'')+'<br><button class="jr">Release the guard \u2014 JIT opens again</button>'+bl+tail}if(lv>=2)return '<span class="bad">'+w+' \u2014 JIT shutdown ARMED</span>'+(j.last_failed?' <span class="dim">last: '+esc(j.last_failed.code||'')+' '+ago(j.last_failed.at)+'</span>':'')+bl+tail;if(lv===1)return '<span class="warn">'+w+'</span>'+(j.last_failed?' <span class="dim">last: '+esc(j.last_failed.code||'')+' '+ago(j.last_failed.at)+'</span>':'')+bl+tail;return '<span class="ok">none in the last 24 h</span>'+(j.last_release?' <span class="dim">released '+ago(j.last_release)+'</span>':'')+bl+tail}
// 0.109.0 (S61, DP 2026-10-19 — the console graphic, live mode): the money as it sits now. Left: the on-chain balance and
// the LiJ wallets (their sendable / receivable summed); middle: this node; right: every peer channel (ex-wallet), one
// band per channel, width by capacity, the band split where the balance sits (this side left, the peer's side right).
// Numbers only from the snapshot (channels, balances); nothing is replayed or predicted — the replay and the plan are
// their own project.
function flowSvg(d){
  var ch=(d.channels||[]),b=d.balances||{},bx=b.boxes||{},pr=b.principles||{};
  var peers=ch.filter(function(c){return !c.wallet}).sort(function(a,c){return c.capacity-a.capacity});
  var wal=ch.filter(function(c){return c.wallet});
  if(!peers.length&&!wal.length)return '';
  var W=760,rowH=30,n=Math.max(peers.length,1),H=Math.max(190,n*rowH+70),top=Math.max(20,H/2-n*rowH/2);
  var maxCap=Math.max.apply(null,peers.map(function(c){return c.capacity}).concat([1]));
  var hubX=330,hubW=130,hubH=88,hubTop=H/2-hubH/2,rightX=500,rightW=W-rightX-10;
  var leftX=12,leftW=170;
  var M=function(v){v=Number(v||0);var a=Math.abs(v);return a>=1e6?(a/1e6).toFixed(2)+'M':a>=1e3?Math.round(a/1e3)+'k':String(Math.round(a))};
  function box(x,y,w,h,title,line1,line2,cls){return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" rx="6" class="fb '+(cls||'')+'"/>'
    +'<text x="'+(x+10)+'" y="'+(y+17)+'" class="ft">'+esc(title)+'</text>'+(line1?'<text x="'+(x+10)+'" y="'+(y+35)+'" class="fv">'+esc(line1)+'</text>':'')+(line2?'<text x="'+(x+10)+'" y="'+(y+50)+'" class="fs">'+esc(line2)+'</text>':'')}
  var out='<svg class="flow" viewBox="0 0 '+W+' '+H+'" width="100%" role="img" aria-label="liquidity now">';
  /* left: on-chain, the wallets */
  var ocY=Math.max(20,hubTop-6),walY=Math.min(H-66,hubTop+hubH-52+40);
  out+=box(leftX,ocY,leftW,56,'ON-CHAIN',fmt(bx.onchain_total)+' sats',fmt(bx.anchor_reserve)+' anchor reserve');
  out+=box(leftX,walY,leftW,56,'LiJ WALLETS \u00b7 '+fmt(wal.length),'send '+M(pr.wallet_out)+' \u00b7 receive '+M(pr.wallet_in),(wal.filter(function(c){return c.active}).length)+' online now');
  /* middle: this node */
  out+=box(hubX,hubTop,hubW,hubH,'THIS NODE','can send '+M(bx.can_send),'can receive '+M(bx.can_receive),'hub');
  /* edges: on-chain (dashed) and the wallets (one band, width by their capacity) into the hub */
  var walCap=wal.reduce(function(a,c){return a+c.capacity},0),walLocal=wal.reduce(function(a,c){return a+c.local_balance},0);
  out+='<path d="M'+(leftX+leftW)+','+(ocY+28)+' C'+(hubX-40)+','+(ocY+28)+' '+(leftX+leftW+40)+','+(hubTop+22)+' '+hubX+','+(hubTop+22)+'" class="fe dash"/>';
  var ww=Math.max(2.5,Math.min(20,walCap/maxCap*20));
  out+=band(leftX+leftW,walY+28,hubX,hubTop+hubH-22,ww,walCap?walLocal/walCap:0.5,'wallets · '+M(walCap));
  /* right: one band per peer channel */
  peers.forEach(function(c,i){
    var y=top+i*rowH+rowH/2,w=Math.max(2.5,c.capacity/maxCap*20),lbl=c.label||c.alias||c.remote_pubkey.slice(0,12)+'\u2026';
    var hubY=hubTop+8+(i+0.5)*(hubH-16)/n;
    out+=band(hubX+hubW,hubY,rightX,y,w,c.capacity?c.local_balance/c.capacity:0.5,'');
    out+='<text x="'+(rightX+6)+'" y="'+(y+4)+'" class="fl'+(c.active?'':' off')+'">'+esc(lbl.slice(0,22))+(c.active?'':' \u00b7 offline')+'</text>';
    out+='<text x="'+(W-12)+'" y="'+(y+4)+'" class="fn" text-anchor="end">'+esc(M(c.local_balance))+' / '+esc(M(c.remote_balance))+'</text>';
  });
  out+='<text x="'+(rightX+6)+'" y="'+(H-8)+'" class="fs">peer channels \u00b7 this side / their side \u00b7 width = capacity</text>';
  return out+'</svg>';
  function band(x1,y1,x2,y2,w,share,label){
    var cx=(x2-x1)/2,d='M'+x1+','+y1+' C'+(x1+cx)+','+y1+' '+(x2-cx)+','+y2+' '+x2+','+y2;
    share=Math.max(0,Math.min(1,share||0));
    var html='<path d="'+d+'" pathLength="100" class="fe them" stroke-width="'+w.toFixed(1)+'"/>'
      +'<path d="'+d+'" pathLength="100" class="fe us" stroke-width="'+w.toFixed(1)+'" stroke-dasharray="'+(share*100).toFixed(1)+' 100"/>';
    if(label)html+='<text x="'+((x1+x2)/2)+'" y="'+((y1+y2)/2-w/2-4)+'" class="fs" text-anchor="middle">'+esc(label)+'</text>';
    return html}
}
function kv(rows){return '<div class="kv">'+rows.map(function(r){return '<div>'+esc(r[0])+'</div><div>'+(r[2]?r[1]:esc(r[1]))+'</div>'}).join('')+'</div>'}
function net(addr){if(!addr)return '<span class="pill dim">?</span>';return /\\.onion/i.test(addr)?'<span class="pill tor">Tor</span>':'<span class="pill clear">clearnet</span>'}
var lastPane={},expanded={},sortState={};
function cellKey(td){var t=(td.textContent||'').trim();var n=parseFloat(t.replace(/[^0-9.\\-]/g,''));return (t!==''&&!isNaN(n)&&/^[\\s\\d.,\\-]*[\\d]/.test(t))?{n:n,t:t.toLowerCase()}:{n:null,t:t.toLowerCase()}}
function applySort(paneEl){
  var st=sortState[paneEl.id];if(!st)return;
  Array.prototype.forEach.call(paneEl.querySelectorAll('table'),function(tbl){
    var rows=Array.prototype.slice.call(tbl.rows);var head=rows.shift();if(!head)return;
    Array.prototype.forEach.call(head.cells,function(th,i){th.classList.toggle('sorted',i===st.col);th.classList.toggle('desc',i===st.col&&st.dir<0)});
    var segs=[],cur={head:null,blocks:[]};
    rows.forEach(function(r){if(r.classList.contains('grp')){segs.push(cur);cur={head:r,blocks:[]}}else if(r.classList.contains('sub')&&cur.blocks.length){cur.blocks[cur.blocks.length-1].push(r)}else{cur.blocks.push([r])}});
    segs.push(cur);
    var body=tbl.tBodies[0]||tbl;
    segs.forEach(function(seg){
      seg.blocks.sort(function(a,b){var ka=cellKey(a[0].cells[st.col]||{textContent:''}),kb=cellKey(b[0].cells[st.col]||{textContent:''});var c=(ka.n!==null&&kb.n!==null)?ka.n-kb.n:ka.t<kb.t?-1:ka.t>kb.t?1:0;return c*st.dir});
      if(seg.head)body.appendChild(seg.head);seg.blocks.forEach(function(bl){bl.forEach(function(r){body.appendChild(r)})});
    });
  });
}
function setPane(id,html){
  if(lastPane[id]===html)return;
  var el0=$(id);if(el0&&el0.contains(document.activeElement)&&/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName))return;   // never yank a field out from under a typing operator
  var el=$(id);var sc=[];Array.prototype.forEach.call(el.querySelectorAll('.tbl'),function(t){sc.push([t.scrollLeft,t.scrollTop])});
  el.innerHTML=html;lastPane[id]=html;applySort(el);
  Array.prototype.forEach.call(el.querySelectorAll('.tbl'),function(t,i){if(sc[i]){t.scrollLeft=sc[i][0];t.scrollTop=sc[i][1]}});
}
function render(d){
  $('sub').textContent=(d.node&&d.node.alias||'')+' \\u00b7 adapter '+d.version+' \\u00b7 '+new Date(d.ts).toLocaleTimeString();
  if(d.node&&d.node.alias&&document.title!=='LIJOX console \\u2014 '+d.node.alias)document.title='LIJOX console \\u2014 '+d.node.alias;
  var n=d.node||{};
  setPane('node',kv([['alias',n.alias],['pubkey','<span class="mono">'+esc(n.pubkey)+'</span>',1],['LND',n.version],['height',fmt(n.block_height)+(n.synced?' <span class="ok">synced</span>':' <span class="warn">syncing</span>')+(n.synced_to_graph===false?' <span class="dim">graph syncing</span>':''),1],['peers',n.num_peers],['channels',fmt(n.num_active)+' active \\u00b7 '+fmt(n.num_inactive)+' inactive \\u00b7 '+fmt(n.num_pending)+' pending',1],['reach',(n.uris||[]).map(function(u){return net(u)+' <span class="mono">'+esc(u)+'</span>'}).join('<br>')||'<span class="dim">no URIs advertised</span>',1]]));
  var g=d.guardrails||{};var mult=Number(g.live_mult_pct||100);
  setPane('guard',kv([['open-fee multiplier now','<span class="'+(mult>100?(mult>=Number(g.max_mult_pct)?'bad':'warn'):'ok')+'">'+mult+'%</span> <span class="dim">refreshed '+ago(g.refreshed_ms)+'</span>',1],['on-chain vs floor',fmt(g.onchain_confirmed)+' sats confirmed \\u00b7 floor '+fmt(g.reserve_floor_sats)+' \\u00b7 headroom '+(g.headroom==null?'\\u2014':fmt(g.headroom)),1],['scarcity ramp','starts at '+fmt(g.ramp_start_sats)+' headroom \\u2192 up to '+fmt(g.max_mult_pct)+'%',1],['open fee ladder',(g.ladder_sats||[]).map(fmt).join(' \\u00b7 ')+' sats <span class="dim">a wallet\\u2019s 1st, 2nd \\u2026 open in '+fmt(g.window_days)+' d; the last for every open after</span>',1],['JIT grant',(g.grant?'granted = '+fmt(g.grant.base)+' + '+fmt(g.grant.pct)+'% of the payment above '+fmt(g.grant.from)+', at most '+fmt(g.grant.ceiling)+' sats <span class="dim">channel = payment + granted</span>':'\\u2014'),1],['open fee floor',fmt(g.open_fee_min_sats)+' sats \\u00b7 routing '+fmt(g.fee_ppm)+' ppm',1],['floor opens/day',fmt(g.floor_max_opens_per_day)],['JIT guard',jitGuardLine(g.jit_guard),1],['lease',(g.lease_enabled?(g.lease_dry_run?'<span class="warn">on, dry run</span> (logs, never closes)':'<span class="ok">on</span>'):'<span class="dim">off</span>')+' \\u00b7 '+fmt(g.lease_days)+' d silence \\u00b7 cycle '+fmt(g.lease_cycle_min)+' min'+(d.lease?' \\u00b7 '+fmt(d.lease.cycles)+' run'+(d.lease.cycles===1?'':'s')+(d.lease.last_cycle_at?', last '+ago(Date.parse(d.lease.last_cycle_at)):'')+' \\u00b7 '+fmt(d.lease.wallet_peers_known)+' wallet peers known':'')+'<br>'+fmt(g.lease_leased)+' channels leased \\u00b7 '+fmt(g.lease_excluded)+' excluded \\u00b7 '+(g.lease_list_saved_at?'list saved '+ago(g.lease_list_saved_at):'<span class="bad">exclusion list never saved \\u2014 the lease closes nothing until you set it below</span>'),1]]));
  // 0.111.0 (S63): JIT \u00b7 now — the live promises, the aggregating sets, the held payments (was the public /health/jit).
  var jn=d.jit_now;if(!jn){setPane('jitnow','<span class="dim">no report</span>')}else{
    var pr=jn.promises||[],ag=jn.aggregating||[],hd=jn.held||[];
    var ph='<div class="dim" style="margin-bottom:6px">'+fmt(pr.length)+' live promise'+(pr.length===1?'':'s')+' \\u00b7 '+fmt(ag.length)+' aggregating \\u00b7 '+fmt(hd.length)+' held payment'+(hd.length===1?'':'s')+'</div>';
    var pt=pr.length?'<div class="tbl"><table><tr><th>promise</th><th>wallet</th><th>mode</th><th class="n">size (sats)</th><th class="n">fee (sats)</th><th>secret</th><th>expires</th></tr>'+pr.map(function(x){return '<tr><td class="mono">'+esc(x.scid)+'</td><td class="mono">'+esc(x.client)+'\\u2026</td><td>'+esc(x.mode)+'</td><td class="n">'+(x.mode==='variable'?'<span class="dim">open</span>':fmt(Math.round(Number(x.size_msat)/1000)))+'</td><td class="n">'+fmt(Math.round(Number(x.fee_msat)/1000))+'</td><td>'+(x.secret?'<span class="ok">registered</span>':'<span class="dim">not yet</span>')+'</td><td>'+(x.expires_in_s>0?'in '+fmt(Math.round(x.expires_in_s/60))+' min':'<span class="dim">expired</span>')+'</td></tr>'}).join('')+'</table></div>':'';
    var at=ag.length?'<div class="dim" style="margin:6px 0">aggregating</div><div class="tbl"><table><tr><th>promise</th><th class="n">parts</th><th class="n">sum (sats)</th><th>window</th></tr>'+ag.map(function(x){return '<tr><td class="mono">'+esc(x.scid)+'</td><td class="n">'+fmt(x.shards)+'</td><td class="n">'+fmt(Math.round(Number(x.sum_msat)/1000))+'</td><td>'+fmt(x.window_remaining_s)+' s left</td></tr>'}).join('')+'</table></div>':'';
    var ht=hd.length?'<div class="dim" style="margin:6px 0">held payments (the wallet is being woken)</div><div class="tbl"><table><tr><th>hash</th><th>kind</th><th>wallet</th><th class="n">sats</th><th>held for</th><th>fails at block</th></tr>'+hd.map(function(x){return '<tr><td class="mono">'+esc(x.payment_hash)+'\\u2026</td><td>'+esc(x.kind)+'</td><td class="mono">'+esc(x.client)+'\\u2026</td><td class="n">'+fmt(Math.round(Number(x.amount_msat)/1000))+'</td><td>'+(x.age_s<120?fmt(x.age_s)+' s':fmt(Math.round(x.age_s/60))+' min')+'</td><td>'+(x.auto_fail_height?fmt(x.auto_fail_height):'\\u2014')+'</td></tr>'}).join('')+'</table></div>':'';
    setPane('jitnow',ph+pt+at+ht+(pr.length||ag.length||hd.length?'':'<div class="dim">quiet</div>'));
  }
  // 0.77.0 (DP): the delegate rail's guardrails — the daily breaker (limit, what it has
  // counted in the rolling 24 h, when it last moved) and its siblings.
  var dg=d.delegate;
  if(!dg){setPane('delegate','<span class="dim">no delegate report (module not loaded)</span>')}else{
    var lim=Number(dg.daily_limit_msat||0)/1000,sp=Number(dg.daily_spent_msat||0)/1000,left=Math.max(0,lim-sp),pct=lim>0?sp/lim*100:0;
    setPane('delegate',kv([
      ['daily breaker',fmt(Math.round(sp))+' of '+fmt(Math.round(lim))+' sats used in the last 24 h <span class="'+(pct>=90?'bad':pct>=60?'warn':'ok')+'">('+pct.toFixed(1)+'%)</span> \\u00b7 '+fmt(Math.round(left))+' sats left \\u00b7 '+fmt(dg.daily_count)+' spend'+(dg.daily_count===1?'':'s')+' <span class="dim">rolling 24 h, every chit, amount + fee \\u00b7 DELEGATE_DAILY_MSAT</span>',1],
      ['last spend',dg.last_spend_ms?ago(dg.last_spend_ms)+' <span class="dim">('+new Date(dg.last_spend_ms).toLocaleString()+')</span>':'<span class="dim">none yet</span>',1],
      ['live slips',fmt(dg.live)+' of '+fmt(dg.max_live)+' allowed <span class="dim">DELEGATE_MAX_LIVE \\u00b7 '+fmt(dg.slips_total)+' slips on file</span>',1],
      ['fee limit',fmt(Math.round(Number(dg.fee_limit_msat||0)/1000))+' sats <span class="dim">the refund path\\u2019s ceiling and the reserve\\u2019s sanity cap \\u00b7 DELEGATE_FEE_LIMIT_MSAT</span>',1],
      ['all time',fmt(Math.round(Number(dg.all_time_msat||0)/1000))+' sats paid by delegation',1]
    ]))}
  // 0.86.0: NWC — the switch, the relay, connections registered, requests waiting now, wakes sent today (report only)
  var nw=d.nwc;
  if(!nw){setPane('nwc','<span class="dim">no NWC report (module not loaded)</span>')}else if(!nw.enabled){setPane('nwc','<span class="dim">off \u2014 NWC_ENABLED is not true; this provider offers no NWC</span>')}else{
    setPane('nwc',kv([
      ['relay','<span class="mono">'+esc(nw.relay||'')+'</span> <span class="dim">the API tunnel, path /nwc</span>',1],
      ['connections',fmt(nw.connections)+' registered by '+fmt(nw.wallets)+' wallet(s) <span class="dim">at most '+fmt(nw.max_connections)+' per wallet</span>',1],
      ['waiting now',fmt(nw.waiting)+' request(s) <span class="dim">kept at most '+fmt(nw.request_ttl_ceiling_s)+' s; '+fmt(nw.max_waiting)+' per connection</span> \u00b7 '+fmt(nw.replies_kept)+' repl'+(nw.replies_kept===1?'y':'ies')+' kept',1],
      ['wakes today',fmt(nw.wakes_today)+' <span class="dim">one per wallet per '+fmt(nw.wake_min_interval_s)+' s at most</span> \u00b7 '+fmt(nw.sockets)+' open socket(s)',1]
    ]))}
  var b=d.balances||{};
  var pr=b.principles||{};function cov(x){return x==null?'<span class="dim">n/a</span>':x.toFixed(1)+'\\u00d7'}
  var bx=b.boxes||{};function kpi(t,v,sub,cls){return '<div class="kpi '+(cls||'')+'"><div class="t">'+t+'</div><div class="v">'+v+'</div><div class="s">'+(sub||'')+'</div></div>'}
  var ti=bx.top_inbound;var boxesHtml='<div class="kpis">'
    +kpi('Treasury',fmt(bx.treasury)+' sats',(Number(bx.treasury||0)/1e8).toFixed(4)+' BTC')
    +kpi('On-chain',fmt(bx.onchain_total)+' sats',fmt(bx.anchor_reserve)+' anchor reserve',bx.onchain_total<2e6?'bad':bx.onchain_total<5e6?'warn':'')
    +kpi('Can send',fmt(bx.can_send)+' sats',fmt(bx.n_active)+' active channels')
    +kpi('Can receive',fmt(bx.can_receive)+' sats','inbound capacity',bx.can_receive<1e6?'warn':'')
    +kpi('Wallets\u2019 sendable',fmt(pr.wallet_out)+' sats',fmt(pr.wallet_n)+' wallet channel'+(pr.wallet_n===1?'':'s')+' \u00b7 their side, gross of reserves')
    +kpi('Wallets\u2019 receivable',fmt(pr.wallet_in)+' sats','this node\u2019s side of those channels \u00b7 gross of reserves')
    +kpi('Top inbound peer',ti?(ti.pct*100).toFixed(1)+'%':'\\u2014',ti?esc(ti.alias)+' \\u00b7 '+fmt(ti.sats)+' sats':'no peer channels',ti?(ti.pct>0.8?'bad':ti.pct>0.5?'warn':'good'):'')
    +'</div>';
  /* 0.109.1 (DP 2026-10-19 23:15): the Liquidity · now graphic is OFF THE SCREEN — "looks poor and needs improvement" — the card
     stays in the markup hidden and the drawing code stays; it comes back when the graphic is redone. */
  if(window.LIJ_SHOW_FLOW){var fc=document.getElementById('flowcard');if(fc)fc.hidden=false;setPane('flow',flowSvg(d)||'<span class="dim">no channels yet \u2014 the graphic draws once this node has one</span>')}
  setPane('bal',boxesHtml+kv([['on-chain confirmed',fmt(b.onchain_confirmed)+' sats'+(b.reserved_anchor?' <span class="dim">('+fmt(b.reserved_anchor)+' reserved for anchors)</span>':''),1],['on-chain unconfirmed',fmt(b.onchain_unconfirmed)+' sats'],['channel local',fmt(b.local)+' sats'+(b.unsettled?' <span class="dim">('+fmt(b.unsettled)+' in flight)</span>':''),1],['channel remote',fmt(b.remote)+' sats'],['pending open local',fmt(b.pending_open_local)+' sats'],
    ['P1 outbound cover',cov(pr.p1_cover),1],
    ['P2 inbound cover',cov(pr.p2_cover),1],
    ['how figured','<span class="dim">P1 = ex-wallet outbound '+fmt(pr.ext_out)+' \\u00f7 wallets\\u2019 spendable '+fmt(pr.wallet_out)+' \\u2014 how many times over the LSP could push out what every wallet holds.<br>P2 = ex-wallet inbound '+fmt(pr.ext_in)+' \\u00f7 wallets\\u2019 receive room '+fmt(pr.wallet_in)+' \\u2014 how many times over the network could fill what every wallet can still receive.<br>'+fmt(pr.wallet_n)+' wallet channels ('+fmt(pr.wallet_active)+' online now) + '+fmt(pr.ext_n)+' peer channels ('+fmt(pr.ext_active)+' online); all channels count \\u2014 a wallet is offline whenever its phone is closed; wallets\\u2019 spendable = their side of wallet channels, receive room = the LSP\\u2019s side.</span>',1]]));
  var ch=d.channels||[];
  // 0.77.1 (DP): the channel count at the top of the pane, refreshed with every 5 s snapshot like the rest
  var chWallet=ch.filter(function(c){return c.wallet}).length,chActive=ch.filter(function(c){return c.active}).length;
  var chHead='<div class="dim" style="margin-bottom:6px">'+fmt(ch.length)+' channel'+(ch.length===1?'':'s')+' \\u00b7 '+fmt(chActive)+' active \\u00b7 '+fmt(chWallet)+' to LiJ wallets \\u00b7 '+fmt(ch.length-chWallet)+' to peer nodes'+(d.pending&&d.pending.length?' \\u00b7 '+fmt(d.pending.length)+' pending':'')+'</div>';
  setPane('sumnote','<textarea class="note" id="sumnotebox" data-kind="summary" data-key="" data-saved="'+esc(d.summary_note||'')+'" placeholder="summary note (saved when you click away)">'+esc(d.summary_note||'')+'</textarea>');
  var rows='';ch.forEach(function(c){var lbl=c.label||c.alias||c.remote_pubkey.slice(0,12)+'\\u2026';
    rows+='<tr><td>'+(c.wallet?'<span class="ok">wallet</span> ':'')+esc(lbl)+' '+(c.private?'<span class="dim">private</span> ':'')+'<span class="mono dim">'+esc(c.channel_point.slice(0,10))+'\\u2026:'+esc(c.channel_point.split(':')[1])+'</span></td><td>'+(c.opened_ms?esc(new Date(c.opened_ms).toLocaleString([],{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})):(c.opened_block?'<span class="dim">block '+fmt(c.opened_block)+'</span>':'<span class="dim">\\u2014</span>'))+(c.initiator?'':' <span class="dim">by peer</span>')+'</td><td>'+net(c.address)+'</td><td class="n">'+fmt(c.capacity)+'</td><td class="n">'+fmt(c.local_balance)+'</td><td class="n">'+fmt(c.remote_balance)+'</td><td>'+(c.active?'<span class="ok">active</span>':'<span class="bad">inactive</span>')+(c.pending_htlcs?' <span class="warn">'+c.pending_htlcs+' htlc</span>':'')+'</td><td>'+(c.excluded?'<span class="dim">excluded</span>':(c.lease?esc(c.lease):'<span class="dim">\\u2014</span>'))+(c.lease_override_days?' <span class="warn">override '+fmt(c.lease_override_days)+' d</span>':'')+(c.last_seen_ms?'<br><span class="dim">'+esc(c.last_source||'seen')+' \\u00b7 '+ago(c.last_seen_ms)+'</span>':'')+'</td><td><input class="note" data-kind="channel" data-key="'+esc(c.channel_point)+'" value="'+esc(c.note||'')+'" data-saved="'+esc(c.note||'')+'" placeholder="note"></td><td><button class="lx" data-cp="'+esc(c.channel_point)+'" data-peer="'+esc(c.remote_pubkey)+'" data-x="'+(c.excluded?'1':'0')+'">'+(c.excluded?'include in lease':'exclude from lease')+'</button> <button class="lt" data-cp="'+esc(c.channel_point)+'" data-ttl="'+esc(c.lease_override_days||'')+'" data-def="'+esc(c.lease_ttl_days||'')+'">lease\\u2026</button></td></tr>'});
  setPane('chan',chHead+'<div class="tbl"><table><tr><th>peer \\u00b7 channel</th><th>opened on</th><th>net</th><th class="n">capacity</th><th class="n">local</th><th class="n">remote</th><th>state</th><th>lease</th><th>note</th><th></th></tr>'+rows+'</table></div>'+(ch.length?'':'<div class="dim">no channels</div>'));

  var w=d.wallets||[];
  setPane('wal','<div class="dim" style="margin-bottom:6px">'+fmt(d.wallet_count||0)+' wallet'+(d.wallet_count===1?'':'s')+' served (distinct by public key; a wallet with several pay codes counts once; a wallet with a channel and no pay code here counts too)</div><div class="tbl"><table><tr><th>wallet</th><th>pay-code name</th><th class="n">holds</th><th class="n">LNURL hashes</th><th>first seen</th><th>last heard</th><th class="n">remote (wallet) balance</th><th>label</th></tr>'+w.map(function(x){return '<tr><td class="mono">'+esc(x.pubkey.slice(0,16))+'\\u2026</td><td>'+(x.name?esc(x.name):(x.channel_only?'<span class="dim">no pay code here</span>':'\\u2014'))+'</td><td class="n">'+fmt(x.holds)+'</td><td class="n">'+fmt(x.hashes)+'</td><td>'+(x.first_seen_ms?new Date(x.first_seen_ms).toLocaleDateString():'\\u2014')+'</td><td>'+(x.last_heard_ms?ago(x.last_heard_ms):'<span class="dim">no channel</span>')+'</td><td class="n">'+(x.remote_sats==null?'<span class="dim">\\u2014</span>':fmt(x.remote_sats)+' sats')+'</td><td><input class="note" data-kind="wallet" data-key="'+esc(x.pubkey)+'" value="'+esc(x.label||'')+'" data-saved="'+esc(x.label||'')+'" placeholder="label"></td></tr>'+(((d.registry_records||{})[x.pubkey]||[]).map(function(rr){return '<tr class="sub"><td colspan="8"><span class="dim">recovery record \\u00b7 channel</span> <span class="mono" style="font-size:13px">'+esc(String(rr.funding).slice(0,16))+'\\u2026</span> <span class="dim">\\u00b7</span> '+fmt(rr.value_sat)+' sats'+(rr.close_height?' <span class="dim">\\u00b7 closed at '+fmt(rr.close_height)+'</span>':' <span class="dim">\\u00b7 open</span>')+'</td></tr>'}).join(''))}).join('')+'</table></div>'+(w.length?'':'<div class="dim">no wallets registered a name yet</div>'));
  var p=d.pending||[];
  setPane('pend',p.length?'<div class="tbl"><table><tr><th>kind</th><th>peer</th><th class="n">capacity</th><th>txid</th></tr>'+p.map(function(x){return '<tr><td>'+esc(x.kind)+'</td><td class="mono">'+esc(x.remote_pubkey.slice(0,12))+'\\u2026</td><td class="n">'+fmt(x.capacity)+'</td><td class="mono">'+esc((x.channel_point||'').slice(0,16))+'\\u2026</td></tr>'}).join('')+'</table></div>':'<div class="dim">nothing pending</div>');
  var u=d.unconfirmed||{};
  setPane('unc',u.error?'<div class="dim">'+esc(u.error)+'</div>':(((u.txs||[]).length||(u.sweeps||[]).length)?'<div class="tbl"><table><tr><th>what</th><th class="n">sats</th><th class="n">fee</th><th>txid</th><th>since</th></tr>'+(u.txs||[]).map(function(t){return '<tr><td>'+esc(t.label||(t.amount>=0?'incoming':'outgoing'))+'</td><td class="n">'+fmt(t.amount)+'</td><td class="n">'+fmt(t.fee)+'</td><td class="mono">'+esc(t.txid.slice(0,16))+'\\u2026</td><td>'+ago(t.time_ms)+'</td></tr>'}).join('')+(u.sweeps||[]).map(function(t){return '<tr><td>sweep pending ('+esc(t.kind)+')</td><td class="n">'+fmt(t.amount)+'</td><td class="n">'+esc(t.fee_rate)+' sat/vB</td><td class="mono">'+esc(t.outpoint.slice(0,16))+'\\u2026</td><td>'+esc(t.tries)+' tries</td></tr>'}).join('')+'</table></div>':'<div class="dim">nothing unconfirmed</div>')+(u.published_for_others?'<div class="dim" style="margin-top:6px">'+fmt(u.published_for_others)+' more published for wallets or closes \\u2014 none of this node\\u2019s funds in them; LND never marks those confirmed, the wallets track them</div>':''));
  var st=d.settings||[];var lp=d.lnd_policy||{};var groups=[];var byG={};st.forEach(function(x){if(!byG[x.group]){byG[x.group]=[];groups.push(x.group)}byG[x.group].push(x)});
  var polTxt=lp.error?'<span class="dim">LND policy not readable: '+esc(lp.error)+'</span>':(lp.checked?(lp.mismatches.length?'<span class="bad">LND charges differently on '+lp.mismatches.length+' of '+lp.checked+' wallet channels</span> '+lp.mismatches.map(function(m){return '<span class="dim">'+esc(m.chan_id.slice(-6))+': '+fmt(m.base_msat)+' msat + '+fmt(m.ppm)+' ppm</span>'}).join(', '):'<span class="ok">LND charges the advertised base + ppm on all '+lp.checked+' wallet channels checked</span>'):'<span class="dim">no wallet channel to check</span>');
  setPane('settings','<div class="dim" style="margin-bottom:8px">A report. Nothing here can be changed from the console \\u2014 every value is set in the box\\u2019s .env (or the adapter\\u2019s default) and applied at restart.</div><div class="tbl"><table><tr><th>setting</th><th>value</th><th>source</th><th>variable</th><th></th></tr>'+groups.map(function(g){return '<tr class="grp"><td colspan="5">'+esc(g)+'</td></tr>'+byG[g].map(function(x){return '<tr><td>'+esc(x.label)+'</td><td class="n">'+esc(String(x.value))+(x.unit?' <span class="dim">'+esc(x.unit)+'</span>':'')+'</td><td><span class="'+(x.source==='.env'?'ok':'dim')+'">'+esc(x.source)+'</span></td><td class="mono dim">'+esc(x.name||'')+'</td><td class="dim">'+esc(x.note||'')+'</td></tr>'}).join('')+(g==='Advertised fees'?'<tr><td colspan="5">'+polTxt+'</td></tr>':'')}).join('')+'</table></div>');
  var r=d.registry||{};
  setPane('reg',kv([['registry',r.url||'<span class="dim">not configured (registry-free)</span>',1],['last registration',r.last_ok?'<span class="ok">ok</span> '+ago(r.last_ok):(r.last_error?'<span class="bad">'+esc(r.last_error)+'</span>':'<span class="dim">never</span>'),1],['next',r.next_ms?ago(r.next_ms).replace(' ago','')+' (every '+r.every_h+' h)':'\\u2014',1],['advertised',(r.https_url||'')+'<br>'+(r.wss_url||''),1]]));
  var k=d.backups||{};
  setPane('bak',kv(Object.keys(k).length?Object.keys(k).map(function(leg){var v=k[leg];return [leg,(v.ok?'<span class="ok">ok</span>':'<span class="bad">failed</span>')+' '+ago(v.at_ms)+(v.stale?' <span class="warn">stale</span>':'')+(v.note?' <span class="dim">'+esc(v.note)+'</span>':''),1]}):[['SCB legs','<span class="dim">no backup kit configured</span>',1]]));
  var l=d.loops||{};
  setPane('loops',kv(Object.keys(l).map(function(name){var v=l[name];return [name,(v.stale?'<span class="bad">stale</span>':'<span class="ok">fresh</span>')+' \\u00b7 '+ago(v.last)+' \\u00b7 every '+Math.round(v.period_ms/1000)+' s',1]}).concat([['watchdog',d.watchdog?'<span class="ok">petting</span>':'<span class="dim">no NOTIFY_SOCKET</span>',1],['uptime',(d.uptime_s/3600).toFixed(1)+' h'],['tapes received',fmt(d.tapes)+(d.last_tape_ms?' \\u00b7 last '+ago(d.last_tape_ms):''),1]])));
  $('sess').textContent='session until '+new Date(d.session_until).toLocaleTimeString()+' \\u00b7 from '+d.from;
  if(typeof d._y==='number'&&Math.abs(window.scrollY-d._y)>2){window.scrollTo(0,d._y)}
}
var plPeriod='day',plDate=null,plTimer=null;
function sats(msat){return Math.round(Number(msat||0)/1000)}
function fiat(satsN,rate){if(!rate)return '';var v=satsN/1e8*rate;return '<span class="dim">'+(v<0?'\\u2212':'')+'$'+Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span>'}
function renderPL(r){
  var p=r.periods[plPeriod];var rate=r.rates_usd;
  var rev=sats(p.routing_fee_msat)+sats(p.open_fee_msat)+sats(p.hold_fee_msat);
  var chain=p.chain_fee_open_sats+p.chain_fee_close_sats+p.chain_fee_sweep_sats+p.chain_fee_other_sats;
  var cost=chain+sats(p.payment_fee_msat);var net=rev-cost;
  // 0.76.0 (DP): each line shows the sats that MOVED for it and the rate it earned or cost (fee \\u00f7 moved).
  // Where only part of a line's fees carry a moved amount (ledger events from before 0.76.0), the rate is
  // computed over that part and says so; a line with nothing moved shows no rate.
  function pct(feeSats,movedSats,note){if(!(movedSats>0))return '';var v=feeSats/movedSats*100;return (v<0.0005&&feeSats>0?'<0.001':v.toFixed(v<0.1?3:2))+'%'+(note?' <span class="dim">'+note+'</span>':'')}
  function row(lbl,v,moved,pc,note,cls){return '<tr'+(cls?' class="'+cls+'"':'')+'><td>'+lbl+'</td><td class="n">'+fmt(v)+'</td><td class="n">'+fiat(v,rate)+'</td><td class="n">'+(moved>0?fmt(moved):'')+'</td><td class="n">'+(pc||'')+'</td><td class="dim">'+(note||'')+'</td></tr>'}
  var opPart=(p.open_moved_count>0&&p.open_moved_count<p.open_count)?'on '+fmt(p.open_moved_count)+' of '+fmt(p.open_count):'';
  var hdPart=(p.hold_moved_count>0&&p.hold_moved_count<p.hold_count)?'on '+fmt(p.hold_moved_count)+' of '+fmt(p.hold_count):'';
  $('plbody').innerHTML='<div class="tbl"><table><tr><th>'+esc(plPeriod.toUpperCase())+' \\u00b7 '+esc(p.date)+'</th><th class="n">sats</th><th class="n">'+(rate?'USD':'')+'</th><th class="n">moved</th><th class="n">rate</th><th></th></tr>'
   +'<tr><td class="h" colspan="6">Revenue</td></tr>'
   +row('routing fees',sats(p.routing_fee_msat),sats(p.routing_out_msat),pct(sats(p.routing_fee_msat),sats(p.routing_out_msat)),fmt(p.routing_count)+' forwards')
   +row('channel-open fees',sats(p.open_fee_msat),sats(p.open_moved_msat),pct(sats(p.open_moved_fee_msat),sats(p.open_moved_msat),opPart),fmt(p.open_count)+' opens')
   +row('hold / LNURL fees',sats(p.hold_fee_msat),sats(p.hold_moved_msat),pct(sats(p.hold_moved_fee_msat),sats(p.hold_moved_msat),hdPart),fmt(p.hold_count)+' holds')
   +row('revenue',rev,0,'','','tot')
   +'<tr><td class="h" colspan="6">Costs</td></tr>'
   +row('chain fees \\u00b7 opens',p.chain_fee_open_sats,p.chain_moved_open_sats,pct(p.chain_fee_open_sats,p.chain_moved_open_sats))
   +row('chain fees \\u00b7 closes',p.chain_fee_close_sats,p.chain_moved_close_sats,pct(p.chain_fee_close_sats,p.chain_moved_close_sats))
   +row('chain fees \\u00b7 sweeps',p.chain_fee_sweep_sats,p.chain_moved_sweep_sats,pct(p.chain_fee_sweep_sats,p.chain_moved_sweep_sats))
   +row('chain fees \\u00b7 other',p.chain_fee_other_sats,p.chain_moved_other_sats,pct(p.chain_fee_other_sats,p.chain_moved_other_sats),fmt(p.chain_tx_count)+' txs'+(p.chain_fee_unknown_count?' \u00b7 <span class="warn">fee unknown \u00b7 '+fmt(p.chain_fee_unknown_count)+' tx'+(p.chain_fee_unknown_count===1?'':'s')+'</span>':''))
   +row('payment fees',sats(p.payment_fee_msat),sats(p.payment_value_msat),pct(sats(p.payment_fee_msat),sats(p.payment_value_msat)),fmt(p.payment_count)+' payments, '+fmt(p.delivery_count)+' deliveries')
   +row('costs',cost,0,'','','tot')
   +row('<b>net</b>',net,0,'','','tot')+'</table></div>'
   +(r.missing.length?'<div class="warn" style="margin-top:6px">partial: '+r.missing.map(esc).join(' \\u00b7 ')+'</div>':'')
   +'<div class="dim" style="margin-top:6px">first day '+esc(r.first_day)+(rate?' \\u00b7 rate '+fmt(rate)+' USD/BTC':'')+' \\u00b7 moved = sats forwarded / delivered / paid / funded on that line; rate = fee \\u00f7 moved</div>';
}
function loadPL(){
  var d=plDate||$('pldate').value;
  fetch('/console/pl?date='+encodeURIComponent(d)).then(function(x){return x.json()}).then(function(r){if(r.ok===false){$('plbody').innerHTML='<div class="bad">'+esc(r.error||'PL unavailable')+'</div>';return}renderPL(r)}).catch(function(){$('plbody').innerHTML='<div class="bad">no answer</div>'});
}
function initPL(){
  var today=new Date();var k=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0')+'-'+String(today.getDate()).padStart(2,'0');
  $('pldate').value=k;$('pldate').max=k;
  $('pldate').addEventListener('change',function(){plDate=$('pldate').value;loadPL()});
  Array.prototype.forEach.call(document.querySelectorAll('#pl .per button'),function(b){b.addEventListener('click',function(){plPeriod=b.getAttribute('data-p');Array.prototype.forEach.call(document.querySelectorAll('#pl .per button'),function(x){x.className=x===b?'on':''});loadPL()})});
  loadPL();plTimer=setInterval(loadPL,60000);
}
function connect(){
  var es=new EventSource('/console/events');
  es.onmessage=function(e){try{var d=JSON.parse(e.data);d._y=window.scrollY;render(d)}catch(err){}};
  es.onerror=function(){es.close();$('sub').textContent='disconnected \\u2014 reconnecting\\u2026';setTimeout(function(){location.reload()},4000)};
}
function login(){
  var code=$('code').value.replace(/\\D/g,'');if(code.length!==6)return;
  $('msg').textContent='';
  fetch('/console/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:code})}).then(function(r){return r.json()}).then(function(j){
    if(j.ok){location.reload()}else{$('msg').textContent=j.error||'code refused';$('code').value='';$('code').focus()}
  }).catch(function(){$('msg').textContent='no answer'});
}
var fullCard=null,fullPh=null;
function expandCard(card){
  var r=card.getBoundingClientRect();
  var ph=card.cloneNode(false);ph.className='card placeholder';ph.style.height=r.height+'px';card.parentNode.insertBefore(ph,card);
  card.style.top=r.top+'px';card.style.left=r.left+'px';card.style.width=r.width+'px';card.style.height=r.height+'px';
  card.classList.add('full');void card.offsetWidth;
  card.style.top='0px';card.style.left='0px';card.style.width=window.innerWidth+'px';card.style.height=window.innerHeight+'px';
  fullCard=card;fullPh=ph;document.body.style.overflow='hidden';
}
function collapseCard(){
  if(!fullCard)return;var card=fullCard,ph=fullPh;var r=ph.getBoundingClientRect();
  card.style.top=r.top+'px';card.style.left=r.left+'px';card.style.width=r.width+'px';card.style.height=r.height+'px';
  var done=function(){card.removeEventListener('transitionend',done);card.classList.remove('full');card.style.top=card.style.left=card.style.width=card.style.height='';if(ph.parentNode)ph.parentNode.removeChild(ph)};
  card.addEventListener('transitionend',done);setTimeout(done,400);
  fullCard=null;fullPh=null;document.body.style.overflow='';
}
window.addEventListener('resize',function(){if(fullCard){fullCard.style.width=window.innerWidth+'px';fullCard.style.height=window.innerHeight+'px'}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&fullCard)collapseCard()});
document.addEventListener('DOMContentLoaded',function(){
  document.addEventListener('click',function(e){var th=e.target.closest?e.target.closest('th'):null;if(th&&th.parentNode&&th.parentNode.rowIndex===0){var pane=th.closest('.card > div[id]');if(pane){var col=th.cellIndex;var st=sortState[pane.id];sortState[pane.id]=(st&&st.col===col)?{col:col,dir:-st.dir}:{col:col,dir:1};applySort(pane)}return}
    var h=e.target.closest?e.target.closest('.card > h2'):null;if(!h)return;var card=h.parentNode;if(fullCard===card){collapseCard()}else if(!fullCard){expandCard(card)}});
  if($('login')){var c=$('code');c.focus();c.addEventListener('input',function(){if(c.value.replace(/\\D/g,'').length===6)login()});$('go').addEventListener('click',login);return}
  $('logout').addEventListener('click',function(){fetch('/console/logout',{method:'POST'}).then(function(){location.reload()})});
  $('guard').addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button.jr'):null;if(!b)return;if(!confirm('Release the JIT guard?\\n\\nJIT channel opens start again on every rail. The count of funded-but-failed opens starts afresh from now.'))return;b.disabled=true;fetch('/console/jit-release',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json()}).then(function(j){if(!j.ok)alert(j.error||'refused');lastPane['guard']=null}).catch(function(){alert('no answer');b.disabled=false})});
  $('guard').addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button.jrw'):null;if(!b)return;var w=b.getAttribute('data-w');if(!confirm('Release this wallet from the JIT block?\\n\\n'+w+'\\n\\nJIT channel opens for it start again; its count of failed opens starts afresh. The guard for everyone is not touched.'))return;b.disabled=true;fetch('/console/jit-release-wallet',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:w})}).then(function(r){return r.json()}).then(function(j){if(!j.ok)alert(j.error||'refused');lastPane['guard']=null}).catch(function(){alert('no answer');b.disabled=false})});
  $('chan').addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button.lt'):null;if(!b)return;var cp=b.getAttribute('data-cp'),cur=b.getAttribute('data-ttl'),def=b.getAttribute('data-def');var v=prompt('Lease length for this channel, in days (1 to 3650).\\nEmpty = back to the default of '+def+' days.\\n\\nA channel whose peer has been silent longer than this is force-closed on the next hourly run, unless it is excluded.\\n\\n'+cp,cur||'');if(v===null)return;v=v.trim();if(v!==''&&!(Number(v)>=1&&Number(v)<=3650)){alert('1 to 3650 days, or empty');return}if(!confirm((v===''?'Clear the override \\u2014 back to '+def+' days?':'Set the lease to '+v+' days?')+'\\n\\n'+cp))return;b.disabled=true;fetch('/console/lease-ttl',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chan_point:cp,ttl_days:v===''?null:Number(v)})}).then(function(r){return r.json()}).then(function(j){if(!j.ok)alert(j.error||'refused');lastPane['chan']=null}).catch(function(){alert('no answer');b.disabled=false})});
  $('chan').addEventListener('click',function(e){var b=e.target.closest?e.target.closest('button.lx'):null;if(!b)return;var cp=b.getAttribute('data-cp'),x=b.getAttribute('data-x')==='1';if(!confirm((x?'Include this channel in the lease again?':'Exclude this channel from the lease?')+'\\n\\n'+cp))return;b.disabled=true;fetch('/console/lease-exclude',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chan_point:cp,excluded:!x,peer:b.getAttribute('data-peer')})}).then(function(r){return r.json()}).then(function(j){if(!j.ok)alert(j.error||'refused');lastPane['chan']=null}).catch(function(){alert('no answer');b.disabled=false})});
  function saveNote(el){var kind=el.getAttribute('data-kind'),key=el.getAttribute('data-key')||'';if(el.getAttribute('data-saved')===el.value)return;fetch('/console/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:kind,key:key,text:el.value})}).then(function(r){return r.json()}).then(function(j){if(!j.ok){alert(j.error||'not saved');return}el.setAttribute('data-saved',el.value);lastPane['chan']=null;lastPane['wal']=null;lastPane['sumnote']=null}).catch(function(){alert('no answer')})}
  document.addEventListener('focusout',function(e){var el=e.target;if(el&&el.classList&&el.classList.contains('note'))saveNote(el)});
  document.addEventListener('keydown',function(e){var el=e.target;if(e.key==='Enter'&&el&&el.classList&&el.classList.contains('note')&&el.tagName==='INPUT'){el.blur()}});
  connect();initPL();
});
})();
`;
const sha256b64 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');
const CSP = `default-src 'none'; script-src 'sha256-${sha256b64(JS)}'; style-src 'sha256-${sha256b64(CSS)}'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;

function pageLogin(msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIJOX console</title><style>${CSS}</style></head><body>
<div id="login"><h1>LIJOX console</h1><p>Six digits from your authenticator.</p><input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="000000"><div id="msg" class="bad">${msg ? escapeHtml(msg) : ''}</div><button id="go">Enter</button></div>
<script>${JS}</script></body></html>`;
}
function pageConsole() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LIJOX console</title><style>${CSS}</style></head><body>
<header><h1>LIJOX console</h1><span class="sub" id="sub">connecting\u2026</span><span class="sp"></span><span class="sub" id="sess"></span><button id="logout">Log out</button></header>
<main>
<section class="card"><h2>Guardrails</h2><div id="guard" class="dim">\u2026</div></section>
<section class="card"><h2>JIT \u00b7 now</h2><div id="jitnow" class="dim">\u2026</div></section>
<section class="card"><h2>Delegate rail</h2><div id="delegate" class="dim">\u2026</div></section>
<section class="card"><h2>NWC</h2><div id="nwc" class="dim">\u2026</div></section>
<section class="card" id="pl"><h2>PL</h2><div class="ctl"><input type="date" id="pldate"><span class="per"><button data-p="day" class="on">Day</button> <button data-p="mtd">MTD</button> <button data-p="ytd">YTD</button> <button data-p="ltd">LTD</button></span></div><div id="plbody" class="dim">\u2026</div></section>
<section class="card"><h2>Node</h2><div id="node" class="dim">\u2026</div></section>
<section class="card"><h2>Balances</h2><div id="bal" class="dim">\u2026</div></section>
<section class="card wide" id="flowcard" hidden><h2>Liquidity \u00b7 now</h2><div id="flow" class="dim">\u2026</div></section>
<section class="card"><h2>Channels</h2><div id="sumnote"></div><div id="chan" class="dim">\u2026</div></section>
<section class="card"><h2>Wallets served</h2><div id="wal" class="dim">\u2026</div></section>
<section class="card"><h2>Pending channels</h2><div id="pend" class="dim">\u2026</div></section>
<section class="card"><h2>Unconfirmed on-chain</h2><div id="unc" class="dim">\u2026</div></section>
<section class="card"><h2>Registry</h2><div id="reg" class="dim">\u2026</div></section>
<section class="card"><h2>Backups</h2><div id="bak" class="dim">\u2026</div></section>
<section class="card"><h2>Loops</h2><div id="loops" class="dim">\u2026</div></section>
<section class="card"><h2>Settings (report)</h2><div id="settings" class="dim">\u2026</div></section>
</main><script>${JS}</script></body></html>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ── the module ─────────────────────────────────────────────────────────────────
// deps: { version, lndGet, snapshot: async () => {...panes...}, log: (line) => void }
function createConsole(deps) {
  const env = process.env;
  const secretB32 = env.CONSOLE_TOTP_SECRET || '';
  const secret = secretB32 ? base32Decode(secretB32) : null;
  const port = parseInt(env.CONSOLE_PORT || '7004', 10);
  const sessionMs = parseFloat(env.CONSOLE_SESSION_HOURS || '12') * 3600 * 1000;
  // 0.73.3: the cookie name carries a per-instance tag (from the TOTP secret's hash), so two
  // consoles tunnelled to the same host on different ports keep separate sessions.
  const COOKIE = 'lijc_' + crypto.createHash('sha256').update(secretB32).digest('hex').slice(0, 8);
  const sessions = new Map();     // cookie -> { ip, until }
  const failures = new Map();     // ip -> { n, until }
  const usedCounters = new Set();
  const log = deps.log || ((l) => console.log(l));

  function binds() {
    const out = new Set(['127.0.0.1']);
    if ((env.CONSOLE_TAILSCALE || 'true') !== 'false') {
      const ifs = os.networkInterfaces();
      for (const name of Object.keys(ifs)) {
        if (!/^tailscale/i.test(name)) continue;
        for (const a of ifs[name] || []) if (a.family === 'IPv4' || a.family === 4) out.add(a.address);
      }
    }
    for (const a of String(env.CONSOLE_BIND || '').split(',').map((s) => s.trim()).filter(Boolean)) out.add(a);
    return [...out];
  }

  function remoteIp(req) { return String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }
  function cookieOf(req) { const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || ''); return m ? m[1] : null; }
  function sessionOf(req) {
    const c = cookieOf(req); if (!c) return null;
    const s = sessions.get(c); if (!s) return null;
    if (Date.now() > s.until || s.ip !== remoteIp(req)) { sessions.delete(c); return null; }
    return { key: c, ...s };
  }
  function send(res, code, type, body, extra) {
    res.writeHead(code, Object.assign({ 'content-type': type, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }, extra || {}));
    res.end(body);
  }
  const json = (res, code, obj, extra) => send(res, code, 'application/json', JSON.stringify(obj), extra);

  async function readJson(req) {
    return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) { req.destroy(); resolve(null); } }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve(null); } }); });
  }

  async function handle(req, res) {
    const ip = remoteIp(req);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (!secret) return send(res, 503, 'text/plain', 'console: CONSOLE_TOTP_SECRET is not set — run `node lij-adapter.js --totp-enroll` on the box and put the secret in config.env');

    if (path === '/console/login' && req.method === 'POST') {
      const f = failures.get(ip);
      if (f && f.until > Date.now()) { log(`[Console] login LOCKED from ${ip} (${Math.round((f.until - Date.now()) / 1000)}s left)`); return json(res, 429, { ok: false, error: 'locked — try again in ' + Math.ceil((f.until - Date.now()) / 60000) + ' min' }); }
      const body = await readJson(req);
      const counter = body ? totpVerify(secret, body.code, Date.now(), usedCounters) : null;
      if (counter === null) {
        const n = (f && f.until > Date.now() - 600000 ? f.n : 0) + 1;
        failures.set(ip, { n, until: n >= 5 ? Date.now() + 600000 : Date.now() });
        log(`[Console] login BAD from ${ip} (${n}/5)`);
        return json(res, 401, { ok: false, error: n >= 5 ? 'locked for 10 min' : 'code refused' });
      }
      usedCounters.add(counter); if (usedCounters.size > 64) { const first = [...usedCounters][0]; usedCounters.delete(first); }
      failures.delete(ip);
      const key = crypto.randomBytes(32).toString('hex');
      sessions.set(key, { ip, until: Date.now() + sessionMs });
      log(`[Console] login OK from ${ip}; session ${sessionMs / 3600000}h`);
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/console; Max-Age=${Math.floor(sessionMs / 1000)}` });
    }

    const sess = sessionOf(req);
    if (path === '/console/logout' && req.method === 'POST') {
      if (sess) { sessions.delete(sess.key); log(`[Console] logout from ${ip}`); }
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/console; Max-Age=0` });
    }
    if (path === '/console' || path === '/console/') {
      return send(res, 200, 'text/html; charset=utf-8', sess ? pageConsole() : pageLogin(''));
    }
    // 0.111.0 (S63): GET /console/lease — the lease's figures per channel (the retired public /lease/status). A console
    // session reads it; so does the box-local dashboard, from LOOPBACK ONLY, with the route token. Nothing proxies to this
    // listener, so loopback here means a process on the box, never the internet.
    if (path === '/console/lease' && req.method === 'GET') {
      const local = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(String((req.socket && req.socket.remoteAddress) || ''));
      const tok = String(req.headers['x-adapter-secret'] || '');
      const want = deps.routeToken ? String(deps.routeToken() || '') : '';
      const tokenOk = local && !!want && tok.length === want.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want));
      if (!sess && !tokenOk) return json(res, 401, { ok: false, error: 'login' });
      if (!deps.leaseStatus) return json(res, 503, { ok: false, error: 'not wired' });
      try { return json(res, 200, await deps.leaseStatus()); } catch (e) { return json(res, 500, { ok: false, error: String(e && e.message || e) }); }
    }
    if (!sess) return json(res, 401, { ok: false, error: 'login' });

    if (path === '/console/jit-release-wallet' && req.method === 'POST') {   // 0.111.0: one blocked wallet back in (session + confirm, audited)
      if (!deps.releaseJitWallet) return json(res, 503, { ok: false, error: 'not wired' });
      const body = await readJson(req);
      if (!body || typeof body.wallet !== 'string') return json(res, 400, { ok: false, error: 'wallet required' });
      try { const r = await deps.releaseJitWallet(body.wallet, 'console ' + ip); log(`[Console] JIT wallet block ${r.ok ? 'RELEASED' : 'release refused: ' + r.error} ${String(body.wallet).slice(0, 16)}… from ${ip}`); return json(res, r.ok ? 200 : 400, r); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }
    if (path === '/console/lease-ttl' && req.method === 'POST') {   // 0.111.0: a channel's lease length (the retired public /lease/ttl; floor one day)
      if (!deps.setLeaseTtl) return json(res, 503, { ok: false, error: 'not wired' });
      const body = await readJson(req);
      if (!body || typeof body.chan_point !== 'string') return json(res, 400, { ok: false, error: 'chan_point required' });
      try { const r = await deps.setLeaseTtl(body.chan_point, body.ttl_days, 'console ' + ip); log(`[Console] lease ttl ${r.ok ? (r.ttl_days === null ? 'CLEARED' : 'SET ' + r.ttl_days + ' d') : 'refused: ' + r.error} ${body.chan_point} from ${ip}`); return json(res, r.ok ? 200 : 400, r); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }

    if (path === '/console/jit-release' && req.method === 'POST') {   // 0.104.0: the operator's hand on the JIT guard
      if (!deps.releaseJitGuard) return json(res, 503, { ok: false, error: 'not wired' });
      try { const r = await deps.releaseJitGuard('console ' + ip); log(`[Console] JIT guard ${r.ok ? 'RELEASED' : 'release refused: ' + r.error} from ${ip}`); return json(res, r.ok ? 200 : 400, r); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }
    if (path === '/console/lease-exclude' && req.method === 'POST') {
      if (!deps.setLeaseExclude) return json(res, 503, { ok: false, error: 'not wired' });
      const body = await readJson(req);
      if (!body || typeof body.chan_point !== 'string') return json(res, 400, { ok: false, error: 'chan_point required' });
      try { const r = await deps.setLeaseExclude(body.chan_point, !!body.excluded, body.peer); log(`[Console] lease exclude ${body.excluded ? 'SET' : 'CLEARED'} ${body.chan_point} from ${ip}`); return json(res, 200, r); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }
    if (path === '/console/notes' && req.method === 'POST') {
      if (!deps.setNote) return json(res, 503, { ok: false, error: 'not wired' });
      const body = await readJson(req);
      if (!body || typeof body.kind !== 'string') return json(res, 400, { ok: false, error: 'kind required' });
      try { const r = await deps.setNote(body.kind, String(body.key || ''), String(body.text || '')); log(`[Console] note ${body.kind} ${String(body.key || '').slice(0, 16)} set from ${ip}`); return json(res, 200, r); }
      catch (e) { return json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    }
    if (path === '/console/pl' && req.method === 'GET') {
      if (!deps.pl) return json(res, 503, { ok: false, error: 'PL engine not wired' });
      try { const r = await deps.pl(url.searchParams.get('date') || '', { recompute: url.searchParams.get('recompute') === '1' }); return json(res, 200, r); }
      catch (e) { return json(res, 500, { ok: false, error: 'PL: ' + (e && e.message || e) }); }
    }
    if (path === '/console/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
      let closed = false; req.on('close', () => { closed = true; });
      const tick = async () => {
        if (closed) return;
        if (Date.now() > sess.until) { res.write('event: expired\ndata: {}\n\n'); res.end(); return; }
        try {
          const snap = await deps.snapshot();
          snap.version = deps.version; snap.ts = Date.now(); snap.session_until = sess.until; snap.from = ip;
          res.write('data: ' + JSON.stringify(snap) + '\n\n');
        } catch (e) { res.write('data: ' + JSON.stringify({ error: String(e && e.message || e), ts: Date.now(), version: deps.version, session_until: sess.until, from: ip }) + '\n\n'); }
        setTimeout(tick, 5000);
      };
      tick();
      return;
    }
    return send(res, 404, 'text/plain', 'not found');
  }

  function start() {
    if (!secret) { log('[Console] disabled: CONSOLE_TOTP_SECRET not set (run --totp-enroll)'); return []; }
    const servers = [];
    for (const addr of binds()) {
      const srv = http.createServer((req, res) => { handle(req, res).catch((e) => { try { send(res, 500, 'text/plain', 'console error'); } catch (_) {} log('[Console] error: ' + (e && e.message)); }); });
      srv.listen(port, addr, () => log(`[Console] listening on http://${addr}:${port}/console (TOTP)`));
      srv.on('error', (e) => log(`[Console] cannot bind ${addr}:${port}: ${e.message}`));
      servers.push(srv);
    }
    return servers;
  }

  return { start, binds };
}

// `node lij-adapter.js --totp-enroll`: print a fresh secret for config.env + the otpauth URI.
function totpEnroll(label) {
  const secret = base32Encode(crypto.randomBytes(20));
  const uri = `otpauth://totp/${encodeURIComponent(label || 'LIJOX console')}?secret=${secret}&issuer=LIJOX&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

module.exports = { createConsole, totpEnroll, totpCode, totpVerify, base32Encode, base32Decode, CSP };
