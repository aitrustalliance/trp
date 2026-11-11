#!/usr/bin/env python3
"""OpenTelemetry export for TRP (Trust Requirements Profile) evaluations and VTR (Verifiable Trust Receipt) receipts.

Each evaluation or receipt becomes one span or one log record in the JSON encoding of the OpenTelemetry Protocol
(OTLP), written with the Python standard library and the reference library in vtr/tools. No OpenTelemetry package
is needed at runtime. When the opentelemetry-api package and an SDK are installed, emit_spans() sends the same spans
through a TracerProvider the application already configured.

    python adapters/otel/trp_otel.py receipts receipts.jws --signal logs > receipts.otlp.json
    python adapters/otel/trp_otel.py evaluation --profile trp.json --evidence evidence.json --at 2026-11-04T12:00:00Z
    python adapters/otel/trp_otel.py check receipts.otlp.json

Attribute names follow the OpenTelemetry semantic conventions where a registered name fits, gen_ai.agent.id for the
agent that acted among them. Every other name sits under the trp namespace. README.md lists each attribute.

A receipt's claims map onto attributes one to one, so attributes_to_claims() rebuilds the claims and the digest
of the rebuilt claims equals trp.vtr.digest. A claim the attribute table cannot carry exactly, such as a null
member or a free-form details object, travels as canonical JSON under trp.vtr.json.<claim>.

Evidence values never leave the adapter unless the caller passes include_evidence, or --include-evidence on the
command line. The export carries the evidence digest in every case.

The export translates what a receipt claims and checks the claims against the VTR rules. It does not check the
signature, so run vtr/tools/vtr_verify.py on a receipt before trusting it.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import re
import sys
import time
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "vtr" / "tools"))
import vtr  # noqa: E402  the VTR reference library in vtr/tools/vtr.py

AttributeValue = str | bool | int | float | list[str]
Attributes = dict[str, AttributeValue]

SCOPE_NAME = "trp-otel-export"
SCOPE_VERSION = "0.6.0"
DEFAULT_SERVICE_NAME = "trp-evaluator"
SPAN_KIND_INTERNAL = 1  # opentelemetry.proto.trace.v1.Span.SpanKind
SEVERITY = {"meets": (9, "INFO"), "does_not_meet": (13, "WARN"), "incomplete": (13, "WARN")}  # SeverityNumber
EVALUATION_EVENT = "trp.evaluation.result"
RECEIPT_EVENT = "trp.vtr.receipt"
JSON_PREFIX = "trp.vtr.json."
HEX_ID = re.compile(r"[0-9a-fA-F]+")

# Top-level claims that carry one value. The type is the Python type the attribute takes.
SCALARS: dict[str, tuple[str, type]] = {
    "vtr_version": ("trp.vtr.version", str),
    "iss": ("trp.vtr.iss", str),
    "iat": ("trp.vtr.iat", int),
    "sub": ("trp.subject.id", str),
    "kind": ("trp.vtr.kind", str),
    "mode": ("trp.vtr.mode", str),
    "coverage": ("trp.coverage", float),
    "evidence_digest": ("trp.evidence.digest", str),
    "result_digest": ("trp.result.digest", str),
    "nonce": ("trp.vtr.nonce", str),
    "prev": ("trp.vtr.prev", str),
    "build": ("trp.vtr.build", str),
    "outcome": ("trp.vtr.outcome", str),
    "policy_digest": ("trp.vtr.policy_digest", str),
    "input_digest": ("trp.vtr.input_digest", str),
    "trp_clauses": ("trp.vtr.trp_clauses", list),
}

# Object claims. Each documented member path maps to one attribute. The registered gen_ai names come from the
# OpenTelemetry GenAI semantic conventions, which README.md pins to one commit.
OBJECTS: dict[str, dict[str, tuple[str, type]]] = {
    "trp_ref": {
        "id": ("trp.profile.id", str),
        "version": ("trp.profile.version", str),
        "digest": ("trp.profile.digest", str),
    },
    "evaluator": {
        "implementation": ("trp.evaluator.implementation", str),
        "version": ("trp.evaluator.version", str),
        "spec_version": ("trp.evaluator.spec_version", str),
    },
    "window": {"start": ("trp.vtr.window.start", str), "end": ("trp.vtr.window.end", str)},
    "agent": {"id": ("gen_ai.agent.id", str), "version": ("gen_ai.agent.version", str)},
    "model": {"provider": ("gen_ai.provider.name", str), "version": ("trp.vtr.model.version", str)},
    "tool": {"name": ("gen_ai.tool.name", str), "target": ("trp.vtr.tool.target", str)},
    "fallback": {
        "from": ("trp.vtr.fallback.from", str),
        "to": ("trp.vtr.fallback.to", str),
        "trp_clause": ("trp.vtr.fallback.trp_clause", str),
    },
    "principal": {
        "scheme": ("trp.vtr.principal.scheme", str),
        "value": ("trp.vtr.principal.value", str),
        "issuer": ("trp.vtr.principal.issuer", str),
    },
    "on_behalf_of": {
        "scheme": ("trp.vtr.on_behalf_of.scheme", str),
        "value": ("trp.vtr.on_behalf_of.value", str),
        "issuer": ("trp.vtr.on_behalf_of.issuer", str),
    },
    "cost": {
        "tokens.input": ("trp.vtr.cost.input_tokens", int),
        "tokens.output": ("trp.vtr.cost.output_tokens", int),
        "money.amount": ("trp.vtr.cost.amount", str),
        "money.currency": ("trp.vtr.cost.currency", str),
    },
    "escalation": {
        "decided_by.scheme": ("trp.vtr.escalation.decided_by.scheme", str),
        "decided_by.value": ("trp.vtr.escalation.decided_by.value", str),
        "decided_by.issuer": ("trp.vtr.escalation.decided_by.issuer", str),
        "decision": ("trp.vtr.escalation.decision", str),
        "decided_at": ("trp.vtr.escalation.decided_at", str),
    },
}

# The standing always carries all of its members. A null band or response leaves its attribute out.
STANDING = {"result": "trp.standing.result", "band": "trp.standing.band", "response": "trp.standing.response"}

# Arrays of objects, written as one string array per member with the same index in each. A column marked optional
# is written only when every row carries it.
ROWS: dict[str, tuple[tuple[str, str, bool], ...]] = {
    "results": (("clause", "trp.results.clause", False), ("outcome", "trp.results.outcome", False)),
    "evaluators": (
        ("name", "trp.vtr.evaluators.name", False),
        ("version", "trp.vtr.evaluators.version", False),
        ("decision", "trp.vtr.evaluators.decision", True),
    ),
}

# Attributes about the record that are not claims.
RECEIPT_DIGEST = "trp.vtr.digest"
RECEIPT_ALG = "trp.vtr.alg"
RECEIPT_KID = "trp.vtr.kid"
EVIDENCE_JSON = "trp.evidence.json"


class ExportError(ValueError):
    pass


@dataclass(frozen=True)
class Record:
    """One evaluation or one receipt, ready to write as a span or a log record."""

    event_name: str
    span_name: str
    time_unix_nano: int
    attributes: Attributes
    key: str  # the content the derived trace and span identifiers are computed from
    standing_result: str


# ---------------------------------------------------------------- typed access to the reference library


def digest(value: object) -> str:
    """RFC 8785 canonical JSON, then SHA-256, then base64url without padding, as vtr/spec.md defines a digest."""
    try:
        return cast(str, vtr.digest(value))  # type: ignore[no-untyped-call]
    except vtr.VTRError as err:
        raise ExportError(f"a value has no RFC 8785 canonical form ({err})") from None


def canonical(value: object) -> str:
    try:
        return cast(str, vtr.canonical(value))  # type: ignore[no-untyped-call]
    except vtr.VTRError as err:
        raise ExportError(f"a value has no RFC 8785 canonical form ({err})") from None


def _unb64u(text: str) -> bytes:
    return cast(bytes, vtr.unb64u(text))  # type: ignore[no-untyped-call]


def _check_claims(claims: object) -> None:
    try:
        vtr.check_claims(claims)  # type: ignore[no-untyped-call]
    except vtr.VTRError as err:
        raise ExportError(f"the receipt claims break a VTR rule ({err})") from None


def _determination(profile: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(profile, dict) or not isinstance(evidence, dict):
        raise ExportError("the profile and the evidence must each be a JSON object")
    try:
        return cast(dict[str, Any], vtr.determination(profile, evidence))  # type: ignore[no-untyped-call]
    except (KeyError, TypeError, ValueError) as err:
        raise ExportError(f"the reference evaluator cannot evaluate this profile and evidence ({err!r})") from None


def _trp_ref(profile: dict[str, Any]) -> dict[str, str]:
    return cast(dict[str, str], vtr.trp_ref(profile))  # type: ignore[no-untyped-call]


# ---------------------------------------------------------------- claims to attributes and back


def _is_type(value: object, kind: type) -> bool:
    """Whether a claim value fits the attribute type. A boolean is never a number, and a float attribute takes an
    integer, since canonical JSON writes 1 and 1.0 the same way."""
    if isinstance(value, bool):
        return kind is bool
    if kind is float:
        return isinstance(value, (int, float))
    if kind is list:
        return isinstance(value, (list, tuple)) and all(isinstance(x, str) for x in value)
    return isinstance(value, kind)


def _leaves(value: Mapping[str, Any], prefix: str = "") -> list[tuple[str, Any]] | None:
    """The leaf paths of a nested object, or None when an object on the way is empty, which no path could carry."""
    if not value:
        return None
    out: list[tuple[str, Any]] = []
    for key, member in value.items():
        path = f"{prefix}{key}"
        if isinstance(member, dict):
            nested = _leaves(member, path + ".")
            if nested is None:
                return None
            out.extend(nested)
        else:
            out.append((path, member))
    return out


def _attribute(value: Any, kind: type) -> AttributeValue:
    if kind is float:
        return float(value)
    if kind is list:
        return list(value)
    return cast(AttributeValue, value)


def _encode_object(claim: str, value: Any) -> Attributes | None:
    if not isinstance(value, dict):
        return None
    table = OBJECTS[claim]
    leaves = _leaves(value)
    if leaves is None:
        return None
    attrs: Attributes = {}
    for path, member in leaves:
        if path not in table or not _is_type(member, table[path][1]):
            return None
        name, kind = table[path]
        attrs[name] = _attribute(member, kind)
    return attrs


def _encode_standing(value: Any) -> Attributes | None:
    if not isinstance(value, dict) or set(value) != set(STANDING) or not isinstance(value["result"], str):
        return None
    attrs: Attributes = {STANDING["result"]: value["result"]}
    for member in ("band", "response"):
        if value[member] is None:
            continue
        if not isinstance(value[member], str):
            return None
        attrs[STANDING[member]] = value[member]
    return attrs


def _encode_rows(claim: str, value: Any) -> Attributes | None:
    columns = ROWS[claim]
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        return None
    allowed = {c[0] for c in columns}
    attrs: Attributes = {}
    for member, name, optional in columns:
        present = [member in row for row in value]
        if optional and value and not all(present):
            if any(present):
                return None  # a column some rows carry and some do not has no exact parallel array form
            continue
        if optional and not value:
            continue
        if not all(present):
            return None
        cells = [row[member] for row in value]
        if any(not isinstance(cell, str) for cell in cells):
            return None
        attrs[name] = cells
    if any(set(row) - allowed for row in value):
        return None
    return attrs


def claims_to_attributes(claims: Mapping[str, Any]) -> Attributes:
    """One attribute per documented claim member. A claim whose value the tables cannot carry exactly goes under
    trp.vtr.json.<claim> as canonical JSON, so attributes_to_claims() always rebuilds the same claims."""
    attrs: Attributes = {}
    for claim, value in claims.items():
        encoded: Attributes | None = None
        if claim in SCALARS:
            name, kind = SCALARS[claim]
            encoded = {name: _attribute(value, kind)} if _is_type(value, kind) else None
        elif claim in OBJECTS:
            encoded = _encode_object(claim, value)
        elif claim == "standing":
            encoded = _encode_standing(value)
        elif claim in ROWS:
            encoded = _encode_rows(claim, value)
        attrs.update(encoded if encoded is not None else {JSON_PREFIX + claim: canonical(value)})
    return attrs


def _typed(attrs: Mapping[str, Any], name: str, kind: type) -> Any:
    """An attribute value of the type the export writes. An SDK span stores an array as a tuple, read as a list."""
    value = attrs[name]
    if not _is_type(value, kind):
        raise ExportError(f"attribute {name} is not of the type the export writes")
    return list(value) if kind is list else value


def attributes_to_claims(attrs: Mapping[str, Any]) -> dict[str, Any]:
    """Rebuilds receipt claims from exported attributes. Attributes that are not claims are ignored."""
    claims: dict[str, Any] = {}
    for claim, (name, kind) in SCALARS.items():
        if name in attrs:
            claims[claim] = _typed(attrs, name, kind)
    for claim, table in OBJECTS.items():
        present = [(path, name, kind) for path, (name, kind) in table.items() if name in attrs]
        if not present:
            continue
        obj: dict[str, Any] = {}
        for path, name, kind in present:
            *parents, leaf = path.split(".")
            node = obj
            for part in parents:
                node = node.setdefault(part, {})
            node[leaf] = _typed(attrs, name, kind)
        claims[claim] = obj
    if STANDING["result"] in attrs:
        claims["standing"] = {
            member: (_typed(attrs, name, str) if name in attrs else None) for member, name in STANDING.items()
        }
    for claim, columns in ROWS.items():
        cols = {member: _typed(attrs, name, list) for member, name, _ in columns if name in attrs}
        if not cols:
            continue
        lengths = {len(v) for v in cols.values()}
        if len(lengths) != 1:
            raise ExportError(f"the {claim} arrays differ in length")
        claims[claim] = [{member: cells[i] for member, cells in cols.items()} for i in range(lengths.pop())]
    for name, value in attrs.items():
        if name.startswith(JSON_PREFIX):
            claim = name[len(JSON_PREFIX) :]
            if claim in claims:
                raise ExportError(f"claim {claim} is carried twice")
            if not isinstance(value, str):
                raise ExportError(f"attribute {name} is not a JSON string")
            claims[claim] = json.loads(value)
    return claims


# ---------------------------------------------------------------- records

RFC3339 = re.compile(r"(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))")


def unix_nano(text: str) -> int:
    """Nanoseconds since the Unix epoch for an RFC 3339 date-time with an offset. Fraction digits past the ninth
    are dropped, since OTLP counts time in nanoseconds."""
    m = RFC3339.fullmatch(text)
    if not m:
        raise ExportError(f"{text!r} is not an RFC 3339 date-time with an offset")
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    offset = dt.timedelta(0)
    if m.group(9):
        offset = dt.timedelta(hours=int(m.group(10)), minutes=int(m.group(11)))
        offset = offset if m.group(9) == "+" else -offset
    try:
        t = dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone(offset))
    except ValueError:
        raise ExportError(f"{text!r} is not a valid date and time") from None
    seconds = int((t - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)).total_seconds())
    return seconds * 1_000_000_000 + int((m.group(7) or "0")[:9].ljust(9, "0"))


def receipt_record(claims: Mapping[str, Any], header: Mapping[str, Any] | None = None) -> Record:
    """A record for one receipt. The claims must pass the VTR claim rules."""
    _check_claims(dict(claims))
    attrs = claims_to_attributes(claims)
    receipt_digest = digest(dict(claims))
    attrs[RECEIPT_DIGEST] = receipt_digest
    if header is not None:
        for name, member in ((RECEIPT_ALG, "alg"), (RECEIPT_KID, "kid")):
            if isinstance(header.get(member), str):
                attrs[name] = header[member]
    trp_ref = claims["trp_ref"]
    return Record(
        RECEIPT_EVENT,
        f"trp.evaluate {trp_ref['id']}",
        int(claims["iat"]) * 1_000_000_000,
        dict(sorted(attrs.items())),
        receipt_digest,
        claims["standing"]["result"],
    )


def evaluation_record(
    profile: dict[str, Any],
    evidence: dict[str, Any],
    at_unix_nano: int,
    sub: str | None = None,
    include_evidence: bool = False,
) -> Record:
    """A record for one evaluation of evidence against a profile with the reference evaluator, the determination a
    receipt would carry without the issuer and the signature. Evidence values are left out unless
    include_evidence is set."""
    d = _determination(profile, evidence)
    pseudo: dict[str, Any] = {
        "trp_ref": _trp_ref(profile),
        "standing": d["standing"],
        "coverage": d["coverage"],
        "results": d["results"],
        "evidence_digest": digest(evidence),
        "result_digest": d["result_digest"],
        "evaluator": dict(vtr.EVALUATOR, spec_version=profile.get("spec_version", "0.5")),
    }
    if sub is not None:
        pseudo["sub"] = sub
    attrs = claims_to_attributes(pseudo)
    if include_evidence:
        attrs[EVIDENCE_JSON] = canonical(evidence)
    key = canonical({"attributes": attrs, "time": str(at_unix_nano)})  # nanoseconds pass 2^53, beyond canonical JSON
    return Record(
        EVALUATION_EVENT,
        f"trp.evaluate {profile['trp_id']}",
        at_unix_nano,
        dict(sorted(attrs.items())),
        key,
        d["standing"]["result"],
    )


def _parse_compact(text: str) -> tuple[dict[str, Any], dict[str, Any]]:
    parts = text.split(".")
    if len(parts) != 3:
        raise ExportError("a receipt line is not a compact JWS")
    try:
        header = json.loads(_unb64u(parts[0]))
        claims = json.loads(_unb64u(parts[1]))
    except (ValueError, vtr.VTRError) as err:
        raise ExportError(f"a receipt is not readable ({err})") from None
    if not isinstance(header, dict) or not isinstance(claims, dict):
        raise ExportError("a receipt header or payload is not a JSON object")
    return header, claims


def _receipt_item(item: Any) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if isinstance(item, str):
        header, claims = _parse_compact(item.strip())
        return claims, header
    if isinstance(item, dict) and isinstance(item.get("claims"), dict) and isinstance(item.get("proof"), dict):
        batch = item["proof"].get("batch")
        return item["claims"], (_parse_compact(batch)[0] if isinstance(batch, str) else None)
    if isinstance(item, dict):
        return item, None
    raise ExportError("a receipt is neither a compact JWS, a batched receipt nor a claims object")


def read_receipts(text: str) -> list[tuple[dict[str, Any], dict[str, Any] | None]]:
    """Receipts from one file, each as a pair of its claims and its JWS header. The header is None for a bare claims
    object. The file has one compact JWS per line, as the TRP gate writes them, or JSON with one receipt or an array
    of them. A JSON receipt is a compact JWS string or a batched receipt {claims, proof}, and a bare claims object is
    read too."""
    body = text.strip()
    if not body:
        raise ExportError("the file has no receipts")
    if body[0] in '[{"':
        try:
            value = json.loads(body)
        except json.JSONDecodeError as err:
            raise ExportError(f"the file is not JSON ({err.msg})") from None
        items = value if isinstance(value, list) else [value]
    else:
        items = [line for line in body.splitlines() if line.strip()]
    return [_receipt_item(item) for item in items]


# ---------------------------------------------------------------- OTLP JSON


def _derived_id(label: str, key: str, size: int) -> str:
    """A trace or span identifier derived from the record's content, so the same receipt always gets the same span."""
    return hashlib.sha256(f"trp.otel.{label}\x00{key}".encode()).hexdigest()[: size * 2]


