# OpenTelemetry Export

`trp_otel.py` writes TRP (Trust Requirements Profile) evaluations and VTR (Verifiable Trust Receipt) receipts as OpenTelemetry signals. The tracing and logging backends a team already runs can then query and alert on trust decisions next to the agent spans that caused them. Each evaluation or receipt becomes one span or one log record in the JSON (JavaScript Object Notation) encoding of the OpenTelemetry Protocol (OTLP). The adapter needs only the Python standard library and the reference library in `vtr/tools`. When the OpenTelemetry Python software development kit (SDK) is installed, `emit_spans()` sends the same spans through the application's own pipeline.

## Use

```bash
python adapters/otel/trp_otel.py receipts receipts.jws --signal logs > receipts.otlp.json
python adapters/otel/trp_otel.py receipts receipts.jws --trace-id 4bf92f3577b34da6a3ce929d0e0e4736 --parent-span-id 00f067aa0ba902b7
python adapters/otel/trp_otel.py evaluation --profile trp.json --evidence evidence.json --at 2026-11-04T12:00:00Z --sub urn:example:agent:7
python adapters/otel/trp_otel.py check receipts.otlp.json
curl -X POST -H "Content-Type: application/json" --data @receipts.otlp.json http://localhost:4318/v1/logs
```

`receipts` reads one compact JSON Web Signature (JWS) per line, the file the TRP gate writes with `--receipts`, or JSON with one receipt or an array of them. A JSON receipt can be a compact JWS string or a batched receipt with `claims` and `proof`, and a bare claims object is read too. `evaluation` runs the reference evaluator on the evidence and exports the determination a receipt of the same evaluation would carry. That record has no issuer and no signature. `check` rebuilds every digest in an export and exits 1 when one differs. The output of `receipts` and `evaluation` is an OTLP `ExportTraceServiceRequest` or `ExportLogsServiceRequest` in JSON, ready to post to the `/v1/traces` or `/v1/logs` path of any OTLP receiver over the Hypertext Transfer Protocol (HTTP).

The adapter checks each receipt's claims against the VTR claim rules and refuses a receipt that breaks one. It does not check the signature. Run `vtr/tools/vtr_verify.py` on a receipt before a backend treats its span as proof of anything.

## Signals

| Signal | Written As | Name | Time |
|---|---|---|---|
| `--signal traces`, the default | One span of kind `INTERNAL` (1) per record. The span has no duration and no status | `trp.evaluate <profile id>` | The receipt's `iat`, or `--at` for an evaluation |
| `--signal logs` | One log record per record, carrying `eventName` | `trp.vtr.receipt` for a receipt and `trp.evaluation.result` for an evaluation | The same time as the span, in `timeUnixNano` and `observedTimeUnixNano` |

The span status stays unset for every standing. A standing of `does_not_meet` is a finding about the subject, and the evaluation that produced it succeeded. A log record carries severity `INFO` (9) when the standing meets the profile and `WARN` (13) when it does not meet or is incomplete.

Without `--trace-id`, each span gets a trace identifier and a span identifier derived from the Secure Hash Algorithm SHA-256 digest of its record, so the same receipt always becomes the same span and a backend can drop a duplicate. `--trace-id` with `--parent-span-id` places every span under an existing span, such as the tool call span of the agent the receipt judged, and ties every log record to that span. OTLP JSON writes identifiers in hexadecimal. The adapter writes them in lowercase and refuses an identifier of all zeroes.

## Attributes

Attribute names follow the OpenTelemetry semantic conventions where a registered name fits. Every other name sits under the `trp.` namespace. Digests and canonical JSON follow the JSON Canonicalization Scheme of Request for Comments (RFC) 8785, as every VTR digest does. The resource carries `service.name`, set with `--service-name` and `trp-evaluator` by default, and the instrumentation scope is `trp-otel-export` version 0.6.0.

