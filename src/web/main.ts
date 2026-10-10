// Web interface: streams the factory from the engine, sends text, and lets the player look
// around with mouse, trackpad and keyboard. Changing the factory is text-only.

import type { Camera } from '../game/api.ts';
import { MAX_ZOOM, MIN_ZOOM, clamp, clampCamera, fitCamera, screenToWorld } from '../shared/camera.ts';
import { TILE_PX, type CatalogView, type ClientMessage, type LogEntry, type MachineView, type ServerMessage, type Snapshot } from '../shared/protocol.ts';
import { Renderer, STATUS_COLOR } from './render.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('floor');
const renderer = new Renderer(canvas);
let catalog: CatalogView | null = null;
let ws: WebSocket | null = null;
let retry = 500;
const snaps: { snap: Snapshot; at: number }[] = [];
const INTERP_MS = 200;

function sendMsg(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendViewport(): void {
  sendMsg({ t: 'viewport', w: window.innerWidth, h: window.innerHeight });
}

function latest(): Snapshot | null {
  return snaps.length ? snaps[snaps.length - 1].snap : null;
}

function world(): { w: number; h: number } {
  return latest()?.world ?? { w: 120, h: 80 };
}

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

// ---------- camera ----------
// `cam` is what is drawn; `target` is where it is heading. Direct manipulation (drag, trackpad,
// keys) moves both at once; animated moves (wheel notches, +/-, fit, server focus) ease `cam`
// toward `target`. A zoom anchor keeps the tile under the cursor fixed while zoom animates.

let cam: Camera = { x: 30, y: 20, zoom: 1 };
let target: Camera = { ...cam };
let anchor: { sx: number; sy: number; wx: number; wy: number } | null = null;
let fling = { x: 0, y: 0 };
let touched = false;

function anchoredCenter(a: NonNullable<typeof anchor>, zoom: number): { x: number; y: number } {
  const vp = viewport();
  const s = TILE_PX * zoom;
  return { x: a.wx - (a.sx - vp.w / 2) / s, y: a.wy - (a.sy - vp.h / 2) / s };
}

function setBoth(c: Camera): void {
  cam = clampCamera(c, world());
  target = { ...cam };
  anchor = null;
  cameraChanged();
}

function panBy(dx: number, dy: number): void {
  cam = clampCamera({ ...cam, x: cam.x + dx, y: cam.y + dy }, world());
  if (anchor) {
    anchor.wx += dx;
    anchor.wy += dy;
    target = clampCamera({ ...target, ...anchoredCenter(anchor, target.zoom) }, world());
  } else {
    target = clampCamera({ ...target, x: target.x + dx, y: target.y + dy }, world());
  }
  cameraChanged();
}

/** Zoom by `factor` keeping screen point (sx, sy) fixed. Animated unless `instant`. */
function zoomAt(factor: number, sx: number, sy: number, instant: boolean): void {
  const base = instant ? cam.zoom : target.zoom;
  const zoom = clamp(base * factor, MIN_ZOOM, MAX_ZOOM);
  const w = screenToWorld(cam, viewport(), sx, sy);
  const a = { sx, sy, wx: w.x, wy: w.y };
  if (instant) {
    setBoth({ zoom, ...anchoredCenter(a, zoom) });
    return;
  }
  anchor = a;
  target = clampCamera({ zoom, ...anchoredCenter(a, zoom) }, world());
  cameraChanged();
}

function fitFactory(): void {
  const s = latest();
  if (!s || !catalog) return;
  const sizes = new Map(catalog.machines.map((m) => [m.id, m]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of s.machines) {
    const d = sizes.get(m.type)!;
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + d.w);
    y1 = Math.max(y1, m.y + d.h);
  }
  const rect = s.machines.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: s.world.w, h: s.world.h };
  anchor = null;
  target = clampCamera(fitCamera(rect, viewport()), world());
  cameraChanged();
}

