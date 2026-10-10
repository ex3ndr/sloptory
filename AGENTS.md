# Sloptory — agent notes

A browser factory sim where the only input is text. The Node server is the game engine and runs
one game; the web page only renders the streamed state and sends text.

## Setup and commands

Requires Node ≥ 23.6 (TypeScript runs natively via type stripping, no compile step) and pnpm.

```sh
pnpm install
pnpm dev          # build the web bundle, then start the engine on http://127.0.0.1:4780
pnpm start        # start the engine only (expects dist/web from `pnpm build`)
pnpm test         # node:test unit tests in test/
pnpm typecheck    # tsc --noEmit
pnpm build        # esbuild src/web -> dist/web
pnpm check        # typecheck + test + build
pnpm smoke [url]  # end-to-end check against a running engine (starts a NEW game there; the old one is autosaved)
```

Server flags / env: `--port`/`PORT` (4780), `--host`/`HOST` (127.0.0.1), `--socket`/`SLOPTORY_SOCKET`
(unix socket instead of TCP), `--saves`/`SLOPTORY_SAVES` (./saves), `--new` (ignore the autosave),
`--no-console` (don't read commands from stdin), `SLOPTORY_AUTOSAVE_SECONDS` (60).

Agent selection: `SLOPTORY_AGENT=auto|parser|anthropic|openai|openrouter` (default auto). Auto uses the
first key found among `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, otherwise the
built-in parser. `SLOPTORY_MODEL` overrides the model; `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` override endpoints.

Tests write temporary saves under `os.tmpdir()`; in a sandbox where that is read-only, run them
with `TMPDIR=$PWD/.context/tmp`. Scratch files go in `.context/` (gitignored).

## Layout

```
src/engine/    pure, deterministic simulation (no I/O)
  catalog.ts     items, machines, recipes — all data-driven; add content here
  state.ts       GameState (plain JSON), constants, seeded RNG
  world.ts       footprints, occupancy, capacities, free-space search
  routing.ts     A* conveyor routing and re-routing after layout changes
  sim.ts         fixed 0.1 s step: power, machine cycles, belt transport
  economy.ts     buying, selling/shipping, orders, autobuy
  ops.ts         place / remove / move / connect / disconnect / set recipe
  blueprints.ts  complete production lines (mug, kettle, watch, phone)
  resolve.ts     forgiving name resolution ("kiln 1", "aluminium", "the mug line")
  save.ts        save file (de)serialization
src/game/      api.ts (the Command union), game.ts (Game: exec, tick, save/load, snapshot), report.ts (text replies)
src/agent/     parser.ts (deterministic text -> Commands), agent.ts (ParserAgent), llm.ts + tools.ts (LLM tool calling)
src/server/    main.ts: HTTP static + /api/*, WebSocket /ws, 10 Hz tick loop, autosave, stdin console
src/shared/    protocol.ts: wire messages shared by server and web
src/web/       index.html, style.css, main.ts (socket, HUD, console), render.ts (canvas renderer)
scripts/       build.ts (esbuild), smoke.ts (end-to-end client)
test/          unit tests for recipes, routing, economy, blueprints, save/load, parser
```

## Architecture rules

- Every state change goes through `Game.exec(command, view)`. The parser and the LLM both emit the
  same `Command`s (`src/game/api.ts`); LLM tools in `tools.ts` are a thin mirror of that union.
- The engine is deterministic: no `Math.random`/`Date` in `src/engine`; use `random(state)`. The
  save round-trip test relies on this. `GameState` must stay plain JSON (no Maps or classes).
- Logistics model: purchases go into one shared stock (needs a receiving dock). A dock or warehouse
  connected to a machine dispatches whatever stock items that machine's recipe needs. Belts are
  auto-routed; players never place belt tiles. The shipping dock sells `product` items.
- Camera is per-client view state held by the server (`ClientView`) and pushed to that client; it
  only changes via text commands. Simple camera/time/save commands take the parser fast path
  even when an LLM is configured.
- Server → client: `hello` (catalog), `state` snapshots at 5 Hz, `log`, `camera`, `busy`.
  Client → server: `cmd` (text) and `viewport` (window size, for camera fitting).
- TypeScript is run by Node's type stripping: import with `.ts` extensions, use `import type` for
  types, and avoid enums, namespaces and constructor parameter properties (`erasableSyntaxOnly`).
