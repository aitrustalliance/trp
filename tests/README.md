# TRP Conformance Test Suite

This directory contains the conformance test suite for the Trust Requirements
Profile specification. The suite validates that TRP profiles conform to the
published JSON Schema and that the reference evaluator produces deterministic,
expected results for known inputs.

## Running the tests

```shell
pip install jsonschema
python tests/run_conformance.py --verbose
```

## What the suite tests

### 1. Schema conformance (valid profiles)

Files in `profiles/valid/` must pass JSON Schema validation against
`schema/trp.schema.json`. These include:

| File | What it exercises |
|------|-------------------|
| `minimal.json` | Only required fields; proves the schema accepts a bare profile. |
| `full-featured.json` | Every optional field populated; proves the full grammar works. |
| `with-extension.json` | Profile inheritance via the `extends` field. |

### 2. Schema rejection (invalid profiles)

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

### 3. Example profile validation

All `trp.json` files under `examples/` must pass schema validation, ensuring
that published reference profiles stay conformant as the schema evolves.

### 4. Evaluator determinism

The reference evaluator (`tools/evaluate.py`) is run against evidence samples
in `evidence/`. Each sample embeds its expected standing, response, and
hard-override flag. The suite verifies that:

- Healthy evidence produces `trusted` standing with `full` response.
- Warning-level evidence produces `conditional` standing with `restricted` response.
- Critical-level evidence produces `untrusted` standing with `suspended` response.
- A triggered hard rule produces `untrusted` standing with hard override.
- The same input always produces the same output (determinism check).

## Adding new tests

**New valid profile:** Add a `.json` file to `profiles/valid/`. It must pass
schema validation.

**New invalid profile:** Add a `.json` file to `profiles/invalid/` with a
`x_test_description` field explaining what constraint it violates. It must
fail schema validation.

**New evidence sample:** Add a `.json` file to `evidence/` with
`_expected_standing`, `_expected_response`, and `_expected_hard_override`
fields. The test runner evaluates it against `profiles/valid/full-featured.json`.

## Continuous integration

The GitHub Actions workflow at `.github/workflows/ci.yml` runs this suite
on every push and pull request against `main`, across Python 3.10 and 3.12.
