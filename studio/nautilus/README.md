# Nautilus

Nautilus is a browser game built on the Trust Requirements Profile (TRP). The player captains a free vessel through a drowned world while the Leviathan's airship tries to blind it, board it and rewrite its rules. The vessel runs on an open TRP profile, `examples/nautilus/trp.json`, and the open TRP engine evaluates its evidence ten times a second. The engine's verdict rings the engine order telegraph, so Full Ahead, Half Ahead and All Stop come from the same rules a real system would use.

The story draws on Jules Verne's public-domain novels *Twenty Thousand Leagues Under the Seas* (1870) and *Robur the Conqueror* (1886). The ship designs follow Verne's text and are original to this project. `DESIGN.md` is the design document and the single source of truth for what is in the game.

## What Is In It

- A daily voyage, eighty seconds long, with a par set by a reference captain and medals against it.
- A shakedown cruise in which Conseil and Ned Land speak over the wire.
- Season One, six chapters on a chart drawn from Verne, each with its own sea, weather, threat mix, set piece and port scene with one choice that changes the ship.
- The chart room, where the captain fits one of three rule books, one system and one crew member before a chapter. Each rule book is a published TRP profile the player can read.
- Salvage. What a threat leaves behind sinks and can be recovered, sea chests carry pages and brass, and giant clams open only for a ship at rest.
- The salon, a hub drawn in 3D with the library, the chart table, the logbook, the organ, the telegraph repeater, the dry dock and the ship's articles.
- The Captain's Codex, twenty-four entries at three depths, filled by play and never required.
- A procedural score that follows danger, synthesized sound, generated weather and seas, and a 2D renderer for machines without WebGL.

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
| `art.js` | 2D renderer drawing, gauges, telegraph, salvage, the salon and the share card |
| `tutorial.js` | The shakedown cruise, spoken by Conseil and Ned Land |
| `campaign.json` | Season One: the chapters, their seas and hazards, the port scenes and the fittings |
| `DESIGN.md` | The design document |
| `../codex.js`, `../codex.json` | The Captain's Codex, shared with TRP Studio |
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

## The Captain's Codex

Every threat in the voyage stands for a real failure mode in AI trust, safety and governance. `studio/codex.json` holds twenty-four entries, each with a definition anyone can read, the tie to the game, an explanation for learners, a documented case, the matching section of the Trust Requirements Profile specification, the wider frameworks, and a self-check. Pages reach the library as salvage. What is left of a threat sinks and can be recovered, sea chests on the seabed carry the Navigator pages, and pearls in the giant clams carry the Captain pages. A clam opens only for a ship at rest, and the captain's All Stop lever is always available. `tests/codex_content.js` checks the structure, the specification citations, the quizzes and the house style.

`config.js` can carry a `learnMoreUrl`, shown under each entry, for a host that offers courses on the material.

## The Rule Books

Three profiles live in `examples/`: `nautilus-cautious`, `nautilus` and `nautilus-bold`. They differ only in their thresholds. Cautious rings earlier and stops longer. Standard rings before harm. Bold's limits sit past the point of harm, so its rules never stop the ship in time and the captain's harpoon is the only defence. `tests/nautilus_campaign.js` sails every chapter under every book with the reference captain and holds each book to what its description says.

## How Scoring Works

A voyage lasts 80 seconds, or a chapter's own length. Leagues come from speed, which depends on the engine order the rules set. Harpooning threats scores points with a combo multiplier. A stop the rules make before harm begins scores 40, a stop that catches harm within three quarters of a second scores 60, each gear is a point of brass, salvage scores on its own scale, and reaching port adds 300. Three hull hits sink the ship, four at easy difficulty. Par is the score of a steady reference captain on the same voyage, and medals compare against it. Brass, medals and unlocks have no cash value.

## Agents

`window.TRPNautilus.play({ seed, difficulty, policy })` runs a voyage headless and returns the summary. A policy is a function `(voyage, dt)` that calls `voyage.fire(id)`, `voyage.fireAt(x, y)`, `voyage.setDepth(y)` and `voyage.setManualStop(on)`. `TRPNautilus.rules()` returns the vessel's profile, `TRPNautilus.sailChapter(id)` starts a chapter on screen, and `TRPNautilus.advance(seconds)` steps the voyage on screen with the reference captain at the helm.

## Tests

```bash
node tests/nautilus_core.js
node tests/nautilus_campaign.js
node tests/codex_content.js
node tests/browser/nautilus_e2e.js
```
