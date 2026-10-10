import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LlmAgent, type HistoryItem, type Provider, type RunHooks, type RunResult, type ToolCall, type ToolOutput } from '../src/agent/llm.ts';
import { run } from '../src/engine/sim.ts';
import type { ClientView } from '../src/game/api.ts';
import { Game } from '../src/game/game.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sloptory-llm-'));
  dirs.push(dir);
  const game = new Game({ savesDir: dir });
  const view: ClientView = { camera: { x: 30, y: 20, zoom: 1 }, viewport: { w: 1400, h: 900 } };
  const progress: string[] = [];
  return { game, view, progress, ctx: { game, view, progress: (l: string) => progress.push(l) } };
}

/** Plays back fixed rounds of tool calls, like a model would, and records what came back. */
class ScriptedProvider implements Provider {
  readonly label = 'scripted';
  calls = 0;
  outputs: ToolOutput[] = [];
  users: string[] = [];
  private rounds: Omit<ToolCall, 'id'>[][];
  private reply: string;
  private failAfter: number;

  constructor(rounds: Omit<ToolCall, 'id'>[][], reply = 'Built it.', failAfter = Infinity) {
    this.rounds = rounds;
    this.reply = reply;
    this.failAfter = failAfter;
  }

  async run(system: string, _history: HistoryItem[], user: string, hooks: RunHooks, maxRounds: number): Promise<RunResult> {
    this.calls++;
    this.users.push(user);
    assert.match(system, /There are no prefab lines/);
    let toolCalls = 0;
    for (let i = 0; i < this.rounds.length && i < maxRounds; i++) {
      if (i >= this.failAfter) throw new Error('connection reset');
      hooks.onText?.(`round ${i + 1}`);
      for (const c of this.rounds[i]) {
        toolCalls++;
        this.outputs.push(hooks.exec({ ...c, id: `t${toolCalls}` }));
      }
    }
    const exhausted = this.rounds.length > maxRounds;
    return { text: this.reply, rounds: Math.min(this.rounds.length, maxRounds) + 1, toolCalls, usage: { input: 12000, output: 800, cached: 9000, cost: 0.01 }, exhausted };
  }
}

const LINE_OPS = [
  { op: 'place', type: 'receiving_dock', x: 2, y: 2, as: 'dock' },
  { op: 'place', type: 'slip_caster', x: 9, y: 2, as: 'cast' },
  { op: 'place', type: 'kiln', x: 15, y: 2, recipe: 'bisque_fire', as: 'k1' },
  { op: 'place', type: 'glazing_station', x: 21, y: 2, as: 'glaze' },
  { op: 'place', type: 'kiln', x: 26, y: 2, recipe: 'glaze_fire', as: 'k2' },
  { op: 'place', type: 'qa', x: 32, y: 2, recipe: 'qa_mug', as: 'qa' },
  { op: 'place', type: 'packaging', x: 37, y: 2, recipe: 'pack_mug', as: 'pack' },
  { op: 'place', type: 'shipping_dock', x: 43, y: 2, as: 'ship' },
  { op: 'connect', from: '@dock', to: '@cast' },
  { op: 'connect', from: '@cast', to: '@k1' },
  { op: 'connect', from: '@k1', to: '@glaze' },
  { op: 'connect', from: '@dock', to: '@glaze' },
  { op: 'connect', from: '@glaze', to: '@k2' },
  { op: 'connect', from: '@k2', to: '@qa' },
  { op: 'connect', from: '@qa', to: '@pack' },
  { op: 'connect', from: '@dock', to: '@pack' },
  { op: 'connect', from: '@pack', to: '@ship' },
  { op: 'name_line', name: 'Mug line', machines: ['@dock', '@cast', '@k1', '@glaze', '@k2', '@qa', '@pack', '@ship'] },
];

