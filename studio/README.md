# TRP Studio

TRP Studio runs a live system against a Trust Requirements Profile in your browser. You change the conditions, the open TRP engine evaluates every tick, and the standing, signals, hard rules and event log update in real time. Nothing leaves the page.

## Run It

Open the hosted Studio, or run it from a clone:

```bash
git clone https://github.com/aitrustalliance/trp
cd trp
python3 -m http.server 8000
```

Then open http://localhost:8000/studio/ in a browser. The Studio has no build step and no dependencies.

Useful links:

| Link | Opens |
|---|---|
| `studio/?pack=robot-cell` | A specific pack |
| `studio/?story=0` | A pack without playing its story |
| `studio/?profile=<url>` | Any TRP profile at a public URL, built into a live demo |
| `studio/?pack=robot-cell&mode=arena` | Straight into the Arena |
| `studio/lab.html` | Experimental live inputs, real robot data and your webcam |

You can also drag any TRP profile or pack file onto the page, or use Import.

## Modes

**Command** is the first screen.

- 56 systems from the 4 packs that carry a harm model, each with its own simulator, each evaluated by the engine every tick (250 ms) against the pack's profile.
- Faults are the pack's Arena moves. Benign excursions are new to each pack and push one signal toward a limit with no harm present.
- The bar counts harm caught, harm missed and false stops over a five minute window. Definitions match `arena.js`: caught means stopped within the reaction window of harm onset, missed means harm ended without a stop, false stop means a stop with no harm present or near.
- The rule book dial applies one of four profiles per pack. Loose moves every limit one warning-to-critical gap past the harm point. Published is the profile as shipped. Tight moves every limit one gap toward safe. Tuned applies the `solution` limits shipped with the pack's Learn challenge, set by measurement over 300 fault runs.
- Measured over four minutes on the shipped packs: loose 71 caught, 106 missed, 23 false stops. Published 88, 89, 29. Tight 148, 0, 252. Tuned 177, 0, 54.
- A system opens to its evidence against its limits, then into Live. A pack joins the floor by carrying a `command` block (`group`, `unit`, `count`, `fault_rate`, `benign`, `benign_rate`) beside its `arena` harm model.

**Live** lets you change conditions and watch the profile respond. Click any event to see exactly which requirement caused it.

**Arena** is a daily strategy game. A scripted Challenger stages eight rounds of trouble, and you defend the system by spending a fixed budget on guards before the match starts. Each guard shields a signal, tightens a threshold or adds a rule. You score for every incident the system stops within 0.75 seconds and for keeping it running, and you lose points for needless stops. Medals compare your score with par, the best score any affordable set of guards can reach on that day's seed. The seed changes every day, so everyone plays the same match.

**Stress test** runs hundreds of episodes with random faults and reports how many the profile caught, missed or stopped on needlessly.

**Learn** hands you a profile with a gap in it. You change its limits, the Studio tests them against 300 runs with faults mixed in, and you see what your rules catch and where they stop for nothing. Challenges live in `studio/challenges.json`, and `tests/learn_challenges.js` checks that each one starts unsolved and can be solved. Below the challenges is the glossary, twenty-four terms on AI trust, safety and governance and the TRP specification at three depths, each with a documented case, the section of the specification it comes from, the wider frameworks and a self-check. It is `studio/codex.json`, rendered by `studio/codex.js`, and the Nautilus game shares it as the Captain's Codex.

The **Fleet** pack evaluates 144 robot cells at once, every frame, to show how fast the engine runs.

## Agents Can Play

Everything runs locally, so there is no server to overload. In the browser, `window.TRPGames` exposes `events()`, `play({ event, guards, seed })` and `stress({ event, episodes })`. From a terminal:

```bash
node studio/games-cli.js --list
node studio/games-cli.js --event robot-cell --guards second-sensor,speed-limit
node studio/games-cli.js --event robot-cell --stress 200
```