| Attribute | Type | Carries | Written For |
|---|---|---|---|
| `trp.profile.id` | string | `trp_ref.id`, the profile identifier | Both |
| `trp.profile.version` | string | `trp_ref.version` | Both |
| `trp.profile.digest` | string | `trp_ref.digest`, the digest of the profile document | Both |
| `trp.standing.result` | string | `standing.result`, one of `meets`, `does_not_meet` or `incomplete` | Both |
| `trp.standing.band` | string | `standing.band`, left out when the band is null | Both |
| `trp.standing.response` | string | `standing.response`, left out when the response is null | Both |
| `trp.coverage` | double | `coverage`, the share of requirements checked | Both |
| `trp.results.clause` | string array | `results[].clause` in receipt order | Both |
| `trp.results.outcome` | string array | `results[].outcome`, at the same index as its clause | Both |
| `trp.evidence.digest` | string | `evidence_digest` | Both |
| `trp.result.digest` | string | `result_digest`, the digest of the evaluator output | Both |
| `trp.evaluator.implementation` | string | `evaluator.implementation` | Both |
| `trp.evaluator.version` | string | `evaluator.version` | Both |
| `trp.evaluator.spec_version` | string | `evaluator.spec_version` | Both |
| `trp.subject.id` | string | `sub`, the subject evaluated, or `--sub` for an evaluation | Both, when given |
| `trp.evidence.json` | string | The evidence object in RFC 8785 canonical JSON | An evaluation with `--include-evidence` |
| `trp.vtr.digest` | string | The digest of the receipt's claims, the value `prev` and batch leaves use | Receipts |
| `trp.vtr.alg` | string | `alg` from the JWS header, or from the batch statement of a batched receipt | Receipts read from a JWS |
| `trp.vtr.kid` | string | `kid` from the same header | Receipts read from a JWS |
| `trp.vtr.version` | string | `vtr_version` | Receipts |
| `trp.vtr.iss` | string | `iss` | Receipts |
| `trp.vtr.iat` | int | `iat` in Unix seconds | Receipts |
| `trp.vtr.kind` | string | `kind` | Receipts |
| `trp.vtr.mode` | string | `mode` | Receipts |
| `trp.vtr.window.start` | string | `window.start` | Receipts that carry it |
| `trp.vtr.window.end` | string | `window.end` | Receipts that carry it |
| `trp.vtr.nonce` | string | `nonce` | Receipts that carry it |
| `trp.vtr.prev` | string | `prev` | Receipts that carry it |
| `trp.vtr.build` | string | `build` | Receipts that carry it |
| `trp.vtr.outcome` | string | `outcome`, one of `allow`, `stop` or `escalate` | Receipts that carry it |
| `trp.vtr.trp_clauses` | string array | `trp_clauses` | Receipts that carry it |
| `trp.vtr.policy_digest` | string | `policy_digest` | Receipts that carry it |
| `trp.vtr.input_digest` | string | `input_digest` | Receipts that carry it |
| `gen_ai.agent.id` | string | `agent.id`, the agent that acted | Receipts that carry it |
| `gen_ai.agent.version` | string | `agent.version` | Receipts that carry it |
| `gen_ai.provider.name` | string | `model.provider` | Receipts that carry it |
| `trp.vtr.model.version` | string | `model.version` | Receipts that carry it |
| `gen_ai.tool.name` | string | `tool.name` | Receipts that carry it |
| `trp.vtr.tool.target` | string | `tool.target`, such as the Model Context Protocol (MCP) server the call went to | Receipts that carry it |
| `trp.vtr.cost.input_tokens` | int | `cost.tokens.input` | Receipts that carry it |
| `trp.vtr.cost.output_tokens` | int | `cost.tokens.output` | Receipts that carry it |
| `trp.vtr.cost.amount` | string | `cost.money.amount`, a decimal string | Receipts that carry it |
| `trp.vtr.cost.currency` | string | `cost.money.currency`, an ISO 4217 code | Receipts that carry it |
| `trp.vtr.fallback.from` | string | `fallback.from` | Receipts that carry it |
| `trp.vtr.fallback.to` | string | `fallback.to` | Receipts that carry it |
| `trp.vtr.fallback.trp_clause` | string | `fallback.trp_clause` | Receipts that carry it |
| `trp.vtr.principal.scheme` | string | `principal.scheme` | Receipts that carry it |
| `trp.vtr.principal.value` | string | `principal.value` | Receipts that carry it |
| `trp.vtr.principal.issuer` | string | `principal.issuer` | Receipts that carry it |
| `trp.vtr.on_behalf_of.scheme` | string | `on_behalf_of.scheme` | Receipts that carry it |
| `trp.vtr.on_behalf_of.value` | string | `on_behalf_of.value` | Receipts that carry it |
| `trp.vtr.on_behalf_of.issuer` | string | `on_behalf_of.issuer` | Receipts that carry it |
| `trp.vtr.escalation.decided_by.scheme` | string | `escalation.decided_by.scheme` | Receipts that carry it |
| `trp.vtr.escalation.decided_by.value` | string | `escalation.decided_by.value` | Receipts that carry it |
| `trp.vtr.escalation.decided_by.issuer` | string | `escalation.decided_by.issuer` | Receipts that carry it |
| `trp.vtr.escalation.decision` | string | `escalation.decision` | Receipts that carry it |
| `trp.vtr.escalation.decided_at` | string | `escalation.decided_at` | Receipts that carry it |
| `trp.vtr.evaluators.name` | string array | `evaluators[].name` | Receipts that carry it |
| `trp.vtr.evaluators.version` | string array | `evaluators[].version` | Receipts that carry it |
| `trp.vtr.evaluators.decision` | string array | `evaluators[].decision`, written only when every entry has one | Receipts that carry it |
| `trp.vtr.json.<claim>` | string | A claim in RFC 8785 canonical JSON, used for `details` and for any claim whose value the rows above cannot carry exactly, such as a null party or a member the table does not list | Receipts that need it |

