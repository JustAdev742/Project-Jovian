/**
 * The Diagnostic Dashboard: one self-contained HTML file per run.
 *
 * Rendered to static HTML here, so it opens offline, prints, and still reads with JavaScript off;
 * a small inline script adds filtering on top. No fonts, scripts or styles are fetched — a report
 * about a machine that may be offline must not need the network to display.
 *
 * Visual language follows Nova's admin dashboard (Main backend/src/services/nova/dashboard.ts):
 * the same slate surfaces and the same severity colours AND shapes, so severity never relies on
 * colour alone. The one emphatic element is the verdict sentence at the top, written from the data.
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SEV = {
  P0: { color: '#F87171', mark: '▲▲', word: 'blocks play or hosting' },
  P1: { color: '#FB923C', mark: '▲', word: 'serious' },
  P2: { color: '#FBBF24', mark: '■', word: 'degraded' },
  P3: { color: '#38BDF8', mark: '▪', word: 'minor' },
  INFO: { color: '#94A3B8', mark: '·', word: 'worth knowing' },
};
const CONF = {
  CONFIRMED: 'Confirmed: a positive signal was observed',
  PROBABLE: 'Probable: one link of the evidence is inferred',
  POTENTIAL: 'Potential: a heuristic match, a lead rather than a finding',
};
const STATUS_WORD = { open: 'Open', stale: 'Stale', 'not-ours': 'Not ours', 'known-benign': 'Known benign', resolved: 'Resolved' };
const COV_WORD = { checked: 'Checked', skipped: 'Skipped', 'n/a': 'Not applicable', error: 'Error' };

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : esc(d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
}

function sevBadge(s) {
  const v = SEV[s] || SEV.INFO;
  return `<span class="sev" style="--sev:${v.color}" title="${esc(`${s}: ${v.word}`)}"><span aria-hidden="true">${v.mark}</span> ${esc(s)}</span>`;
}

/** The headline: what a reader most needs to know, in one or two sentences, from the data. */
export function verdict(report) {
  const causes = report.causes || [];
  const open = report.findings.filter(f => f.status === 'open');
  const p0 = causes.filter(c => c.severity === 'P0');
  const linked = new Set(causes.flatMap(c => c.findings)).size;
  if (!open.length) return { lead: 'No open problems were found in the areas that were checked.', rest: 'Check the coverage list for what was skipped before reading that as a clean bill of health.' };
  const lead = p0.length
    ? `${p0.length === 1 ? 'One problem blocks' : `${p0.length} problems block`} play or hosting: ${p0.map(c => c.short || c.title.replace(/[.,]$/, '')).join(', and ')}.`
    : `Nothing blocks play outright. The most serious cause: ${causes[0]?.title ?? open[0].title}.`;
  const rest = causes.length
    ? `${causes.length} underlying cause${causes.length === 1 ? '' : 's'} explain ${linked} of the ${open.length} open findings.`
    : `${open.length} open findings, none yet grouped under a cause.`;
  return { lead, rest };
}

function causesSection(report) {
  const causes = report.causes || [];
  if (!causes.length) return '';
  const items = causes.map((c, i) => `
    <li class="cause" style="--sev:${(SEV[c.severity] || SEV.INFO).color}">
      <div class="cause-head">
        ${sevBadge(c.severity)}
        <span class="conf conf-${esc(c.confidence.toLowerCase())}" title="${esc(CONF[c.confidence] || '')}">${esc(c.confidence.toLowerCase())}</span>
      </div>
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.narrative)}</p>
      <p class="next"><strong>Next step:</strong> ${esc(c.next)}</p>
      <button type="button" class="link" data-cause="${esc(c.id)}">Show the ${c.findings.length} linked finding${c.findings.length === 1 ? '' : 's'}</button>
    </li>`).join('');
  return `<section aria-labelledby="h-causes"><h2 id="h-causes">Causes, most urgent first</h2><ol class="causes">${items}</ol></section>`;
}

