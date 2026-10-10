# Sloptory

A browser-based tech factory simulation where the only way to change the factory is text: tell an
agent what to build and watch it design and wire the plant.

You run a plant that makes ceramic mugs, smart kettles, smartwatches and smartphones, with real
production hardware: receiving docks and warehouses, CNC mills, deep-draw presses, injection
molders, anodizing tanks, SMT pick-and-place, reflow ovens, AOI, PCB test, kilns, glazing and
slip casting, final assembly, test benches, QA, packaging and shipping. Think Factorio without
the fiddly parts: you say what connects to what and the engine routes the conveyors.

## Run it

```sh
pnpm install
pnpm dev        # http://127.0.0.1:4780
```

Node ≥ 23.6 is required. The game autosaves to `saves/` and resumes on restart.

## Play

**Look around** with the mouse and keyboard: drag (or two-finger scroll on a trackpad) to pan,
mouse wheel or pinch to zoom toward the cursor, WASD / arrow keys to pan, `+` / `-` to zoom and
`F` or `Home` to fit the whole factory. Hover a machine for its recipe, status and buffers. Keys
navigate while the text box is not focused: `Esc` or a click on the floor leaves it, `Enter` or `/`
goes back.

**Change the factory** only by typing into the console:

```
I want to make smart kettles      add a second assembly station to the kettle line
build me a smartphone factory     why is the mug line slow? · fix it
status · orders · stock · diagnose · info kiln 1 · rename kiln 1 to Bisque kiln
save as day1 · load day1 · saves · new game · speed 4 · go to the kettle line
```

With `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set, an LLM agent (default
`anthropic/claude-sonnet-5.5` on OpenRouter; override with `SLOPTORY_MODEL`) designs layouts itself:
it reads the catalog and the floor, places machines, wires conveyors in batches, checks its work with
a diagnose tool, and buys materials. You watch machines appear as it works. Without a key, a
built-in parser handles direct commands such as `build a mug line` (prefab blueprints),
`place a kiln at 60,30`, `connect kiln 3 to qa 1` and `buy 200 clay`.

See [AGENTS.md](AGENTS.md) for architecture, configuration and tests.
