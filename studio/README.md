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

You can also drag any TRP profile or pack file onto the page, or use Import.

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
```

## Contributing A Pack

1. Add your profile under `examples/<name>/trp.json`. The conformance suite validates it against the schema.
2. Add `studio/packs/<name>/pack.json` and list it in `studio/packs/index.json`.
3. Pick an existing scene, or use `instrument`.
4. Run the conformance suite and the parity check, then open a pull request.

Threshold values in example packs are illustrative, not certified safety limits.
