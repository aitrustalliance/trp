# Writing Your First Trust Requirements Profile

A practical guide for domain experts, compliance professionals, and engineers.

## What This Guide Is For

A Trust Requirements Profile (TRP) encodes what trust means in your domain
as a machine-readable document. This guide walks you through writing one from
scratch, validating it, and testing it with the reference evaluator. No prior
experience with JSON Schema or trust frameworks is required.

By the end, you will have a working profile that any conforming evaluator can
read and enforce.

## Before You Start

You need three things:

1. **Domain knowledge.** You understand the trust requirements for your use
   case: what to measure, what thresholds matter, and what conditions
   should halt operations. This is the hard part, and it is yours.

2. **A text editor.** Any editor that handles JSON (VS Code, Sublime,
   Notepad++, vim).

3. **Python 3.10+ with jsonschema installed.**
   ```bash
   pip install jsonschema
   ```

## Step 1: Start With the Required Fields

Every TRP profile needs six fields. Copy this skeleton into a new file
called `my-profile.json`:

```json
{
  "$schema": "https://aitrustalliance.com/schema/trp/0.5/trp.schema.json",
  "trp_id": "my-use-case",
  "spec_version": "0.5",
  "version": "1.0.0",
  "authority": "your-organization.com",
  "scope": {
    "intended_use": "Describe what this profile governs in one sentence."
  },
  "standing_bands": [
    { "band": "trusted", "severity": 0 },
    { "band": "untrusted", "severity": 1 }
  ]
}
```

This is already a valid profile. You can verify it right now:

```bash
python -c "
import json, jsonschema
schema = json.load(open('schema/trp.schema.json'))
profile = json.load(open('my-profile.json'))
jsonschema.Draft202012Validator(schema).validate(profile)
print('Valid.')
"
```

No output other than "Valid." means your profile conforms to the schema.

### Field-by-field

| Field | What to write | Example |
|-------|---------------|---------|
| `trp_id` | A short, lowercase, hyphenated identifier. Unique within your authority. | `healthcare-phi-governance` |
| `spec_version` | Always `"0.5"` for now. | `"0.5"` |
| `version` | Your profile's version. Use semantic versioning. | `"1.0.0"` |
| `authority` | Who is responsible for this profile. Usually your organization's domain. | `"mercy-health.org"` |
| `scope.intended_use` | One sentence describing what this profile governs. | `"Trust requirements for AI systems processing protected health information."` |
| `standing_bands` | The outcome levels your profile declares, from best (lowest severity) to worst. | See below. |

## Step 2: Define Your Standing Bands

Standing bands are the possible outcomes of an evaluation. Think of them as
grades. Most profiles use two or three:

```json
"standing_bands": [
  {
    "band": "trusted",
    "severity": 0,
    "range": "All signals within acceptable range, no hard rules triggered."
  },
  {
    "band": "conditional",
    "severity": 1,
    "range": "One or more signals in warning range."
  },
  {
    "band": "untrusted",
    "severity": 2,
    "range": "Any signal in critical range or a hard rule triggered."
  }
]
```

Choose names that make sense in your domain. A manufacturing profile might
use `operational`, `restricted`, `shutdown`. A financial services profile
might use `cleared`, `flagged`, `blocked`. The names are yours. The
severity numbers determine ordering: lower is better.

## Step 3: Add Scored Signals

Scored signals are the measurable indicators that contribute to a trust
evaluation. Each signal has a name, a weight, a direction, and two
thresholds (warning and critical).

Ask yourself: **What would I measure to decide whether this system is
trustworthy?**

Here is a signal for a healthcare AI system:

```json
"scored_signals": [
  {
    "signal": "deidentification_confidence",
    "weight": 30,
    "direction": "lower_is_unsafe",
    "warning_threshold": 0.95,
    "critical_threshold": 0.85,
    "unit": "ratio",
    "reason": "Below 95% confidence, PHI may leak into outputs."
  }
]
```

### How to choose values

**signal**: A descriptive, lowercase name. This is the key that evidence
data will use to report a measurement.