// Tell the server where we are looking (text commands like "place a kiln" use it), throttled.
let syncTimer = 0;
let lastSync = 0;
function cameraChanged(): void {
  touched = true;
  if (syncTimer) return;
  const wait = Math.max(0, 250 - (performance.now() - lastSync));
  syncTimer = window.setTimeout(() => {
    syncTimer = 0;
    lastSync = performance.now();
    sendMsg({ t: 'camera', camera: target });
  }, wait);
}

// ---------- socket ----------

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 500;
    setLink(true);
    sendViewport();
    if (touched) sendMsg({ t: 'camera', camera: target });
  };
  ws.onclose = () => {
    setLink(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data as string) as ServerMessage);
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'hello':
      catalog = msg.catalog;
      if (!touched) {
        cam = { ...msg.camera };
        target = { ...msg.camera };
      }
      $('agent').textContent = msg.agent === 'parser' ? 'built-in parser (no LLM key)' : msg.agent;
      $('log').innerHTML = '';
      for (const e of msg.log) appendLog(e, false);
      break;
    case 'state':
      snaps.push({ snap: msg, at: performance.now() });
      if (snaps.length > 3) snaps.shift();
      updateHud(msg);
      break;
    case 'log':
      for (const e of msg.entries) appendLog(e, true);
      break;
    case 'camera':
      // A text command (or a new/loaded game) moved this view.
      anchor = null;
      target = clampCamera(msg.camera, world());
      break;
    case 'busy':
      $('busy').hidden = !msg.busy;
      break;
  }
}

function setLink(live: boolean): void {
  const el = $('link');
  el.classList.toggle('live', live);
  el.querySelector('span')!.textContent = live ? 'live' : 'offline';
}

// ---------- HUD ----------

function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

