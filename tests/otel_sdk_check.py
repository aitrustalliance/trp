#!/usr/bin/env python3
"""Checks the OpenTelemetry export against the official OpenTelemetry Python packages.

Every golden file in adapters/otel/fixtures/golden must parse as an OTLP ExportTraceServiceRequest or
ExportLogsServiceRequest with the message classes of opentelemetry-proto, refusing any field the protocol does not
define. emit_spans() must send spans through an opentelemetry-sdk TracerProvider with the names, times and
attributes the JSON export writes, and the claims rebuilt from those SDK spans must have each receipt's digest.

    pip install jsonschema cryptography "opentelemetry-sdk==1.45.2" "opentelemetry-proto==1.45.2"
    python tests/otel_sdk_check.py
"""

from __future__ import annotations

import base64
import copy
import json
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from google.protobuf import json_format  # type: ignore[import-untyped]
from opentelemetry import trace
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.trace.v1.trace_pb2 import Span
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "adapters" / "otel"))
import trp_otel as otel  # noqa: E402

GOLDEN = ROOT / "adapters" / "otel" / "fixtures" / "golden"
VECTORS = ROOT / "vtr" / "vectors" / "valid"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
ID_FIELDS = {"traceId", "spanId", "parentSpanId"}

passed = 0
failed: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
        print(f"FAIL  {name}  {detail}")