**weight**: How much this signal matters relative to others. Weights don't
need to sum to 100. They express relative importance: a signal with weight
30 is three times more significant than a signal with weight 10.

**direction**: Which way is dangerous?
- `"lower_is_unsafe"` - higher values are better (accuracy, confidence,
  coverage). Crossing below the threshold is bad.
- `"higher_is_unsafe"` - lower values are better (latency, error rate,
  bias score). Crossing above the threshold is bad.

**warning_threshold**: The value where you start paying attention. Not yet
dangerous, but trending the wrong way.

**critical_threshold**: The value where trust is broken. Beyond this point,
the system should not be trusted for this signal.

**unit**: Optional but recommended. Documents what the number means
(`"ratio"`, `"ms"`, `"hours"`, `"count"`).

**reason**: Optional but strongly recommended. Explains *why* this threshold
matters in your domain. This is where your expertise lives.

**on_missing**: What happens if this signal has no data? Options:
- `"incomplete"` (default): Treat as incomplete evidence.
- `"critical"`: Treat as if the signal is in the critical range.
- `"ignore"`: Skip this signal in the evaluation.

### A complete set of signals

A real profile typically has 4-8 signals. Here is a set for an AI chatbot
handling customer financial data:

```json
"scored_signals": [
  {
    "signal": "pii_detection_accuracy",
    "weight": 35,
    "direction": "lower_is_unsafe",
    "warning_threshold": 0.97,
    "critical_threshold": 0.90,
    "unit": "ratio",
    "reason": "PII detection below 97% risks exposing customer data.",
    "on_missing": "critical"
  },
  {
    "signal": "response_latency_ms",
    "weight": 10,
    "direction": "higher_is_unsafe",
    "warning_threshold": 2000,
    "critical_threshold": 10000,
    "unit": "ms",
    "reason": "Latency above 2s degrades experience; above 10s indicates failure."
  },
  {
    "signal": "hallucination_rate",
    "weight": 25,
    "direction": "higher_is_unsafe",
    "warning_threshold": 0.03,
    "critical_threshold": 0.10,
    "unit": "ratio",
    "reason": "Financial advice with >3% hallucination rate is dangerous."
  },
  {
    "signal": "bias_score",
    "weight": 20,
    "direction": "higher_is_unsafe",
    "warning_threshold": 0.05,
    "critical_threshold": 0.15,
    "unit": "ratio",
    "reason": "Demographic bias above 5% violates fair lending requirements."
  },
  {
    "signal": "consent_coverage",
    "weight": 10,
    "direction": "lower_is_unsafe",
    "warning_threshold": 0.99,
    "critical_threshold": 0.95,
    "unit": "ratio",
    "reason": "Operating on data without verified consent is a regulatory violation."
  }
]
```

## Step 4: Add Hard Rules

Hard rules are pass/fail conditions that override scored signals. When a
hard rule fires, the evaluation immediately produces the worst standing
regardless of how good the signal scores are.

Ask yourself: **What conditions should immediately stop this system?**

```json
"hard_rules": [
  {
    "rule": "unauthorized-data-access",
    "field": "unauthorized_access_detected",
    "condition": "is_true",
    "action": "halt"
  },
  {
    "rule": "model-not-approved",
    "field": "model_approval_status",
    "condition": "not_equals",
    "value": "approved",
    "action": "block_startup"
  },
  {
    "rule": "excessive-error-rate",
    "field": "error_rate",
    "condition": "greater_than",
    "value": 0.20,
    "action": "require_review"
  }
]
```

### Available conditions

| Condition | Meaning | Needs `value`? |
|-----------|---------|----------------|
| `is_true` | The field is truthy | No |
| `is_false` | The field is falsy | No |
| `equals` | The field equals the value | Yes |
| `not_equals` | The field does not equal the value | Yes |
| `less_than` | The field is less than the value | Yes |
| `greater_than` | The field is greater than the value | Yes |

### Available actions

| Action | Meaning |
|--------|---------|
| `halt` | Stop operations immediately. |
| `block_startup` | Prevent the system from starting. |
| `require_review` | Flag for human review before proceeding. |