def check_id(value: str, size: int, label: str) -> str:
    """A trace identifier (16 bytes) or span identifier (8 bytes) as lowercase hex. All zeroes is invalid in OTLP."""
    if len(value) != size * 2 or not HEX_ID.fullmatch(value) or int(value, 16) == 0:
        raise ExportError(f"{label} must be {size * 2} hex digits and not all zero")
    return value.lower()


def any_value(value: AttributeValue) -> dict[str, Any]:
    """An attribute value as an OTLP JSON AnyValue. A 64-bit integer is a decimal string, as proto3 JSON writes it."""
    if isinstance(value, bool):
        return {"boolValue": value}
    if isinstance(value, int):
        return {"intValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    return {"arrayValue": {"values": [any_value(x) for x in value]} if value else {}}


def _key_values(attrs: Mapping[str, AttributeValue]) -> list[dict[str, Any]]:
    return [{"key": k, "value": any_value(v)} for k, v in attrs.items()]


def from_any_value(value: Mapping[str, Any]) -> Any:
    """The Python value of an OTLP JSON AnyValue, for the members this export writes and the other members OTLP
    defines. An integer may arrive as a JSON number or a decimal string, as proto3 JSON allows."""
    if "stringValue" in value:
        return value["stringValue"]
    if "boolValue" in value:
        return bool(value["boolValue"])
    if "intValue" in value:
        return int(value["intValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "arrayValue" in value:
        return [from_any_value(x) for x in value["arrayValue"].get("values", [])]
    if "kvlistValue" in value:
        return {kv["key"]: from_any_value(kv.get("value", {})) for kv in value["kvlistValue"].get("values", [])}
    if "bytesValue" in value:
        return base64.b64decode(value["bytesValue"])
    return None


def attributes_from_otlp(key_values: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    return {kv["key"]: from_any_value(kv.get("value", {})) for kv in key_values}


def _resource(service_name: str) -> dict[str, Any]:
    return {"attributes": _key_values({"service.name": service_name})}


def _scope() -> dict[str, Any]:
    return {"name": SCOPE_NAME, "version": SCOPE_VERSION}


def otlp_traces(
    records: Sequence[Record],
    service_name: str = DEFAULT_SERVICE_NAME,
    trace_id: str | None = None,
    parent_span_id: str | None = None,
) -> dict[str, Any]:
    """An OTLP JSON ExportTraceServiceRequest with one internal span per record. A span starts and ends at the
    record's time. trace_id and parent_span_id place every span inside an existing trace. Without them each span
    gets identifiers derived from its record."""
    if parent_span_id is not None and trace_id is None:
        raise ExportError("a parent span needs the trace it belongs to")
    spans = []
    for r in records:
        span: dict[str, Any] = {
            "traceId": check_id(trace_id, 16, "trace_id") if trace_id else _derived_id("trace", r.key, 16),
            "spanId": _derived_id("span", r.key, 8),
        }
        if parent_span_id:
            span["parentSpanId"] = check_id(parent_span_id, 8, "parent_span_id")
        span.update(
            {
                "name": r.span_name,
                "kind": SPAN_KIND_INTERNAL,
                "startTimeUnixNano": str(r.time_unix_nano),
                "endTimeUnixNano": str(r.time_unix_nano),
                "attributes": _key_values(r.attributes),
            }
        )
        spans.append(span)
    return {
        "resourceSpans": [{"resource": _resource(service_name), "scopeSpans": [{"scope": _scope(), "spans": spans}]}]
    }


def otlp_logs(
    records: Sequence[Record],
    service_name: str = DEFAULT_SERVICE_NAME,
    trace_id: str | None = None,
    parent_span_id: str | None = None,
) -> dict[str, Any]:
    """An OTLP JSON ExportLogsServiceRequest with one event record per record. trace_id and parent_span_id tie each
    record to the span it describes, such as the tool call a receipt judged."""
    if parent_span_id is not None and trace_id is None:
        raise ExportError("a parent span needs the trace it belongs to")
    out: list[dict[str, Any]] = []
    for r in records:
        number, text = SEVERITY[r.standing_result]
        rec: dict[str, Any] = {
            "timeUnixNano": str(r.time_unix_nano),
            "observedTimeUnixNano": str(r.time_unix_nano),
            "severityNumber": number,
            "severityText": text,
            "eventName": r.event_name,
            "attributes": _key_values(r.attributes),
        }
        if trace_id:
            rec["traceId"] = check_id(trace_id, 16, "trace_id")
        if parent_span_id:
            rec["spanId"] = check_id(parent_span_id, 8, "parent_span_id")
        out.append(rec)
    return {
        "resourceLogs": [{"resource": _resource(service_name), "scopeLogs": [{"scope": _scope(), "logRecords": out}]}]
    }


def exported_attributes(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The attributes of every span and log record in an OTLP JSON traces or logs request."""
    out: list[dict[str, Any]] = []
    for rs in doc.get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            out.extend(attributes_from_otlp(s.get("attributes", [])) for s in ss.get("spans", []))
    for rl in doc.get("resourceLogs", []):
        for sl in rl.get("scopeLogs", []):
            out.extend(attributes_from_otlp(r.get("attributes", [])) for r in sl.get("logRecords", []))
    return out


def check_export(doc: Mapping[str, Any]) -> list[str]:
    """Problems found when the digests are rebuilt from exported attributes, empty when every one matches. A record
    with trp.vtr.digest must rebuild to claims with that digest, and a record with trp.evidence.json must carry
    evidence whose digest is trp.evidence.digest."""
    problems = []
    for i, attrs in enumerate(exported_attributes(doc)):
        if RECEIPT_DIGEST in attrs:
            try:
                rebuilt = digest(attributes_to_claims(attrs))
            except (ExportError, ValueError) as err:
                problems.append(f"record {i}: the claims cannot be rebuilt ({err})")
                continue
            if rebuilt != attrs[RECEIPT_DIGEST]:
                problems.append(f"record {i}: the rebuilt claims do not have the digest {RECEIPT_DIGEST} names")
        if EVIDENCE_JSON in attrs and digest(json.loads(attrs[EVIDENCE_JSON])) != attrs.get("trp.evidence.digest"):
            problems.append(f"record {i}: the exported evidence does not have the evidence digest")
    return problems


# ---------------------------------------------------------------- the OpenTelemetry API and SDK, when installed


def sdk_available() -> bool:
    try:
        import opentelemetry.sdk.trace  # noqa: F401
    except ImportError:
        return False
    return True


def sdk_tracer_provider(service_name: str = DEFAULT_SERVICE_NAME) -> Any:
    """A TracerProvider from opentelemetry-sdk with service.name set. The caller adds its span processors."""
    try:
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
    except ImportError as err:
        raise ExportError("opentelemetry-sdk is not installed") from err
    return TracerProvider(resource=Resource.create({"service.name": service_name}))


def emit_spans(
    records: Sequence[Record],
    tracer_provider: Any = None,
    trace_id: str | None = None,
    parent_span_id: str | None = None,
) -> None:
    """Sends one internal span per record through an OpenTelemetry TracerProvider, the global one by default. Each
    span has the name and attributes otlp_traces() writes and starts and ends at the record's time. Span identifiers
    come from the provider, and the trace identifier comes from the parent when trace_id and parent_span_id name one."""
    try:
        from opentelemetry import trace
    except ImportError as err:
        raise ExportError("opentelemetry-api is not installed") from err
    if parent_span_id is not None and trace_id is None:
        raise ExportError("a parent span needs the trace it belongs to")
    provider = tracer_provider if tracer_provider is not None else trace.get_tracer_provider()
    tracer = provider.get_tracer(SCOPE_NAME, SCOPE_VERSION)
    context = None
    if trace_id and parent_span_id:
        parent = trace.SpanContext(
            trace_id=int(check_id(trace_id, 16, "trace_id"), 16),
            span_id=int(check_id(parent_span_id, 8, "parent_span_id"), 16),
            is_remote=True,
            trace_flags=trace.TraceFlags(trace.TraceFlags.SAMPLED),
        )
        context = trace.set_span_in_context(trace.NonRecordingSpan(parent))
    for r in records:
        span = tracer.start_span(
            r.span_name,
            context=context,
            kind=trace.SpanKind.INTERNAL,
            attributes=r.attributes,
            start_time=r.time_unix_nano,
        )
        span.end(end_time=r.time_unix_nano)


# ---------------------------------------------------------------- command line


def _load_json(path: str) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ExportError(f"{path} is not JSON ({err.msg})") from None


def _write(doc: Mapping[str, Any]) -> None:
    json.dump(doc, sys.stdout, indent=2, ensure_ascii=False)
    print()


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export TRP evaluations and VTR receipts as OTLP JSON.")
    sub = ap.add_subparsers(dest="command", required=True)
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--signal", choices=["traces", "logs"], default="traces")
    shared.add_argument("--service-name", default=DEFAULT_SERVICE_NAME)
    shared.add_argument("--trace-id", help="32 hex digits, to place the records in an existing trace")
    shared.add_argument("--parent-span-id", help="16 hex digits, the span the records describe")
    rc = sub.add_parser("receipts", parents=[shared], help="export receipts")
    rc.add_argument("file", help="one compact JWS per line, or JSON with one receipt or an array of them")
    ev = sub.add_parser("evaluation", parents=[shared], help="evaluate evidence and export the evaluation")
    ev.add_argument("--profile", required=True)
    ev.add_argument("--evidence", required=True)
    ev.add_argument("--at", help="RFC 3339 time of the evaluation, default now")
    ev.add_argument("--sub", help="the subject evaluated, as a URI")
    ev.add_argument("--include-evidence", action="store_true", help="also export the evidence values")
    ck = sub.add_parser("check", help="rebuild the digests in an OTLP JSON export")
    ck.add_argument("file")
    args = ap.parse_args(argv)
    try:
        if args.command == "check":
            problems = check_export(_load_json(args.file))
            for p in problems:
                print(p, file=sys.stderr)
            print("valid" if not problems else "invalid")
            return 1 if problems else 0
        if args.command == "receipts":
            text = Path(args.file).read_text(encoding="utf-8")
            records = [receipt_record(c, h) for c, h in read_receipts(text)]
        else:
            at = unix_nano(args.at) if args.at else time.time_ns()
            records = [
                evaluation_record(
                    _load_json(args.profile), _load_json(args.evidence), at, args.sub, args.include_evidence
                )
            ]
        write = otlp_traces if args.signal == "traces" else otlp_logs
        _write(write(records, args.service_name, args.trace_id, args.parent_span_id))
    except ExportError as err:
        print(f"trp_otel: {err}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
