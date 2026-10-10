// The one command API on the engine. Both the deterministic parser and the LLM agent
// produce these; Game.exec() is the only thing that executes them. Name fields accept
// exact ids ("kiln-1", "clay", "glaze_fire") or loose names ("kiln 1", "aluminium").

export type QueryKind =
  | 'status'
  | 'machines'
  | 'machine'
  | 'stock'
  | 'orders'
  | 'recipes'
  | 'catalog'
  | 'blueprints'
  | 'power'
  | 'lines';

/** pan: relative (dx, dy). center: absolute tile (x, y). zoom: factor or level. focus: a named target. */
export type CameraAction = 'pan' | 'center' | 'zoom' | 'focus' | 'overview';

export type Command =
  | { op: 'help'; topic?: string }
  | { op: 'place'; machine: string; x?: number; y?: number; recipe?: string; count?: number }
  | { op: 'remove'; target: string }
  | { op: 'move'; target: string; x: number; y: number }
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; from: string; to?: string }
  | { op: 'set_recipe'; target: string; recipe: string }
  | { op: 'buy'; item: string; qty: number }
  | { op: 'sell'; item: string; qty: number | 'all' }
  | { op: 'blueprint'; name: string; x?: number; y?: number }
  | { op: 'query'; what: QueryKind; target?: string }
  | {
      op: 'camera';
      action: CameraAction;
      dx?: number;
      dy?: number;
      x?: number;
      y?: number;
      factor?: number;
      level?: number;
      target?: string;
    }
  | { op: 'speed'; value: number }
  | { op: 'resume' }
  | { op: 'autobuy'; on: boolean }
  | { op: 'new_game'; name?: string }
  | { op: 'save'; name?: string }
  | { op: 'load'; name: string }
  | { op: 'list_saves' };

export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface Camera {
  /** Center of the view, in tiles. */
  x: number;
  y: number;
  /** 1 = TILE_PX pixels per tile. */
  zoom: number;
}

/** Per-client view state. Only text commands change it; the server pushes it to the client. */
export interface ClientView {
  camera: Camera;
  viewport: { w: number; h: number };
}
