# Reference Evaluators

Two independent reference implementations that load a TRP profile and
evaluate a data sample against it. The Python and Node.js evaluators share
no code. Both produce identical standings, hard-override decisions, and
response actions for the same profile and evidence, proving that the
specification is independently implementable. Both also write the same
`result_hash`, the SHA-256 of the RFC 8785 canonical JSON form of the output
without its `evaluation` member.

These are reference tools for testing and development. Production evaluation
sources run on their own implementations.

## Implementations

| File | Language | Dependencies |
|------|----------|-------------|
| `evaluate.py` | Python 3.10+ | `jsonschema` (optional, for schema validation) |
| `evaluate.js` | Node.js 18+ | None |

## Quick Start

```shell
# Python
python3 tools/evaluate.py examples/manufacturing-safety/trp.json --generate-sample > sample.json
python3 tools/evaluate.py examples/manufacturing-safety/trp.json sample.json

# Node.js
node tools/evaluate.js examples/manufacturing-safety/trp.json sample.json
```

## Example Output

```json
{
  "trp_id": "manufacturing-safety",
  "trp_version": "1.0.0",
  "hard_rules_triggered": [],
  "hard_rules_inconclusive": [],
  "signal_results": [
    {
      "signal": "human_distance_m",
      "value": 1.8,
      "unit": "m",
      "severity": 0.0,
      "penalty": 0.0,
      "in_warning": false,
      "in_critical": false
    }
  ],
  "missing_signals": [],
  "standing": "good",
  "hard_override": false,
  "response": "full"
}
```

## How It Maps to the Specification

| Spec Concept | Evaluator Behavior |
|---|---|
| Scored signals with direction and thresholds | Severity computed per signal using the spec's directional threshold model |
| Hard rules with conditions and actions | Checked before scoring. Any trigger overrides the standing |
| Inconclusive hard rules (Section 3.4) | A missing field or a type mismatch makes the rule inconclusive, lists it in `hard_rules_inconclusive` and marks the assessment incomplete |
| Inheritance via `extends` (Section 7) | Not supported yet, so the profile is rejected with exit code 2 |
| On-missing policy | A missing signal follows its declared policy. critical puts the standing in the worst band, the same as a value in the critical range, incomplete marks the assessment incomplete, and ignore drops the signal |
| Scored signal value type (Section 3.3) | Only a finite JSON number is scored. Text, numeric text such as "0.5", a boolean, null, an object, an array, not a number (NaN), infinity and an integer too large for a double are type mismatches. The signal is listed in `missing_signals` with the reason `type_mismatch` and never appears in `signal_results`. Its on_missing policy governs as it does for an absent signal, whose entry carries no `reason` member |
| Weight 0 (Section 3.3) | The signal is informational. It is reported in `signal_results` or `missing_signals` and never moves the band, whatever its value or on_missing |
| Standing bands with severity order | Bands sorted by severity and assigned from the worst active condition. A triggered hard rule comes first, then a critical condition, then an incomplete assessment, then a warning. A critical condition sets the worst band whatever other evidence is missing |
| Required standing and response bands | Response action mapped from the assigned band |
| Drift over a window | Moving average tracked per signal across consecutive evaluations. The `drift_detected` field is a placeholder that both reference evaluators always report as `false`, because the specification leaves the method for judging drift to the evaluation source |

## Limitations

This evaluator is intentionally simple and exists to show that the TRP format is machine-actionable. Production evaluation sources may bring their own scoring algorithms and drift models, and the specification permits that because it defines the profile format and leaves the evaluation method open.

## OSCAL Export And Import

`trp_oscal.py` writes a TRP profile in the Open Security Controls Assessment Language (OSCAL) 1.2.3 of the National Institute of Standards and Technology (NIST) and reads OSCAL back. The export writes a TRP-native OSCAL catalog with one control per scored signal and per hard rule, along with an OSCAL profile that imports that catalog and the controls the TRP profile maps in other catalogs. A profile that declares mappings in its `x_oscal` extension also gets an OSCAL mapping collection. The import brings a document the export wrote back as the same TRP profile, and turns any other OSCAL catalog or profile into a skeleton whose placeholder signals carry no threshold.

```shell
python3 tools/trp_oscal.py export profile.json --out-dir out/
python3 tools/trp_oscal.py validate out/*.json
python3 tools/trp_oscal.py import out/my-profile.oscal-profile.json
```

`docs/oscal.md` documents the namespace, the encoding of each TRP member and the `x_oscal` extension.
