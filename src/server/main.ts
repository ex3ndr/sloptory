// Sloptory engine server: runs the one game at a fixed tick, serves the web interface,
// streams state over WebSocket and accepts text commands.

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Agent } from '../agent/agent.ts';
import { createAgent } from '../agent/llm.ts';
import { TICK_SECONDS } from '../engine/state.ts';
import type { ClientView } from '../game/api.ts';
import { Game, defaultCamera } from '../game/game.ts';
import { clampCamera } from '../shared/camera.ts';
import { SNAPSHOT_EVERY_TICKS, type ClientMessage, type LogEntry, type ServerMessage } from '../shared/protocol.ts';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const config = {
  port: Number(arg('port') ?? process.env.PORT ?? 4780),
  host: arg('host') ?? process.env.HOST ?? '127.0.0.1',
  socket: arg('socket') ?? process.env.SLOPTORY_SOCKET,
  savesDir: resolve(arg('saves') ?? process.env.SLOPTORY_SAVES ?? join(ROOT, 'saves')),
  webDir: resolve(arg('web') ?? process.env.SLOPTORY_WEB ?? join(ROOT, 'dist', 'web')),
  autosaveSeconds: Number(process.env.SLOPTORY_AUTOSAVE_SECONDS ?? 60),
  fresh: process.argv.includes('--new'),
};

interface Client {
  id: string;
  ws: WebSocket;
  view: ClientView;
  /** Until the player moves the camera, it keeps re-fitting the factory to the window. */
  cameraTouched: boolean;
}

const clients = new Map<WebSocket, Client>();
let clientSeq = 0;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const c of clients.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
}

const game = new Game({ savesDir: config.savesDir });
const resumed = !config.fresh && game.resumeAutosave();
game.setListeners(
  () => {
    for (const c of clients.values()) {
      c.cameraTouched = false;
      c.view.camera = defaultCamera(game.state, c.view.viewport);
      send(c.ws, { t: 'camera', camera: c.view.camera });
    }
  },
  (entry: LogEntry) => {
    broadcast({ t: 'log', entries: [entry] });
    const who = entry.kind === 'agent' || entry.kind === 'error' ? `${entry.kind} (${entry.via ?? 'engine'})` : entry.kind;
    console.log(`[T+${Math.floor(entry.time)}s] ${who}: ${entry.text.replace(/\n/g, '\n    ')}`);
  },
);
const agent: Agent = createAgent();
game.addLog('system', resumed ? `Resumed autosave: T+${Math.floor(game.state.time)}s.` : 'New factory. Type "help" or "build a mug line" to begin.');

// ---- commands: one at a time, in arrival order ----

let queue: Promise<void> = Promise.resolve();
let busy = 0;

function submit(text: string, view: ClientView, onCamera?: () => void): Promise<string> {
  const trimmed = text.trim().slice(0, 2000);
  if (!trimmed) return Promise.resolve('');
  game.addLog('player', trimmed);
  const ctx = { game, view, progress: (line: string) => game.addLog('tool', line, agent.name) };
  // Camera, speed, help and save answer at once, even while a slow request is running.
  const before0 = JSON.stringify(view.camera);
  const quick = agent.quick?.(trimmed, ctx);
  if (quick) {
    game.addLog(quick.ok ? 'agent' : 'error', quick.text, quick.via);
    if (JSON.stringify(view.camera) !== before0) onCamera?.();
    return Promise.resolve(quick.text);
  }
  let reply = '';
  queue = queue.then(async () => {
    if (busy++ === 0) broadcast({ t: 'busy', busy: true });
    const before = JSON.stringify(view.camera);
    try {
      const r = await agent.handle(trimmed, ctx);
      reply = r.text;
      game.addLog(r.ok ? 'agent' : 'error', r.text, r.via);
    } catch (e) {
      reply = `Agent error: ${(e as Error).message}`;
      game.addLog('error', reply);
    } finally {
      if (--busy === 0) broadcast({ t: 'busy', busy: false });
    }
    if (JSON.stringify(view.camera) !== before) onCamera?.();
  });
  return queue.then(() => reply);
}

// ---- HTTP ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100_000) req.destroy();
    });
    req.on('end', () => ok(data));
    req.on('error', fail);
  });
}