function clock(t: number): string {
  const s = Math.floor(t);
  return `T+${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function updateHud(s: Snapshot): void {
  if (!catalog) return;
  const items = new Map(catalog.items.map((i) => [i.id, i]));
  $('game-name').textContent = s.name;
  $('cash').textContent = money(s.cash);
  const rate = $('rate');
  rate.textContent = `${s.perMinute.revenue >= 0 ? '+' : ''}${money(s.perMinute.revenue)}/min`;
  rate.classList.toggle('up', s.perMinute.revenue > 0);
  $('clock').textContent = clock(s.time);
  $('speed').textContent = s.speed === 0 ? 'PAUSED' : `${s.speed}×`;
  const p = s.power;
  $('power').textContent = `${Math.round(p.demand)} / ${p.capacity} kW`;
  const bar = $('power-bar');
  bar.style.width = `${Math.min(100, (p.demand / p.capacity) * 100)}%`;
  bar.style.background = p.satisfaction < 1 ? 'var(--bad)' : p.demand / p.capacity > 0.8 ? 'var(--warn)' : 'var(--ok)';
  const shipped = Object.values(s.shipped).reduce((a, b) => a + b, 0);
  $('shipped').textContent = shipped.toLocaleString('en-US');
  $('shipped-rate').textContent = `${s.perMinute.shipped}/min`;
  const stockTotal = Object.values(s.stock).reduce((a, b) => a + b, 0);
  $('stock-total').textContent = stockTotal.toLocaleString('en-US');
  $('stock-cap').textContent = `/ ${s.stockCap.toLocaleString('en-US')}`;
  const processing = s.machines.filter((m) => m.status !== 'ready');
  $('floor-running').textContent = `${processing.filter((m) => m.status === 'working').length} / ${processing.length}`;
  $('floor-belts').textContent = `running · ${s.belts.length} belts`;

  const orders = $('orders');
  orders.replaceChildren();
  if (s.orders.length === 0) orders.append(el('li', 'empty', 'No open orders'));
  for (const o of s.orders) {
    const li = el('li', 'order');
    li.append(el('span', 'what', `${o.id} · ${o.qty}× ${items.get(o.item)?.name ?? o.item}`));
    li.append(el('span', 'due', clock(Math.max(0, o.expiresAt - s.time)).slice(2)));
    const barWrap = el('span', 'bar');
    const fill = el('span');
    fill.style.width = `${(o.filled / o.qty) * 100}%`;
    barWrap.append(fill);
    li.append(barWrap);
    li.append(el('span', 'pay', `${o.filled}/${o.qty} delivered · ${money(o.price)} each`));
    orders.append(li);
  }

  const lines = $('lines');
  lines.replaceChildren();
  if (s.lines.length === 0) lines.append(el('li', 'empty', 'No lines yet. Try “build a mug line”'));
  for (const l of s.lines) {
    const li = el('li', 'line-row');
    li.append(el('span', '', l.name));
    const lamps = el('span', 'lamps');
    for (const m of s.machines) {
      if (m.line !== l.id || m.status === 'ready') continue;
      const lamp = el('i', `lamp ${m.status}`);
      lamp.title = `${m.name ?? m.id}: ${m.status}`;
      lamps.append(lamp);
    }
    li.append(lamps);
    lines.append(li);
  }

  const auto = $('autobuy');
  auto.textContent = s.autobuy ? 'autobuy on' : 'autobuy off';
  auto.classList.toggle('on', s.autobuy);
  const stock = $('stock');
  stock.replaceChildren();
  const entries = Object.entries(s.stock).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) stock.append(el('li', 'empty', 'Empty. Try “buy 200 clay”'));
  for (const [id, q] of entries.slice(0, 16)) {
    const li = el('li');
    const sw = el('i', 'sw');
    sw.style.background = items.get(id)?.color ?? '#888';
    li.append(sw, el('span', 'nm', items.get(id)?.name ?? id), el('span', 'q', q.toLocaleString('en-US')));
    stock.append(li);
  }
}

// ---------- console ----------

const logEl = $('log');

function appendLog(e: LogEntry, animate: boolean): void {
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const div = el('div', `entry ${e.kind}`);
  div.append(el('span', 't', clock(e.time).slice(2)));
  const body = el('span', 'body');
  div.append(body);
  if (e.via && e.kind !== 'player' && e.kind !== 'tool') div.append(el('span', 'via', `· ${e.via}`));
  logEl.append(div);
  while (logEl.childElementCount > 300) logEl.firstElementChild!.remove();
  if (animate && (e.kind === 'agent' || e.kind === 'error')) {
    // Teletype: print the reply quickly instead of popping it in.
    const text = e.text;
    const start = performance.now();
    const dur = Math.min(700, text.length * 6);
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / dur);
      body.textContent = text.slice(0, Math.ceil(text.length * k));
      if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
      if (k < 1) requestAnimationFrame(tick);
    };
    tick();
  } else {
    body.textContent = e.text;
  }
  if (nearBottom || !animate) logEl.scrollTop = logEl.scrollHeight;
}

const input = $<HTMLInputElement>('cmd');
const history: string[] = [];
let histPos = 0;

$<HTMLFormElement>('prompt').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendMsg({ t: 'cmd', text });
  if (history[history.length - 1] !== text) history.push(text);
  histPos = history.length;
  input.value = '';
  logEl.scrollTop = logEl.scrollHeight;
});

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    input.blur();
    ev.preventDefault();
  } else if (ev.key === 'ArrowUp' && history.length) {
    histPos = Math.max(0, histPos - 1);
    input.value = history[histPos];
    ev.preventDefault();
  } else if (ev.key === 'ArrowDown' && history.length) {
    histPos = Math.min(history.length, histPos + 1);
    input.value = history[histPos] ?? '';
    ev.preventDefault();
  }
});

function updateMode(): void {
  const typing = document.activeElement === input;
  document.body.classList.toggle('typing', typing);
  document.body.classList.toggle('navigating', !typing);
  input.placeholder = typing ? 'Tell the factory what to do. Try “build a mug line”' : 'Press Enter or / to type a command';
}
input.addEventListener('focus', updateMode);
input.addEventListener('blur', updateMode);

// ---------- keyboard navigation (only while the text box is not focused) ----------

const PAN_KEYS: Record<string, [number, number]> = {
  arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0], arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1],
};
const held = new Set<string>();
let fast = false;
let keyVel = { x: 0, y: 0 };

window.addEventListener('keydown', (ev) => {
  if (document.activeElement === input || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  fast = ev.shiftKey;
  if (k === 'enter' || k === '/') {
    input.focus();
    ev.preventDefault();
  } else if (k in PAN_KEYS) {
    if (!held.has(k)) {
      // A fresh press starts moving at once, so a quick tap still nudges the view.
      const kick = (0.5 * (fast ? 1800 : 900)) / (TILE_PX * cam.zoom);
      keyVel = { x: keyVel.x + PAN_KEYS[k][0] * kick, y: keyVel.y + PAN_KEYS[k][1] * kick };
    }
    held.add(k);
    fling = { x: 0, y: 0 };
    ev.preventDefault();
  } else if (k === '+' || k === '=') {
    zoomAt(1.35, viewport().w / 2, viewport().h / 2, false);
    ev.preventDefault();
  } else if (k === '-' || k === '_') {
    zoomAt(1 / 1.35, viewport().w / 2, viewport().h / 2, false);
    ev.preventDefault();
  } else if (k === 'f' || k === 'home') {
    fitFactory();
    ev.preventDefault();
  }
});
window.addEventListener('keyup', (ev) => {
  held.delete(ev.key.toLowerCase());
  fast = ev.shiftKey;
});
window.addEventListener('blur', () => held.clear());

// ---------- mouse and trackpad ----------

let drag: { id: number; x: number; y: number } | null = null;
/** Recent pointer positions, for release momentum measured over real elapsed time. */
let trail: { t: number; x: number; y: number }[] = [];
const FLING_MAX_PX = 2500;

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 && ev.button !== 1) return;
  input.blur();
  drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  fling = { x: 0, y: 0 };
  trail = [{ t: performance.now(), x: ev.clientX, y: ev.clientY }];
  if (anchor) setBoth(cam);
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add('dragging');
  hideTip();
  ev.preventDefault();
});

canvas.addEventListener('pointermove', (ev) => {
  if (drag && ev.pointerId === drag.id) {
    const s = TILE_PX * cam.zoom;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    drag.x = ev.clientX;
    drag.y = ev.clientY;
    panBy(-dx / s, -dy / s);
    const now = performance.now();
    trail.push({ t: now, x: ev.clientX, y: ev.clientY });
    while (trail.length > 2 && now - trail[0].t > 120) trail.shift();
    return;
  }
  hover = { sx: ev.clientX, sy: ev.clientY };
});

function endDrag(ev: PointerEvent): void {
  if (!drag || ev.pointerId !== drag.id) return;
  // Keep a little momentum if the pointer was still moving when released.
  const now = performance.now();
  const first = trail[0];
  const lastP = trail[trail.length - 1];
  if (first && lastP && now - lastP.t < 60) {
    const dt = Math.max(0.04, (lastP.t - first.t) / 1000);
    let vx = (first.x - lastP.x) / dt;
    let vy = (first.y - lastP.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed > FLING_MAX_PX) {
      vx *= FLING_MAX_PX / speed;
      vy *= FLING_MAX_PX / speed;
    }
    const s = TILE_PX * cam.zoom;
    if (speed > 300) fling = { x: vx / s, y: vy / s };
  }
  trail = [];
  drag = null;
  canvas.classList.remove('dragging');
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => {
  hover = null;
  hideTip();
});

/** Mouse wheels zoom; trackpad two-finger scrolls pan; pinch (ctrl+wheel) zooms. */
type WheelKind = 'pinch' | 'pan' | 'notch';
let gesture: { kind: WheelKind; at: number } | null = null;
const MAC_LINE = 4.000244140625;

function classifyWheel(ev: WheelEvent): WheelKind {
  if (ev.ctrlKey || ev.metaKey) return 'pinch';
  const now = performance.now();
  // Events of one gesture (including trackpad momentum) arrive within a few frames of each other.
  if (gesture && now - gesture.at < 150) {
    gesture.at = now;
    if (gesture.kind === 'notch' && ev.deltaX !== 0) gesture.kind = 'pan';
    return gesture.kind;
  }
  let kind: WheelKind;
  const dy = Math.abs(ev.deltaY);
  const legacy = (ev as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  if (ev.deltaMode !== 0) kind = 'notch'; // lines/pages: a physical wheel (Firefox)
  else if (ev.deltaX !== 0) kind = 'pan'; // a horizontal component: a trackpad
  else if (dy > 0 && dy < 60 && Math.abs(dy / MAC_LINE - Math.round(dy / MAC_LINE)) < 1e-6) kind = 'notch'; // macOS wheel line steps
  else if (legacy !== undefined && legacy !== 0 && Math.abs(legacy) % 120 === 0) kind = 'notch'; // classic 120-unit wheel
  else if (dy >= 50 && Number.isInteger(ev.deltaY)) kind = 'notch';
  else kind = 'pan';
  gesture = { kind, at: now };
  return kind;
}

window.addEventListener(
  'wheel',
  (ev) => {
    const overPanel = (ev.target as HTMLElement).closest('#console, #side, #hud');
    if (overPanel) {
      if (ev.ctrlKey) ev.preventDefault(); // no page zoom from a pinch over the panels
      return;
    }
    ev.preventDefault();
    hideTip();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? window.innerHeight : 1;
    const kind = classifyWheel(ev);
    if (kind === 'pinch') {
      zoomAt(Math.exp(-ev.deltaY * unit * 0.01), ev.clientX, ev.clientY, true);
    } else if (kind === 'pan') {
      const s = TILE_PX * cam.zoom;
      fling = { x: 0, y: 0 };
      const horizontal = ev.shiftKey && ev.deltaX === 0;
      panBy(((horizontal ? ev.deltaY : ev.deltaX) * unit) / s, (horizontal ? 0 : ev.deltaY * unit) / s);
    } else {
      const steps = clamp(Math.abs(ev.deltaY * unit) / 100, 1, 3) * Math.sign(ev.deltaY);
      if (steps !== 0) zoomAt(Math.pow(1.2, -steps), ev.clientX, ev.clientY, false);
    }
  },
  { passive: false },
);

// Safari reports trackpad pinches as gesture events.
let gestureZoom = 1;
window.addEventListener('gesturestart', (ev) => {
  ev.preventDefault();
  gestureZoom = cam.zoom;
});
window.addEventListener('gesturechange', (ev) => {
  ev.preventDefault();
  const g = ev as Event & { scale: number; clientX: number; clientY: number };
  zoomAt((gestureZoom * g.scale) / cam.zoom, g.clientX, g.clientY, true);
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(sendViewport, 200);
});

// ---------- hover tooltip ----------

let hover: { sx: number; sy: number } | null = null;
let hoverId: string | null = null;
const tip = $('tip');

function hideTip(): void {
  tip.hidden = true;
  hoverId = null;
}

function bagText(b: Record<string, number>): string {
  const names = new Map(catalog!.items.map((i) => [i.id, i.name]));
  const parts = Object.entries(b).map(([k, q]) => `${q} ${names.get(k) ?? k}`);
  return parts.length ? parts.join(', ') : 'empty';
}

function machineAt(s: Snapshot, x: number, y: number): MachineView | null {
  const sizes = new Map(catalog!.machines.map((m) => [m.id, m]));
  for (const m of s.machines) {
    const d = sizes.get(m.type)!;
    if (x >= m.x && y >= m.y && x < m.x + d.w && y < m.y + d.h) return m;
  }
  return null;
}

function updateTip(): void {
  const s = latest();
  if (!hover || drag || !s || !catalog) {
    if (!tip.hidden) hideTip();
    return;
  }
  const w = screenToWorld(cam, viewport(), hover.sx, hover.sy);
  const m = machineAt(s, w.x, w.y);
  if (!m) {
    if (!tip.hidden) hideTip();
    return;
  }
  hoverId = m.id;
  const d = catalog.machines.find((x) => x.id === m.type)!;
  const recipe = m.recipe ? catalog.recipes.find((r) => r.id === m.recipe) : null;
  const line = m.line ? s.lines.find((l) => l.id === m.line)?.name : null;
  const n = m.id.slice(m.id.lastIndexOf('-') + 1);
  tip.replaceChildren();
  const head = el('div', 'tip-head');
  head.append(el('b', '', m.name ?? `${d.name} ${n}`), el('span', 'tip-id', m.id));
  const status = el('div', 'tip-status', m.status);
  status.style.color = STATUS_COLOR[m.status] ?? '#ccc';
  tip.append(head, el('div', 'tip-type', `${d.name} · ${d.w}×${d.h} · ${d.power} kW${line ? ` · ${line}` : ''}`), status);
  if (d.role === 'process') {
    tip.append(el('div', '', recipe ? `${recipe.name} · ${recipe.time}s cycle` : 'No recipe set'));
    tip.append(el('div', 'tip-buf', `in: ${bagText(m.input)}`), el('div', 'tip-buf', `out: ${bagText(m.output)}`));
  } else if (d.role === 'storage') {
    tip.append(el('div', 'tip-buf', `shared stock: ${Object.values(s.stock).reduce((a, b) => a + b, 0)} / ${s.stockCap}`));
  }
  tip.hidden = false;
  const vp = viewport();
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(hover.sx + 16, vp.w - r.width - 8)}px`;
  tip.style.top = `${Math.min(hover.sy + 16, vp.h - r.height - 8)}px`;
}

