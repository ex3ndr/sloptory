import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildBlueprint } from '../src/engine/blueprints.ts';
import { neededSupplies } from '../src/engine/economy.ts';
import { deserialize, sanitizeSaveName, serialize } from '../src/engine/save.ts';
import { run } from '../src/engine/sim.ts';
import type { ClientView } from '../src/game/api.ts';
import { Game } from '../src/game/game.ts';
import { fresh, seconds } from './helpers.ts';

function busyFactory() {
  const s = fresh();
  buildBlueprint(s, 'mug');
  for (const it of neededSupplies(s)) s.stock[it] = 200;
  run(s, seconds(90));
  return s;
}

test('serialize/deserialize round-trips the whole state exactly', () => {
  const s = busyFactory();
  assert.ok(s.belts.some((b) => b.items.length > 0), 'mid-production, with items on belts');
  const copy = deserialize(serialize(s));
  assert.deepEqual(copy, s);
});

test('a loaded game continues exactly like the original (determinism)', () => {
  const a = busyFactory();
  const b = deserialize(serialize(a));
  run(a, seconds(60));
  run(b, seconds(60));
  assert.deepEqual(b, a);
  assert.ok((a.stats.shipped.mug_boxed ?? 0) > 0);
});

test('bad save files are rejected', () => {
  assert.throws(() => deserialize('{"hello":1}'), /Not a Sloptory save/);
  assert.throws(() => deserialize(JSON.stringify({ format: 'sloptory-save', version: 999, state: {} })), /Unsupported/);
  assert.equal(sanitizeSaveName('  Day 1!.json '), 'day-1');
  assert.equal(sanitizeSaveName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeSaveName('!!!'), null);
});

test('Game save / change / load restores the saved factory from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sloptory-test-'));
  try {
    const view: ClientView = { camera: { x: 0, y: 0, zoom: 1 }, viewport: { w: 1280, h: 800 } };
    const game = new Game({ savesDir: dir });
    assert.ok(game.exec({ op: 'blueprint', name: 'mug' }, view).ok);
    for (let i = 0; i < 50; i++) game.tick();
    const saved = game.exec({ op: 'save', name: 'day1' }, view);
    assert.ok(saved.ok, saved.message);
    const snapshot = serialize(game.state, 'x');

    assert.ok(game.exec({ op: 'remove', target: 'kiln 1' }, view).ok);
    for (let i = 0; i < 30; i++) game.tick();
    assert.notEqual(serialize(game.state, 'x'), snapshot);

    const loaded = game.exec({ op: 'load', name: 'day1' }, view);
    assert.ok(loaded.ok, loaded.message);
    assert.equal(serialize(game.state, 'x'), snapshot);
    assert.ok(game.state.machines.some((m) => m.id === 'kiln-1'));

    const listed = game.exec({ op: 'list_saves' }, view);
    assert.match(listed.message, /day1/);
    assert.match(listed.message, /autosave/, 'loading autosaved the game it replaced');

    assert.equal(game.exec({ op: 'load', name: 'nope' }, view).ok, false);
    writeFileSync(join(dir, 'broken.json'), 'not json');
    assert.equal(game.exec({ op: 'load', name: 'broken' }, view).ok, false);

    const ng = game.exec({ op: 'new_game' }, view);
    assert.ok(ng.ok);
    assert.equal(game.state.machines.length, 0);
    const g2 = new Game({ savesDir: dir });
    assert.ok(g2.resumeAutosave(), 'autosave resumes on startup');
    assert.ok(g2.state.machines.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
