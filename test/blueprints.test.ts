import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLUEPRINTS, buildBlueprint } from '../src/engine/blueprints.ts';
import { neededSupplies } from '../src/engine/economy.ts';
import { run } from '../src/engine/sim.ts';
import { fresh, seconds } from './helpers.ts';

for (const bp of BLUEPRINTS) {
  test(`${bp.name} blueprint builds a connected line that ships ${bp.product}`, () => {
    const s = fresh();
    s.cash = 2_000_000;
    const r = buildBlueprint(s, bp.id);
    assert.ok(r.ok, r.message);
    assert.equal(s.machines.length, bp.parts.length);
    assert.equal(s.belts.length, bp.links.length);
    for (const b of s.belts) assert.ok(b.path.length > 0, `${b.from} -> ${b.to} routed`);
    for (const it of neededSupplies(s)) s.stock[it] = 120;
    run(s, seconds(240));
    assert.ok((s.stats.shipped[bp.product] ?? 0) >= 5, `shipped ${s.stats.shipped[bp.product] ?? 0} ${bp.product}`);
    assert.ok(s.stats.revenue > 0);
  });
}

test('all four blueprints fit on one floor without overlapping', () => {
  const s = fresh();
  s.cash = 5_000_000;
  for (const bp of BLUEPRINTS) assert.ok(buildBlueprint(s, bp.id).ok);
  assert.equal(s.lines.length, 4);
  assert.ok(s.belts.every((b) => b.path.length > 0));
});

test('blueprints refuse when cash is short or the requested area is taken', () => {
  const s = fresh();
  s.cash = 1000;
  assert.equal(buildBlueprint(s, 'mug').ok, false);
  s.cash = 2_000_000;
  assert.ok(buildBlueprint(s, 'mug', { x: 5, y: 5 }).ok);
  const again = buildBlueprint(s, 'mug', { x: 5, y: 5 });
  assert.equal(again.ok, false);
  assert.match(again.message, /clear/);
});