function findingRow(f, causeIds = '') {
  const ev = f.evidence.map(e => `
      <li><span class="where" translate="no">${esc(e.source || '')}${e.line ? `:${e.line}` : ''}${e.time ? ` <span class="t">${when(e.time) || esc(e.time)}</span>` : ''}</span>
      <code translate="no">${esc(e.excerpt)}</code></li>`).join('');
  const extra = [
    f.explain ? `<p>${esc(f.explain)}</p>` : '',
    f.data?.stale ? `<p class="stale-why">Marked stale: ${esc(f.data.stale)}</p>` : '',
    f.fix?.summary ? `<p><strong>Fix:</strong> ${esc(f.fix.summary)}${f.fix.repairId ? ` <span class="repair">Repair available: <code translate="no">repair --apply ${esc(f.fix.repairId)}</code></span>` : ''}</p>` : '',
    f.kb ? `<p class="kb">Recorded in ${esc(f.kb)}</p>` : '',
    f.count > f.evidence.length && f.evidence.length ? `<p class="kb">Showing ${f.evidence.length} of ${f.count} occurrences.</p>` : '',
  ].join('');
  return `
  <tr data-sev="${esc(f.severity)}" data-conf="${esc(f.confidence)}" data-status="${esc(f.status)}" data-comp="${esc(f.component)}" data-causes="${esc(causeIds)}" data-text="${esc((f.title + ' ' + f.key).toLowerCase())}">
    <td>${sevBadge(f.severity)}</td>
    <td><span class="conf conf-${esc(f.confidence.toLowerCase())}" title="${esc(CONF[f.confidence] || '')}">${esc(f.confidence.toLowerCase())}</span></td>
    <td class="hide-sm">${esc(STATUS_WORD[f.status] || f.status)}</td>
    <td class="hide-sm">${esc(f.component)}</td>
    <td class="title-cell">
      <details>
        <summary>${esc(f.title)}${f.baseline === 'new' ? ' <span class="new">new since baseline</span>' : ''}</summary>
        <div class="detail">${extra}${ev ? `<ul class="evidence">${ev}</ul>` : ''}</div>
      </details>
    </td>
    <td class="num">${f.count}</td>
  </tr>`;
}

function findingsSection(report) {
  const comps = [...new Set(report.findings.map(f => f.component))].sort();
  const opt = (v, label) => `<option value="${esc(v)}">${esc(label)}</option>`;
  return `
  <section aria-labelledby="h-findings">
    <h2 id="h-findings">Every finding, with its evidence</h2>
    <form class="filters" role="search" aria-label="Filter findings" onsubmit="return false">
      <label>Search <input type="search" id="q" name="q" placeholder="e.g. quickbar…" autocomplete="off" spellcheck="false"></label>
      <label>Severity <select id="f-sev">${opt('', 'All')}${Object.keys(SEV).map(s => opt(s, s)).join('')}</select></label>
      <label>Confidence <select id="f-conf">${opt('', 'All')}${Object.keys(CONF).map(c => opt(c, c.toLowerCase())).join('')}</select></label>
      <label>Status <select id="f-status">${opt('open', 'Open')}${opt('', 'All')}${Object.entries(STATUS_WORD).filter(([k]) => k !== 'open').map(([k, v]) => opt(k, v)).join('')}</select></label>
      <label>Component <select id="f-comp">${opt('', 'All')}${comps.map(c => opt(c, c)).join('')}</select></label>
      <button type="button" id="f-reset" class="link">Clear filters</button>
    </form>
    <p id="count" class="count" aria-live="polite"></p>
    <p id="none" class="dim" hidden>No findings match these filters. <button type="button" class="link" id="f-reset2">Clear filters</button> to see all ${report.findings.length}.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Findings table, scrolls sideways on narrow screens">
      <table>
        <caption class="sr-only">Findings, most urgent first. Expand a title for its evidence.</caption>
        <thead><tr><th scope="col">Severity</th><th scope="col">Confidence</th><th scope="col" class="hide-sm">Status</th><th scope="col" class="hide-sm">Component</th><th scope="col">Finding</th><th scope="col" class="num">Count</th></tr></thead>
        <tbody>${report.findings.length ? report.findings.map(f => findingRow(f, (report.causes || []).filter(c => c.findings.includes(f.key)).map(c => c.id).join(' '))).join('') : '<tr><td colspan="6" class="dim">No findings in the areas that were checked. See “What was checked” for what was not.</td></tr>'}</tbody>
      </table>
    </div>
  </section>`;
}