## Step 5: Add Optional Metadata

These fields are optional but add value for discoverability, governance,
and compliance mapping:

```json
"name": "Financial AI Chatbot Trust Requirements",
"description": "Trust profile for customer-facing AI chatbots handling account inquiries and financial advice.",
"author": {
  "name": "Risk & Compliance Team",
  "role": "Chief Risk Officer",
  "credential": "CRCM, CAMS"
},
"created_at": "2026-08-28T00:00:00Z",
"license": "Apache-2.0",
"taxonomy": {
  "industry": "financial-services",
  "use_case": "customer-chatbot"
},
"scope": {
  "intended_use": "Trust requirements for AI chatbots handling customer financial inquiries.",
  "boundary": "Customer-facing chatbot interactions within retail banking.",
  "jurisdiction": ["US"],
  "out_of_scope": ["Internal employee tools", "Batch processing systems"]
}
```

### Assurance Mapping

Link your signals to external compliance frameworks so auditors can trace
requirements:

```json
"assurance_mapping": [
  { "framework": "FFIEC IT Examination Handbook", "reference": "Information Security, II.C.20" },
  { "framework": "NIST AI RMF", "reference": "MEASURE 2.6" },
  { "framework": "OCC SR 11-7", "reference": "Model Risk Management" }
]
```

Note: This does not change what your profile requires. It does document why your
signals and thresholds exist, creating a traceable link between your trust
requirements and the regulatory framework they implement.

## Step 6: Add Drift Detection

Drift detection watches for sustained trends that might not trigger an
individual threshold but indicate degradation over time:

```json
"drift": {
  "window": 5,
  "signals": ["hallucination_rate", "bias_score"]
}
```

The `window` is the number of consecutive evaluations over which a trend
is assessed. Each signal listed must also appear in `scored_signals`.

## Step 7: Define Required Standing

Specify the minimum acceptable standing and what response applies at each
band:

```json
"required_standing": {
  "minimum_acceptable_band": "conditional",
  "source_requirement": "Evaluation source must be independent of the system operator.",
  "response_bands": [
    { "band": "trusted", "response": "full" },
    { "band": "conditional", "response": "restricted" },
    { "band": "untrusted", "response": "suspended" }
  ]
}
```

The `response` values are: `full`, `restricted`, `suspended`, `revoked`.
These tell enforcement systems how to react at each standing level. The
profile declares the responses; enforcement is handled by the systems that
consume the evaluation result.

## Step 8: Validate and Test

### Validate against the schema

```bash
python -c "
import json, jsonschema
schema = json.load(open('schema/trp.schema.json'))
profile = json.load(open('my-profile.json'))
jsonschema.Draft202012Validator(schema).validate(profile)
print('Valid.')
"
```

### Generate sample evidence

```bash
python tools/evaluate.py my-profile.json --generate-sample > sample.json
```

This creates a JSON file with all signals set to safe values. Review it
to confirm the signal names and safe defaults make sense.

### Run an evaluation

```bash
python tools/evaluate.py my-profile.json sample.json
```

You should see a result with `"standing": "trusted"` and no hard rules
triggered. If you don't, check your thresholds and signal directions.

### Test edge cases

Edit `sample.json` to push signals into warning and critical ranges.
Verify that the evaluator produces the standing you expect. This is how
you confirm that your thresholds are calibrated correctly before
publishing.

### Run the conformance suite

```bash
python tests/run_conformance.py --verbose
```

If your profile is in `examples/`, the suite automatically validates it
against the schema.

## Step 9: Publish

Place your profile in the `examples/` directory with a descriptive folder
name:

```
examples/
  your-domain-use-case/
    trp.json          your profile
    README.md         brief description of the use case and requirements
```

Submit a pull request. Your profile carries its own author, version,
license, and taxonomy. Your work stays attributed and yours.

## Extension Fields

### Signal Naming and Evidence Mapping

Signal names in a TRP profile are chosen by the profile author. The evaluator
treats them as opaque keys matched against evidence data. There is no global
signal registry. A healthcare profile uses `deidentification_confidence`. A
manufacturing profile uses `human_distance_m`. A financial profile uses
`pii_detection_accuracy`. Each domain speaks its own language.

