# Reference Evaluators

Two independent reference implementations that load a TRP profile and
evaluate a data sample against it. The Python and Node.js evaluators share
no code. Both produce identical standings, hard-override decisions, and
response actions for the same profile and evidence, proving that the
specification is independently implementable.

These are reference tools for testing and development, not production
evaluation sources.

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
| Hard rules with conditions and actions | Checked before scoring; any trigger overrides the standing |
| On-missing policy | Missing signals handled per their declared policy (critical, incomplete, or ignore) |
| Standing bands with severity order | Bands sorted by severity; assignment based on worst active condition |
| Required standing and response bands | Response action mapped from the assigned band |
| Drift over a window | Moving average tracked per signal across consecutive evaluations |

## Limitations

This evaluator is intentionally simple. It demonstrates that the TRP format is machine-actionable, not that this particular implementation is optimal. Production evaluation sources may use different scoring algorithms, richer drift models, or additional verification logic. The specification permits all of these because it defines the profile format, not the evaluation method.
