#!/usr/bin/env node
/**
 * Does the backend answer each observed endpoint with the METHOD the client uses?
 *
 * WHY. VERSION_COMPATIBILITY.md §2 concludes "34 distinct endpoint families. Every one of them is
 * routed. Zero unrouted." That was established by matching normalised **paths** against registered
 * routes. A route registered POST-only therefore counted as "routed" even if the client sends GET.
 *
 * `reserveGeneralChatRooms` was exactly that: registered POST-only, 81 calls a session, and it
 * 404ed. Found by driving the session flow, not by the table — because the table cannot see it.
 *
 * A CAVEAT THAT APPLIES TO EVERY RESULT HERE: the methods in that table are **inferred**. Their only
 * source is `cobalt.log`, which records `curl_easy_setopt(CURLOPT_URL, ...)` — the URL, never the
 * verb. So a mismatch reported below means "the table's assumed method is not registered", which is
 * a prompt to check, not proof of a bug. Absence of a mismatch is the stronger direction.
 *
 * USAGE
 *   node tools/method-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'VERSION_COMPATIBILITY.md');
const SRC = path.join(ROOT, 'Main backend', 'src');

/** Rows of the §2 table: `| 9 | \`GET /path\` | 81 | ... |` */
function observedRows() {
  const md = fs.readFileSync(DOC, 'utf8');
  const start = md.indexOf('## 2. The complete 7.40 HTTP surface');
  const end = md.indexOf('## 2a.', start);
  const out = [];
  for (const line of md.slice(start, end).split(/\r?\n/)) {
    const m = /^\|\s*\d+\s*\|\s*`(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`\s*\|\s*(\d+)/.exec(line);
    if (m) out.push({ method: m[1], path: m[2].trim(), calls: Number(m[3]) });
  }
  return out;
}

/** Every route the backend registers, as {method, path}. */
function registeredRoutes() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.ts') || e.name.endsWith('.test.ts')) continue;
      const src = fs.readFileSync(p, 'utf8');

      // fastify.get('/x', ...) / fastify.post(...) etc.
      for (const m of src.matchAll(/fastify\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g)) {
        out.push({ method: m[1].toUpperCase(), path: m[2] });
      }
      // fastify.route({ method: [...] | '...', url: '...', handler ... })
      //
      // Scanned forward from the call rather than to a matching brace: the handler body lives inside
      // the same object, so a lazy `{...}` match stops at the first inner brace and a capped window
      // misses `url:` entirely once a handler is more than a few lines. That is not hypothetical —
      // it silently dropped reserveGeneralChatRooms the moment it was converted to this form, and
      // the audit then reported the very route it had just been used to fix as UNROUTED.
      for (const m of src.matchAll(/fastify\.route\(\{/g)) {
        const head = src.slice(m.index, m.index + 4000);
        const um = /\burl:\s*['"`]([^'"`]+)['"`]/.exec(head);
        const mm = /\bmethod:\s*(\[[^\]]*\]|['"`][A-Za-z]+['"`])/.exec(head);
        if (!um || !mm) continue;
        for (const v of mm[1].matchAll(/[A-Za-z]+/g)) out.push({ method: v[0].toUpperCase(), path: um[1] });
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Split a path into segments, marking which are wildcards.
 *
 * The two sides are NOT symmetric, and assuming they were produced ten false "UNROUTED" lines on the
 * first run: the observed table prints CONCRETE paths (`/client/QueryProfile`,
 * `/cloudstorage/system/DefaultGame.ini`, `/versioncheck/Windows`) while the backend registers
 * PARAMETERISED ones (`/client/:operation`, `/system/:filename`, `/versioncheck/:platform`).
 * Normalising both to `*` cannot match a literal against a parameter, so every parameterised route
 * looked unrouted — including QueryProfile, the single busiest endpoint there is, which the session
 * probe had just driven successfully. A wildcard in the ROUTE has to match a literal in the TABLE.
 */
const segments = (p) => p.replace(/\/+$/, '').split('/').filter(Boolean);
const isWild = (s) => s.startsWith(':') || (s.startsWith('{') && s.endsWith('}'));

/** Does a registered route match an observed path? Route wildcards match any single segment. */
function routeMatches(routePath, observedPath) {
  const r = segments(routePath);
  const o = segments(observedPath);
  if (r.length !== o.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (isWild(r[i]) || isWild(o[i])) continue;
    if (r[i] !== o[i]) return false;
  }
  return true;
}

const rows = observedRows();
const routes = registeredRoutes();

console.log(`${rows.length} observed endpoint families · ${routes.length} registered route definitions\n`);

let mismatched = 0;
let unrouted = 0;
for (const row of rows.sort((a, b) => b.calls - a.calls)) {
  const matching = routes.filter((r) => routeMatches(r.path, row.path));
  const have = matching.length ? new Set(matching.map((r) => r.method)) : null;
  if (!have) {
    console.log(`  UNROUTED   ${String(row.calls).padStart(4)}  ${row.method.padEnd(6)} ${row.path}`);
    unrouted++;
  } else if (!have.has(row.method)) {
    console.log(
      `  METHOD     ${String(row.calls).padStart(4)}  table says ${row.method.padEnd(6)} but only ` +
        `${[...have].join('/')} is registered   ${row.path}`,
    );
    mismatched++;
  }
}

if (!mismatched && !unrouted) console.log('  every observed family is routed AND answers the assumed method.');
console.log(`\n${rows.length - mismatched - unrouted}/${rows.length} clean · ${mismatched} method mismatch · ${unrouted} unrouted`);
if (mismatched) {
  console.log('\nA METHOD line is a prompt, not a verdict: the table\'s methods are inferred, because');
  console.log('cobalt.log records URLs and not verbs. Check the handler before changing anything.');
}
process.exit(unrouted ? 1 : 0);
