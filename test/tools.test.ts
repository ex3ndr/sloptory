import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { TOOLS, toolToCommand } from '../src/agent/tools.ts';
import { buildBlueprint } from '../src/engine/blueprints.ts';
import { diagnose, findFreeAreas, renderMap } from '../src/engine/inspect.ts';
import { connect } from '../src/engine/ops.ts';
import { resolveMachine } from '../src/engine/resolve.ts';
import { serialize } from '../src/engine/save.ts';
import type { ClientView, Command } from '../src/game/api.ts';
import { Game } from '../src/game/game.ts';
import { fresh, place } from './helpers.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function newGame(): { game: Game; view: ClientView } {
  const dir = mkdtempSync(join(tmpdir(), 'sloptory-tools-'));
  dirs.push(dir);
  return { game: new Game({ savesDir: dir }), view: { camera: { x: 30, y: 20, zoom: 1 }, viewport: { w: 1400, h: 900 } } };
}

type BatchData = { dry_run: boolean; applied: boolean; succeeded: number; failed: number; results: { i: number; op: string; ok: boolean; message: string; id?: string }[] };

const MINI_LINE: Command[] = [
  { op: 'place', machine: 'receiving_dock', x: 2, y: 2, as: 'dock' },
  { op: 'place', machine: 'slip_caster', x: 9, y: 2, as: 'cast' },
  { op: 'place', machine: 'kiln', x: 15, y: 2, recipe: 'bisque_fire', as: 'kiln' },
  { op: 'connect', from: '@dock', to: '@cast' },
  { op: 'connect', from: '@cast', to: '@kiln' },
  { op: 'name_line', name: 'Clay line', machines: ['@dock', '@cast', '@kiln'] },
];

// ---------- free space ----------

test('find_space returns clear areas with a margin, nearest the hint, never overlapping', () => {
  const s = fresh();
  const [first] = findFreeAreas(s, 10, 5);
  assert.deepEqual(first, { x: 1, y: 1, w: 10, h: 5 }, 'empty floor: top-left, inside the margin');
  place(s, 'warehouse', 3, 3);
  const areas = findFreeAreas(s, 10, 5, { x: 0, y: 0 }, 1, 4);
  assert.equal(areas.length, 4);
  for (const a of areas) {
    for (const m of s.machines) {
      const clear = a.x - 1 >= m.x + 4 || a.x + a.w + 1 <= m.x || a.y - 1 >= m.y + 4 || a.y + a.h + 1 <= m.y;
      assert.ok(clear, `area ${a.x},${a.y} keeps a margin from ${m.id}`);
    }
  }
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      const a = areas[i];
      const b = areas[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'candidates do not overlap');
    }
  }
  const near = findFreeAreas(s, 4, 4, { x: 100, y: 70 }, 1, 1)[0];
  assert.ok(Math.abs(near.x + 2 - 100) + Math.abs(near.y + 2 - 70) < 3, 'nearest the hint');
  assert.equal(findFreeAreas(s, 130, 10).length, 0, 'bigger than the floor');
});

test('find_space avoids conveyors, and the command reports when nothing fits', () => {
  const { game, view } = newGame();
  const s = game.state;
  const a = place(s, 'qa', 2, 2);
  const b = place(s, 'qa', 40, 2);
  connect(s, a.id, b.id);
  const areas = findFreeAreas(s, 30, 3, { x: 20, y: 3 }, 0, 1);
  const belt = s.belts[0].path;
  for (let i = 0; i < belt.length; i += 2) {
    const [x, y] = [belt[i], belt[i + 1]];
    assert.ok(!(x >= areas[0].x && x < areas[0].x + 30 && y >= areas[0].y && y < areas[0].y + 3), 'area does not cover the belt');
  }
  const r = game.exec({ op: 'find_space', w: 200, h: 5 }, view);
  assert.equal(r.ok, false);
  assert.match(r.message, /No free 200×5 area/);
});

// ---------- batch ----------

