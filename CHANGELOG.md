# Changelog

All notable changes to the TRP specification and tooling are documented here.
This project follows [Semantic Versioning](https://semver.org/) for the
specification and [Keep a Changelog](https://keepachangelog.com/) format.

## [Unreleased]

### Added
- TRP Studio (`studio/`), a browser demo that runs a live system against a
  profile and evaluates it every tick, with scenario packs for a robot cell,
  a machine line, a healthcare data flow and an agent (Agno). Any profile can
  be imported and becomes a live demo.
- `studio/engine.js`, a browser port of the Node.js reference evaluator, and
  `tests/studio_parity.js`, which requires identical results from both for
  every example profile and evidence sample. CI runs it.
- Reference profiles `examples/machine-line/trp.json` and
  `examples/agent-tool-use/trp.json`.
- GitHub Pages workflow that publishes the Studio.
- Studio Arena, a daily strategy game in which players defend a system against
  a scripted Challenger by buying guards, with par, medals, a streak and
  shareable results. Arena events for all four scenario packs.
- Studio stress test, explain-a-halt, replay links and scene recording.
- Fleet pack, which evaluates 144 robot cells every frame.
- Agent access through `window.TRPGames`, `studio/games-cli.js` and
  `studio/llms.txt`.
- Experimental Studio Lab (`studio/lab.html`) with a LeRobot episode replay and
  a webcam distance sensor, documented in `studio/DATA_SOURCES.md`, and the
  reference profile `examples/arm-motion/trp.json`.
- Nautilus (`studio/nautilus/`), a 3D browser game in which a vessel runs on
  an open TRP profile and the engine's verdict rings the engine order
  telegraph. Daily voyage, medals against par, ranks, shipyard, shareable
  log card, opt-in crew sign-up, and a 2D fallback. Tested by
  `tests/nautilus_core.js` and `tests/browser/nautilus_e2e.js`.
- Nautilus Season One: six chapters drawn from Verne on a chart, each with
  its own sea, weather, threat mix, set piece and port scene with one
  choice. A chart room where the captain fits one of three published rule
  books (`examples/nautilus-cautious`, `examples/nautilus`,
  `examples/nautilus-bold`), one system and one crew member. Salvage that
  fills the Captain's Codex, the salon hub, a shakedown cruise, a procedural
  score, a prologue, difficulty, reduced motion and text size settings, and
  the captain's own All Stop lever. `studio/nautilus/DESIGN.md` is the
  design document and `tests/nautilus_campaign.js` checks every chapter and
  rule book against its description.
- Nautilus sea conditions (vents, silt, swell, unrest) that push a gauge
  toward its limits without harm, a captain's own rule book written in the
  chart room and checked by the engine, the hunter, the Long Voyage of
  generated legs from Verne's places, a headless playtest with five kinds
  of captain, and an art pass: an opening shot, caustics, hull plating,
  port vignettes and crew medallions.
- The Captain's Codex (`studio/codex.json`, `studio/codex.js`), twenty-four
  entries on AI trust, safety and governance and the TRP specification at
  three depths, with documented cases and self-checks, checked by
  `tests/codex_content.js`.
- Studio Learn mode with four challenges, graded by a fixed-seed stress
  test, in which players fix the limits of a profile with a gap in it. Each
  challenge ships the limits that solve it, as `solution`.
- Studio Command, the first screen: a floor of fifty-six systems from every
  pack, each judged by the engine every tick, with a bar that counts harm caught,
  harm missed and false stops, and a rule book dial (loose,
  published, tight, tuned by measurement) that shows the trade-off live.
  Packs carry a `command` block with benign excursions.
- The Studio header offers Nautilus as coming soon with an early access
  sign-up, in place of a link to the game.
- TRP Arena Protocol (`studio/ARENA_PROTOCOL.md`) and match runner
  (`studio/match.js`), so any two programs can play the Arena against each
  other with replies checked, process groups stopped and results
  re-verifiable. Example contestants in JavaScript and Python and a language
  model template, tested by `tests/arena_protocol.js`.
- Studio import checks (`studio/safety.js`), an escaping HTML template for
  every write to the page, a Content Security Policy, and tests in
  `tests/studio_safety.js` and `tests/browser/studio_e2e.js`. CI runs the
  browser tests, and a CodeQL workflow scans JavaScript and Python.

## [0.5.2] - 2026-10-31

### Added
- Extension registry at `extensions/registry.json` with `extensions/README.md`,
  and `x_provenance` reserved for the provenance module.
- Schema support for URI-namespaced extension keys (`https://` URIs and `urn:`
  URNs) in every object that accepts `x_` keys, including `extends`, matching
  Section 7.
- Section 3.4 requires a hard rule whose field is missing to be treated as
  inconclusive, and states that an inconclusive rule marks the assessment
  incomplete without applying the rule's action.
- `hard_rules_inconclusive` in both evaluators' output, listing each
  inconclusive rule with its reason (`missing` or `type_mismatch`).
- Conformance tests for URI keys, `http://` key rejection, missing and
  mistyped hard rule fields, `extends` rejection, and the registry
  (42 tests, up from 27).

### Changed
- Spec header and Section 12, GOVERNANCE.md, README and CONTRIBUTING describe
  Striv AI as steward during the formative stage, with stewardship
  transferring to the AI Trust Alliance once its governance is formalized,
  and Ohio State as a founding participant.
- Section 3.6 and the schema description give the severity range as 0 to 10,
  matching the schema and every published profile.
- Section 7 describes both extension key forms and how a module changes
  assessment through an evidence adapter.
- README and ROADMAP cite the concept DOI 10.5281/zenodo.22099403, which
  resolves to the latest release. Version DOIs are 10.5281/zenodo.22099404
  (v0.5.0) and 10.5281/zenodo.22216886 (v0.5.1).
- `--generate-sample` writes a safe, correctly typed value for every hard
  rule field in both evaluators.
- The Python evaluator uses a timezone-aware UTC timestamp.
- `tools/README.md` states that `drift_detected` is a placeholder, which both
  reference evaluators always report as `false`.

### Fixed
- Both evaluators now reject a profile that uses `extends`, as Section 7
  requires. They previously ignored the base profile silently.
- Hard rule type mismatches are inconclusive in both evaluators, as Section 3.4
  requires. The text "false" previously counted as true. Non-numeric text in a
  numeric rule crashed the Python evaluator while the Node evaluator passed it,
  and numeric-looking text such as "0.01" was silently converted by both.

## [0.5.1] - 2026-08-28

### Added
- Conformance test suite with 27 tests across schema validation, rejection,
  example verification, and evaluator determinism (`tests/`).
- GitHub Actions CI workflow running on Python 3.10 and 3.12 on every push
  and pull request (`.github/workflows/ci.yml`).
- `SECURITY.md` vulnerability reporting policy.
- `CHANGELOG.md` (this file).
- `requirements.txt` for reproducible dependency installation.
- Test profiles exercising minimal, full-featured, and inheritance scenarios.
- Evidence samples covering healthy, warning, critical, hard-rule, and
  missing-signal evaluation paths.
- Drift detection in the Node.js evaluator, matching the Python reference implementation.

### Changed
- Updated `ROADMAP.md` to reflect completed conformance test suite.

## [0.5.0] - 2026-08-19

### Added
- TRP specification v0.5 public working draft (`spec/trp-spec.md`).
- JSON Schema for profile validation, Draft 2020-12
  (`schema/trp.schema.json`).
- Reference evaluator with scored signals, hard rules, drift detection, and
  standing band assignment (`tools/evaluate.py`).
- Manufacturing robot cell safety reference profile.
- Healthcare data governance reference profile.
- Contribution guidelines (`CONTRIBUTING.md`).
- Governance model and stewardship documentation (`GOVERNANCE.md`).
- Project roadmap (`ROADMAP.md`).
- Apache 2.0 license.
- Zenodo DOI registration (10.5281/zenodo.22099404).
