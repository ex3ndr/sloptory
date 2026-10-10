import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ParserAgent } from '../src/agent/agent.ts';
import { isFastPath, parse } from '../src/agent/parser.ts';
import { buildBlueprint } from '../src/engine/blueprints.ts';
import type { ClientView, Command } from '../src/game/api.ts';
import { Game } from '../src/game/game.ts';
import { fresh } from './helpers.ts';

const state = fresh();
state.cash = 5_000_000;
buildBlueprint(state, 'mug');
buildBlueprint(state, 'phone');

const CASES: [string, Command[]][] = [
  ['help', [{ op: 'help' }]],
  ['build a mug line', [{ op: 'blueprint', name: 'mug', x: undefined, y: undefined }]],
  ['Build a complete smart kettle line', [{ op: 'blueprint', name: 'kettle', x: undefined, y: undefined }]],
  ['build a smartwatch line at 10, 40', [{ op: 'blueprint', name: 'watch', x: 10, y: 40 }]],
  ['make phones', [{ op: 'blueprint', name: 'phone', x: undefined, y: undefined }]],
  ['place a kiln at 10,5', [{ op: 'place', machine: 'kiln', x: 10, y: 5, recipe: undefined, count: undefined }]],
  ['build a smt line', [{ op: 'place', machine: 'smt_line', x: undefined, y: undefined, recipe: undefined, count: undefined }]],
  ['place cnc mill at 3,4 for watch case', [{ op: 'place', machine: 'cnc_mill', x: 3, y: 4, recipe: 'watch case', count: undefined }]],
  ['add 2 kilns', [{ op: 'place', machine: 'kiln', x: undefined, y: undefined, recipe: undefined, count: 2 }]],
  ['connect kiln 1 to packaging 1', [{ op: 'connect', from: 'kiln 1', to: 'packaging 1' }]],
  [
    'connect dock 1 -> caster 1 -> kiln 1',
    [
      { op: 'connect', from: 'dock 1', to: 'caster 1' },
      { op: 'connect', from: 'caster 1', to: 'kiln 1' },
    ],
  ],
  ['disconnect kiln 1 from packaging 1', [{ op: 'disconnect', from: 'kiln 1', to: 'packaging 1' }]],
  ['set kiln 1 to glaze firing', [{ op: 'set_recipe', target: 'kiln 1', recipe: 'glaze firing' }]],
  ['set recipe of cnc 1 to watch case', [{ op: 'set_recipe', target: 'cnc 1', recipe: 'watch case' }]],
  ['buy 200 clay', [{ op: 'buy', item: 'clay', qty: 200 }]],
  ['buy clay 50', [{ op: 'buy', item: 'clay', qty: 50 }]],
  ['order 2k aluminium', [{ op: 'buy', item: 'aluminum_billet', qty: 2000 }]],
  ['buy a kiln', [{ op: 'place', machine: 'kiln', x: undefined, y: undefined, recipe: undefined, count: undefined }]],
  ['sell 10 mugs', [{ op: 'sell', item: 'mugs', qty: 10 }]],
  ['remove kiln 2', [{ op: 'remove', target: 'kiln 2' }]],
  ['move kiln 1 to 20,5', [{ op: 'move', target: 'kiln 1', x: 20, y: 5 }]],
  ['scroll left 10', [{ op: 'camera', action: 'pan', dx: -10, dy: 0 }]],
  ['left', [{ op: 'camera', action: 'pan', dx: -10, dy: 0 }]],
  ['up 5', [{ op: 'camera', action: 'pan', dx: 0, dy: -5 }]],
  ['zoom in', [{ op: 'camera', action: 'zoom', factor: 1.5 }]],
  ['zoom 2', [{ op: 'camera', action: 'zoom', level: 2 }]],
  ['go to the SMT line', [{ op: 'camera', action: 'focus', target: 'smt line' }]],
  ['go to 40,20', [{ op: 'camera', action: 'center', x: 40, y: 20 }]],
  ['overview', [{ op: 'camera', action: 'overview' }]],
  ['save as day1', [{ op: 'save', name: 'day1' }]],
  ['save', [{ op: 'save', name: undefined }]],
  ['load day1', [{ op: 'load', name: 'day1' }]],
  ['new game', [{ op: 'new_game', name: undefined }]],
  ['saves', [{ op: 'list_saves' }]],
  ['status', [{ op: 'query', what: 'status', target: undefined }]],
  ['info kiln 1', [{ op: 'query', what: 'machine', target: 'kiln 1' }]],
  ['pause', [{ op: 'speed', value: 0 }]],
  ['speed 4', [{ op: 'speed', value: 4 }]],
  ['resume', [{ op: 'resume' }]],
  ['autobuy on', [{ op: 'autobuy', on: true }]],
  [
    'please build a mug line and then buy 200 clay',
    [
      { op: 'blueprint', name: 'mug', x: undefined, y: undefined },
      { op: 'buy', item: 'clay', qty: 200 },
    ],
  ],
  [
    'buy 200 clay, buy 100 glaze and buy 100 cartons',
    [
      { op: 'buy', item: 'clay', qty: 200 },
      { op: 'buy', item: 'glaze', qty: 100 },
      { op: 'buy', item: 'carton', qty: 100 },
    ],
  ],
];