test('batch applies ops in order, resolves @refs, and reports a precise error per failed op', () => {
  const { game, view } = newGame();
  const r = game.exec(
    {
      op: 'batch',
      ops: [
        { op: 'place', machine: 'receiving_dock', x: 2, y: 2, as: 'dock' },
        { op: 'place', machine: 'slip_caster', x: 9, y: 2, as: 'cast' },
        { op: 'place', machine: 'kiln', x: 10, y: 2, recipe: 'bisque_fire', as: 'kiln' }, // overlaps the caster
        { op: 'connect', from: '@dock', to: '@cast' },
        { op: 'connect', from: '@cast', to: '@kiln' }, // its place failed
        { op: 'blueprint', name: 'mug' } as Command, // not a batch op
        { op: 'buy', item: 'clay', qty: 50 },
      ],
    },
    view,
  );
  assert.equal(r.ok, false);
  const data = r.data as BatchData;
  assert.deepEqual(
    data.results.map((x) => x.ok),
    [true, true, false, true, false, false, true],
  );
  assert.equal(data.results[0].id, 'dock-1');
  assert.match(data.results[2].message, /Slip caster 1 is in the way/);
  assert.match(data.results[4].message, /Unknown reference "@kiln"/);
  assert.match(data.results[5].message, /not allowed in a batch/);
  assert.match(r.message, /4\/7 ops succeeded/);
  assert.match(r.message, /#2 place/);
  assert.equal(game.state.machines.length, 2, 'successful ops stay applied');
  assert.equal(game.state.belts.length, 1);
  assert.equal(game.state.stock.clay, 50);
});

test('a dry run changes nothing and predicts the real run exactly', () => {
  const { game, view } = newGame();
  const before = serialize(game.state, 'x');
  const dry = game.exec({ op: 'batch', ops: MINI_LINE, dryRun: true }, view);
  assert.ok(dry.ok, dry.message);
  assert.match(dry.message, /dry run, nothing changed/);
  assert.equal(serialize(game.state, 'x'), before, 'state untouched');
  const real = game.exec({ op: 'batch', ops: MINI_LINE }, view);
  assert.ok(real.ok, real.message);
  const strip = (d: BatchData) => d.results.map((x) => ({ ok: x.ok, id: x.id, message: x.message }));
  assert.deepEqual(strip(dry.data as BatchData), strip(real.data as BatchData));
  assert.equal(game.state.machines.length, 3);
  assert.equal(game.state.lines[0].name, 'Clay line');
  assert.deepEqual(
    game.state.machines.map((m) => m.line),
    ['line-1', 'line-1', 'line-1'],
  );
});

test('an atomic batch rolls back everything when one op fails', () => {
  const { game, view } = newGame();
  const before = serialize(game.state, 'x');
  const r = game.exec({ op: 'batch', atomic: true, ops: [...MINI_LINE, { op: 'connect', from: '@kiln', to: 'nowhere-9' }] }, view);
  assert.equal(r.ok, false);
  assert.match(r.message, /rolled back/);
  assert.equal(serialize(game.state, 'x'), before);
  assert.equal((r.data as BatchData).applied, false);
});

// ---------- diagnose ----------

test('diagnose flags missing inputs, dead-end outputs and machines without recipes', () => {
  const s = fresh();
  assert.deepEqual(diagnose(s), [], 'an empty floor has no problems');
  const caster = place(s, 'slip_caster', 10, 10);
  place(s, 'kiln', 20, 10);
  const codes = diagnose(s).map((i) => `${i.code}:${i.machine ?? ''}`);
  assert.ok(codes.includes(`input_unconnected:${caster.id}`));
  assert.ok(codes.includes(`output_unconnected:${caster.id}`));
  assert.ok(codes.includes('no_recipe:kiln-1'));
  const text = diagnose(s).find((i) => i.code === 'input_unconnected')!.text;
  assert.match(text, /needs clay/);
  assert.match(text, /receiving dock/);
});

test('diagnose passes a complete line, then reports stock, useless belts, routes and power', () => {
  const s = fresh();
  buildBlueprint(s, 'mug');
  let issues = diagnose(s);
  assert.deepEqual(
    issues.filter((i) => i.severity === 'error'),
    [],
    'a blueprint line is structurally sound',
  );
  assert.ok(issues.some((i) => i.code === 'out_of_stock'), 'but it has no clay, glaze or cartons yet');
  s.stock = { clay: 100, glaze: 100, carton: 100 };
  assert.ok(!diagnose(s).some((i) => i.code === 'out_of_stock'));

  // A kiln running bisque feeding packaging carries nothing useful.
  assert.ok(connect(s, 'kiln-1', 'packaging-1').ok);
  issues = diagnose(s);
  assert.ok(issues.some((i) => i.code === 'useless_conveyor' && /kiln-1 → packaging-1/.test(i.text)));

  // A boxed-in machine leaves its conveyor without a route.
  const t = fresh();
  const a = place(t, 'qa', 20, 20);
  const b = place(t, 'qa', 0, 0);
  assert.ok(connect(t, a.id, b.id).ok);
  place(t, 'warehouse', 2, 0);
  place(t, 'qa', 0, 2);
  assert.ok(diagnose(t).some((i) => i.code === 'route_unreachable'));

  // Eight kilns need more than the 400 kW base supply at full load.
  const p = fresh();
  for (let i = 0; i < 8; i++) place(p, 'kiln', 2 + (i % 4) * 5, 2 + Math.floor(i / 4) * 5, 'bisque_fire');
  const power = diagnose(p).find((i) => i.code === 'power_at_full_load');
  assert.ok(power);
  assert.match(power.text, /480 kW/);
  assert.match(power.text, /1 substation/);
});

test('diagnose can be scoped to one line', () => {
  const { game, view } = newGame();
  game.exec({ op: 'batch', ops: MINI_LINE }, view);
  game.exec({ op: 'place', machine: 'cnc_mill', x: 60, y: 40 }, view); // no recipe, outside the line
  const all = game.exec({ op: 'diagnose' }, view);
  const line = game.exec({ op: 'diagnose', target: 'clay line' }, view);
  assert.ok(/cnc-1/.test(all.message));
  assert.ok(!/cnc-1/.test(line.message), 'other machines are out of scope');
  assert.match(line.message, /kiln-1 makes bisque_mug but no conveyor takes it away/);
  assert.match(line.message, /Clay line/);
});

// ---------- names, lines, map ----------

test('rename, name_line and camera focus work with free-form names', () => {
  const { game, view } = newGame();
  game.exec({ op: 'batch', ops: MINI_LINE }, view);
  const r = game.exec({ op: 'rename', target: 'kiln 1', name: 'Bisque Kiln' }, view);
  assert.ok(r.ok, r.message);
  const ref = resolveMachine(game.state, 'bisque kiln');
  assert.ok('machine' in ref && ref.machine.id === 'kiln-1');
  assert.equal(game.exec({ op: 'rename', target: 'caster 1', name: 'bisque kiln' }, view).ok, false, 'names are unique');
  assert.equal(game.exec({ op: 'name_line', name: 'X', machines: ['kiln-1', 'nope-3'] }, view).ok, false);
  const focus = game.exec({ op: 'camera', action: 'focus', target: 'the clay line' }, view);
  assert.ok(focus.ok, focus.message);
  assert.match(focus.message, /Clay line/);
  assert.ok(game.exec({ op: 'name_line', name: 'Kilns', machines: ['bisque kiln'] }, view).ok);
  assert.equal(game.state.lines.length, 2);
  assert.equal(game.snapshot().machines.find((m) => m.id === 'kiln-1')!.name, 'Bisque Kiln');
});

test('map shows machines, conveyors and a legend for a region', () => {
  const s = fresh();
  const a = place(s, 'qa', 2, 2);
  const b = place(s, 'qa', 8, 2);
  connect(s, a.id, b.id);
  const { map, legend } = renderMap(s, 0, 0, 12, 5);
  const rows = map.split('\n').slice(2);
  assert.equal(rows.length, 5);
  assert.equal(rows[2], '2 ..AA====BB..');
  assert.match(legend.A, /^qa-1 \(qa\) @2,2 2x2$/);
});

// ---------- LLM tool surface ----------

test('LLM tools have no blueprints and map onto engine commands', () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(!names.some((n) => /blueprint/.test(n)));
  for (const t of TOOLS) assert.ok(!/blueprint/i.test(JSON.stringify(t.parameters)), `${t.name} schema`);
  for (const n of ['get_catalog', 'find_recipes', 'get_state', 'find_free_area', 'view_map', 'diagnose', 'batch', 'rename_machine', 'name_line']) {
    assert.ok(names.includes(n), n);
  }
  const cmd = toolToCommand('batch', {
    dry_run: true,
    ops: [
      { op: 'place', type: 'kiln', x: 3, y: 4, recipe: 'bisque_fire', as: 'k' },
      { op: 'connect', from: '@k', to: 'qa-1' },
      { op: 'rename', id: '@k', name: 'Hot' },
    ],
  });
  assert.deepEqual(cmd, {
    op: 'batch',
    dryRun: true,
    atomic: false,
    ops: [
      { op: 'place', machine: 'kiln', x: 3, y: 4, recipe: 'bisque_fire', name: undefined, as: 'k' },
      { op: 'connect', from: '@k', to: 'qa-1' },
      { op: 'rename', target: '@k', name: 'Hot' },
    ],
  });
  assert.deepEqual(toolToCommand('find_free_area', { w: 40, h: 10, near_x: 5, near_y: 6 }), { op: 'find_space', w: 40, h: 10, x: 5, y: 6, margin: undefined, count: undefined });
  assert.throws(() => toolToCommand('build_blueprint', { blueprint: 'mug' }), /Unknown tool/);
});

test('read tools return structured data', () => {
  const { game, view } = newGame();
  game.exec({ op: 'batch', ops: MINI_LINE }, view);
  const st = game.exec({ op: 'inspect', target: 'clay line' }, view);
  const data = st.data as { machines: { id: string; from: string[]; to: string[]; w: number }[] };
  assert.deepEqual(
    data.machines.map((m) => m.id),
    ['dock-1', 'caster-1', 'kiln-1'],
  );
  assert.deepEqual(data.machines[1].from, ['dock-1']);
  assert.deepEqual(data.machines[1].to, ['kiln-1']);
  const item = game.exec({ op: 'item', item: 'smart kettle', upstream: true }, view).data as { chain: { id: string }[]; buy: string[] };
  assert.equal(item.chain[item.chain.length - 1].id, 'pack_kettle');
  assert.ok(item.chain.some((r) => r.id === 'smt_kettle'));
  assert.ok(item.buy.includes('steel_sheet') && item.buy.includes('carton'));
  const cat = game.exec({ op: 'catalog', filter: 'electronics' }, view).data as { machines: { type: string }[] };
  assert.deepEqual(
    cat.machines.map((m) => m.type),
    ['smt_line', 'reflow_oven', 'aoi', 'pcb_test'],
  );
});
