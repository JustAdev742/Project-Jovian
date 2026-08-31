/**
 * Regression tests for the latent client-endpoint routes.
 *
 * These are static-source tests on purpose. The failure they guard against happened for real while
 * this module was being written: `/fortnite/api/stats/accountId/:accountId/bulk/window/:windowId`
 * was added here even though compat.routes.ts already declared the same shape with a differently
 * NAMED parameter (`:window`). Fastify treats those as one route and throws
 * FST_ERR_DUPLICATED_ROUTE at startup — which means the whole backend fails to bind, not just that
 * endpoint. A string comparison does not catch it; a shape comparison does.
 *
 * Run: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..', '..');
const LATENT = path.join(SRC, 'services', 'compat', 'latent.routes.ts');

/** Every `fastify.<method>('<path>'` declaration in a file, as [method, path] pairs. */
function declarationsIn(file: string): Array<[string, string]> {
  const text = fs.readFileSync(file, 'utf8');
  const out: Array<[string, string]> = [];
  const re = /fastify\.(get|post|put|delete|patch)\s*(?:<[^>]*>)?\s*\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m[1], m[2]]);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

/** Fastify identifies a route by its SHAPE — parameter names are not part of it. */
function shape(method: string, route: string): string {
  return `${method} ${route.replace(/:[A-Za-z0-9_]+/g, ':@')}`;
}

describe('latent routes — must not collide with any existing route', () => {
  test('no route shape is declared both here and elsewhere', () => {
    const others = walk(SRC)
      .filter((f) => f !== LATENT)
      .flatMap((f) => declarationsIn(f).map(([m, r]) => shape(m, r)));
    const otherSet = new Set(others);

    const collisions = declarationsIn(LATENT)
      .map(([m, r]) => shape(m, r))
      .filter((s) => otherSet.has(s));

    assert.deepEqual(
      collisions,
      [],
      `these shapes are already declared elsewhere and would throw FST_ERR_DUPLICATED_ROUTE at startup:\n  ${collisions.join('\n  ')}`,
    );
  });

  test('declares no duplicate shape within itself', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const [m, r] of declarationsIn(LATENT)) {
      const s = shape(m, r);
      if (seen.has(s)) dupes.push(s);
      seen.add(s);
    }
    assert.deepEqual(dupes, []);
  });

  test('the stats bulk/window route specifically stays OUT of this file', () => {
    // The exact regression. compat.routes.ts owns it and implements it better — it seeds and
    // returns real player stats, where the reference backend returns an empty object.
    const here = declarationsIn(LATENT).map(([, r]) => r);
    assert.ok(
      !here.some((r) => r.includes('/bulk/window/')),
      'stats bulk/window belongs to compat.routes.ts; re-adding it here breaks startup',
    );
  });
});

describe('latent routes — parametric service prefixes stay narrow', () => {
  test('no route is a bare catch-all that could swallow real traffic', () => {
    for (const [method, route] of declarationsIn(LATENT)) {
      assert.notEqual(route, '/*', `${method} ${route} would swallow everything`);
      assert.notEqual(route, '/:service/*', `${method} ${route} is too broad`);
      // Every parametric-prefix route must still pin at least two literal segments after it, so it
      // can only match the specific endpoint it was written for.
      if (route.startsWith('/:service/')) {
        const literals = route.split('/').slice(2).filter((s) => s && !s.startsWith(':') && s !== '*');
        assert.ok(
          literals.length >= 2,
          `${method} ${route} pins only ${literals.length} literal segment(s) after the service prefix — too broad`,
        );
      }
    }
  });
});