A claim takes exactly one form, its attributes in the table or its `trp.vtr.json.<claim>` attribute.

## Registered Names

The registered names come from two sources that `fixtures/sources.json` pins to a release or a commit. Both were read on 2026-11-04.

| Name | Source | Stability |
|---|---|---|
| `service.name` | OpenTelemetry semantic conventions v1.45.0 | Stable |
| `gen_ai.agent.id`, `gen_ai.agent.version`, `gen_ai.provider.name`, `gen_ai.tool.name` | OpenTelemetry GenAI semantic conventions repository at commit `633cbb0`, which has no release yet | Development |

Semantic conventions v1.45.0 marks every `gen_ai.*` name as moved to the GenAI repository, so the names above come from that repository's `model/gen-ai/registry.yaml`. Development stability means a later release can rename them, and a change there means a change to the table in `trp_otel.py`.

Some registered names were read and left out.

- The `gen_ai.evaluation.result` event and its `gen_ai.evaluation.*` attributes describe an evaluation of output from generative artificial intelligence (AI) for quality or accuracy, with an optional numeric score. A TRP evaluation judges a subject's evidence against a profile, and a VTR carries no numeric rating of the subject, so the export writes its own event names.
- `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` belong on the inference span that consumed the tokens. A backend that sums them across spans would count a receipt's `cost` twice, so the receipt's token counts stay under `trp.vtr.cost`.
- `gen_ai.request.model` and `gen_ai.response.model` name a model, and the receipt's `model.version` names a version, so it stays under `trp.vtr.model`.
- The `security_rule.*` attributes describe the one rule that raised an event. A TRP evaluation reports every requirement of a profile at once.

`trp` is not a namespace the semantic conventions register at v1.45.0 or at the GenAI commit above. The naming guidance in v1.45.0 suggests a reverse domain prefix for names an organization defines. A future registration of `trp` by another party would clash with these names, and moving them under a prefix such as `org.aitrustalliance.trp` is a rename in one table.

## Round Trip

`attributes_to_claims()` rebuilds a receipt's claims from its attributes, and the RFC 8785 digest of the rebuilt claims equals `trp.vtr.digest`. A null band or response comes back as null. A claim exported as canonical JSON comes back from that JSON, and every array keeps its order. `check` and `check_export()` run this for every record of an export and also confirm that `trp.evidence.json`, when present, has the digest `trp.evidence.digest` names. An edited band, issue time, clause order or evidence value fails the check.

## Evidence

An evaluation export carries the evidence digest and the per-requirement outcomes, and no evidence value. `--include-evidence`, or `include_evidence=True` in `evaluation_record()`, adds the evidence in canonical JSON as `trp.evidence.json`. A receipt carries no evidence, so a receipt export has nothing to add. VTR Privacy Considerations apply to the digest as well, since evidence with few possible values can be guessed from its digest.

## OpenTelemetry SDK