function coverageSection(report) {
  const byModule = {};
  for (const c of report.coverage) (byModule[c.module] ||= []).push(c);
  const rows = Object.entries(byModule).map(([m, list]) => `
    <tbody>
      <tr class="group"><th colspan="3" scope="rowgroup">${esc(m)}</th></tr>
      ${list.map(c => `<tr><td class="cov cov-${esc(c.status.replace('/', ''))}">${esc(COV_WORD[c.status] || c.status)}</td><td>${esc(c.area)}</td><td class="dim">${esc(c.detail)}</td></tr>`).join('')}
    </tbody>`).join('');
  const gaps = report.coverage.filter(c => c.status !== 'checked').length;
  return `
  <section aria-labelledby="h-cov">
    <h2 id="h-cov">What was checked</h2>
    <p class="dim">${report.coverage.length - gaps} areas checked; ${gaps} skipped, not applicable or in error. A clean result only covers the checked areas.</p>
    <div class="table-wrap" tabindex="0" role="region" aria-label="Coverage table, scrolls sideways on narrow screens"><table class="coverage"><caption class="sr-only">Coverage by module</caption>
      <thead><tr><th scope="col">Result</th><th scope="col">Area</th><th scope="col">Detail</th></tr></thead>${rows}</table></div>
  </section>`;
}

