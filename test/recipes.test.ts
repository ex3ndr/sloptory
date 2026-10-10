import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINES, RECIPES, RECIPE_LIST, ITEMS } from '../src/engine/catalog.ts';
import { run } from '../src/engine/sim.ts';
import { fresh, place, seconds } from './helpers.ts';

test('catalog is consistent: every recipe references known items and its machine', () => {
  for (const r of RECIPE_LIST) {
    assert.ok(MACHINES[r.machine], `${r.id} machine`);
    assert.ok(MACHINES[r.machine].recipes.includes(r.id), `${r.id} listed on machine`);
    for (const it of [...Object.keys(r.inputs), ...Object.keys(r.outputs)]) assert.ok(ITEMS[it], `${r.id} item ${it}`);
    assert.ok(r.time > 0);
  }
});

test('every product chain bottoms out in buyable items', () => {
  const makers = new Map<string, string[]>();
  for (const r of RECIPE_LIST) for (const out of Object.keys(r.outputs)) makers.set(out, [...(makers.get(out) ?? []), r.id]);
  const seen = new Set<string>();
  const check = (item: string) => {
    if (seen.has(item)) return;
    seen.add(item);
    const def = ITEMS[item];
    if (def.kind === 'raw' || def.kind === 'component') return;
    const rs = makers.get(item);
    assert.ok(rs && rs.length > 0, `nothing makes ${item}`);
    for (const inp of Object.keys(RECIPES[rs[0]].inputs)) check(inp);
  };
  for (const p of ['mug_boxed', 'kettle_boxed', 'watch_boxed', 'phone_boxed']) check(p);
});

test('a machine consumes inputs and produces outputs after its cycle time', () => {
  const s = fresh();
  const caster = place(s, 'slip_caster', 5, 5);
  assert.equal(caster.recipe, 'cast_mugs', 'single-recipe machines auto-select');
  caster.input.clay = 6;
  run(s, 1);
  assert.equal(caster.status, 'working');
  assert.equal(caster.input.clay, 3, 'inputs are consumed when the cycle starts');
  run(s, seconds(RECIPES.cast_mugs.time) - 1);
  assert.equal(caster.output.greenware_mug, 2);
  assert.equal(s.stats.produced.greenware_mug, 2);
  run(s, seconds(RECIPES.cast_mugs.time));
  assert.equal(caster.output.greenware_mug, 4);
  assert.equal(caster.status, 'starved');
});

test('kilns fire in batches and multi-recipe machines start idle', () => {
  const s = fresh();
  const kiln = place(s, 'kiln', 5, 5);
  assert.equal(kiln.recipe, null);
  run(s, 1);
  assert.equal(kiln.status, 'idle');
  kiln.recipe = 'bisque_fire';
  kiln.input.greenware_mug = 3;
  run(s, 1);
  assert.equal(kiln.status, 'starved', 'a batch of four is needed');
  kiln.input.greenware_mug = 4;
  run(s, seconds(12) + 1);
  assert.equal(kiln.output.bisque_mug, 4);
});

test('a full output buffer blocks the machine', () => {
  const s = fresh();
  const cnc = place(s, 'cnc_mill', 5, 5, 'mill_phone_frame');
  cnc.input.aluminum_billet = 10;
  cnc.output.phone_frame = 4;
  run(s, 2);
  assert.equal(cnc.status, 'blocked');
  assert.equal(cnc.input.aluminum_billet, 10);
});

test('a power shortfall slows every machine down proportionally', () => {
  const s = fresh();
  // Eight kilns at 60 kW = 480 kW > 400 kW base supply.
  const kilns = Array.from({ length: 8 }, (_, i) => place(s, 'kiln', 2 + (i % 4) * 5, 2 + Math.floor(i / 4) * 5, 'bisque_fire'));
  for (const k of kilns) k.input.greenware_mug = 4;
  run(s, seconds(12) + 1);
  assert.ok(s.power.satisfaction < 1);
  assert.ok(Math.abs(s.power.satisfaction - 400 / 480) < 0.01);
  assert.equal(kilns[0].output.bisque_mug, undefined, 'not done yet at 83% power');
  run(s, seconds(3));
  assert.equal(kilns[0].output.bisque_mug, 4);
  // A substation restores full speed.
  place(s, 'substation', 40, 40);
  run(s, 1);
  assert.equal(s.power.capacity, 800);
});