`studio/llms.txt` describes the rules for language model agents.

## Agent Matches

Agents can also play each other. `studio/match.js` runs a Guardian against a Challenger, or two legs with the sides swapped, between any programs that speak the TRP Arena Protocol over standard input and output. Matches run on your own machine, every result can be re-checked with `--verify`, and example contestants come in JavaScript and Python, including a template that asks a language model. See `studio/ARENA_PROTOCOL.md`.

```bash
node studio/match.js --event agno --versus builtin:greedy "python3 studio/agents/random_agent.py"
```

## Sharing

Share copies a link that replays your session. Record saves a video clip of the scene. Arena results come with a share line, a README badge, and links to post the result.

## Packs

Each example in the Studio is a scenario pack, a JSON file that pairs a TRP profile with a simulation and a story. The packs in `studio/packs/` are listed in `studio/packs/index.json`.

| Field | Meaning |
|---|---|
| `pack_version` | Always `"1"` for this format |
| `id`, `title`, `subtitle` | How the pack appears in the Studio |
| `scene` | The drawing to use: `robot-cell`, `machine-line`, `data-flow`, `agent-trace` or `instrument` |
| `profile` | Path to the TRP profile, relative to the pack file. An imported pack can embed the profile object here instead |
| `tick_ms` | How often the profile is evaluated, in milliseconds |
| `cycle_s` | Length of one work cycle, used for episode and frame numbering |
| `signals` | One entry per profile signal and hard rule field, with `base`, and for numbers `jitter`, `min`, `max`, `decimals` and `label` |
| `rule_labels` | Optional readable names for hard rules |
| `controls` | What the viewer can change (see below) |
| `story` | Optional timed script that plays when the pack opens |
| `arena` | Optional Arena event, with rounds, budget, harm conditions, Challenger moves and guards |

A control is either a slider bound to one signal, or a toggle with effects:

```json
{ "id": "loose", "label": "Loose fixture", "type": "toggle",
  "effects": { "vibration_rms_g": { "to": 1.32, "ramp_s": 2.5 } } }
```

An effect can ramp a number (`to` and `ramp_s`), set a value at once (`set`), or remove the signal from the evidence (`omit`), which shows how a profile treats missing data.

A story step runs at `at_s` seconds, can show a `caption`, move sliders with `set`, flip toggles with `toggle`, and finish with `end`.

A profile without a pack still works. The Studio builds one automatically, with a slider for every scored signal and a toggle for every hard rule, and draws it with the `instrument` scene.

## Engine

`studio/engine.js` is a browser port of the Node.js reference evaluator in `tools/evaluate.js`. `tests/studio_parity.js` evaluates every example profile against every evidence sample with both, and CI fails if any result differs.

```bash
node tests/studio_parity.js
node tests/lerobot_parse.js
```

## Security

Anything the Studio did not ship with is untrusted, including imported files, `?profile=` links and replay links. `studio/safety.js` rejects files over 1 MB, values of the wrong type, oversized lists and names that reach an object's prototype. `?profile=` links must use https or point to the same site. Every piece of HTML the page writes goes through an escaping template, and a Content Security Policy blocks inline script as a second layer.

```bash
node tests/studio_safety.js
node tests/arena_protocol.js
npm install --no-save playwright axe-core && npx playwright install chromium
node tests/browser/studio_e2e.js
```

The browser tests open every pack in every mode, import hostile profiles and packs with the policy on and off, try bad links and poisoned storage, play a full Arena match, and check the phone layout, control names, load time and frame rate.

## Contributing A Pack

1. Add your profile under `examples/<name>/trp.json`. The conformance suite validates it against the schema.
2. Add `studio/packs/<name>/pack.json` and list it in `studio/packs/index.json`.
3. Pick an existing scene, or use `instrument`.
4. Run the conformance suite and the parity check, then open a pull request.

Threshold values in example packs are illustrative, not certified safety limits.