def hex_ids_to_base64(value: Any) -> Any:
    """OTLP JSON writes trace and span identifiers in hex, where the proto3 JSON mapping that json_format follows
    expects base64. This is the one deviation the OTLP specification lists for identifiers."""
    if isinstance(value, dict):
        return {
            k: (base64.b64encode(bytes.fromhex(v)).decode() if k in ID_FIELDS else hex_ids_to_base64(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [hex_ids_to_base64(v) for v in value]
    return value


def proto_checks() -> None:
    for path in sorted(GOLDEN.glob("*.json")):
        doc = json.loads(path.read_text())
        traces = "resourceSpans" in doc
        message: Any = ExportTraceServiceRequest() if traces else ExportLogsServiceRequest()
        try:
            json_format.Parse(json.dumps(hex_ids_to_base64(doc)), message, ignore_unknown_fields=False)
            parsed = True
        except json_format.ParseError as err:
            parsed = False
            check(f"{path.name}: parses as an OTLP request", False, err)
        if not parsed:
            continue
        check(f"{path.name}: parses as an OTLP request with no unknown field", True)
        if traces:
            spans = [s for rs in message.resource_spans for ss in rs.scope_spans for s in ss.spans]
            first = doc["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
            check(
                f"{path.name}: spans are internal and keep their identifiers",
                all(s.kind == Span.SPAN_KIND_INTERNAL for s in spans)
                and spans[0].trace_id.hex() == first["traceId"]
                and spans[0].span_id.hex() == first["spanId"],
            )
            check(
                f"{path.name}: span times parse from decimal strings",
                spans[0].start_time_unix_nano == int(first["startTimeUnixNano"]),
            )
            records = [{kv.key: kv.value for kv in s.attributes} for s in spans]
        else:
            logs = [r for rl in message.resource_logs for sl in rl.scope_logs for r in sl.log_records]
            first = doc["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
            check(
                f"{path.name}: the event name lands in LogRecord.event_name",
                all(r.event_name in {otel.EVALUATION_EVENT, otel.RECEIPT_EVENT} for r in logs)
                and logs[0].event_name == first["eventName"],
            )
            check(
                f"{path.name}: trace context is set only when the export ties records to a span",
                all((r.trace_id.hex() == TRACE_ID) == ("traceId" in first) for r in logs),
            )
            records = [{kv.key: kv.value for kv in r.attributes} for r in logs]
        for attrs in records:
            kinds = {k: v.WhichOneof("value") for k, v in attrs.items()}
            check(
                f"{path.name}: issue times are 64-bit integers and coverage is a double",
                kinds.get("trp.vtr.iat", "int_value") == "int_value" and kinds.get("trp.coverage") == "double_value",
                kinds,
            )
            check(
                f"{path.name}: result arrays are arrays of strings",
                kinds.get("trp.results.clause") == "array_value"
                and all(
                    x.WhichOneof("value") == "string_value" for x in attrs["trp.results.clause"].array_value.values
                ),
            )
        roundtrip = json_format.MessageToDict(message)
        check(
            f"{path.name}: the parsed request has the same number of attributes",
            sum(len(r) for r in records) == sum(len(a) for a in otel.exported_attributes(doc)),
            roundtrip.keys(),
        )
    bad = json.loads((GOLDEN / "receipt-agent-tool-allow.traces.json").read_text())
    wrong = copy.deepcopy(bad)
    wrong["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["startTime"] = "1"
    try:
        json_format.Parse(
            json.dumps(hex_ids_to_base64(wrong)), ExportTraceServiceRequest(), ignore_unknown_fields=False
        )
        check("a field OTLP does not define is refused by the strict parse", False)
    except json_format.ParseError:
        check("a field OTLP does not define is refused by the strict parse", True)


def records_for_sdk() -> list[otel.Record]:
    records: list[otel.Record] = []
    for name in ("agent-tool-allow", "agent-tool-escalate", "kind-conformance", "es256-missing-signal-lowers-coverage"):
        receipt = json.loads((VECTORS / f"{name}.json").read_text())["receipt"]
        records.extend(otel.receipt_record(c, h) for c, h in otel.read_receipts(receipt))
    profile = json.loads((ROOT / "tests/profiles/valid/full-featured.json").read_text())
    evidence = json.loads((ROOT / "tests/evidence/all-healthy.json").read_text())
    records.append(otel.evaluation_record(profile, evidence, otel.unix_nano("2026-11-04T12:00:00Z")))
    return records


def as_lists(attrs: Mapping[str, Any] | None) -> dict[str, Any]:
    return {k: (list(v) if isinstance(v, tuple) else v) for k, v in (attrs or {}).items()}


def sdk_checks() -> None:
    check("the SDK is reported available", otel.sdk_available())
    records = records_for_sdk()
    for parent in (False, True):
        provider = otel.sdk_tracer_provider("trp-sdk-check")
        exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        ids: dict[str, str] = {"trace_id": TRACE_ID, "parent_span_id": PARENT_SPAN_ID} if parent else {}
        otel.emit_spans(records, provider, **ids)
        spans = exporter.get_finished_spans()
        label = "inside a given trace" if parent else "as root spans"
        check(f"{label}: one SDK span per record", len(spans) == len(records), len(spans))
        expected = otel.otlp_traces(records, **ids)["resourceSpans"][0]["scopeSpans"][0]["spans"]
        for span, rec, json_span in zip(spans, records, expected, strict=True):
            attrs = as_lists(span.attributes)
            check(
                f"{label} {rec.span_name}: the SDK span matches the JSON export in name and kind, and in time",
                span.name == json_span["name"]
                and span.kind == trace.SpanKind.INTERNAL
                and span.start_time == span.end_time == int(json_span["startTimeUnixNano"]),
            )
            check(
                f"{label} {rec.span_name}: the SDK span has the JSON export's attributes",
                attrs == otel.attributes_from_otlp(json_span["attributes"]),
            )
            check(
                f"{label} {rec.span_name}: service.name and the scope reach the SDK span",
                span.resource.attributes.get("service.name") == "trp-sdk-check"
                and span.instrumentation_scope is not None
                and (span.instrumentation_scope.name, span.instrumentation_scope.version)
                == (otel.SCOPE_NAME, otel.SCOPE_VERSION),
            )
            if otel.RECEIPT_DIGEST in attrs:
                check(
                    f"{label} {rec.span_name}: the claims rebuilt from the SDK span have the receipt digest",
                    otel.digest(otel.attributes_to_claims(attrs)) == attrs[otel.RECEIPT_DIGEST],
                )
            context = span.get_span_context()
            if parent:
                check(
                    f"{label} {rec.span_name}: the span sits under the given parent",
                    span.parent is not None
                    and span.parent.span_id == int(PARENT_SPAN_ID, 16)
                    and context is not None
                    and context.trace_id == int(TRACE_ID, 16),
                )
            else:
                check(f"{label} {rec.span_name}: the span is a root span", span.parent is None)
        provider.shutdown()


def main() -> int:
    proto_checks()
    sdk_checks()
    print(f"OpenTelemetry SDK and OTLP proto: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