```python
from opentelemetry.sdk.trace.export import BatchSpanProcessor
import trp_otel

provider = trp_otel.sdk_tracer_provider("trp-gate")  # or the application's own TracerProvider
provider.add_span_processor(BatchSpanProcessor(exporter))  # any span exporter the application uses
records = [trp_otel.receipt_record(c, h) for c, h in trp_otel.read_receipts(open("receipts.jws").read())]
trp_otel.emit_spans(records, provider, trace_id=None, parent_span_id=None)
```

`emit_spans()` needs `opentelemetry-api` and uses the global `TracerProvider` when none is passed. Each span matches its JSON export in name and attributes and starts and ends at the same time. Span identifiers come from the provider. `sdk_tracer_provider()` builds an SDK `TracerProvider` with `service.name` set. Log records go out through the OTLP JSON path only, because the Python logs application programming interface (API) in 1.45.2 is still the private module `opentelemetry._logs`. An SDK configured with a limit on attribute value length truncates long `trp.vtr.json.<claim>` values, and a truncated value no longer rebuilds its digest.

## Fixtures

`fixtures/golden` contains nine exports made from receipts in `vtr/vectors/valid` and from the test profile `tests/profiles/valid/full-featured.json` with two conformance evidence samples. `fixtures/sources.json` records the command and the input digests for each file, and the commit of every OpenTelemetry source the attribute names and the encoding come from.

| File | Input | Shows |
|---|---|---|
| `receipt-agent-tool-allow.traces.json` | `agent-tool-allow` | A gate receipt as a span |
| `receipt-agent-tool-escalate.logs.json` | `agent-tool-escalate` | A gate receipt as an event tied to the span of its tool call |
| `receipt-kind-conformance.traces.json` | `kind-conformance` | A `details` object carried as canonical JSON |
| `receipt-batch-of-5-leaf-2.logs.json` | `batch-of-5-leaf-2` | A batched receipt, with `alg` and `kid` from the batch statement |
| `receipt-es256-window-nonce-prev.traces.json` | `es256-window-nonce-prev` | The optional claims `window`, `nonce` and `prev` |
| `receipt-es256-missing-signal-lowers-coverage.logs.json` | `es256-missing-signal-lowers-coverage` | An incomplete standing with no band and no response |
| `gate-receipts.logs.json` | Three gate receipts, one per line | A receipt file as the TRP gate writes it |
| `evaluation-all-healthy.traces.json` | `tests/evidence/all-healthy.json` | An evaluation that meets the profile |
| `evaluation-hard-rule-triggered.with-evidence.logs.json` | `tests/evidence/hard-rule-triggered.json` | A triggered hard rule, exported with `--include-evidence` |

## Checks

```bash
pip install jsonschema cryptography && python tests/otel_check.py
pip install "opentelemetry-sdk==1.45.2" "opentelemetry-proto==1.45.2" && python tests/otel_sdk_check.py
```

`tests/otel_check.py` needs no OpenTelemetry package. It regenerates each golden file and compares it byte for byte. It checks the field names and value encodings OTLP JSON requires. It rebuilds the digest of all 29 valid receipt vectors through both signals and of 15 claim sets built to reach every shape the VTR schema allows, and it catches edited exports. It exports evidence carrying marker values and confirms none appears without the flag, and that every value in a receipt export comes from the receipt itself. It also confirms the SDK path reports a missing package. `python tests/otel_check.py --write` rewrites the golden files after a deliberate change.

`tests/otel_sdk_check.py` parses every golden file with the OTLP message classes of `opentelemetry-proto` and refuses any field the protocol does not define. It then sends receipts and an evaluation through an SDK `TracerProvider` into an in-memory exporter. The SDK spans must match the JSON export and rebuild each receipt digest. The check runs them as root spans and again under a given parent.

| Package | Version | License | Role |
|---|---|---|---|
| `opentelemetry-sdk` | 1.45.2 | Apache License 2.0 | Optional path and its check, with `opentelemetry-api` 1.45.2 and `opentelemetry-semantic-conventions` 0.66b2 as its dependencies |
| `opentelemetry-proto` | 1.45.2 | Apache License 2.0 | Strict parse of the golden files in the check, with `protobuf` 7.36.2 (BSD 3-Clause License) |