// ---------- render loop ----------

let last = performance.now();
let tipAt = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // Held keys pan at a constant screen speed with a short ease in and out.
  let kx = 0;
  let ky = 0;
  for (const k of held) {
    kx += PAN_KEYS[k][0];
    ky += PAN_KEYS[k][1];
  }
  const len = Math.hypot(kx, ky) || 1;
  const speed = held.size ? (fast ? 1800 : 900) / (TILE_PX * cam.zoom) : 0;
  const ease = 1 - Math.exp(-dt * 14);
  keyVel = { x: keyVel.x + ((kx / len) * speed - keyVel.x) * ease, y: keyVel.y + ((ky / len) * speed - keyVel.y) * ease };
  if (Math.abs(keyVel.x) + Math.abs(keyVel.y) > 0.01) panBy(keyVel.x * dt, keyVel.y * dt);
  else keyVel = { x: 0, y: 0 };

  if (!drag && Math.abs(fling.x) + Math.abs(fling.y) > 0.05) {
    panBy(fling.x * dt, fling.y * dt);
    const decay = Math.exp(-dt * 5);
    fling = { x: fling.x * decay, y: fling.y * decay };
  }

  const k = 1 - Math.exp(-dt * 12);
  if (anchor) {
    const zoom = cam.zoom * Math.pow(target.zoom / cam.zoom, k);
    const done = Math.abs(Math.log(zoom / target.zoom)) < 0.002;
    const z = done ? target.zoom : zoom;
    cam = clampCamera({ zoom: z, ...anchoredCenter(anchor, z) }, world());
    if (done) anchor = null;
  } else {
    cam = {
      x: cam.x + (target.x - cam.x) * k,
      y: cam.y + (target.y - cam.y) * k,
      zoom: cam.zoom * Math.pow(target.zoom / cam.zoom, k),
    };
  }

  $('view').textContent = `${Math.round(target.x)},${Math.round(target.y)}`;
  $('zoom').textContent = `${target.zoom.toFixed(2)}×`;
  if (now - tipAt > 120) {
    tipAt = now;
    updateTip();
  }
  if (catalog && snaps.length > 0) {
    const renderAt = now - INTERP_MS;
    let prev: Snapshot | null = null;
    let curr = snaps[snaps.length - 1].snap;
    let alpha = 1;
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].at <= renderAt) {
        prev = snaps[i - 1].snap;
        curr = snaps[i].snap;
        alpha = Math.max(0, Math.min(1, (renderAt - snaps[i - 1].at) / Math.max(1, snaps[i].at - snaps[i - 1].at)));
        break;
      }
    }
    renderer.draw({ cam, prev, curr, alpha, catalog, now: now / 1000, hoverId });
  }
  requestAnimationFrame(frame);
}

connect();
input.focus();
updateMode();
requestAnimationFrame(frame);
