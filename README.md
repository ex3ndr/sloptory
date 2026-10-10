# Sloptory

A browser-based tech factory simulation where the only control is text: tell an agent what to
build and watch the factory change.

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

There are no buttons. Type into the console:

```
build a mug line                 buy 200 clay; buy 100 glaze; buy 100 cartons
autobuy on                       speed 4
build a smart kettle line        go to the smt line · zoom in · left 10 · overview
place a kiln at 60,30            connect kiln 3 to qa 1 · set kiln 3 to glaze firing
status · orders · stock · info kiln 1 · recipes for cnc · help
save as day1 · load day1 · saves · new game
```

With `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` set, an LLM agent handles free-form
requests ("get me making phones and keep the line stocked") through the same command API. Without
a key, a built-in parser understands the commands above.

See [AGENTS.md](AGENTS.md) for architecture, configuration and tests.
