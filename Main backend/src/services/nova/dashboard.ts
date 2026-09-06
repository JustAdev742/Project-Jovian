/**
 * The operator dashboard, server-rendered as one self-contained HTML document.
 *
 * WHY IT IS BUILT THIS WAY
 * ------------------------
 * The context it is read in decides everything: someone is looking at this on a phone, over a
 * Tailscale Funnel link, while players are telling them the game is broken. So:
 *
 *   - **No CDN, no web font, no framework, no build step.** Every external request is another thing
 *     that can be slow or blocked between an operator and the incident list. The whole page is one
 *     response with inline CSS and one small inline script.
 *   - **Mobile-first.** 375px is the design target, not an afterthought; the wide layout is the
 *     enhancement.
 *   - **Dense.** This is a data table, not a landing page. Spacing scale is 4-24px.
 *
 * ACCESSIBILITY DECISIONS, MADE DELIBERATELY
 *   - Every colour pair was measured, not eyeballed. Body text is 15:1 on card, the dimmest text is
 *     6.1:1, and every severity colour clears 5.6:1. Borders use #64748B (3.3-3.8:1) because a UI
 *     boundary needs 3:1 under WCAG 1.4.11 — the palette's suggested #475569 measured 2.36 and was
 *     rejected.
 *   - **Severity is never colour alone.** Each row carries the severity WORD, and a distinct glyph
 *     shape per level. A red bar with no text fails for the ~8% of men with a colour vision
 *     deficiency, and fails completely in a greyscale screenshot — which is how this will be pasted
 *     into a chat.
 *   - Focus is visible (2px #38BDF8 outline, 8.3:1) and never removed.
 *   - `prefers-reduced-motion` removes the only transition.
 *
 * SECURITY: EVERYTHING RENDERED HERE CAME FROM AN UNTRUSTED CLIENT. Routes, details and build
 * strings are reported by player machines over the ingest endpoint. `esc()` is applied to every
 * interpolation without exception — a client that reports a URL of `</script><script>…` must render
 * as text, not execute. The store redacts secrets on the way in; this escapes on the way out.
 */
import type { Incident } from './incidents';

