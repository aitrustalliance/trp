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

**Live** lets you change conditions and watch the profile respond. Click any event to see exactly which requirement caused it.

**Arena** is a daily strategy game. A scripted Challenger stages eight rounds of trouble, and you defend the system by spending a fixed budget on guards before the match starts. Each guard shields a signal, tightens a threshold or adds a rule. You score for every incident the system stops within 0.75 seconds and for keeping it running, and you lose points for needless stops. Medals compare your score with par, the best score any affordable set of guards can reach on that day's seed. The seed changes every day, so everyone plays the same match.

**Stress test** runs hundreds of episodes with random faults and reports how many the profile caught, missed or stopped on needlessly.

The **Fleet** pack evaluates 144 robot cells at once, every frame, to show how fast the engine runs.

## Agents Can Play

Everything runs locally, so there is no server to overload. In the browser, `window.TRPGames` exposes `events()`, `play({ event, guards, seed })` and `stress({ event, episodes })`. From a terminal:

```bash
node studio/games-cli.js --list
node studio/games-cli.js --event robot-cell --guards second-sensor,speed-limit
node studio/games-cli.js --event robot-cell --stress 200
```

`studio/llms.txt` describes the rules for language model agents.

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
npm install --no-save playwright && npx playwright install chromium
node tests/browser/studio_e2e.js
```

The browser tests open every pack in every mode, import hostile profiles and packs with the policy on and off, try bad links and poisoned storage, play a full Arena match, and check the phone layout, control names, load time and frame rate.

## Contributing A Pack

1. Add your profile under `examples/<name>/trp.json`. The conformance suite validates it against the schema.
2. Add `studio/packs/<name>/pack.json` and list it in `studio/packs/index.json`.
3. Pick an existing scene, or use `instrument`.
4. Run the conformance suite and the parity check, then open a pull request.

Threshold values in example packs are illustrative, not certified safety limits.
