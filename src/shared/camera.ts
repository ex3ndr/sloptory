// Camera math shared by the engine (text camera commands) and the web client (mouse/keyboard).

import type { Camera } from '../game/api.ts';
import { TILE_PX, VIEW_INSETS } from './protocol.ts';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 3;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Keeps the zoom in range and the view centre on (or just around) the floor. */
export function clampCamera(c: Camera, world: { w: number; h: number }): Camera {
  return {
    x: clamp(c.x, -5, world.w + 5),
    y: clamp(c.y, -5, world.h + 5),
    zoom: clamp(c.zoom, MIN_ZOOM, MAX_ZOOM),
  };
}

/** Camera that fits a rect into the part of the screen not covered by the HUD panels. */
export function fitCamera(r: Box, viewport: { w: number; h: number }, pad = 3): Camera {
  const i = VIEW_INSETS;
  const w = Math.max(320, viewport.w - i.left - i.right);
  const h = Math.max(200, viewport.h - i.top - i.bottom);
  const zoom = clamp(Math.min(w / ((r.w + pad * 2) * TILE_PX), h / ((r.h + pad * 2) * TILE_PX)), MIN_ZOOM, 2.2);
  // Shift so the rect sits in the middle of the free area rather than the screen.
  const dx = (i.right - i.left) / 2 / (TILE_PX * zoom);
  const dy = (i.bottom - i.top) / 2 / (TILE_PX * zoom);
  return { x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, zoom };
}

/** Screen pixel -> tile coordinates for a camera and viewport. */
export function screenToWorld(c: Camera, viewport: { w: number; h: number }, sx: number, sy: number): { x: number; y: number } {
  const s = TILE_PX * c.zoom;
  return { x: c.x + (sx - viewport.w / 2) / s, y: c.y + (sy - viewport.h / 2) / s };
}