interface DashboardData {
  summary: {
    totalEvents: number;
    distinctProblems: number;
    byCategory: Record<string, number>;
    bySubsystem: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  incidents: Incident[];
  /**
   * Whether diagnostics are being written to disk, and how much is there.
   *
   * Optional so existing callers and tests keep compiling; absent means "not reported", which is
   * rendered as nothing rather than as a reassuring default. An operator must never read silence as
   * "history is safe".
   */
  persistence?: { durable: boolean; rows: number; pending: number };
}

/** HTML-escape. Applied to EVERY interpolated value; see the security note above. */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Severity presentation. `glyph` is what makes this readable without colour — a greyscale
 * screenshot, a colour-blind reader, and a monochrome terminal paste all still rank correctly.
 */
const SEVERITY: Record<string, { colour: string; glyph: string; rank: number }> = {
  CRITICAL:      { colour: '#F87171', glyph: '▲▲', rank: 0 },
  HIGH:          { colour: '#FB923C', glyph: '▲', rank: 1 },
  MEDIUM:        { colour: '#FBBF24', glyph: '■', rank: 2 },
  LOW:           { colour: '#38BDF8', glyph: '▪', rank: 3 },
  INFORMATIONAL: { colour: '#94A3B8', glyph: '·', rank: 4 },
};

/** Plain-English scope, so the reader does not have to learn the enum. */
const SCOPE_TEXT: Record<string, string> = {
  ISOLATED_CLIENT: 'One machine — probably local to that player',
  SMALL_CLUSTER: 'A few players',
  VERSION_SPECIFIC: 'Concentrated in one build — looks like a regression',
  HOST_ISSUE: 'Reported by a match host, not by players',
  BACKEND_OUTAGE: 'We are returning errors, to many people',
  NETWORK_WIDESPREAD: 'Many clients cannot reach us at all',
  WIDESPREAD: 'Broad',
};

/** Inline SVG sparkline from the incident's 12 five-minute buckets. No chart library, no script. */
function sparkline(buckets: number[]): string {
  if (!buckets.length || buckets.every((b) => b === 0)) {
    return '<span class="spark-empty" aria-hidden="true">no activity in the last hour</span>';
  }
  const w = 96;
  const h = 22;
  const max = Math.max(...buckets, 1);
  const step = w / Math.max(1, buckets.length - 1);
  const pts = buckets.map((b, i) => `${(i * step).toFixed(1)},${(h - (b / max) * (h - 2) - 1).toFixed(1)}`);
  const peak = Math.max(...buckets);
  return (
    `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" ` +
    `aria-label="Last hour, five-minute buckets. Peak ${peak}, latest ${buckets[buckets.length - 1]}.">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`
  );
}

function relative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STYLES = `
:root{
  --bg:#0F172A; --card:#1B2336; --muted:#272F42;
  --fg:#F8FAFC; --fg-dim:#94A3B8; --border:#64748B;
  --ok:#4ADE80; --focus:#38BDF8;
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px;
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--fg);
  /* System stack: a web font is one more network dependency between an operator and an outage. */
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-text-size-adjust:100%;
}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
header{padding:var(--s4); border-bottom:1px solid var(--border)}
h1{margin:0 0 var(--s1); font-size:17px; letter-spacing:-0.01em}
.sub{color:var(--fg-dim); font-size:13px}
main{padding:var(--s4); max-width:1100px; margin:0 auto}
.tiles{display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:var(--s2); margin-bottom:var(--s5)}
.tile{background:var(--card); border:1px solid var(--border); border-radius:6px; padding:var(--s3)}
.tile .n{font-size:22px; font-weight:600; line-height:1.1}
.tile .l{color:var(--fg-dim); font-size:12px; margin-top:var(--s1)}
.banner{
  background:var(--card); border:1px solid #F87171; border-left:4px solid #F87171;
  border-radius:6px; padding:var(--s3); margin-bottom:var(--s4);
}
/* Amber rather than red: diagnostics not being saved is a degraded state, not an outage, and it
   must not compete visually with the incident banner directly above it. */
.banner.warn{border-color:#F5A524; border-left-color:#F5A524}
/* Sign-in. Deliberately plain: this page is reached from a phone during an outage, so it is one
   field, one button, and a touch target that clears the 44px minimum. */
form.signin{display:flex; flex-direction:column; gap:var(--s2); max-width:420px; margin:var(--s4) 0}
form.signin label{font-size:13px; color:var(--fg-dim)}
form.signin input{
  background:var(--card); border:1px solid var(--border); border-radius:6px;
  padding:12px; color:var(--fg); font-size:16px; min-height:44px;
}
/* Never remove the focus ring; this is the one control on the page. */
form.signin input:focus-visible, form.signin button:focus-visible{outline:2px solid #93C5FD; outline-offset:2px}
form.signin button{
  background:#1D4ED8; color:#fff; border:1px solid #3B82F6; border-radius:6px;
  padding:12px 18px; font-size:15px; font-weight:600; min-height:44px; cursor:pointer;
}
form.signin button:hover{background:#1E40AF}
main > .hint{font-size:12px; color:var(--fg-dim)}
ol.incidents{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:var(--s2)}
li.incident{
  background:var(--card); border:1px solid var(--border); border-radius:6px;
  padding:var(--s3); border-left:4px solid var(--sev);
}
li.incident.resolved{opacity:0.62}
.row1{display:flex; align-items:baseline; gap:var(--s2); flex-wrap:wrap}
.rank{color:var(--fg-dim); font-size:12px; min-width:2ch}
.sev{color:var(--sev); font-weight:600; font-size:12px; letter-spacing:0.04em; white-space:nowrap}
.id{color:var(--fg-dim); font-size:12px}
.title{margin:var(--s2) 0 0; font-size:14px; font-weight:500; overflow-wrap:anywhere}
.meta{display:flex; flex-wrap:wrap; gap:var(--s1) var(--s3); margin-top:var(--s2); color:var(--fg-dim); font-size:12px}
.meta b{color:var(--fg); font-weight:600}
.scope{margin-top:var(--s2); font-size:12px; color:var(--fg-dim)}
.trend{display:flex; align-items:center; gap:var(--s2); margin-top:var(--s2); color:var(--sev)}
.spark{display:block}
.spark-empty{color:var(--fg-dim); font-size:12px}
.growth{font-size:12px; font-weight:600}
.tag{
  display:inline-block; background:var(--muted); border:1px solid var(--border);
  border-radius:4px; padding:1px 6px; font-size:11px; color:var(--fg);
}
.empty{background:var(--card); border:1px solid var(--border); border-radius:6px; padding:var(--s5); text-align:center; color:var(--fg-dim)}
a{color:var(--focus)}
:focus-visible{outline:2px solid var(--focus); outline-offset:2px}
button{
  font:inherit; color:var(--fg); background:var(--muted);
  border:1px solid var(--border); border-radius:4px; padding:var(--s1) var(--s2);
  cursor:pointer; transition:background 160ms ease;
}
button[aria-pressed="true"]{background:var(--focus); color:#0F172A; border-color:var(--focus)}
button:hover{background:#33405A}
.filters{display:flex; gap:var(--s2); flex-wrap:wrap; margin-bottom:var(--s4)}

/* Live tail. Deliberately quiet: it must not compete with the ranked incident list for attention,
   and it is read on a phone in a dark room. */
.live{background:var(--card); border:1px solid var(--border); border-radius:6px; padding:var(--s3) var(--s4); margin-bottom:var(--s4)}
.live h2{font-size:13px; font-weight:600; margin:0 0 var(--s2); display:flex; align-items:center; gap:var(--s2); color:var(--fg-dim)}
/* Connection state carries a SHAPE and a LABEL, never colour alone — the whole page follows that
   rule so it stays readable for colour-blind users and in a washed-out phone screen. */
.dot{width:8px; height:8px; border-radius:50%; flex:none; background:var(--fg-dim)}
.dot.ok{background:#4ADE80}
.dot.bad{background:#F87171; border-radius:1px}
.dot.wait{background:#FBBF24; border-radius:2px}
.feed{list-style:none; margin:0; padding:0; max-height:190px; overflow-y:auto; font-size:12px}
.feed li{display:flex; gap:var(--s2); align-items:baseline; padding:3px 0; border-bottom:1px solid rgba(100,116,139,.18)}
.feed li:last-child{border-bottom:0}
.feed time{color:var(--fg-dim); font-variant-numeric:tabular-nums; flex:none}
.feed b{font-weight:600; flex:none}
.feed span{color:var(--fg-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.feed em{margin-left:auto; font-style:normal; color:var(--fg-dim); flex:none}
.feed li.fresh b{color:var(--focus)}
.live .hint{margin:var(--s2) 0 0; font-size:11px; color:var(--fg-dim)}
@media (prefers-reduced-motion: reduce){ *{transition:none !important; animation:none !important} }
@media (min-width:760px){ .row1{flex-wrap:nowrap} .title{font-size:15px} }
`;

/** Passing `null` renders the locked page — used when the admin secret is absent or wrong. */
/**
 * Why the locked page needs an argument.
 *
 * `renderDashboard(null)` used to mean "locked", full stop, and rendered one message for two
 * unrelated situations. `configured` says whether a secret exists at all; `failed` says the visitor
 * just tried one and it was wrong. Optional so every existing caller and test keeps working, and
 * absent behaves as it always did.
 */
export interface LockedState {
  configured: boolean;
  failed?: boolean;
}

export function renderDashboard(data: DashboardData | null, locked?: LockedState): string {
  const head =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Nova — diagnostics</title><style>${STYLES}</style></head><body>`;

  if (!data) {
    // TWO DIFFERENT STATES, AND THEY USED TO RENDER THE SAME TEXT.
    //
    // "no secret is configured" and "you did not send the secret" are opposite problems with
    // opposite fixes, and the page said the first for both. The reported symptom was exactly that:
    // an operator opened the link, read "closed unless an admin secret is configured", and
    // reasonably concluded the coordinator was misconfigured — while the secret was set, working,
    // and simply not being sent, because a BROWSER CANNOT SEND A CUSTOM HEADER by typing a URL.
    //
    // A diagnostic tool that misdiagnoses its own state is worse than one that says nothing.
    if (!locked?.configured) {
      return (
        head +
        `<main><h1>Diagnostics dashboard is not enabled</h1>` +
        `<p class="sub">This view shows cross-player failure data, so it is closed until an admin ` +
        `secret exists. Set <code class="mono">NOVA_AC_ADMIN_SECRET</code> in the coordinator's ` +
        `<code class="mono">.env</code> and restart the backend.</p>` +
        `</main></body></html>`
      );
    }

    return (
      head +
      `<main><h1>Sign in to the diagnostics dashboard</h1>` +
      `<p class="sub">A secret is configured on this coordinator; this browser has not sent it. ` +
      `Signing in stores it as an HttpOnly cookie, so it stays out of the address bar, out of ` +
      `browser history, and out of any screenshot of this link.</p>` +
      (locked.failed
        ? `<div class="banner" role="alert"><strong>That secret was not accepted.</strong> ` +
          `It must match <code class="mono">NOVA_AC_ADMIN_SECRET</code> exactly.</div>`
        : '') +
      `<form class="signin" method="post" action="/nova/api/dashboard/login">` +
        `<label for="secret">Admin secret</label>` +
        // type=password so it is not shouldered or captured by a screen recording.
        //
        // `autocomplete="current-password"`, NOT "off". The first version used "off" on the
        // reasoning that this is a shared operational secret rather than a personal credential —
        // accesslint failed it as a WCAG 2.2 SC 3.3.8 violation, and the rule is right: blocking
        // password managers forces the reader to transcribe a 31-character secret by hand, on a
        // phone, during an outage. That is a cognitive-accessibility failure, and the alternative
        // people actually reach for is pasting the secret somewhere less safe.
        `<input id="secret" name="secret" type="password" autocomplete="current-password" autofocus ` +
          `required maxlength="200" spellcheck="false">` +
        `<button type="submit">Sign in</button>` +
      `</form>` +
      `<p class="hint">Scripts and probes can keep using the ` +
      `<code class="mono">x-nova-admin</code> header, which is unchanged.</p>` +
      `</main></body></html>`
    );
  }

  const { summary, incidents } = data;
  const spiking = incidents.filter((i) => i.possibleIncident);
  const active = incidents.filter((i) => i.state === 'ACTIVE');

  const tiles = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL'] as const)
    .map((sev) => {
      const n = summary.bySeverity[sev] ?? 0;
      return (
        `<div class="tile"><div class="n" style="color:${SEVERITY[sev].colour}">${esc(n)}</div>` +
        `<div class="l">${SEVERITY[sev].glyph} ${esc(sev)}</div></div>`
      );
    })
    .join('');

  // A baseline of 0 means "this has never happened before", which is worth saying plainly. The
  // first draft rendered "rising sharply against 0/5min baseline", which is not a sentence.
  const worst = spiking[0];
  const against =
    worst && worst.trend.baseline > 0
      ? `against a baseline of ${esc(worst.trend.baseline)} per 5 min`
      : 'with no prior history — this is new';
  const banner = spiking.length
    ? `<div class="banner" role="status"><strong>POSSIBLE INCIDENT</strong> — ` +
      `${esc(spiking.length)} problem${spiking.length === 1 ? '' : 's'} rising sharply, ${against}. ` +
      `Listed first below.</div>`
    : '';

  const rows = incidents.length
    ? incidents
        .map((i, idx) => {
          const s = SEVERITY[i.severity] ?? SEVERITY.INFORMATIONAL;
          const growth =
            i.trend.growthPct === null
              ? (i.trend.current > 0 ? 'new' : '')
              : `${i.trend.growthPct > 0 ? '+' : ''}${esc(i.trend.growthPct)}%`;
          return (
            `<li class="incident${i.state === 'RESOLVED' ? ' resolved' : ''}" style="--sev:${s.colour}">` +
              `<div class="row1">` +
                `<span class="rank">#${idx + 1}</span>` +
                // Glyph + word: severity survives greyscale and colour-blindness.
                `<span class="sev">${s.glyph} ${esc(i.severity)}</span>` +
                `<span class="id mono">${esc(i.id)}</span>` +
                `<span class="tag">${esc(i.source)}</span>` +
                `<span class="tag">${esc(i.subsystem)}</span>` +
                (i.state === 'RESOLVED' ? `<span class="tag">resolved</span>` : '') +
                (i.possibleIncident ? `<span class="tag" style="border-color:#F87171;color:#F87171">spiking</span>` : '') +
              `</div>` +
              `<p class="title mono">${esc(i.title)}</p>` +
              `<div class="meta">` +
                `<span><b>${esc(i.affectedUsers)}</b> affected</span>` +
                `<span><b>${esc(i.occurrences)}</b> occurrences</span>` +
                `<span>build <b>${esc(i.version)}</b></span>` +
                `<span>from <b>${esc(i.component)}</b></span>` +
                `<span>first ${esc(relative(i.firstSeen))}</span>` +
                `<span>last ${esc(relative(i.lastSeen))}</span>` +
                `<span>score <b>${esc(i.score)}</b></span>` +
              `</div>` +
              // Zero identified players is not "one machine" — it is unauthenticated traffic, which
              // is a different thing to go and look at. Saying "one machine" there sends the reader
              // hunting for a player who does not exist.
              `<div class="scope">${esc(
                i.affectedUsers === 0
                  ? 'No identified player — unauthenticated or pre-login traffic'
                  : SCOPE_TEXT[i.scope] ?? i.scope,
              )}</div>` +
              `<div class="trend">${sparkline(i.trend.buckets)}` +
                `<span class="growth">${growth ? esc(growth) : ''}</span></div>` +
              (i.correlationIds.length
                ? `<div class="scope">trace: <span class="mono">${esc(i.correlationIds[0])}</span></div>`
                : '') +
            `</li>`
          );
        })
        .join('')
    : `<div class="empty">Nothing has failed. This is the correct and boring state.</div>`;

  // Two scripts, both inline and dependency-free for the same reason the page is server-rendered:
  // it is read on a phone, over a tunnel, while something is on fire.
  //
  //   1. A severity filter over already-rendered rows.
  //   2. A live tail on /nova/api/diagnostics/stream (SSE).
  //
  // THE LIVE TAIL IS ADDITIVE, NOT LOAD-BEARING. The server-rendered incident list below is the
  // authoritative view and is complete without any script running at all. If the stream is refused,
  // blocked by a proxy, or the browser has no EventSource, the page still shows everything it did
  // before — it just stops saying "live". A dashboard whose content depends on a socket is a
  // dashboard that shows nothing at the exact moment the network is the problem.
  //
  // Auth: EventSource cannot set headers, so the secret is carried the way the page itself was
  // opened — from location.search. It is never written into the document, so it stays out of the
  // rendered HTML and out of anything saved from it.
  const script = `
<script>
(function(){
  var list=document.getElementById('list');
  if(list){
    document.querySelectorAll('[data-filter]').forEach(function(btn){
      btn.addEventListener('click',function(){
        var want=btn.getAttribute('data-filter');
        document.querySelectorAll('[data-filter]').forEach(function(b){
          b.setAttribute('aria-pressed', String(b===btn));
        });
        list.querySelectorAll('li.incident').forEach(function(li){
          li.hidden = want!=='ALL' && li.querySelector('.sev').textContent.indexOf(want)===-1;
        });
      });
    });
  }

  var dot=document.getElementById('livedot'), lab=document.getElementById('livelabel'),
      feed=document.getElementById('feed'), seen=0;
  if(!feed||typeof EventSource==='undefined'){ if(lab) lab.textContent='live updates unavailable'; return; }

  function state(cls,text){ if(dot) dot.className='dot '+cls; if(lab) lab.textContent=text; }

  var qs=new URLSearchParams(location.search), secret=qs.get('secret');
  var auth=secret?('secret='+encodeURIComponent(secret)):'';

  // ONE renderer for both carriers. The event objects are identical whichever way they arrive, so
  // there is exactly one place that knows how to draw one.
  function push(d){
    seen++;
    var li=document.createElement('li');
    // textContent throughout — never innerHTML. Every field here originates from a client-reported
    // URL, and the server escapes for ITS render, not for ours.
    var t=document.createElement('time'); t.textContent=new Date(d.at).toLocaleTimeString();
    var c=document.createElement('b');    c.textContent=d.category;
    var r=document.createElement('span'); r.textContent=d.method+' '+d.route;
    var n=document.createElement('em');   n.textContent=d.isNew?'new':('x'+d.count);
    li.appendChild(t); li.appendChild(c); li.appendChild(r); li.appendChild(n);
    if(d.isNew) li.className='fresh';
    feed.insertBefore(li,feed.firstChild);
    // Bounded in the DOM as well as on the wire: an unbounded feed is a memory leak on a page meant
    // to be left open for hours.
    while(feed.childNodes.length>60) feed.removeChild(feed.lastChild);
  }

  var mode='', es=null, pollTimer=null, cursor=null;

  // ── FALLBACK: SAME EVENTS, DIFFERENT CARRIER ────────────────────────────────────────────────
  // Not a page-refresh loop. It reads the same event objects the stream emits, addressed by
  // sequence number, so nothing is missed or double-counted — and the missed count tells us when the ring
  // has moved past us rather than letting the feed imply continuity it does not have.
  function poll(){
    var u='/nova/api/diagnostics/since?'+auth+(cursor!==null?('&seq='+cursor):'');
    fetch(u,{cache:'no-store'}).then(function(r){ return r.ok?r.json():null; }).then(function(j){
      if(!j) { state('bad','updates unavailable'); return; }
      if(cursor===null){ cursor=j.head; state('ok','live (polling) · connected'); return; }
      if(j.missed>0){
        var li=document.createElement('li');
        var w=document.createElement('b'); w.textContent='GAP';
        var s=document.createElement('span'); s.textContent=j.missed+' event(s) scrolled out before this page read them';
        li.appendChild(w); li.appendChild(s); feed.insertBefore(li,feed.firstChild);
      }
      (j.events||[]).forEach(function(d){ push(d); cursor=d.seq; });
      if(typeof j.head==='number') cursor=Math.max(cursor,j.head);
      state('ok','live (polling) · '+seen+' since load');
    }).catch(function(){ state('bad','updates unavailable'); });
  }

  function startPolling(why){
    if(mode==='poll') return;
    mode='poll';
    if(es){ try{ es.close(); }catch(e){} es=null; }
    state('wait','falling back ('+why+')…');
    poll();
    // 3s: fast enough to feel live, slow enough that a page left open all day is ~1,200 requests
    // against a route that returns an empty array when nothing is wrong.
    pollTimer=setInterval(poll,3000);
  }

  // SSE FIRST — it is the correct transport and it works on any direct or SSH-forwarded connection.
  // Measured: it delivers correctly from the backend and through the path-allowlist proxy, and
  // delivers NOTHING through Cloudflare's free tunnel, which buffers the body. Hence the timer.
  if(typeof EventSource==='undefined'){ startPolling('no EventSource'); return; }
  try{ es=new EventSource('/nova/api/diagnostics/stream'+(auth?('?'+auth):'')); }
  catch(e){ startPolling('stream refused'); return; }

  var helloTimer=setTimeout(function(){ if(mode!=='sse') startPolling('stream silent'); },4000);

  es.addEventListener('hello',function(){
    mode='sse'; clearTimeout(helloTimer); state('ok','live (stream)');
  });
  es.addEventListener('diagnostic',function(m){
    var d; try{ d=JSON.parse(m.data); }catch(e){ return; }
    push(d); state('ok','live (stream) · '+seen+' since load');
  });
  es.onerror=function(){
    // EventSource retries by itself, so an error is only fatal if it never connected. If we never
    // saw the hello frame, the transport is the problem — switch rather than retry into the same wall.
    if(mode!=='sse') startPolling('stream error');
    else state('bad','reconnecting…');
  };
})();
</script>`;

  // Durability, stated plainly in both directions. "Kept" tells an operator that what they are
  // looking at will still be there after the restart they are about to do; the warning tells them
  // the opposite before they find out the hard way.
  const p = data.persistence;
  const durability = !p
    ? ''
    : p.durable
      ? ` · ${esc(p.rows)} kept on disk`
      : ' · history NOT saved';
  const storeWarning = p && !p.durable
    ? `<div class="banner warn" role="status"><strong>DIAGNOSTICS ARE NOT BEING SAVED</strong> — ` +
      `the durable store did not come up, so everything on this page is in memory only and a crash ` +
      `will take it with it. Check the backend log for a <code>[Diagnostics]</code> line.</div>`
    : '';

  return (
    head +
    `<header><h1>Nova diagnostics</h1>` +
    `<div class="sub">${esc(summary.distinctProblems)} distinct problems · ` +
    `${esc(summary.totalEvents)} events · ${esc(active.length)} active${durability} · ` +
    `generated ${esc(new Date().toISOString())}</div></header>` +
    `<main>` +
    storeWarning +
    banner +
    `<div class="tiles">${tiles}</div>` +
    // The live tail sits ABOVE the incident list because it answers a different question: the list
    // says what is broken, this says what is happening right now. During an incident the second is
    // what you watch.
    `<section class="live" aria-live="polite">` +
      `<h2><span class="dot wait" id="livedot"></span>` +
      `<span id="livelabel">connecting…</span></h2>` +
      `<ol class="feed" id="feed"></ol>` +
      `<p class="hint">Newest first. The list below is server-rendered and stays correct even if ` +
      `this stream drops — reload for a full recount.</p>` +
    `</section>` +
    `<div class="filters">` +
      `<button data-filter="ALL" aria-pressed="true">All</button>` +
      (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const)
        .map((s) => `<button data-filter="${s}" aria-pressed="false">${SEVERITY[s].glyph} ${s}</button>`)
        .join('') +
    `</div>` +
    `<ol class="incidents" id="list">${rows}</ol>` +
    `</main>${script}</body></html>`
  );
}