function baselineSection(report) {
  const b = report.baseline;
  if (!b?.compared) {
    return `<section aria-labelledby="h-base"><h2 id="h-base">Changes since the baseline</h2>
      <p class="dim">No baseline is saved yet, so new problems cannot be told from old ones. Save this run as the baseline with <code translate="no">node doctor/nova-doctor.mjs scan --save-baseline</code>.</p></section>`;
  }
  const list = (items, empty) => items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` : `<p class="dim">${empty}</p>`;
  return `<section aria-labelledby="h-base"><h2 id="h-base">Changes since the baseline of ${when(b.baselineAt)}</h2>
    <div class="cols">
      <div><h3>New (${b.new.length})</h3>${list(b.new.map(k => esc(report.findings.find(f => f.key === k)?.title || k)), 'Nothing new.')}</div>
      <div><h3>No longer reported (${b.resolved.length})</h3>${list(b.resolved.map(r => esc(r.title)), 'Nothing dropped out.')}
        <p class="dim">“No longer reported” means the detector no longer sees it. The log may have rotated away, so it is not the same as fixed.</p></div>
    </div>
    <p class="dim">${b.persisting} open findings are unchanged.</p></section>`;
}

const CSS = `
:root{--bg:#0F172A;--raised:#1B2336;--muted:#272F42;--fg:#F8FAFC;--body:#D5DEEA;--dim:#A3B1C6;--line:#3B4659;--control:#64748B;--line-hover:#94A3B8;--focus:#38BDF8;--focus-hover:#7DD3FC;--ok:#4ADE80;--warn:#FBBF24;--bad:#F87171;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 var(--sans);font-kerning:normal}
.wrap{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
a,button{color:var(--focus)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
header .meta{color:var(--dim);font-size:14px;margin:0 0 28px;display:flex;flex-wrap:wrap;gap:4px 20px}
.verdict{font-size:clamp(22px,3.4vw + 8px,40px);overflow-wrap:break-word;line-height:1.18;font-weight:600;letter-spacing:-.012em;max-width:30ch;margin:0 0 12px;text-wrap:balance}
.verdict-rest{font-size:20px;line-height:1.4;color:var(--dim);max-width:60ch;margin:0 0 24px}
.strip{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 40px;padding:0;list-style:none;font-size:15px;color:var(--dim)}
.strip strong{color:var(--fg);font-variant-numeric:tabular-nums;font-size:18px;margin-right:6px}
h2{font-size:22px;line-height:1.3;margin:48px 0 16px;letter-spacing:-.005em;text-wrap:balance}
h3{font-size:17px;line-height:1.35;margin:6px 0 6px;text-wrap:balance}
.skip{position:absolute;left:16px;top:-48px;background:var(--focus);color:var(--bg);padding:8px 12px;border-radius:6px;font-weight:600;z-index:2}
.skip:focus{top:12px}
button,summary,select,input,a{touch-action:manipulation;-webkit-tap-highlight-color:rgba(56,189,248,.25)}
button.link:hover{color:var(--focus-hover);text-decoration-thickness:2px}
details summary:hover{color:var(--fg);text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
.filters select option{background:var(--raised);color:var(--fg)}
.filters input:hover,.filters select:hover{border-color:var(--line-hover)}
p{margin:0 0 10px;max-width:78ch;overflow-wrap:break-word}
.dim{color:var(--dim)}
code{font-family:var(--mono);font-size:13px}
.sev{display:inline-flex;align-items:center;gap:5px;color:var(--sev);font-weight:600;font-size:14px;white-space:nowrap;font-variant-numeric:tabular-nums}
.conf{font-size:14px;white-space:nowrap}
.conf-confirmed{color:var(--fg)}
.conf-probable{color:var(--dim)}
.conf-potential{color:var(--dim);font-style:italic}
.causes{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.cause{min-width:0;overflow-wrap:anywhere;position:relative;padding:16px 20px 16px 22px;background:var(--raised);border-left:4px solid var(--sev);border-radius:0 8px 8px 0}
.cause-head{display:flex;gap:16px;align-items:baseline}
.cause p{color:var(--body)}
.cause .next{color:var(--fg)}
button.link{background:none;border:0;padding:6px 0;font:inherit;font-size:15px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;min-height:32px}
.filters{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;margin:0 0 12px}
.filters label{display:flex;flex-direction:column;gap:4px;font-size:14px;color:var(--dim)}
.filters input,.filters select{font:inherit;font-size:15px;color:var(--fg);background:var(--raised);border:1px solid var(--control);border-radius:6px;padding:7px 10px;min-height:40px}
.filters input{min-width:220px}
.count{color:var(--dim);font-size:14px;margin:0 0 8px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
thead th{font-size:14px;font-weight:600;color:var(--dim);background:var(--raised);position:sticky;top:0}
tbody tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.title-cell{min-width:320px}
details summary{cursor:pointer;line-height:1.4;padding:3px 0;min-height:24px}
details summary::marker{color:var(--dim)}
.detail{padding:10px 0 4px}
.detail p{font-size:15px;color:var(--body)}
.evidence{list-style:none;margin:6px 0 0;padding:0;display:grid;gap:8px}
.evidence li{background:var(--muted);border-radius:6px;padding:8px 10px}
.evidence .where{display:block;font-family:var(--mono);font-size:12.5px;color:var(--dim);margin-bottom:3px;overflow-wrap:anywhere}
.evidence code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--fg)}
.where .t{margin-left:8px}
.stale-why,.kb{color:var(--dim)}
.new{display:inline-block;margin-left:8px;font-size:13px;color:var(--bg);background:var(--ok);border-radius:4px;padding:0 6px;font-weight:600}
.repair{display:block;margin-top:4px;color:var(--dim)}
.coverage .group th{background:var(--raised);font-size:14px;color:var(--fg)}
.cov{white-space:nowrap;font-weight:600;font-size:14px}
.cov-checked{color:var(--ok)}.cov-skipped{color:var(--warn)}.cov-na{color:var(--dim)}.cov-error{color:var(--bad)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
footer{margin-top:56px;color:var(--dim);font-size:14px}
@media (max-width:720px){.wrap{padding:20px 16px 48px}.hide-sm{display:none}.title-cell{min-width:220px}.verdict-rest{font-size:18px}}
@media (prefers-reduced-motion:no-preference){details[open] .detail{animation:open .16s ease-out}@keyframes open{from{opacity:0}to{opacity:1}}}
@media print{body{background:#fff;color:#000}.filters,button.link{display:none}details{display:block}.cause,.evidence li,thead th{background:#f3f4f6}}
`;

const SCRIPT = `
(function(){
  var rows=[].slice.call(document.querySelectorAll('tbody tr[data-sev]'));
  var q=document.getElementById('q'),sev=document.getElementById('f-sev'),conf=document.getElementById('f-conf'),st=document.getElementById('f-status'),comp=document.getElementById('f-comp'),count=document.getElementById('count');
  var none=document.getElementById('none');
  var cause='';
  // Filter state lives in the URL hash, so a filtered view can be shared or bookmarked.
  function save(){
    var p=new URLSearchParams();
    if(q.value)p.set('q',q.value); if(sev.value)p.set('sev',sev.value); if(conf.value)p.set('conf',conf.value);
    if(st.value!=='open')p.set('status',st.value); if(comp.value)p.set('comp',comp.value); if(cause)p.set('cause',cause);
    var h=p.toString(); history.replaceState(null,'',h?'#'+h:location.pathname+location.search);
  }
  function load(){
    var p=new URLSearchParams(location.hash.slice(1));
    q.value=p.get('q')||''; sev.value=p.get('sev')||''; conf.value=p.get('conf')||'';
    st.value=p.has('status')?p.get('status'):'open'; comp.value=p.get('comp')||''; cause=p.get('cause')||'';
  }
  function apply(){
    var t=q.value.trim().toLowerCase(),n=0;
    rows.forEach(function(r){
      var ok=(!t||r.dataset.text.indexOf(t)>=0)&&(!sev.value||r.dataset.sev===sev.value)&&(!conf.value||r.dataset.conf===conf.value)&&(!st.value||r.dataset.status===st.value)&&(!comp.value||r.dataset.comp===comp.value)&&(!cause||(' '+r.dataset.causes+' ').indexOf(' '+cause+' ')>=0);
      r.hidden=!ok; if(ok)n++;
    });
    count.textContent='Showing '+n+' of '+rows.length+' findings'+(cause?' linked to one cause':'')+'.';
    if(none)none.hidden=n>0||!rows.length;
    save();
  }
  function reset(){q.value='';sev.value='';conf.value='';st.value='open';comp.value='';cause='';apply();}
  [q,sev,conf,st,comp].forEach(function(el){el.addEventListener('input',function(){if(el!==q)cause='';apply();});});
  document.getElementById('f-reset').addEventListener('click',reset);
  var r2=document.getElementById('f-reset2'); if(r2)r2.addEventListener('click',reset);
  [].slice.call(document.querySelectorAll('button[data-cause]')).forEach(function(b){b.addEventListener('click',function(){cause=b.dataset.cause;q.value='';sev.value='';conf.value='';st.value='';comp.value='';apply();document.getElementById('h-findings').scrollIntoView();document.getElementById('q').focus({preventScroll:true});});});
  load(); apply();
})();`;

export function renderHtml(report) {
  const v = verdict(report);
  const s = report.summary;
  const strip = Object.keys(SEV).map(k => `<li><strong>${s.bySeverity[k] || 0}</strong>open ${esc(k)} <span class="sr-only">(${esc(SEV[k].word)})</span></li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0F172A">
<title>Nova doctor report</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#h-causes">Skip to the causes</a>
<div class="wrap">
<header>
  <p class="meta"><span>Scanned ${esc(report.machine)}, ${when(report.startedAt)}</span><span>${report.options.build ? 'Builds compiled' : 'Builds not compiled (add --build)'}; ${report.options.remote ? 'coordinator checked' : 'coordinator not checked (add --remote)'}</span></p>
  <h1 class="verdict">${esc(v.lead)}</h1>
  <p class="verdict-rest">${esc(v.rest)}</p>
  <ul class="strip" aria-label="Open findings by severity">${strip}<li><strong>${s.total}</strong>findings in all, including stale, not ours and known benign</li></ul>
</header>
<main>
${causesSection(report)}
${findingsSection(report)}
${coverageSection(report)}
${baselineSection(report)}
</main>
<footer><p>Confidence says how sure the doctor is that a finding is real; severity says how bad it would be. Severity runs from P0, which blocks play or hosting, to P3, which is minor. Stale means a finding was not seen in the most recent sessions: it may be fixed, or that code path may not have run.</p>
<p>Generated by <code translate="no">node doctor/nova-doctor.mjs</code>. Every quoted log line has been checked for tokens and secrets before being written here.</p></footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}