test('the LLM agent designs a line with batch + diagnose, streams progress, and it ships', async () => {
  const { game, view, progress, ctx } = setup();
  const provider = new ScriptedProvider([
    [{ name: 'find_recipes', args: { item: 'mug_boxed', upstream: true } }, { name: 'find_free_area', args: { w: 50, h: 6 } }],
    [{ name: 'batch', args: { ops: LINE_OPS, dry_run: true } }],
    [{ name: 'batch', args: { ops: LINE_OPS, atomic: true } }],
    [{ name: 'diagnose', args: { target: 'Mug line' } }],
    [
      { name: 'buy', args: { item: 'clay', qty: 200 } },
      { name: 'set_autobuy', args: { on: true } },
      { name: 'camera', args: { action: 'focus', target: 'mug line' } },
    ],
  ]);
  const agent = new LlmAgent(provider);
  const r = await agent.handle('make me some mugs', ctx);
  assert.ok(r.ok, r.text);
  assert.equal(r.text, 'Built it.');
  assert.match(r.via, /scripted · 6 rounds · 8 tools · 12k in \(9.0k cached\) \/ 800 out · \$0\.010 · \d+\.\ds/);
  assert.match(provider.users[0], /<factory>[\s\S]*Occupied area: none, the floor is empty[\s\S]*Player: make me some mugs/);
  assert.ok(provider.outputs.every((o) => !o.isError), provider.outputs.map((o) => o.content.slice(0, 120)).join('\n'));
  const diag = JSON.parse(provider.outputs[4].content);
  assert.equal(diag.data.errors, 0, 'the scripted layout is sound');
  assert.deepEqual(progress.slice(0, 2), ['… round 1', 'looked up recipes for mug_boxed (full chain)']);
  assert.ok(progress.some((l) => /^checked a plan \(dry run\): 18\/18 ops would succeed/.test(l)));
  assert.ok(progress.some((l) => /^batch: 8 place, 9 connect, 1 name_line \(18\/18 ok\)/.test(l)));
  assert.ok(progress.some((l) => /^diagnose: /.test(l)));
  assert.equal(game.state.lines[0].name, 'Mug line');
  assert.equal(game.state.lines[0].blueprint, null, 'no blueprint was used');
  for (let i = 0; i < 3000; i++) game.tick();
  assert.ok((game.state.stats.shipped.mug_boxed ?? 0) > 0, 'mugs ship');
  void view;
  void run;
});

test('tool errors go back to the model as errors; a recovered run is still a normal reply', async () => {
  const { ctx } = setup();
  const provider = new ScriptedProvider([
    [{ name: 'place_machine', args: { type: 'kiln', x: 200, y: 5 } }],
    [{ name: 'connect', args: { from: 'kiln-7', to: 'qa-1' } }],
    [{ name: 'build_blueprint', args: { blueprint: 'mug' } }],
    [{ name: 'batch', args: { ops: [{ op: 'place', type: 'kiln', x: 5, y: 5, recipe: 'bisque_fire' }, { op: 'remove', id: 'kiln-9' }] } }],
    [{ name: 'batch', args: { ops: JSON.stringify([{ op: 'place', type: 'qa', x: 30, y: 5, recipe: 'qa_mug' }]) } }],
    [{ name: 'batch', args: { operations: [] } }],
  ]);
  const r = await new LlmAgent(provider).handle('do things', ctx);
  assert.equal(r.ok, true);
  const [place, conn, unknown, batch, stringOps, noOps] = provider.outputs;
  assert.ok(!stringOps.isError, 'ops sent as a JSON string still work');
  assert.ok(noOps.isError && /batch needs .*ops.*arguments had: operations/.test(noOps.content));
  assert.ok(place.isError && /^ERROR: .*does not fit at 200,5/.test(place.content));
  assert.ok(conn.isError && /No kiln #7|kiln-7/.test(conn.content));
  assert.ok(unknown.isError && /Unknown tool .*build_blueprint/.test(unknown.content));
  assert.ok(batch.isError);
  const data = JSON.parse(batch.content.replace(/^ERROR: /, '')).data;
  assert.deepEqual(
    data.results.map((x: { ok: boolean }) => x.ok),
    [true, false],
  );
});

test('fast-path text never reaches the model; outages fall back without redoing work', async () => {
  const { ctx, game } = setup();
  const idle = new ScriptedProvider([]);
  const agent = new LlmAgent(idle);
  const zoom = await agent.handle('zoom in', ctx);
  assert.equal(zoom.via, 'fast-path');
  assert.equal(idle.calls, 0);
  assert.ok(agent.quick('left 5', ctx));
  assert.equal(agent.quick('build a mug line', ctx), null);

  const down = new ScriptedProvider([[{ name: 'list_saves', args: {} }]], '', 0);
  const fallback = await new LlmAgent(down).handle('build a mug line', ctx);
  assert.match(fallback.text, /Built Mug line 1[\s\S]*LLM unavailable: connection reset/);
  assert.equal(game.state.lines.length, 1);

  const mid = new ScriptedProvider([[{ name: 'place_machine', args: { type: 'kiln', x: 60, y: 60, recipe: 'bisque_fire' } }], [{ name: 'list_saves', args: {} }]], '', 1);
  const partial = await new LlmAgent(mid).handle('add a kiln please', ctx);
  assert.equal(partial.ok, false);
  assert.match(partial.text, /Placed Kiln 3[\s\S]*LLM stopped: connection reset/);
  assert.equal(game.state.machines.filter((m) => m.type === 'kiln').length, 3, 'nothing was redone by the parser');
});

test('the round limit stops a runaway model and says so', async () => {
  const { ctx } = setup();
  const rounds = Array.from({ length: 40 }, () => [{ name: 'diagnose', args: {} }]);
  const r = await new LlmAgent(new ScriptedProvider(rounds, 'still going'), 5).handle('fix everything', ctx);
  assert.equal(r.ok, false);
  assert.match(r.text, /Stopped after \d+ tool rounds/);
});