This is deliberate. Forcing every domain to adopt a universal signal vocabulary
would slow adoption and produce names too generic to be useful. The profile
author is the domain expert. They name the signals. The evaluator matches keys.

For organizations connecting TRP to existing telemetry (Prometheus, CloudWatch,
Splunk, Datadog), the mapping between your internal metric names and TRP signal
names happens in the evidence adapter, not in the profile. A simple adapter
reads your monitoring system, extracts the relevant values, and passes them to
the evaluator using the signal names the profile expects. The evaluator does not
need to know where the data came from.

Naming conventions that help:

- Use lowercase with underscores: `response_latency_ms`, not `ResponseLatencyMs`.
- Include the unit in the name when it clarifies meaning: `latency_ms`, `distance_m`, `age_days`.
- Use domain terminology your practitioners already know, not invented abstractions.
- Document the expected source in the `reason` field so integrators know where to find the data.

### Vendor Extensions

TRP supports vendor-specific extensions using the `x_` prefix on any
object. The schema validator accepts them, but they carry no normative
meaning:

```json
{
  "signal": "custom_metric",
  "weight": 10,
  "direction": "higher_is_unsafe",
  "warning_threshold": 50,
  "critical_threshold": 100,
  "x_internal_signal_id": "RISK-042",
  "x_data_source": "splunk-query-7291"
}
```

Use extensions to map TRP signals to your internal systems without
modifying the standard.

## Profile Design Checklist

Before publishing, verify:

- [ ] `trp_id` is lowercase, hyphenated, and unique within your authority.
- [ ] `version` follows MAJOR.MINOR.PATCH format.
- [ ] `scope.intended_use` clearly states what the profile governs.
- [ ] Every `scored_signal` has a `reason` explaining why the threshold matters.
- [ ] `direction` is correct for each signal (which way is dangerous?).
- [ ] `warning_threshold` is less severe than `critical_threshold` for the
      given direction.
- [ ] Hard rules cover the conditions that should immediately stop operations.
- [ ] `standing_bands` are ordered from best (lowest severity) to worst.
- [ ] The profile validates against the schema with zero errors.
- [ ] The evaluator produces expected standings for healthy, warning, and
      critical evidence.
- [ ] `assurance_mapping` links requirements to the relevant compliance
      frameworks.
- [ ] `author` identifies the domain expert responsible for the profile.

## What Makes a Good Profile

A valid profile passes the schema. A good profile earns the trust of the
practitioners who depend on it.

Scope it tightly. "AI system trust requirements" is too broad to be useful.
"Trust requirements for customer-facing AI chatbots handling account
inquiries in US retail banking" tells a reader exactly when this profile
applies and when it does not.

Put your expertise in the `reason` fields. A threshold without a reason is
a number without context. Compare "0.95" to "Below 0.95 confidence, PHI
may leak into model outputs per HIPAA Safe Harbor §164.514(b)." The second
version is one an auditor can trace, a developer can act on, and an
evaluator can enforce.

Five signals with justified thresholds beat fifteen with arbitrary numbers.
You can add signals in later versions. You cannot undo confusion from a
profile that tried to measure everything at once.

Test adversarially. Push every signal to its boundaries. Trigger every hard
rule. If a threshold produces a surprising result, fix the threshold. The
evaluator is deterministic; surprises come from the profile, not the engine.

Version deliberately. Changing a threshold is a MINOR bump. Adding or
removing a signal is a MAJOR bump. Consumers of your profile depend on
that stability.

## Next Steps

- Read the [specification](../spec/trp-spec.md) for the complete field-by-field
  reference.
- Review the [manufacturing safety](../examples/manufacturing-safety/trp.json)
  and [healthcare data governance](../examples/healthcare-data-governance/trp.json)
  reference profiles for real-world examples.
- See [INTEGRATIONS.md](../INTEGRATIONS.md) for how TRP composes with identity,
  authorization, and tool invocation protocols.
- See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to submit your profile to
  the repository.
