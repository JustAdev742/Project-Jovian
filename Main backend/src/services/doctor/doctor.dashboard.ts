/**
 * The fleet dashboard: every reporting player, the problems they share, and their live problem
 * lines — plus a page per player with their latest doctor report.
 *
 * Same visual system as the doctor's own report (doctor/lib/render.mjs) and Nova's admin dashboard:
 * slate surfaces, the shared severity colours AND shapes, one verdict sentence written from the data.
 *
 * Everything shown comes from players' machines, so it is untrusted: server-side values go through
 * esc(), and rows added live by the polling script are built with textContent, never innerHTML.
 * The live list updates on its own, so it has a Pause control (WCAG 2.2.2) and is not an
 * announcing live region.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PlayerRow, LineRow } from './doctor.store';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const SEV: Record<string, { color: string; mark: string; word: string }> = {
  P0: { color: '#F87171', mark: '▲▲', word: 'blocks play or hosting' },
  P1: { color: '#FB923C', mark: '▲', word: 'serious' },
  P2: { color: '#FBBF24', mark: '■', word: 'degraded' },
  P3: { color: '#38BDF8', mark: '▪', word: 'minor' },
  INFO: { color: '#94A3B8', mark: '·', word: 'worth knowing' },
};
const sevBadge = (s: string) => {
  const v = SEV[s] || SEV.INFO;
  return `<span class="sev" style="--sev:${v.color}" title="${esc(`${s}: ${v.word}`)}"><span aria-hidden="true">${v.mark}</span> ${esc(s in SEV ? s : 'INFO')}</span>`;
};

/** "4 min ago", from an ISO string, relative to `now`. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return 'unknown';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const LIVE_WINDOW_MS = 2 * 60_000;
const isLive = (p: PlayerRow, now = Date.now()) => !!p.last_line_at && now - Date.parse(p.last_line_at) < LIVE_WINDOW_MS;
const when = (iso: string | null) => (iso ? `<time datetime="${esc(iso)}" title="${esc(iso.slice(0, 19).replace('T', ' '))} UTC">${esc(ago(iso))}</time>` : 'never');
/** Keeps every <time> phrase current while the page stays open (it is meant to). */
const RELATIVE_TIMES = `(function(){var f=window.Intl&&Intl.RelativeTimeFormat?new Intl.RelativeTimeFormat('en',{numeric:'auto',style:'short'}):null;
  function tick(){[].forEach.call(document.querySelectorAll('time[datetime]'),function(t){var s=Math.max(0,Math.round((Date.now()-Date.parse(t.getAttribute('datetime')))/1000));if(isNaN(s))return;
    t.textContent=s<60?'just now':!f?t.textContent:s<3600?f.format(-Math.round(s/60),'minute'):s<86400?f.format(-Math.round(s/3600),'hour'):f.format(-Math.round(s/86400),'day')})}
  function states(){[].forEach.call(document.querySelectorAll('[data-last-line]'),function(e){var t=Date.parse(e.getAttribute('data-last-line'));var live=!isNaN(t)&&Date.now()-t<${LIVE_WINDOW_MS};e.className='state '+(live?'state-live':'state-quiet');e.textContent=live?'Live':'Quiet'})}
  window.__novaMarkLive=function(acct,iso){[].forEach.call(document.querySelectorAll('tr[data-acct="'+(window.CSS&&CSS.escape?CSS.escape(acct):acct)+'"] [data-last-line]'),function(e){e.setAttribute('data-last-line',iso)});states()};
  setInterval(function(){tick();states()},30000);})();`;

