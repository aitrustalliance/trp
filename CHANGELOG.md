# Changelog

All notable changes to the TRP specification and tooling are documented here.
This project follows [Semantic Versioning](https://semver.org/) for the
specification and [Keep a Changelog](https://keepachangelog.com/) format.

## [0.5.3] - 2026-11-04

TRP 0.5.3 ships with Verifiable Trust Receipt (VTR) version 0.5. Every
evaluator behavior that differs from 0.5.2 is listed under Changed and Fixed.

### Added
- Verifiable Trust Receipt (VTR) version 0.5 in `vtr/`, with the
  specification, a JSON Schema, a Python reference library and emitter,
  independent Python and Node.js verifiers, Merkle batch signing under RFC 9162
  and 45 test vectors that both verifiers must agree on.
  - `standing` is an object with a `result` beside the band and the response.
    The result tells an incomplete evaluation apart from a failing one. A
    receipt whose required evidence is missing, or whose hard rule is
    inconclusive, carries the result `incomplete` with a null band and a null
    response. A triggered hard rule is a known violation, so it gives
    `does_not_meet` even when other evidence is missing. A critical
    condition, a value in the critical range or a signal missing with
    `on_missing: critical`, sets the worst band whatever else is missing, so
    it also gives `does_not_meet` beside missing evidence whenever that band
    does not meet the profile. A signal with weight 0 never changes the
    standing, so its absence never gives `incomplete`.
  - `result_digest` is the digest of the evaluator output with its
    `evaluation` member removed. A verifier with the profile and the evidence
    re-runs either reference evaluator and compares one digest.
  - Coverage counts a requirement as checked only when its outcome is
    something other than `inconclusive`, so a hard rule whose field is
    present with the wrong type does not count as checked.
  - The valid vectors carry every standing result and cover every kind and
    every mode, including a hard rule field of the wrong type and a triggered
    hard rule or a critical signal beside a missing signal. The invalid
    vectors include an unknown key identifier, a missing subject, a coverage
    outside 0 to 1, an incomplete standing altered to `meets` and a triggered
    hard rule or a critical signal reported as `incomplete`.
- The TRP gate signs a VTR for every decision when given a receipt key.
- `profile_from_dict` in `tools/evaluate.py` and `profileFromObject` in
  `tools/evaluate.js`, so a parsed profile can be evaluated without a file.
  The Node.js evaluator can now be loaded as a module.
- `adapters/gate/trp_gate.py`, one TRP gate that judges each AI agent tool
  call before it runs and each tool result before the model sees it, with a
  decision log chained by SHA-256 and a session file shared across servers and
  frameworks.
- `adapters/mcp/trp_mcp_checkpoint.py`, a TRP checkpoint in front of any Model
  Context Protocol (MCP) server on stdio, with the reference profile
  `adapters/mcp/profiles/mcp-tool-checkpoint.trp.json` and policies for the
  official filesystem and fetch servers.
- Adapters for LangChain, LangGraph, the OpenAI Agents SDK, Google ADK, CrewAI
  and AG2 in `adapters/frameworks`, each checked by running the real framework
  with a scripted model.
- An evidence sample can name the profile it runs against in `_profile`.
  Samples without it still run against `full-featured.json`.
- Conformance tests for `on_missing: ignore`, rounding ties, a critical
  signal beside a missing signal or an inconclusive hard rule, and weight 0
  signals (48 tests, up from 42).

### Changed
- Both reference evaluators honor `on_missing: critical` when they assign the
  band. Section 3.3 treats such an absence as a critical condition, so the
  standing is the worst band, the same as a value in the critical range. In
  0.5.2 the evaluators added a penalty that no output used and left the band
  unchanged. `tests/evidence/missing-critical-signal.json`, published in
  0.5.2 with the expected standing `trusted` and the response `full`, now
  expects `untrusted` and `suspended`.
  `tests/evidence/missing-ignored-signal.json` covers `on_missing: ignore`.
- Both evaluators assign the band in a stated order of precedence. A
  triggered hard rule comes first, then a critical condition, then an
  incomplete assessment, then a warning. A value in the critical range takes
  the same precedence as a signal missing with `on_missing: critical`, so a
  critical condition sets the worst band whatever other evidence is missing.
  The band is the same as in 0.5.2 for every input that does not involve
  `on_missing: critical` or weight 0, and
  `tests/evidence/critical-signal-and-missing-signal.json` and
  `tests/evidence/critical-signal-and-inconclusive-rule.json` pin it.
- A signal with weight 0 is informational in both evaluators and never moves
  the band, including a signal whose value is in the critical range or that
  is missing with `on_missing: critical`. In 0.5.2 such a signal could set
  the worst band or the middle band. Section 3.3 states the rule once, where
  weight is defined. `tests/profiles/valid/zero-weight-signal.json` gains a
  weight 0 signal declared `on_missing: critical`, and
  `tests/evidence/zero-weight-critical-value.json` and
  `tests/evidence/zero-weight-missing.json` expect `good` against it.
- `result_hash` in both evaluators is the SHA-256 of the RFC 8785 canonical
  JSON form of the output without its `evaluation` member, so the Python and
  Node.js evaluators write the same hash byte for byte. In 0.5.2 the Python
  evaluator hashed `json.dumps` with sorted keys, and the Node.js evaluator
  passed the top-level keys to `JSON.stringify` as a filter, which dropped
  every nested member, so the two hashes differed whenever the output listed
  a signal or a rule. A `result_hash` recorded under 0.5.2 can differ from
  the 0.5.3 value for the same input. For an evaluation with no drift
  history it equals a VTR `result_digest` in hexadecimal. The
  cross-evaluator check in continuous integration (CI) now compares
  `result_hash` on every profile and evidence pair.
- A non-finite number has no JSON form, so both evaluators now stop with an
  error when the output would carry one, such as a scored signal value that
  converts to not a number (NaN). In 0.5.2 both kept going and wrote the
  value as `NaN` or `null`.
- The specification header, the schema title and description, and the
  README give version 0.5.3, and the VTR library names the evaluator version
  0.5.3. The schema `$id` and the `spec_version` a profile declares stay
  `0.5`.

### Fixed
- `tools/evaluate.js` rounds severity, penalty, drift moving averages and
  generated sample values half to even on the exact value of each number, the
  way Python's `round` does. It used to round a tie such as 0.03125 up, and
  near ties such as 0.95075 could round the other way, so the two evaluators
  could disagree. `tests/evidence/rounding-tie.json` lands on both cases.

### Removed
- A compiled Python file committed by mistake, with a `.gitignore` to keep
  such files out.

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
