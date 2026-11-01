# Nautilus

Nautilus is a browser game built on the Trust Requirements Profile (TRP). The player captains a free vessel through a drowned world while the Leviathan's airship tries to blind it, board it and rewrite its rules. The vessel runs on an open TRP profile, `examples/nautilus/trp.json`, and the open TRP engine evaluates its evidence ten times a second. The engine's verdict rings the engine order telegraph, so Full Ahead, Half Ahead and All Stop come from the same rules a real system would use.

The story draws on Jules Verne's public-domain novels *Twenty Thousand Leagues Under the Seas* (1870) and *Robur the Conqueror* (1886). The ship designs follow Verne's text and are original to this project.

## Run It

```bash
python3 -m http.server 8000
```

Open http://localhost:8000/studio/nautilus/. Add `?renderer=2d` to force the 2D renderer. The game falls back to 2D on its own when WebGL is unavailable.

## Files

| File | Purpose |
|---|---|
| `core.js` | The voyage simulation. Deterministic, tested in Node, no drawing |
| `game.js` | Controller, input, heads-up display, screens, ledger, sharing and sign-up |
| `world3d.js` | 3D renderer on Three.js, with every model built in code |
| `art.js` | 2D renderer drawing, gauges, telegraph and share card |
| `audio.js` | Sound, synthesized in the browser |
| `crew.js` | Opt-in crew sign-up through Web3Forms |
| `config.js` | Settings for whoever hosts the game |
| `vendor/three-0.186.1.js` | Three.js 0.186.1 with bloom post-processing, bundled and minified. MIT license in `vendor/THREE_LICENSE.txt` |
| `privacy.html` | Privacy note for the sign-up |

## Hosting Settings

Edit `config.js` before publishing.

1. Create a Web3Forms access key at https://web3forms.com with the email address that should receive sign-ups, and set `web3formsKey`. Leave it empty to keep the sign-up closed.
2. Set `privacyContact` to the address people can write to about their data. The privacy note shows it.
3. Have the privacy note reviewed before turning on the sign-up.

## How Scoring Works

A voyage lasts 80 seconds. Leagues come from speed, which depends on the engine order the rules set. Harpooning threats scores points with a combo multiplier, a stop the rules make before harm scores 60, each gear is a point of brass, and reaching Free Harbor adds 300. Three hull hits sink the ship. Par is the score of a steady reference captain on the same voyage, and medals compare against it. Brass, medals and unlocks have no cash value.

## Agents

`window.TRPNautilus.play({ seed, policy })` runs a voyage headless and returns the summary. A policy is a function `(voyage, dt)` that calls `voyage.fire(id)`, `voyage.fireAt(x, y)` and `voyage.setDepth(y)`. `TRPNautilus.rules()` returns the vessel's profile.

## Tests

```bash
node tests/nautilus_core.js
node tests/browser/nautilus_e2e.js
```
