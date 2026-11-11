# TRP Conformance Test Suite

This directory contains the conformance test suite for the Trust Requirements
Profile specification. The suite validates that TRP profiles conform to the
published JSON Schema and that the reference evaluator produces deterministic,
expected results for known inputs.

## Running The Tests

```shell
pip install jsonschema
python tests/run_conformance.py --verbose
```

## What The Suite Tests

### 1. Schema Conformance (Valid Profiles)

Files in `profiles/valid/` must pass JSON Schema validation against
`schema/trp.schema.json`. These include:

| File | What it exercises |
|------|-------------------|
| `minimal.json` | Only required fields. Proves the schema accepts a bare profile. |
| `full-featured.json` | Every optional field populated. Proves the full grammar works. |
| `with-extension.json` | Profile inheritance via the `extends` field. The schema accepts it, and the reference evaluators must reject it (group 5). |
| `uri-extension-keys.json` | Extension keys in both forms, `x_` and URI-namespaced (`https://` and `urn:`). |
| `subject-type-uri.json` | A `scope.subject_type` given as an `https://` URI under a namespace its owner controls. |
| `subject-type-urn.json` | A `scope.subject_type` given as a `urn:` URN. |

### 2. Schema Rejection (Invalid Profiles)

Files in `profiles/invalid/` must **fail** JSON Schema validation. Each file
breaks the schema in exactly one way, documented in its `x_test_description`
field:

| File | What it breaks |
|------|----------------|
| `missing-trp-id.json` | Missing required `trp_id`. |
| `bad-trp-id-pattern.json` | Uppercase letters in `trp_id` (pattern violation). |
| `missing-scope-intended-use.json` | `scope` present but missing required `intended_use`. |
| `bad-version-format.json` | Version string not in MAJOR.MINOR.PATCH format. |
| `bad-signal-direction.json` | Signal direction not in allowed enum. |
| `empty-standing-bands.json` | Empty `standing_bands` array (minItems: 1). |
| `bad-extension-key-http.json` | An `http://` extension key, which is not an accepted namespace. |
| `bad-subject-type.json` | A `scope.subject_type` that is neither a listed value nor a namespaced URI. |
| `bad-subject-type-http.json` | A `scope.subject_type` given as an `http://` URI, which is not an accepted namespace. |

### 3. Example Profile Validation

All `trp.json` files under `examples/` must pass schema validation, so
published reference profiles stay conformant as the schema evolves.

### 4. Evaluator Determinism

The reference evaluator (`tools/evaluate.py`) is run against evidence samples
in `evidence/`. Each sample embeds its expected standing, response, and
hard-override flag. The suite verifies that:

- Healthy evidence produces `trusted` standing with `full` response.
- Warning-level evidence produces `conditional` standing with `restricted` response.
- Critical-level evidence produces `untrusted` standing with `suspended` response.
- A triggered hard rule produces `untrusted` standing with hard override.
- A hard rule whose field is missing, or arrives as the wrong type, is
  inconclusive. The assessment is incomplete, so the standing is `untrusted`
  without hard override, and the rule appears in `hard_rules_inconclusive`.
- A severity that lands on a tie at four decimal places, and a drift
  moving average stored just below a tie, round half to even on the exact
  value. The cross-evaluator check confirms the Node.js evaluator rounds
  them the same way.
- A missing signal whose on_missing value is critical produces `untrusted`
  standing without hard override, the same as a value in the critical range.
  A missing signal whose on_missing value is ignore leaves the standing
  `trusted`.
- A signal in its critical range takes precedence over a missing signal or an
  inconclusive hard rule and produces `untrusted` without hard override.
- A signal with weight 0 never moves the band, even when its value is in the
  critical range or it is missing with on_missing critical. These samples run
  against `profiles/valid/zero-weight-signal.json` and expect `good`.
- A scored signal value that is not a finite JSON number is never scored
  (Section 3.3). The `scored-signal-type-*` samples send text, numeric text,
  a boolean, null, an object, an array and an integer too large for a double.
  Each lists the signal in `missing_signals` with the reason `type_mismatch`,
  and the signal's on_missing value decides the standing. A sample for each
  on_missing value pins the standing that value gives, and a mistyped weight 0
  signal never moves the band. `scored-signal-finite-number.json` sends each
  JSON number form and expects every signal scored.
- The same input always produces the same output (determinism check).

### 5. Unsupported Extends

The reference evaluators do not support `extends` yet, so Section 7 requires
them to reject any profile that uses it. Every valid profile that declares
`extends` must be rejected, and every other valid profile must load.

### 6. Extension Registry

Every key in `extensions/registry.json` starts with `x_`, keys are unique,
and each status is `reserved`, `active` or `retired`.

## Scored Signal Value Types Outside JSON

`scored_signal_types_check.py` covers the scored signal values no evidence
file can carry. Not a number (NaN) and infinity have no JSON form and reach an evaluator
only from a caller that passes values in memory, and a JSON number such as
`1e400` is read as infinity by each language's own parser. The check passes
these to the Python and Node.js evaluators, and both must report a type
mismatch and write the same `result_hash`. It also confirms that a
declared signal named after an inherited object member, such as
`constructor`, is absent unless the evidence carries it, and that a hard
rule field holding an integer too large for a double leaves the rule
inconclusive. It needs Node.js 18 or later.

```shell
python tests/scored_signal_types_check.py
```

## Adding New Tests

**New valid profile:** Add a `.json` file to `profiles/valid/`. It must pass
schema validation.

**New invalid profile:** Add a `.json` file to `profiles/invalid/` with a
`x_test_description` field explaining what constraint it violates. It must
fail schema validation.

**New evidence sample:** Add a `.json` file to `evidence/` with
`_expected_standing`, `_expected_response`, and `_expected_hard_override`
fields. Add `_expected_inconclusive_rules` (a list of rule identifiers) when
the sample should leave rules inconclusive, and `_expected_missing_signals`
(the exact `missing_signals` list) when the sample tests a missing or
mistyped scored signal. The test runner evaluates it
against `profiles/valid/full-featured.json`, or against the valid profile
named in `_profile` when the sample sets one. A bare file name in `_profile`
names a profile in `profiles/valid/`, and a path with a slash, such as
`examples/manufacturing-safety/trp.json`, is read from the repository root.

## Cross-Evaluator Check

```shell
python tests/cross_evaluator_check.py
```

The check runs both reference evaluators, `tools/evaluate.py` and
`tools/evaluate.js`, on every profile in `profiles/valid/` and every
`examples/*/trp.json` against every evidence sample. For each pair the two
outputs must match once the volatile `evaluated_at` and `evaluator` members
are removed, and `result_hash` must match byte for byte. Every valid profile
that declares `extends` must be rejected by both. The check needs Node.js 18
or later.

## Continuous Integration

The GitHub Actions workflow at `.github/workflows/ci.yml` runs this suite
on every push and pull request against `main`, across Python 3.10 and 3.12,
and runs the cross-evaluator check in its own job.
