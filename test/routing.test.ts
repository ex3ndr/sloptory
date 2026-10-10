import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect, moveMachine, removeMachine } from '../src/engine/ops.ts';
import { beltValid, isAdjacent, routeBelt } from '../src/engine/routing.ts';
import { run } from '../src/engine/sim.ts';
import { machineIndex, occupancy, rectOf } from '../src/engine/world.ts';
import { fresh, link, place, seconds } from './helpers.ts';

function assertPathSound(s: ReturnType<typeof fresh>, path: number[], fromId: string, toId: string): void {
  const grid = occupancy(s);
  const idx = machineIndex(s);
  for (let i = 0; i < path.length; i += 2) {
    assert.equal(grid[path[i + 1] * s.width + path[i]], 0, `tile ${path[i]},${path[i + 1]} is inside a machine`);
    if (i > 0) assert.equal(Math.abs(path[i] - path[i - 2]) + Math.abs(path[i + 1] - path[i - 1]), 1, 'steps are orthogonal');
  }
  assert.ok(isAdjacent(path[0], path[1], rectOf(idx.get(fromId)!)));
  assert.ok(isAdjacent(path[path.length - 2], path[path.length - 1], rectOf(idx.get(toId)!)));
}

test('straight route between neighbours is the gap between them', () => {
  const s = fresh();
  const a = place(s, 'qa', 5, 5);
  const b = place(s, 'qa', 9, 5);
  const path = routeBelt(s, a, b)!;
  assert.deepEqual(path, [7, 5, 8, 5]);
});

test('routes go around machines in the way', () => {
  const s = fresh();
  const a = place(s, 'qa', 2, 10);
  const wall = place(s, 'warehouse', 6, 8); // 4x4 block between them
  const b = place(s, 'qa', 12, 10);
  const path = routeBelt(s, a, b)!;
  assert.ok(path, 'found a route');
  assertPathSound(s, path, a.id, b.id);
  assert.ok(path.length / 2 > 8, 'detours around the warehouse');
  void wall;
});

test('enclosed machines cannot be reached', () => {
  const s = fresh();
  const a = place(s, 'qa', 20, 20);
  // b sits in the floor corner; its only free sides are blocked by two machines.
  const b = place(s, 'qa', 0, 0);
  place(s, 'warehouse', 2, 0);
  place(s, 'qa', 0, 2);
  const r = connect(s, a.id, b.id);
  assert.equal(r.ok, false);
  assert.match(r.message, /No free route/);
  assert.equal(s.belts.length, 0);
});

test('placing a machine on a belt re-routes it; moving machines re-routes too', () => {
  const s = fresh();
  const a = place(s, 'qa', 5, 5);
  const b = place(s, 'qa', 15, 5);
  link(s, a, b);
  const belt = s.belts[0];
  assert.equal(belt.path.length / 2, 8);
  place(s, 'kiln', 9, 4); // sits right on the straight run
  assertPathSound(s, belt.path, a.id, b.id);
  assert.ok(belt.path.length / 2 > 8);
  const mv = moveMachine(s, b.id, 30, 20);
  assert.ok(mv.ok, mv.message);
  assertPathSound(s, belt.path, a.id, b.id);
  assert.ok(beltValid(s, belt, occupancy(s), machineIndex(s)));
});

test('items travel along a belt and arrive in the next machine', () => {
  const s = fresh();
  const caster = place(s, 'slip_caster', 5, 5);
  const kiln = place(s, 'kiln', 14, 5, 'bisque_fire');
  link(s, caster, kiln);
  caster.input.clay = 30;
  run(s, seconds(5.5));
  assert.equal(caster.output.greenware_mug ?? 0, 0, 'outputs leave on the belt');
  assert.equal(s.belts[0].items.length, 2, 'items are in transit');
  run(s, seconds(25));
  assert.ok(kiln.cycles > 0 || kiln.running, 'the kiln received a batch of greenware');
  // Items on a belt keep their spacing.
  const items = s.belts[0].items;
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].pos - items[i].pos >= 0.5 - 1e-9);
});

test('removing a machine removes its belts and returns items to stock', () => {
  const s = fresh();
  const dock = place(s, 'receiving_dock', 2, 2);
  const caster = place(s, 'slip_caster', 10, 2);
  link(s, dock, caster);
  s.stock.clay = 50;
  run(s, 10);
  const inFlight = s.belts[0].items.length + (caster.input.clay ?? 0);
  assert.ok(inFlight > 0);
  removeMachine(s, caster.id);
  assert.equal(s.belts.length, 0);
  assert.equal(s.stock.clay, 50, 'nothing is lost');
});