for (const [text, expected] of CASES) {
  test(`parses "${text}"`, () => {
    const r = parse(text, state);
    assert.deepEqual(r.unknown, []);
    assert.deepEqual(r.commands, expected);
  });
}

test('unknown text is reported, not guessed', () => {
  const r = parse('flibbertigibbet', state);
  assert.deepEqual(r.commands, []);
  assert.deepEqual(r.unknown, ['flibbertigibbet']);
});

test('camera-only input takes the fast path', () => {
  assert.ok(isFastPath(parse('left 5', state).commands));
  assert.ok(isFastPath(parse('zoom in', state).commands));
  assert.ok(!isFastPath(parse('build a mug line', state).commands));
});

test('parser agent drives a whole game through text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloptory-parser-'));
  try {
    const game = new Game({ savesDir: dir });
    const view: ClientView = { camera: { x: 30, y: 20, zoom: 1 }, viewport: { w: 1400, h: 900 } };
    const agent = new ParserAgent();
    const say = async (text: string) => {
      const r = await agent.handle(text, { game, view });
      assert.ok(r.ok, `"${text}" -> ${r.text}`);
      return r.text;
    };
    assert.match(await say('build a mug line'), /Built Mug line 1/);
    assert.match(await say('buy 300 clay; buy 150 glaze; buy 150 cartons'), /Bought 150 × Carton/);
    await say('go to the kiln 2');
    const before = { ...view.camera };
    await say('scroll left 10');
    assert.equal(Math.round((before.x - view.camera.x) * 10) / 10, 10);
    await say('zoom in');
    assert.ok(view.camera.zoom > before.zoom);
    for (let i = 0; i < 1500; i++) game.tick();
    assert.ok((game.state.stats.shipped.mug_boxed ?? 0) > 0, 'mugs shipped');
    assert.match(await say('status'), /Shipped: \d+ Ceramic mug/);
    assert.match(await say('place a kiln at 60,40'), /Placed Kiln 3/);
    assert.match(await say('connect kiln 3 to qa 1'), /Conveyor Kiln 3 → QA station 1/);
    assert.match(await say('set kiln 3 to glaze firing'), /Glaze firing/);
    assert.match(await say('save as day1'), /Saved as "day1"/);
    await say('remove kiln 3');
    assert.match(await say('load day1'), /Loaded "day1"/);
    assert.ok(game.state.machines.some((m) => m.id === 'kiln-3'));
    const bad = await agent.handle('connect kiln 9 to qa 1', { game, view });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /No kiln #9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