const CSS = `
:root{--bg:#0F172A;--raised:#1B2336;--muted:#272F42;--fg:#F8FAFC;--body:#D5DEEA;--dim:#A3B1C6;--line:#3B4659;--control:#64748B;--focus:#38BDF8;--focus-hover:#7DD3FC;--ok:#4ADE80;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --mono:"Cascadia Mono","Cascadia Code",Consolas,ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 var(--sans)}
.wrap{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
a,button.link{color:var(--focus)}
a:hover,button.link:hover{color:var(--focus-hover)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:16px;top:-48px;background:var(--focus);color:var(--bg);padding:8px 12px;border-radius:6px;font-weight:600}
.skip:focus{top:12px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.meta{color:var(--dim);font-size:14px;margin:0 0 24px;display:flex;flex-wrap:wrap;gap:4px 20px}
.verdict{font-size:clamp(22px,3vw + 8px,36px);line-height:1.2;font-weight:600;letter-spacing:-.01em;max-width:34ch;margin:0 0 12px;text-wrap:balance;overflow-wrap:break-word}
.lede{margin:0 0 20px}
.strip{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 36px;padding:0;list-style:none;font-size:15px;color:var(--dim)}
.strip strong{color:var(--fg);font-size:18px;margin-right:6px;font-variant-numeric:tabular-nums}
h2{font-size:22px;line-height:1.3;margin:44px 0 14px;text-wrap:balance}
h3{font-size:17px;margin:20px 0 8px;text-wrap:balance}
p{margin:0 0 10px;max-width:78ch;overflow-wrap:break-word}
.dim{color:var(--dim)}
code{font-family:var(--mono);font-size:13px}
.sev{display:inline-flex;align-items:center;gap:5px;color:var(--sev);font-weight:600;font-size:14px;white-space:nowrap}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:15px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
thead th{font-size:14px;font-weight:600;color:var(--dim);background:var(--raised)}
tbody tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
td a{display:inline-block;padding:3px 0;min-height:24px}
.state{white-space:nowrap;font-size:14px}
.who-has{display:block;margin-top:2px;font-size:14px;color:var(--dim)}
.who-has a{display:inline;padding:0;min-height:0}
.state-live{color:var(--ok);font-weight:600}
.state-live::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ok);margin-right:6px}
.state-quiet{color:var(--dim)}
.controls{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;margin:0 0 10px}
.controls label{display:flex;flex-direction:column;gap:4px;font-size:14px;color:var(--dim)}
.controls select{font:inherit;font-size:15px;color:var(--fg);background:var(--raised);border:1px solid var(--control);border-radius:6px;padding:7px 10px;min-height:40px}
.controls select:hover{border-color:#94A3B8}
.controls select option{background:var(--raised);color:var(--fg)}
button.toggle{font:inherit;font-size:15px;color:var(--fg);background:var(--raised);border:1px solid var(--control);border-radius:6px;padding:7px 14px;min-height:40px;cursor:pointer}
button.toggle[aria-pressed="true"]{background:var(--muted);border-color:var(--focus)}
button.toggle:hover{border-color:#94A3B8}
button.link{background:none;border:0;padding:6px 0;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.status{color:var(--dim);font-size:14px;margin:0 0 8px}
.log{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:8px;max-height:560px;overflow:auto}
.log li{content-visibility:auto;contain-intrinsic-size:auto 64px;display:grid;grid-template-columns:minmax(0,auto) auto minmax(0,1fr);gap:4px 14px;padding:8px 12px;border-bottom:1px solid var(--line);align-items:baseline}
.log li:last-child{border-bottom:0}
.log .who{font-size:14px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:28ch}
.log .src{font-size:13px;color:var(--dim)}
.log .text{grid-column:1 / -1;font-family:var(--mono);font-size:13px;color:var(--body);white-space:pre-wrap;overflow-wrap:anywhere}
.log .empty{display:block;color:var(--dim)}
form.signin{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:12px}
form.signin label{display:flex;flex-direction:column;gap:4px;font-size:14px;color:var(--dim)}
form.signin input{font:inherit;color:var(--fg);background:var(--raised);border:1px solid var(--control);border-radius:6px;padding:8px 10px;min-height:40px;min-width:260px}
form.signin button{font:inherit;font-weight:600;color:var(--bg);background:var(--focus);border:0;border-radius:6px;padding:8px 16px;min-height:40px;cursor:pointer}
form.signin button:hover{background:var(--focus-hover)}
.alert{color:#F87171;margin:8px 0 0}
.causes{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.causes li{padding:12px 16px;background:var(--raised);border-left:4px solid var(--sev);border-radius:0 8px 8px 0;overflow-wrap:anywhere}
button,select,a{touch-action:manipulation;-webkit-tap-highlight-color:rgba(56,189,248,.25)}
@media (max-width:720px){.wrap{padding:20px 16px 48px}.hide-sm{display:none}}
`;

