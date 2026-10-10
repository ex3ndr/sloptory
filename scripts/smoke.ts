// End-to-end smoke test against a running engine: page and assets, state stream,
// text commands, production and sales over time, save -> change -> load.
// Usage: node scripts/smoke.ts [http://127.0.0.1:4780]

import WebSocket from 'ws';
import type { ServerMessage, Snapshot } from '../src/shared/protocol.ts';

const base = (process.argv[2] ?? 'http://127.0.0.1:4780').replace(/\/$/, '');
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${check}: ${detail}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(): Promise<void> {
  for (const [path, type, needle] of [
    ['/', 'text/html', '<canvas id="floor"'],
    ['/app.js', 'text/javascript', 'WebSocket'],
    ['/style.css', 'text/css', '--safety'],
  ] as const) {
    const res = await fetch(base + path);
    const body = await res.text();
    record(`GET ${path}`, res.status === 200 && (res.headers.get('content-type') ?? '').includes(type) && body.includes(needle), `${res.status} ${res.headers.get('content-type')} ${body.length} bytes`);
  }
  const health = await (await fetch(`${base}/api/health`)).json();
  record('GET /api/health', health.ok === true, JSON.stringify(health));
}

async function ws(): Promise<void> {
  const sock = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
  let latest: Snapshot | null = null;
  const snaps: Snapshot[] = [];
  const replies: { text: string; kind: string }[] = [];
  let hello = false;
  sock.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.t === 'hello') hello = true;
    if (msg.t === 'state') {
      latest = msg;
      snaps.push(msg);
    }
    if (msg.t === 'log') for (const e of msg.entries) if (e.kind === 'agent' || e.kind === 'error') replies.push({ text: e.text, kind: e.kind });
  });
  await new Promise<void>((ok, fail) => {
    sock.once('open', () => ok());
    sock.once('error', fail);
  });
  const snap = (): Snapshot => {
    if (!latest) throw new Error('no state received');
    return latest;
  };
  const say = async (text: string): Promise<string> => {
    const n = replies.length;
    sock.send(JSON.stringify({ t: 'cmd', text }));
    for (let i = 0; i < 300 && replies.length === n; i++) await sleep(50);
    const r = replies[n];
    console.log(`  > ${text}\n    ${r ? r.text.replace(/\n/g, '\n    ') : '(no reply)'}`);
    return r ? r.text : '';
  };

  await sleep(1500);
  record('hello + state stream', hello && snaps.length >= 3, `hello=${hello}, ${snaps.length} snapshots in 1.5s`);
  const t0 = snap().tick;
  await sleep(1000);
  const t1 = snap().tick;
  record('ticks advance', t1 > t0, `tick ${t0} -> ${t1} in 1s (speed ${snap().speed})`);

  // Start from a clean slate so the check is independent of earlier play.
  await say('new game called smoke');
  await sleep(400);
  const built = await say('build a mug line');
  await sleep(400);
  const machines = snap().machines.length;
  const belts = snap().belts.length;
  record('blueprint via text', /Built Mug line/.test(built) && machines === 8 && belts === 9, `${machines} machines, ${belts} belts`);
  const cash0 = snap().cash;
  const bought = await say('buy 300 clay; buy 150 glaze; buy 150 cartons');
  await sleep(400);
  record('buy materials via text', /Bought 300 × Clay/.test(bought) && snap().cash < cash0, `cash ${cash0} -> ${snap().cash}`);
  await say('speed 8');
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline && (snap().shipped.mug_boxed ?? 0) < 10) await sleep(500);
  const s = snap();
  record('mugs produced and sold over time', (s.shipped.mug_boxed ?? 0) >= 10 && s.revenue > 0, `T+${Math.round(s.time)}s shipped ${s.shipped.mug_boxed ?? 0} mugs, revenue $${s.revenue}, cash $${s.cash}`);
  const moving = s.belts.reduce((n, b) => n + b.items.length / 3, 0);
  record('items moving on belts', moving > 0, `${moving} items on belts`);
  await say('pause');
  await sleep(300);

  const saved = await say('save as smoke1');
  const before = snap();
  const removed = await say('remove kiln 2');
  await sleep(400);
  const changed = snap();
  record('change after save', /Removed Kiln 2/.test(removed) && !changed.machines.some((m) => m.id === 'kiln-2'), `${changed.machines.length} machines after removal`);
  const loaded = await say('load smoke1');
  await sleep(400);
  const after = snap();
  const same = after.tick === before.tick && after.machines.length === before.machines.length && after.machines.some((m) => m.id === 'kiln-2') && Math.abs(after.cash - before.cash) < 0.01;
  record('load restores saved state', /Saved as "smoke1"/.test(saved) && /Loaded "smoke1"/.test(loaded) && same, `tick ${before.tick} vs ${after.tick}, cash ${before.cash} vs ${after.cash}, kiln-2 back: ${after.machines.some((m) => m.id === 'kiln-2')}`);

  const camBefore = await say('go to the mug line');
  record('camera text command', /Looking at Mug line 1/.test(camBefore), camBefore);
  await say('resume');
  await say('speed 1');
  sock.close();
}

try {
  await http();
  await ws();
} catch (e) {
  record('smoke run', false, (e as Error).stack ?? String(e));
}
const failed = results.filter((r) => !r.ok);
console.log(`SMOKE ${failed.length === 0 ? 'OK' : 'FAILED'}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
