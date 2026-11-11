# Changelog

All notable changes to the TRP specification and tooling are documented here.
This project follows [Semantic Versioning](https://semver.org/) for the
specification and [Keep a Changelog](https://keepachangelog.com/) format.

## [0.6.0] - 2026-11-11

TRP 0.6.0 widens the subject of a profile from agents to any endpoint or step
in an automated system. Every profile that was valid under 0.5.3 is valid
under 0.6.0, and both reference evaluators give it the same output. Both
evaluators now score a signal only when its value is a finite JSON number,
which changes the output for mistyped evidence and for nothing else.

### Semantic Versioning
This release is 0.6.0. Semantic Versioning 2.0.0 lets anything change during
major version zero, so the choice follows Section 13 of the specification,
which increments MINOR for a non-breaking addition, and the guidance in
Semantic Versioning to increment MINOR when new backward compatible
functionality reaches the public interface. `scope.subject_type` is new
functionality. A profile that uses it fails the 0.5.3 schema, because `scope`
does not allow additional properties, so a consumer pinned to 0.5.3 has to
tell the two apart from the version. A PATCH release would hide that.
- The specification header, the README, the schema title and the schema
  description give version 0.6.0, and the VTR library names the evaluator
  version 0.6.0.
- The schema `$id` moves to `https://aitrustalliance.com/schema/trp/0.6/trp.schema.json`,
  since the path carries MAJOR.MINOR. Profiles that declare the 0.5 `$schema`
  and `spec_version: "0.5"` stay valid against the 0.6 schema, and the
  existing examples and test profiles keep those values to prove it.
- The Verifiable Trust Receipt (VTR) format moves to version 0.6, because
  RFC 9864 deprecates the JSON Web Signature (JWS) algorithm identifier
  `EdDSA` that VTR 0.5 used for Ed25519 signatures. A VTR 0.5 verifier
  refuses a VTR 0.6 receipt, since it allows neither `vtr_version` 0.6 nor
  `alg` `Ed25519`, so the change is incompatible for older verifiers. A VTR
  0.6 verifier accepts every VTR 0.5 receipt. Semantic Versioning increments
  MINOR for such a change while the major version is zero, which gives 0.6
  in place of 0.5.1. The VTR schema `$id` moves to
  `https://aitrustalliance.com/schema/vtr/0.6/vtr.schema.json`. The receipt
  claims and the determination are unchanged.

### Added
- `scope.subject_type`, an optional field that names the kind of subject a
  profile is written for. The values are `agent`, `model`, `user`, `dataset`,
  `workflow`, `route`, `service` and `other`, or an `https://` URI or `urn:`
  URN under a namespace its owner controls. A consumer treats an unknown
  namespaced value as `other` and never rejects a profile for it. The field
  describes the profile and does not change how a subject is assessed.
- Conformance tests for `subject_type` in both namespaced forms and for two
  values the schema must reject.
- `tests/cross_evaluator_check.py`, the cross-evaluator check that CI ran
  inline, now a script anyone can run. It also covers every example profile.
- An evidence sample can name an example profile in `_profile` with a path
  from the repository root, such as `examples/manufacturing-safety/trp.json`.
- The Profile Authoring Guide covers `subject_type` and starts new profiles
  at `spec_version` 0.6.
- A Zero Trust section in the README that maps identity, custody, policy,
  continuous monitoring and the policy decision point onto TRP for readers who know
  National Institute of Standards and Technology (NIST) Special Publication
  800-207, Zero Trust Architecture. It states that whoever has authority sets
  requirements locally and that the standard is agnostic about who authors a
  profile.
- The SCITT And COSE Profile in `vtr/spec.md`, an informative profile that
  carries the claims of a receipt as the payload of a COSE_Sign1 signed
  statement of CBOR Object Signing and Encryption (COSE), where CBOR is the
  Concise Binary Object Representation. The statement is registered with a
  Supply Chain Integrity, Transparency, and Trust (SCITT) transparency service
  under RFC 9943 and checked with a COSE Receipt under RFC 9942. The payload
  is the same canonical claims a JWS receipt signs, so `prev` and batch leaves
  name a receipt the same way in both envelopes. The profile has no test
  vectors, because the project found no independent, widely used
  implementation of COSE Receipts to confirm them, so the reference verifiers
  do not check it. It uses the fully specified COSE algorithms of RFC 9864,
  `ESP256` and `Ed25519`, since RFC 9864 deprecates the COSE values `ES256`
  and `EdDSA`.
- VTR 0.6 signs Ed25519 receipts with the fully specified JSON Object
  Signing and Encryption (JOSE) identifier `Ed25519` that RFC 9864 Section
  2.2 registers. The Internet Assigned Numbers Authority (IANA) JSON Web
  Signature and Encryption Algorithms registry lists it with JOSE
  Implementation Requirements `Optional`, and `EdDSA` is now `Deprecated`.
  - New receipts and batch statements carry `vtr_version` 0.6, and the
    reference library refuses to sign a VTR 0.5 receipt.
  - Both verifiers accept `EdDSA` only on a receipt or batch statement that
    declares VTR 0.5, and treat it there as `Ed25519`. A batch statement
    carries the same `vtr_version` as every receipt in its batch.
  - `ES256` is unchanged, since RFC 9864 Section 2.1 finds the JOSE
    identifiers of RFC 7518 for the Elliptic Curve Digital Signature
    Algorithm (ECDSA) fully specified already.
  - The published Ed25519 test key carries `alg` `Ed25519`, as RFC 9864
    Section 5 describes, under the same key identifier.
  - The vectors are signed again at VTR 0.6 (29 valid and 20 invalid, up
    from 27 and 18). Two valid VTR 0.5 receipts signed with `EdDSA` show
    the older form still verifies. The invalid vector `eddsa-on-vtr-0.6`
    signs a VTR 0.6 receipt with `EdDSA` and must be refused, and
    `ed25519-not-allowed` shows an `Ed25519` receipt still needs the
    operator to allow Ed25519.
  - `tests/vtr_check.py` checks both verifiers on the old and the new
    identifier in single receipts and in batches. Both must also refuse a
    JOSE header that names the COSE identifier `ESP256`, along with an
    unsupported `vtr_version` (181 checks, up from 155).
- Conformance samples `tests/evidence/scored-signal-type-*.json` for a scored
  signal sent as text, numeric text, a boolean, null, an object, an array and
  an integer too large for a double, each with `on_missing` incomplete.
  Further samples cover a mistyped signal for each other `on_missing` value
  and a pair of mistyped signals with weight 0, and
  `scored-signal-finite-number.json` confirms every JSON number form is
  scored (65 tests, up from 48).
- An evidence sample can pin the exact `missing_signals` list it expects in
  `_expected_missing_signals`.
- `tests/scored_signal_types_check.py` runs both evaluators on the values no
  evidence file can carry, which are NaN and infinity passed in memory and
  JSON numbers such as `1e400` that each parser reads as infinity. Both must
  report a type mismatch and write the same `result_hash`. The check runs in
  the cross-evaluator job of continuous integration.
- `tests/vtr_check.py` confirms that both VTR verifiers give a mistyped
  scored signal the outcome `inconclusive` and derive the same standing and
  `result_digest` for it (188 checks, up from 181).
- `adapters/a2a/trp_a2a.py`, the TRP gate on both sides of an A2A (Agent2Agent
  protocol) delegation, built on a2a-sdk 1.3.0. The caller's gate judges each
  delegation before it is sent and each returned task or message before it is
  used. The remote agent's gate judges each inbound task with the caller's
  authenticated identity as evidence. The profile
  `adapters/a2a/profiles/a2a-delegation.trp.json` adds the rules
  `unverified_remote_receipts` and `anonymous_caller`, and the policy keys
  `receipt_mode` and `anonymous_callers` set how each one acts.
  `adapters/a2a/vtr_verifier.py` checks each receipt a remote agent returns
  with the VTR reference library, against the key set and profile the
  deployment trusts for that agent. It also requires the expected issuer, the
  returned task, this caller and an accepted mode. `tests/a2a_check.py` runs
  the adapter against in-process a2a-sdk agents with VTR receipts minted on
  each run.
- `adapters/otel/trp_otel.py`, an OpenTelemetry export that writes each TRP
  evaluation and each VTR receipt as one span or one log record in the JSON
  encoding of the OpenTelemetry Protocol (OTLP). It needs no OpenTelemetry
  package at runtime, and `emit_spans()` sends the same spans through a
  `TracerProvider` of the OpenTelemetry software development kit (SDK) when one
  is installed.
  - Four registered names from the OpenTelemetry generative AI (GenAI)
    semantic conventions at commit 633cbb0 carry the agent, its version, the
    model provider and the tool of a receipt. Every other attribute sits under
    `trp.`, and `adapters/otel/README.md` lists each one.
  - The attributes rebuild each receipt's claims, and the digest of the rebuilt
    claims equals the receipt digest. A claim the attribute table cannot carry
    exactly travels as canonical JSON under `trp.vtr.json.<claim>`.
  - An evaluation export carries the evidence digest and no evidence value.
    `--include-evidence` adds the evidence in canonical JSON.
  - `tests/otel_check.py` needs no OpenTelemetry package (359 checks). It
    compares nine golden files byte for byte and rebuilds the digest of all 29
    valid receipt vectors and of 15 built claim sets. It also confirms that no
    marker value from the evidence reaches the export without the flag.
  - `tests/otel_sdk_check.py` parses every golden file with
    `opentelemetry-proto` 1.45.2 and checks the spans an `opentelemetry-sdk`
    1.45.2 `TracerProvider` receives (110 checks). CI runs both on Python 3.10
    and 3.12 in the `otel-export` job.
- `tools/trp_oscal.py`, an export of TRP profiles to the Open Security Controls
  Assessment Language (OSCAL) 1.2.3 of the National Institute of Standards and
  Technology (NIST), and an import back. `docs/oscal.md` documents it.
  - The export writes a TRP-native OSCAL catalog with one control per scored
    signal and per hard rule, along with an OSCAL profile that imports it.
    TRP data with no OSCAL field travels in props under the namespace
    `https://aitrustalliance.com/ns/trp`, and the two thresholds of each scored
    signal travel as OSCAL parameters, so an OSCAL profile can tailor them.
  - `x_oscal`, a new top-level extension registered as reserved in
    `extensions/registry.json`, declares how single requirements relate to
    controls of other catalogs. The export then imports the mapped controls
    and writes an OSCAL mapping collection under the Control Mapping model. It
    refuses a control that is missing or withdrawn in a local copy of its
    catalog.
  - The import brings a document the export wrote back as the same profile.
    It turns any other OSCAL catalog or profile into a skeleton whose
    placeholder signals carry no weight and no threshold, so the skeleton
    fails the TRP schema until a person completes it.
  - `fixtures/oscal` vendors the official OSCAL 1.2.3 JSON schemas and NIST's
    SP 800-53 Rev. 5 and AI RMF 1.0 catalogs with its SP 800-53 LOW baseline
    from `oscal-content` 1.6.0, byte for byte, with their provenance in
    `sources.json`.
  - `tests/oscal_check.py` validates every export against the official schemas
    and round trips every TRP profile in the repository through the OSCAL
    profile and through the catalog alone. It imports both NIST catalogs and
    the baseline as skeletons and tries every refusal path (255 checks). CI
    runs it on Python 3.10 and 3.12 in the `oscal` job.

### Changed
- Section 1 and the definition of Subject cover any endpoint or step in an
  automated system. A subject can be a software agent, a model including a
  small model that calls tools directly, a user or the agent acting for that
  user, a dataset, a workflow, a route or a service.
- Specification headings use Title Case.
- `vtr/spec.md` describes version 0.6 and gains a Versions section, and the
  VTR schema accepts `vtr_version` 0.5 and 0.6. `vtr_emit.py --new-key`
  takes `ed25519`, with `eddsa` kept as the older name for it.
- `vtr/spec.md` no longer lists a COSE envelope and a SCITT profile as
  planned. RFC 9943 and RFC 9942, which it already cited, are confirmed as the
  published SCITT architecture and COSE Receipts. Selective Disclosure JSON
  Web Tokens stay reserved for a later credential profile, and the `risk`
  claim stays reserved and empty.
- Section 3.3 of the specification states the value type of a scored signal.
  The value MUST be a finite JSON number, and an evaluation source MUST NOT
  score a value of any other type. It treats the signal as inconclusive, the
  same as an absent signal, so the signal's `on_missing` value governs.
- Both reference evaluators apply the rule. Text, numeric text such as
  `"0.5"`, a boolean, null, an object, an array, not a number (NaN), infinity
  and an integer too large for a double are type mismatches. A mistyped
  signal is listed in `missing_signals` with the reason `type_mismatch` and
  never appears in `signal_results`. Its `on_missing` value then decides the
  outcome as it does for an absent signal, so a signal declared `critical`
  stays a critical condition and a signal declared `ignore` is dropped from
  the assessment.
- In 0.5.3 the Python evaluator stopped with an error on text, null, an
  object and an array, and it read `true` as 1 and `"0.5"` as 0.5. The
  Node.js evaluator stopped on text and on an object, and it read null as 0,
  `[1]` as 1, `true` as 1 and `"0.5"` as 0.5. Mistyped evidence could read as
  compliant, and the two evaluators could disagree on the same input.
- The entry for an absent signal is unchanged and carries no `reason`
  member. The output and the `result_hash` match 0.5.3 for every profile and
  evidence pair in the 0.5.3 test suite and for every VTR test vector, so the
  published vectors stay valid.
- A scored signal value of NaN or infinity is a type mismatch. In 0.5.3 both
  evaluators stopped with an error on such a value. Both still stop when any
  other member of the output would carry a non-finite number.
- The Python evaluator treats an integer too large for a double as a type
  mismatch in a hard rule field too, where 0.5.3 stopped with an error. The
  Node.js evaluator looks up a scored signal among the evidence's own
  members, so a declared signal named after an inherited object member such
  as `constructor` is absent unless the evidence carries it.
- `tools/README.md` and `vtr/spec.md` document the `reason` member. A
  mistyped scored signal has the outcome `inconclusive` in a receipt's
  `results` and does not count toward coverage. The rule changes no receipt
  claim.

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
- The specification header, the README, the schema title and the schema
  description give version 0.5.3, and the VTR library names the evaluator version
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