function page(title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="theme-color" content="#0F172A"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to the content</a><div class="wrap">${body}</div>${script ? `<script>${script}</script>` : ''}</body></html>`;
}

function lineItem(l: LineRow, showWho: boolean): string {
  return `<li data-id="${l.id}" data-sev="${esc(l.sev)}" data-acct="${esc(l.account_id)}">${showWho ? `<span class="who" translate="no">${esc(l.display_name || l.account_id.slice(0, 8))}</span>` : ''}${sevBadge(l.sev)}<span class="src">${esc(l.src)} · ${esc((l.received_at || '').slice(11, 19))} UTC${l.rule ? ` · <span translate="no">${esc(l.rule)}</span>` : ''}</span><span class="text" translate="no">${esc(l.text)}</span></li>`;
}

/** The polling script for a live list. Rows are built with textContent only. */
function liveScript(opts: { account?: string; showWho: boolean }): string {
  return `
(function(){
  var list=document.getElementById('log'),status=document.getElementById('log-status'),pause=document.getElementById('pause');
  var who=document.getElementById('f-player'),sev=document.getElementById('f-sev');
  var paused=false,since=0;
  [].forEach.call(list.querySelectorAll('li[data-id]'),function(li){since=Math.max(since,+li.dataset.id)});
  var SEV={P0:['#F87171','\\u25B2\\u25B2'],P1:['#FB923C','\\u25B2'],P2:['#FBBF24','\\u25A0'],P3:['#38BDF8','\\u25AA'],INFO:['#94A3B8','\\u00B7']};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function row(l){
    var li=el('li');li.dataset.id=l.id;li.dataset.sev=l.sev;li.dataset.acct=l.account_id;
    ${opts.showWho ? "var w=el('span','who',l.display_name||String(l.account_id).slice(0,8));w.setAttribute('translate','no');li.appendChild(w);" : ''}
    var s=SEV[l.sev]||SEV.INFO,b=el('span','sev');b.style.setProperty('--sev',s[0]);var m=el('span',null,s[1]);m.setAttribute('aria-hidden','true');b.appendChild(m);b.appendChild(document.createTextNode(' '+(SEV[l.sev]?l.sev:'INFO')));li.appendChild(b);
    li.appendChild(el('span','src',l.src+' \\u00B7 '+String(l.received_at||'').slice(11,19)+' UTC'+(l.rule?' \\u00B7 '+l.rule:'')));
    var t=el('span','text',l.text);t.setAttribute('translate','no');li.appendChild(t);
    return li;
  }
  function visible(li){return (!who||!who.value||li.dataset.acct===who.value)&&(!sev||!sev.value||li.dataset.sev===sev.value)}
  function refilter(){var n=0;[].forEach.call(list.querySelectorAll('li[data-id]'),function(li){li.hidden=!visible(li);if(!li.hidden)n++});var e=document.getElementById('log-empty'),any=list.querySelector('li[data-id]');if(e){e.hidden=n>0;e.textContent=any?'No lines match these filters.':'No problem lines yet. They appear here while players are in a game.'}}
  function save(){var p=new URLSearchParams();if(who&&who.value)p.set('player',who.value);if(sev&&sev.value)p.set('sev',sev.value);var h=p.toString();history.replaceState(null,'',h?'#'+h:location.pathname+location.search)}
  (function load(){var p=new URLSearchParams(location.hash.slice(1));if(who&&p.get('player'))who.value=p.get('player');if(sev&&p.get('sev'))sev.value=p.get('sev');refilter()})();
  if(who)who.addEventListener('input',function(){refilter();save()});if(sev)sev.addEventListener('input',function(){refilter();save()});
  pause.addEventListener('click',function(){paused=!paused;pause.setAttribute('aria-pressed',String(paused));pause.textContent=paused?'Resume live updates':'Pause live updates';status.textContent=paused?'Live updates paused.':'Live: checking for new lines every 10 seconds.'});
  function poll(){
    if(paused||document.hidden)return;
    fetch('/nova/api/doctor/lines.json?since='+since${opts.account ? `+'&account='+encodeURIComponent(${JSON.stringify(opts.account).replace(/</g, '\\u003c')})` : ''},{credentials:'same-origin'}).then(function(r){return r.ok?r.json():null}).then(function(j){
      if(!j||!j.lines||!j.lines.length)return;
      var fresh=[];
      j.lines.forEach(function(l){since=Math.max(since,l.id);var li=row(l);li.hidden=!visible(li);list.insertBefore(li,list.firstChild);
        if(window.__novaMarkLive)window.__novaMarkLive(l.account_id,l.received_at);
        if(who&&![].some.call(who.options,function(o){return o.value===l.account_id})){var o=document.createElement('option');o.value=l.account_id;o.textContent=l.display_name||String(l.account_id).slice(0,8);who.appendChild(o);fresh.push(o.textContent)}});
      while(list.children.length>300)list.removeChild(list.lastChild);
      refilter();
      status.textContent=j.lines.length+' new line'+(j.lines.length===1?'':'s')+' at '+new Date().toLocaleTimeString()+'.'+(fresh.length?' New player'+(fresh.length===1?'':'s')+': '+fresh.join(', ')+'. Reload to add them to the table.':'');
    }).catch(function(){status.textContent='Can’t reach the server. Retrying in 10 seconds.'});
  }
  setInterval(poll,10000);
})();`;
}

function liveSection(lines: LineRow[], opts: { players?: PlayerRow[]; account?: string; heading: string }): string {
  const showWho = !opts.account;
  const items = [...lines].reverse().map(l => lineItem(l, showWho)).join('');
  const playerFilter = showWho && opts.players?.length
    ? `<label>Player <select id="f-player"><option value="">All players</option>${opts.players.map(p => `<option value="${esc(p.account_id)}">${esc(p.display_name)}</option>`).join('')}</select></label>` : '';
  return `<section aria-labelledby="h-live"><h2 id="h-live">${esc(opts.heading)}</h2>
  <p class="dim">Launchers send problems only: catalog matches, engine errors, and warnings from the parts of the game Nova controls. Before sending, the player’s launcher removes tokens, partly masks IP addresses and replaces the PC’s name with a code.</p>
  <div class="controls">${playerFilter}
    <label>Severity <select id="f-sev"><option value="">All</option>${Object.keys(SEV).map(s => `<option value="${s}">${s}</option>`).join('')}</select></label>
    <button type="button" class="toggle" id="pause" aria-pressed="false">Pause live updates</button></div>
  <p id="log-status" class="status" role="status">Live: checking for new lines every 10 seconds.</p>
  <ol id="log" class="log" aria-live="off" aria-label="Live problem lines, newest first">${items}<li id="log-empty" class="empty"${items ? ' hidden' : ''}>No problem lines yet. They appear here while players are in a game.</li></ol>
  </section>`;
}

export function renderFleetPage(d: { players: PlayerRow[]; problems: ReturnType<typeof import('./doctor.store').fleetProblems>; lines: LineRow[] }): string {
  const now = Date.now();
  const live = d.players.filter(p => isLive(p, now)).length;
  const blocked = d.players.filter(p => p.p0 > 0);
  const top = d.problems.find(p => p.severity !== 'INFO');
  const versions = Object.entries(d.players.reduce<Record<string, number>>((a, p) => { const v = p.launcher_version || 'unknown'; a[v] = (a[v] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} (${n})`).join(', ');
  const verdict = !d.players.length
    ? 'No player has reported yet. Reports arrive from launchers 1.9.4 and later.'
    : `${d.players.length} player${d.players.length === 1 ? '' : 's'} reporting. ${blocked.length ? `${blocked.length} ${blocked.length === 1 ? 'has a problem that blocks' : 'have problems that block'} play or hosting.` : 'Nobody is blocked.'}`;
  const commonest = top ? `Most common: ${top.title} (${top.players} ${top.players === 1 ? 'player' : 'players'}).` : '';

  const playerRows = d.players.map(p => `<tr data-acct="${esc(p.account_id)}">
    <td><a href="/nova/api/doctor/players/${esc(p.account_id)}" translate="no">${esc(p.display_name)}</a></td>
    <td><span class="state ${isLive(p, now) ? 'state-live' : 'state-quiet'}" data-last-line="${esc(p.last_line_at || '')}">${isLive(p, now) ? 'Live' : 'Quiet'}</span></td>
    <td class="num">${p.p0 ? `<span class="sev" style="--sev:${SEV.P0.color}"><span aria-hidden="true">${SEV.P0.mark}</span> ${p.p0}</span>` : '0'}</td>
    <td class="num">${p.p1}</td>
    <td class="num hide-sm">${p.open_total}</td>
    <td class="hide-sm">${esc(p.launcher_version || '—')}</td>
    <td class="state">${when(p.last_seen)}</td></tr>`).join('');
  const whoLine = (p: { players: number; who?: { id: string; name: string }[] }) => {
    const w = p.who || [];
    const shown = w.slice(0, 5).map(x => `<a href="/nova/api/doctor/players/${esc(x.id)}" translate="no">${esc(x.name)}</a>`).join(', ');
    return shown ? `<span class="who-has">${shown}${p.players > 5 ? ` and ${p.players - 5} more` : ''}</span>` : '';
  };
  const problemRows = d.problems.slice(0, 80).map(p => `<tr><td>${sevBadge(p.severity)}</td><td>${esc(p.title)}${whoLine(p)}</td><td class="num">${p.players}</td><td class="num hide-sm">${p.occurrences}</td></tr>`).join('');

  const body = `<header><p class="meta"><span>Nova fleet doctor</span><span>Generated ${esc(new Date(now).toISOString().slice(0, 16).replace('T', ' '))} UTC</span><a href="/nova/api/dashboard">Server incidents dashboard</a></p>
  <h1 class="verdict">${esc(verdict)}</h1>
  ${commonest ? `<p class="dim lede">${esc(commonest)}</p>` : ''}
  <ul class="strip" aria-label="Fleet at a glance"><li><strong>${d.players.length}</strong>${d.players.length === 1 ? 'player' : 'players'} reporting</li><li><strong>${live}</strong>live now</li><li><strong>${blocked.length}</strong>with a blocking problem</li><li><span>Launcher versions: ${esc(versions || 'none yet')}</span></li></ul></header>
  <main id="main">
  <section aria-labelledby="h-players"><h2 id="h-players">Players</h2>
  ${d.players.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Players table, scrolls sideways on narrow screens"><table><caption class="sr-only">Every reporting player, most recently seen first</caption>
  <thead><tr><th scope="col">Player</th><th scope="col">Now</th><th scope="col" class="num">P0</th><th scope="col" class="num">P1</th><th scope="col" class="num hide-sm">Open</th><th scope="col" class="hide-sm">Launcher</th><th scope="col">Last seen</th></tr></thead>
  <tbody>${playerRows}</tbody></table></div>` : '<p class="dim">No players yet. A player appears after their launcher sends its first report or problem line.</p>'}</section>
  <section aria-labelledby="h-problems"><h2 id="h-problems">Problems across players</h2>
  <p class="dim">From each player’s latest doctor report. When several players share a problem, look for its cause on the server side first.</p>
  ${d.problems.length ? `<div class="table-wrap" tabindex="0" role="region" aria-label="Problems table, scrolls sideways on narrow screens"><table><caption class="sr-only">Open problems, most severe and most widespread first</caption>
  <thead><tr><th scope="col">Severity</th><th scope="col">Problem</th><th scope="col" class="num">Players</th><th scope="col" class="num hide-sm">Occurrences</th></tr></thead><tbody>${problemRows}</tbody></table></div>` : '<p class="dim">No reports yet. A launcher sends its first one about 90 seconds after it starts, once no game is running.</p>'}</section>
  ${liveSection(d.lines, { players: d.players, heading: 'Live problem lines, all players' })}
  </main>`;
  return page('Nova fleet doctor', body, liveScript({ showWho: true }) + RELATIVE_TIMES);
}

export function renderPlayerPage(d: { player: PlayerRow; report: { receivedAt: string; summary: any; full: any | null } | null; lines: LineRow[] }): string {
  const p = d.player;
  const s = d.report?.summary;
  const causes = (s?.causes || []).map((c: any) => `<li style="--sev:${(SEV[c.severity] || SEV.INFO).color}">${sevBadge(c.severity)} <span class="dim">${esc(String(c.confidence).toLowerCase())}</span><h3>${esc(c.title)}</h3><p class="dim">${c.findings} linked finding${c.findings === 1 ? '' : 's'}</p></li>`).join('');
  const top = (s?.top || []).slice(0, 40).map((f: any) => `<tr><td>${sevBadge(f.severity)}</td><td>${esc(f.title)}</td><td class="hide-sm">${esc(f.component)}</td><td class="num">${f.count}</td></tr>`).join('');
  const body = `<header><p class="meta"><a href="/nova/api/doctor/dashboard">All players</a><span>Launcher ${esc(p.launcher_version || 'unknown')}</span>${p.machine ? `<span title="A hash of the PC’s name. The name itself never leaves the player’s PC." translate="no">${esc(p.machine)}</span>` : '<span>PC unknown</span>'}<span>Last report ${when(p.last_report_at)}</span><span>Last live line ${when(p.last_line_at)}</span></p>
  <h1 class="verdict">${esc(p.display_name)}: ${esc(s?.verdict?.lead || 'no doctor report yet.')}</h1>
  ${s?.verdict?.rest ? `<p class="dim">${esc(s.verdict.rest)}</p>` : ''}
  ${d.report?.full ? `<p><a href="/nova/api/doctor/players/${esc(p.account_id)}/report.html" target="_blank" rel="noopener">Open ${esc(p.display_name)}’s full doctor report</a> <span class="dim">(opens in a new tab)</span></p>` : ''}
  </header><main id="main">
  ${causes ? `<section aria-labelledby="h-causes"><h2 id="h-causes">Causes on this PC</h2><ol class="causes">${causes}</ol></section>` : ''}
  ${top ? `<section aria-labelledby="h-top"><h2 id="h-top">Open findings</h2><div class="table-wrap" tabindex="0" role="region" aria-label="Open findings table, scrolls sideways on narrow screens"><table><caption class="sr-only">Open findings on this player’s PC, most urgent first</caption><thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col" class="hide-sm">Component</th><th scope="col" class="num">Count</th></tr></thead><tbody>${top}</tbody></table></div></section>` : ''}
  ${liveSection(d.lines, { account: p.account_id, heading: `Live problem lines from ${p.display_name}` })}
  </main>`;
  return page(`${p.display_name} · Nova fleet doctor`, body, liveScript({ account: p.account_id, showWho: false }) + RELATIVE_TIMES);
}

export function renderLockedPage(next: string, message?: string): string {
  const body = `<main id="main"><h1 class="verdict">Sign in to see the fleet doctor</h1>
  <p class="dim">${esc(message || 'This page shows every player’s problems, so it needs the admin secret (NOVA_AC_ADMIN_SECRET on the coordinator).')}</p>
  <form class="signin" method="post" action="/nova/api/dashboard/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="secret">Admin secret <input id="secret" name="secret" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button></form>
  <p id="denied" class="alert" role="alert" hidden>The server rejected that secret. Copy NOVA_AC_ADMIN_SECRET from the coordinator again and paste it without spaces.</p></main>`;
  return page('Sign in · Nova fleet doctor', body, `if(/[?&]denied=1/.test(location.search))document.getElementById('denied').hidden=false;`);
}

// ── the full report, rendered with the doctor's own renderer ─────────────────────────────────────

let renderHtml: ((r: any) => string) | null | undefined;
/** Native ESM import that survives TypeScript's CommonJS output (which would turn import() into require()). */
const importEsm = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

async function loadRenderer(): Promise<((r: any) => string) | null> {
  if (renderHtml !== undefined) return renderHtml;
  const candidates = [
    process.env.NOVA_DOCTOR_LIB && path.join(process.env.NOVA_DOCTOR_LIB, 'render.mjs'),
    path.resolve(__dirname, '../../../doctor/lib/render.mjs'),     // ~/nova-backend/doctor (coordinator)
    path.resolve(__dirname, '../../../../doctor/lib/render.mjs'),  // repo/doctor (dev tree)
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try { renderHtml = (await importEsm(pathToFileURL(c).href)).renderHtml; return renderHtml ?? null; } catch { /* try the next */ }
  }
  renderHtml = null;
  return null;
}

export async function renderPlayerReport(full: any): Promise<string> {
  const r = await loadRenderer();
  if (r) {
    try { return r(full); } catch { /* fall through to the plain view */ }
  }
  return page('Doctor report', `<main id="main"><h1 class="verdict">Doctor report</h1><p class="dim">The doctor renderer is not installed on this server, so this is the raw report.</p><pre class="dim" translate="no">${esc(JSON.stringify(full, null, 2))}</pre></main>`);
}