const httpView: ClientView = { camera: defaultCamera(game.state), viewport: { w: 1280, h: 800 } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      return json(res, 200, { ok: true, tick: game.state.tick, time: game.state.time, agent: agent.name, clients: clients.size });
    }
    if (url.pathname === '/api/state') return json(res, 200, game.snapshot());
    if (url.pathname === '/api/log') return json(res, 200, game.log.slice(-100));
    if (url.pathname === '/api/command' && req.method === 'POST') {
      const body = await readBody(req);
      let text = body;
      try {
        text = String(JSON.parse(body).text ?? '');
      } catch {
        // Plain-text body.
      }
      const reply = await submit(text, httpView);
      return json(res, 200, { reply, tick: game.state.tick });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = normalize(join(config.webDir, rel));
    if (!file.startsWith(config.webDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      if (!existsSync(join(config.webDir, 'index.html'))) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('Web app not built. Run "pnpm build".');
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

// ---- WebSocket ----

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const client: Client = {
    id: `c${++clientSeq}`,
    ws,
    view: { camera: defaultCamera(game.state), viewport: { w: 1280, h: 800 } },
    cameraTouched: false,
  };
  clients.set(ws, client);
  send(ws, { t: 'hello', clientId: client.id, catalog: Game.catalog(), camera: client.view.camera, log: game.log.slice(-80), agent: agent.name });
  send(ws, game.snapshot());
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.t === 'viewport') {
      client.view.viewport = { w: Math.max(200, Math.min(8000, msg.w | 0)), h: Math.max(200, Math.min(8000, msg.h | 0)) };
      if (!client.cameraTouched) {
        client.view.camera = defaultCamera(game.state, client.view.viewport);
        send(ws, { t: 'camera', camera: client.view.camera });
      }
    } else if (msg.t === 'camera' && msg.camera && [msg.camera.x, msg.camera.y, msg.camera.zoom].every(Number.isFinite)) {
      // The player moved their own view with mouse or keys; text commands continue from here.
      client.cameraTouched = true;
      client.view.camera = clampCamera(msg.camera, { w: game.state.width, h: game.state.height });
    } else if (msg.t === 'cmd' && typeof msg.text === 'string') {
      void submit(msg.text, client.view, () => {
        client.cameraTouched = true;
        send(ws, { t: 'camera', camera: client.view.camera });
      });
    }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

// ---- tick loop (drift-corrected, fixed 10 Hz) ----

const TICK_MS = TICK_SECONDS * 1000;
let nextAt = performance.now();
let ticks = 0;
function loop(): void {
  const now = performance.now();
  let steps = 0;
  while (now >= nextAt && steps < 5) {
    game.tick();
    ticks++;
    if (ticks % SNAPSHOT_EVERY_TICKS === 0 && clients.size > 0) broadcast(game.snapshot());
    nextAt += TICK_MS;
    steps++;
  }
  if (now - nextAt > 1000) nextAt = now; // fell far behind (sleep/suspend): skip ahead
  setTimeout(loop, Math.max(0, nextAt - performance.now()));
}

const autosaveTimer = setInterval(() => game.autosave(), config.autosaveSeconds * 1000);

function shutdown(): void {
  clearInterval(autosaveTimer);
  game.autosave();
  console.log('Autosaved. Bye.');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---- console: stdin lines are commands too ----

if (!process.argv.includes('--no-console')) {
  const consoleView: ClientView = { camera: defaultCamera(game.state), viewport: { w: 1280, h: 800 } };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    void submit(line, consoleView);
  });
  rl.on('close', () => {
    // stdin closed (e.g. running detached): keep serving.
  });
}

function listening(where: string): void {
  console.log(`Sloptory engine on ${where} · agent: ${agent.name} · saves: ${config.savesDir}`);
  console.log(resumed ? `Resumed autosave at T+${Math.floor(game.state.time)}s.` : 'Started a new game.');
  loop();
}

if (config.socket) {
  if (existsSync(config.socket)) unlinkSync(config.socket);
  server.listen(config.socket, () => listening(`unix:${config.socket}`));
} else {
  server.listen(config.port, config.host, () => listening(`http://${config.host}:${config.port}`));
}
