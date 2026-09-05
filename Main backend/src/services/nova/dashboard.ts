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
@media (prefers-reduced-motion: reduce){ *{transition:none !important; animation:none !important} }
@media (min-width:760px){ .row1{flex-wrap:nowrap} .title{font-size:15px} }
`;

/** Passing `null` renders the locked page — used when the admin secret is absent or wrong. */
export function renderDashboard(data: DashboardData | null): string {
  const head =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Nova — diagnostics</title><style>${STYLES}</style></head><body>`;

  if (!data) {
    return (
      head +
      `<main><h1>Diagnostics dashboard is not enabled</h1>` +
      `<p class="sub">This view shows cross-player failure data, so it is closed unless an admin ` +
      `secret is configured. Set <code class="mono">NOVA_AC_ADMIN_SECRET</code> on the coordinator ` +
      `and send it as the <code class="mono">x-nova-admin</code> header, or as <code class="mono">?secret=</code>.</p>` +
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

  // The only script on the page: a client-side severity filter over already-rendered rows. No
  // fetching, no polling — a reload is the refresh, and it cannot get stuck in a broken state.
  const script = `
<script>
(function(){
  var list=document.getElementById('list');
  if(!list) return;
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
})();
</script>`;

  return (
    head +
    `<header><h1>Nova diagnostics</h1>` +
    `<div class="sub">${esc(summary.distinctProblems)} distinct problems · ` +
    `${esc(summary.totalEvents)} events · ${esc(active.length)} active · ` +
    `generated ${esc(new Date().toISOString())}</div></header>` +
    `<main>` +
    banner +
    `<div class="tiles">${tiles}</div>` +
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
