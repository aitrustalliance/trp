#!/usr/bin/env python3
"""Checks the OpenTelemetry export of TRP evaluations and VTR receipts without any OpenTelemetry package.

The golden files in adapters/otel/fixtures/golden are the export of receipts from vtr/vectors and of evaluations
of conformance evidence. Each one must come out byte for byte the same. Every exported receipt must rebuild to
claims with its digest, for all 29 valid receipt vectors and for claims built to reach every claim shape the VTR
schema allows. An evaluation export must carry no evidence value unless --include-evidence is set.

    pip install jsonschema cryptography && python tests/otel_check.py
    python tests/otel_check.py --write    rewrites the golden files after a deliberate change
"""

from __future__ import annotations

import copy
import glob
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "adapters" / "otel"))
import trp_otel as otel  # noqa: E402

ADAPTER = ROOT / "adapters" / "otel" / "trp_otel.py"
FIXTURES = ROOT / "adapters" / "otel" / "fixtures"
GOLDEN = FIXTURES / "golden"
VECTORS = ROOT / "vtr" / "vectors" / "valid"
AT = "2026-11-04T12:00:00Z"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
REGISTERED = {"service.name", "gen_ai.agent.id", "gen_ai.agent.version", "gen_ai.provider.name", "gen_ai.tool.name"}
CANARY_TEXT = "LEAK-CANARY-7F3A"
CANARY_NUMBERS = ("0.0123456789", "21.987654321")

passed = 0
failed: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
        print(f"FAIL  {name}  {detail}")


def raises(fn: Any, *args: Any, **kwargs: Any) -> bool:
    try:
        fn(*args, **kwargs)
    except otel.ExportError:
        return True
    return False


def vector_receipt(name: str) -> str:
    """The receipt of a valid vector in file form. That is a compact JWS, or a batched receipt in JSON."""
    receipt = json.loads((VECTORS / f"{name}.json").read_text())["receipt"]
    return receipt if isinstance(receipt, str) else json.dumps(receipt)


def payload_claims(receipt: Any) -> dict[str, Any]:
    if isinstance(receipt, dict):
        return dict(receipt["claims"])
    claims: dict[str, Any] = json.loads(otel._unb64u(receipt.split(".")[1]))
    return claims


# ---------------------------------------------------------------- golden files


def golden_cases() -> list[tuple[str, list[str], str | None]]:
    """(golden file, command line arguments, input text written to a temporary file or None)."""
    gate_lines = (
        "\n".join(vector_receipt(n) for n in ("agent-tool-allow", "agent-tool-escalate", "agent-tool-stop")) + "\n"
    )
    evaluation = [
        "--profile",
        "tests/profiles/valid/full-featured.json",
        "--at",
        AT,
        "--sub",
        "urn:example:agent:7",
    ]
    return [
        ("receipt-agent-tool-allow.traces.json", ["receipts", "{input}"], vector_receipt("agent-tool-allow")),
        (
            "receipt-agent-tool-escalate.logs.json",
            ["receipts", "{input}", "--signal", "logs", "--trace-id", TRACE_ID, "--parent-span-id", PARENT_SPAN_ID],
            vector_receipt("agent-tool-escalate"),
        ),
        ("receipt-kind-conformance.traces.json", ["receipts", "{input}"], vector_receipt("kind-conformance")),
        (
            "receipt-batch-of-5-leaf-2.logs.json",
            ["receipts", "{input}", "--signal", "logs"],
            vector_receipt("batch-of-5-leaf-2"),
        ),
        (
            "receipt-es256-window-nonce-prev.traces.json",
            ["receipts", "{input}"],
            vector_receipt("es256-window-nonce-prev"),
        ),
        (
            "receipt-es256-missing-signal-lowers-coverage.logs.json",
            ["receipts", "{input}", "--signal", "logs"],
            vector_receipt("es256-missing-signal-lowers-coverage"),
        ),
        (
            "gate-receipts.logs.json",
            ["receipts", "{input}", "--signal", "logs", "--service-name", "trp-gate"],
            gate_lines,
        ),
        (
            "evaluation-all-healthy.traces.json",
            ["evaluation", *evaluation, "--evidence", "tests/evidence/all-healthy.json"],
            None,
        ),
        (
            "evaluation-hard-rule-triggered.with-evidence.logs.json",
            [
                "evaluation",
                *evaluation,
                "--evidence",
                "tests/evidence/hard-rule-triggered.json",
                "--signal",
                "logs",
                "--include-evidence",
            ],
            None,
        ),
    ]


def run_adapter(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(ADAPTER), *args], capture_output=True, text=True, cwd=ROOT)


def export_case(args: list[str], text: str | None, tmp: Path) -> subprocess.CompletedProcess[str]:
    path = tmp / "input.txt"
    if text is not None:
        path.write_text(text)
    return run_adapter([str(path) if a == "{input}" else a for a in args])


def golden_checks(tmp: Path, write: bool) -> None:
    for name, args, text in golden_cases():
        proc = export_case(args, text, tmp)
        check(f"{name}: the adapter exits 0", proc.returncode == 0, proc.stderr)
        if write:
            (GOLDEN / name).write_text(proc.stdout)
        expected = (GOLDEN / name).read_text() if (GOLDEN / name).exists() else ""
        check(f"{name}: the export matches the golden file byte for byte", proc.stdout == expected)
        again = export_case(args, text, tmp)
        check(f"{name}: a second export is identical", again.stdout == proc.stdout)
    sources = json.loads((FIXTURES / "sources.json").read_text())
    listed = set(sources["golden"])
    on_disk = {Path(p).name for p in glob.glob(str(GOLDEN / "*.json"))}
    check(
        "sources.json lists every golden file", listed == on_disk == {c[0] for c in golden_cases()}, (listed, on_disk)
    )
    for name, entry in sources["golden"].items():
        for path, sha in entry.get("inputs", {}).items():
            digest = hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
            check(f"{name}: input {path} has the digest sources.json records", digest == sha, digest)


# ---------------------------------------------------------------- OTLP JSON shape

HEX32 = re.compile(r"[0-9a-f]{32}")
HEX16 = re.compile(r"[0-9a-f]{16}")
DECIMAL = re.compile(r"(0|[1-9][0-9]*)")
SPAN_KEYS = {"traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "attributes"}
LOG_KEYS = {
    "timeUnixNano",
    "observedTimeUnixNano",
    "severityNumber",
    "severityText",
    "eventName",
    "attributes",
    "traceId",
    "spanId",
}
VALUE_KEYS = {"stringValue", "boolValue", "intValue", "doubleValue", "arrayValue"}


def values_ok(value: Mapping[str, Any]) -> bool:
    if len(value) != 1 or not set(value) <= VALUE_KEYS:
        return False
    if "intValue" in value:
        return isinstance(value["intValue"], str) and DECIMAL.fullmatch(value["intValue"]) is not None
    if "arrayValue" in value:
        return set(value["arrayValue"]) <= {"values"} and all(
            values_ok(v) for v in value["arrayValue"].get("values", [])
        )
    return True


def records_of(doc: Mapping[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    for rs in doc.get("resourceSpans", []):
        for ss in rs["scopeSpans"]:
            for span in ss["spans"]:
                yield "span", span
    for rl in doc.get("resourceLogs", []):
        for sl in rl["scopeLogs"]:
            for rec in sl["logRecords"]:
                yield "log", rec


def shape_checks() -> None:
    for path in sorted(GOLDEN.glob("*.json")):
        doc = json.loads(path.read_text())
        name = path.name
        top = "resourceSpans" if "resourceSpans" in doc else "resourceLogs"
        check(
            f"{name}: one resource with service.name and the export's scope",
            len(doc[top]) == 1
            and otel.attributes_from_otlp(doc[top][0]["resource"]["attributes"]).keys() == {"service.name"}
            and (doc[top][0].get("scopeSpans") or doc[top][0].get("scopeLogs"))[0]["scope"]
            == {"name": otel.SCOPE_NAME, "version": otel.SCOPE_VERSION},
        )
        for kind, rec in records_of(doc):
            keys = [kv["key"] for kv in rec["attributes"]]
            check(f"{name}: attribute keys are unique", len(keys) == len(set(keys)))
            check(
                f"{name}: every attribute is registered or under trp.",
                all(k in REGISTERED or k.startswith("trp.") for k in keys),
                [k for k in keys if not k.startswith("trp.")],
            )
            check(
                f"{name}: every value is one AnyValue member, with 64-bit integers as decimal strings",
                all(values_ok(kv["value"]) for kv in rec["attributes"]),
            )
            if kind == "span":
                check(
                    f"{name}: a span carries only OTLP span fields in lowerCamelCase",
                    set(rec) <= SPAN_KEYS,
                    set(rec) - SPAN_KEYS,
                )
                check(
                    f"{name}: span identifiers are lowercase hex of 16 and 8 bytes",
                    HEX32.fullmatch(rec["traceId"]) is not None and HEX16.fullmatch(rec["spanId"]) is not None,
                )
                check(f"{name}: the span kind is the integer for INTERNAL", rec["kind"] == 1)
                check(
                    f"{name}: span times are decimal strings and the span has no duration",
                    DECIMAL.fullmatch(rec["startTimeUnixNano"]) is not None
                    and rec["startTimeUnixNano"] == rec["endTimeUnixNano"],
                )
            else:
                check(
                    f"{name}: a log record carries only OTLP log fields in lowerCamelCase",
                    set(rec) <= LOG_KEYS,
                    set(rec) - LOG_KEYS,
                )
                check(
                    f"{name}: the severity number is an integer that matches its text",
                    (rec["severityNumber"], rec["severityText"]) in {(9, "INFO"), (13, "WARN")},
                )
                check(
                    f"{name}: the event name is one the export defines",
                    rec["eventName"] in {otel.EVALUATION_EVENT, otel.RECEIPT_EVENT},
                )
        check(f"{name}: check_export rebuilds every digest", otel.check_export(doc) == [], otel.check_export(doc))
    tied = json.loads((GOLDEN / "receipt-agent-tool-escalate.logs.json").read_text())
    rec = next(records_of(tied))[1]
    check(
        "a log record tied to a span carries that trace and span",
        rec.get("traceId") == TRACE_ID and rec.get("spanId") == PARENT_SPAN_ID,
    )


# ---------------------------------------------------------------- round trips


def claim_variants() -> list[tuple[str, dict[str, Any]]]:
    """Claims that reach every shape the VTR schema allows, built from a valid vector's claims. Each must rebuild
    exactly, whether the attribute table carries it or the canonical JSON fallback does."""
    base = payload_claims(json.loads((VECTORS / "agent-tool-allow.json").read_text())["receipt"])
    party = {"scheme": "did", "value": "did:example:alice", "issuer": "https://idp.example.com"}
    variants: list[tuple[str, dict[str, Any]]] = [
        (
            "every optional claim in its documented shape",
            dict(
                base,
                window={"start": "2026-11-03T07:55:00Z", "end": "2026-11-03T08:00:00Z"},
                nonce="cXV4",
                prev="vGXQf1bcXitHWrxkIsQKvHV7uJhB7WN-bODZE8nhxhI",
                build="NVuY-Jjmrh4-jlPH4K_8a1-_yUVojDRNrZ085Gzcvfs",
                fallback={"from": "autonomous", "to": "supervised", "trp_clause": "rule:write_without_approval"},
                principal=party,
                on_behalf_of={"scheme": "email", "value": "ops@example.com"},
                model={"provider": "example-provider", "version": "example-model-2026-10-01"},
                cost={"tokens": {"input": 1200, "output": 340}, "money": {"amount": "0.0042", "currency": "USD"}},
                policy_digest="kVFUWpkpL7RAPaDf8JXI8kE_JebntIJewaX6KIeax8E",
                escalation={"decided_by": party, "decision": "approved", "decided_at": "2026-11-03T08:01:00Z"},
                evaluators=[
                    {"name": "example-scanner", "version": "0.17.1", "decision": "fail"},
                    {"name": "example-toolkit", "version": "5.0.0", "decision": "allow"},
                ],
            ),
        ),
        (
            "null optional claims",
            dict(
                base,
                principal=None,
                on_behalf_of=None,
                build=None,
                outcome=None,
                model=None,
                fallback=None,
                escalation=None,
                cost=None,
                agent=None,
                tool=None,
            ),
        ),
        (
            "an escalation decided by no verified party",
            dict(base, escalation={"decided_by": None, "decision": "timed_out", "decided_at": "2026-11-03T08:01:00Z"}),
        ),
        (
            "members the tables do not list",
            dict(
                base, agent={"id": "a", "version": "1", "runtime": "x"}, evaluator=dict(base["evaluator"], build_id="b")
            ),
        ),
        ("empty objects", dict(base, model={}, cost={"tokens": {}})),
        (
            "evaluators with and without a decision",
            dict(base, evaluators=[{"name": "a", "version": "1", "decision": "d"}, {"name": "b", "version": "2"}]),
        ),
        ("evaluators without decisions", dict(base, evaluators=[{"name": "a", "version": "1"}])),
        ("empty arrays", dict(base, evaluators=[], trp_clauses=[], results=[], coverage=1)),
        ("an agent with a version and no id", dict(base, agent={"version": "1.4.0"})),
        ("a nonce of the wrong type", dict(base, nonce=7)),
        ("a coverage of 0", dict(base, coverage=0)),
        ("a fraction coverage", dict(base, coverage=0.8333)),
        ("text outside ASCII", dict(base, sub="urn:example:agent:été-例")),
        ("an incomplete standing", dict(base, standing={"result": "incomplete", "band": None, "response": None})),
        (
            "a details object on a drill",
            dict(base, kind="drill", details={"scenario": "failover", "passed": True, "steps": [1, 2, {"x": None}]}),
        ),
    ]
    return variants


def naming_checks() -> None:
    names = [n for n, _ in otel.SCALARS.values()]
    names += [n for table in otel.OBJECTS.values() for n, _ in table.values()]
    names += list(otel.STANDING.values()) + [c[1] for cols in otel.ROWS.values() for c in cols]
    names += [otel.RECEIPT_DIGEST, otel.RECEIPT_ALG, otel.RECEIPT_KID, otel.EVIDENCE_JSON]
    check("every attribute name is unique", len(names) == len(set(names)), len(names))
    check(
        "no attribute name is also a namespace of another",
        not [a for a in names for b in names if b.startswith(a + ".")],
    )
    check(
        "names are lowercase and dot delimited",
        all(re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", n) for n in names),
    )
    check("only the registered names sit outside trp.", {n for n in names if not n.startswith("trp.")} <= REGISTERED)


def roundtrip_checks() -> None:
    count = 0
    for path in sorted(VECTORS.glob("*.json")):
        receipt = json.loads(path.read_text())["receipt"]
        claims = payload_claims(receipt)
        for writer in (otel.otlp_traces, otel.otlp_logs):
            records = [
                otel.receipt_record(c, h)
                for c, h in otel.read_receipts(receipt if isinstance(receipt, str) else json.dumps(receipt))
            ]
            doc = json.loads(json.dumps(writer(records)))
            attrs = otel.exported_attributes(doc)[0]
            rebuilt = otel.attributes_to_claims(attrs)
            check(
                f"{path.name} via {writer.__name__}: the rebuilt claims have the receipt's digest",
                otel.digest(rebuilt) == otel.digest(claims) == attrs[otel.RECEIPT_DIGEST],
            )
            check(f"{path.name} via {writer.__name__}: the rebuilt claims equal the payload", rebuilt == claims)
            count += 1
    check(
        "every valid receipt vector was exported both ways", count == 2 * len(list(VECTORS.glob("*.json"))) == 58, count
    )
    for name, claims in claim_variants():
        attrs = otel.claims_to_attributes(claims)
        doc = json.loads(json.dumps(otel.otlp_logs([otel.Record("e", "s", 0, attrs, "k", "meets")])))
        rebuilt = otel.attributes_to_claims(otel.exported_attributes(doc)[0])
        check(
            f"claims with {name}: the rebuilt claims have the same digest",
            otel.digest(rebuilt) == otel.digest(claims),
            sorted(k for k in attrs if k.startswith(otel.JSON_PREFIX)),
        )
    full = dict(claim_variants()[0][1])
    attrs = otel.claims_to_attributes(full)
    check(
        "claims in their documented shape need no JSON fallback",
        not any(k.startswith(otel.JSON_PREFIX) for k in attrs),
        [k for k in attrs if k.startswith(otel.JSON_PREFIX)],
    )
    check(
        "registered names carry the agent and the tool",
        attrs.get("gen_ai.agent.id") == "assistant-7" and attrs.get("gen_ai.tool.name") == "read_text_file",
        attrs,
    )
    check(
        "a registered name carries the model provider", attrs.get("gen_ai.provider.name") == "example-provider", attrs
    )
    check(
        "token counts stay under trp. so token totals are not counted twice",
        attrs.get("trp.vtr.cost.input_tokens") == 1200 and not any(k.startswith("gen_ai.usage.") for k in attrs),
    )
    nulls = otel.claims_to_attributes(claim_variants()[1][1])
    check("a null claim travels as JSON null", nulls.get("trp.vtr.json.principal") == "null")


def tamper_checks() -> None:
    doc = json.loads((GOLDEN / "receipt-agent-tool-allow.traces.json").read_text())

    def edited(edit: Any) -> list[str]:
        d = copy.deepcopy(doc)
        attrs = d["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"]
        edit(attrs)
        return otel.check_export(d)

    def set_value(key: str, value: dict[str, Any]) -> Any:
        return lambda attrs: next(kv for kv in attrs if kv["key"] == key).update(value=value)

    check("the untouched export verifies", otel.check_export(doc) == [])
    check("an edited band is caught", edited(set_value("trp.standing.band", {"stringValue": "conditional"})) != [])
    check("an edited issue time is caught", edited(set_value("trp.vtr.iat", {"intValue": "1793700001"})) != [])
    check(
        "a dropped clause is caught",
        edited(lambda a: a.remove(next(kv for kv in a if kv["key"] == "trp.vtr.input_digest"))) != [],
    )
    check(
        "results in another order are caught",
        edited(
            lambda a: (
                next(kv for kv in a if kv["key"] == "trp.results.outcome")["value"]["arrayValue"]["values"].reverse()
                or next(kv for kv in a if kv["key"] == "trp.results.clause")["value"]["arrayValue"]["values"].reverse()
            )
        )
        != [],
    )
    check(
        "arrays of different lengths are reported",
        any(
            "differ in length" in p
            for p in edited(
                lambda a: next(kv for kv in a if kv["key"] == "trp.results.outcome")["value"]["arrayValue"][
                    "values"
                ].pop()
            )
        ),
    )
    check(
        "an attribute of the wrong type is reported",
        any("type" in p for p in edited(set_value("trp.vtr.iat", {"stringValue": "1793700000"}))),
    )
    check(
        "a claim carried twice is reported",
        any(
            "twice" in p
            for p in edited(
                lambda a: a.append({"key": "trp.vtr.json.iss", "value": {"stringValue": '"https://x.example"'}})
            )
        ),
    )
    ev = json.loads((GOLDEN / "evaluation-hard-rule-triggered.with-evidence.logs.json").read_text())
    rec = ev["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
    kv = next(kv for kv in rec["attributes"] if kv["key"] == otel.EVIDENCE_JSON)
    kv["value"]["stringValue"] = kv["value"]["stringValue"].replace('"latency_ms":120', '"latency_ms":121', 1)
    check("edited evidence values are caught against the evidence digest", otel.check_export(ev) != [])


# ---------------------------------------------------------------- evidence values


def canary_evidence() -> dict[str, Any]:
    evidence: dict[str, Any] = json.loads((ROOT / "tests/evidence/all-healthy.json").read_text())
    evidence.update(
        bias_score=float(CANARY_NUMBERS[0]),
        data_freshness_hours=float(CANARY_NUMBERS[1]),
        compliance_status=CANARY_TEXT,
        _source={"store": CANARY_TEXT + "-SOURCE"},
    )
    return evidence


def leak_checks() -> None:
    profile = json.loads((ROOT / "tests/profiles/valid/full-featured.json").read_text())
    evidence = canary_evidence()
    at = otel.unix_nano(AT)
    for writer in (otel.otlp_traces, otel.otlp_logs):
        unflagged = json.dumps(writer([otel.evaluation_record(profile, evidence, at)]))
        check(
            f"{writer.__name__}: no evidence value appears without the flag",
            CANARY_TEXT not in unflagged and not any(n in unflagged for n in CANARY_NUMBERS),
        )
        keys = {k for a in otel.exported_attributes(json.loads(unflagged)) for k in a}
        check(
            f"{writer.__name__}: the only evidence attribute without the flag is the digest",
            {k for k in keys if k.startswith("trp.evidence.")} == {"trp.evidence.digest"},
            keys,
        )
        flagged = json.loads(json.dumps(writer([otel.evaluation_record(profile, evidence, at, include_evidence=True)])))
        text = json.dumps(flagged)
        check(
            f"{writer.__name__}: with the flag the evidence values are exported",
            CANARY_TEXT in text and all(n in text for n in CANARY_NUMBERS),
        )
        attrs = otel.exported_attributes(flagged)[0]
        check(
            f"{writer.__name__}: the exported evidence has the exported evidence digest",
            otel.digest(json.loads(attrs[otel.EVIDENCE_JSON])) == attrs["trp.evidence.digest"] == otel.digest(evidence),
        )
        check(
            f"{writer.__name__}: the flag adds one attribute and changes no other",
            set(attrs) - set(otel.exported_attributes(json.loads(unflagged))[0]) == {otel.EVIDENCE_JSON},
        )
    for path in sorted(VECTORS.glob("*.json")):
        vector = json.loads(path.read_text())
        claims = payload_claims(vector["receipt"])
        allowed = set(scalars(claims)) | {otel.digest(claims)}
        allowed |= {otel.canonical(v) for v in claims.values()}
        for c, h in otel.read_receipts(
            vector["receipt"] if isinstance(vector["receipt"], str) else json.dumps(vector["receipt"])
        ):
            allowed |= set(scalars(h or {}))
            exported = otel.receipt_record(c, h).attributes
            stray = [
                k for k, v in exported.items() if any(x not in allowed for x in (v if isinstance(v, list) else [v]))
            ]
            check(f"{path.name}: every exported value comes from the receipt itself", not stray, stray)


def scalars(value: Any) -> Iterator[Any]:
    if isinstance(value, dict):
        for v in value.values():
            yield from scalars(v)
    elif isinstance(value, list):
        for v in value:
            yield from scalars(v)
    elif value is not None:
        yield value


# ---------------------------------------------------------------- evaluations and identifiers


def evaluation_checks() -> None:
    profile = json.loads((ROOT / "tests/profiles/valid/full-featured.json").read_text())
    at = otel.unix_nano(AT)
    for sample, result in (
        ("all-healthy", "meets"),
        ("hard-rule-triggered", "does_not_meet"),
        ("missing-critical-signal", "does_not_meet"),
        ("hard-rule-field-missing", "incomplete"),
    ):
        evidence = json.loads((ROOT / f"tests/evidence/{sample}.json").read_text())
        rec = otel.evaluation_record(profile, evidence, at)
        expected = otel._determination(profile, evidence)
        check(
            f"{sample}: the evaluation carries the reference determination",
            rec.attributes["trp.standing.result"] == expected["standing"]["result"] == result
            and rec.attributes["trp.results.outcome"] == [r["outcome"] for r in expected["results"]]
            and rec.attributes["trp.result.digest"] == expected["result_digest"],
            (rec.attributes["trp.standing.result"], result),
        )
        logs = otel.otlp_logs([rec])["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]
        check(
            f"{sample}: the log severity follows the standing result",
            logs["severityNumber"] == (9 if result == "meets" else 13),
        )
    check(
        "a time with one fraction digit is read to the nanosecond",
        otel.unix_nano("1970-01-01T00:00:01.5Z") == 1_500_000_000,
    )
    check(
        "a time with nine fraction digits keeps every digit",
        otel.unix_nano("2026-11-04T12:00:00.123456789Z") == 1793793600_123456789,
    )
    check("an offset moves the time to UTC", otel.unix_nano("2026-11-04T07:00:00-05:00") == otel.unix_nano(AT))
    check("a time without an offset is refused", raises(otel.unix_nano, "2026-11-04T12:00:00"))
    check("a day that does not exist is refused", raises(otel.unix_nano, "2026-02-30T12:00:00Z"))
    check("text that is not a time is refused", raises(otel.unix_nano, "yesterday"))
    extends = json.loads((ROOT / "tests/profiles/valid/with-extension.json").read_text())
    check("a profile the reference evaluator refuses is refused", raises(otel.evaluation_record, extends, {}, at))
    check("evidence that is not an object is refused", raises(otel.evaluation_record, profile, [], at))
    nan = json.loads((ROOT / "tests/evidence/all-healthy.json").read_text())
    nan["accuracy"] = float("nan")
    check("evidence with no canonical form is refused", raises(otel.evaluation_record, profile, nan, at))


def identifier_checks() -> None:
    a = otel.read_receipts(vector_receipt("agent-tool-allow"))
    b = otel.read_receipts(vector_receipt("agent-tool-stop"))
    ra, rb = otel.receipt_record(*a[0]), otel.receipt_record(*b[0])
    sa, sb = otel.otlp_traces([ra]), otel.otlp_traces([rb])
    span_a = sa["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    span_b = sb["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    check("a receipt always gets the same derived identifiers", otel.otlp_traces([ra]) == sa)
    check(
        "different receipts get different identifiers",
        span_a["traceId"] != span_b["traceId"] and span_a["spanId"] != span_b["spanId"],
    )
    joined = otel.otlp_traces([ra, rb], trace_id=TRACE_ID.upper(), parent_span_id=PARENT_SPAN_ID)
    spans = joined["resourceSpans"][0]["scopeSpans"][0]["spans"]
    check(
        "a given trace and parent hold every span, in lowercase hex",
        all(s["traceId"] == TRACE_ID and s["parentSpanId"] == PARENT_SPAN_ID for s in spans) and len(spans) == 2,
    )
    check("an all-zero trace identifier is refused", raises(otel.otlp_traces, [ra], trace_id="0" * 32))
    check("a short span identifier is refused", raises(otel.otlp_traces, [ra], trace_id=TRACE_ID, parent_span_id="abc"))
    check("a parent span without its trace is refused", raises(otel.otlp_logs, [ra], parent_span_id=PARENT_SPAN_ID))
    check(
        "a span time equals the receipt's issue time",
        span_a["startTimeUnixNano"]
        == str(json.loads(otel._unb64u(vector_receipt("agent-tool-allow").split(".")[1]))["iat"] * 10**9),
    )


# ---------------------------------------------------------------- failures


def failure_checks(tmp: Path) -> None:
    good = vector_receipt("agent-tool-allow")
    claims = payload_claims(good)
    check("an empty file is refused", raises(otel.read_receipts, "  \n"))
    check("a line that is not a compact JWS is refused", raises(otel.read_receipts, "abc.def\n"))
    check("a JWS whose payload is not JSON is refused", raises(otel.read_receipts, "e30.bm90IGpzb24.c2ln"))
    check("JSON that is not a receipt is refused", raises(otel.read_receipts, "[42]"))
    check("broken JSON is refused", raises(otel.read_receipts, '{"claims": '))
    check(
        "claims missing a required claim are refused",
        raises(otel.receipt_record, {k: v for k, v in claims.items() if k != "standing"}),
    )
    check("claims with an unknown claim are refused", raises(otel.receipt_record, dict(claims, verdict="allow")))
    check("claims with no canonical form are refused", raises(otel.receipt_record, dict(claims, iat=2**60)))
    check("a bare claims object is read", otel.read_receipts(json.dumps(claims))[0] == (claims, None))
    (tmp / "bad.jws").write_text("not-a-receipt\n")
    proc = run_adapter(["receipts", str(tmp / "bad.jws")])
    check(
        "the command line exits 2 on a receipt it cannot read",
        proc.returncode == 2 and "trp_otel:" in proc.stderr,
        proc.stderr,
    )
    (tmp / "good.jws").write_text(good + "\n")
    proc = run_adapter(["receipts", str(tmp / "good.jws"), "--parent-span-id", PARENT_SPAN_ID])
    check("the command line exits 2 on a parent span without its trace", proc.returncode == 2, proc.stderr)
    doc = json.loads((GOLDEN / "receipt-agent-tool-allow.traces.json").read_text())
    next(kv for kv in doc["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"] if kv["key"] == "trp.vtr.iss")[
        "value"
    ]["stringValue"] = "https://other.example.com"
    (tmp / "tampered.json").write_text(json.dumps(doc))
    proc = run_adapter(["check", str(tmp / "tampered.json")])
    check("check exits 1 on a tampered export", proc.returncode == 1 and proc.stdout.strip() == "invalid", proc.stdout)
    proc = run_adapter(["check", str(GOLDEN / "gate-receipts.logs.json")])
    check("check exits 0 on an untouched export", proc.returncode == 0 and proc.stdout.strip() == "valid", proc.stderr)


def no_sdk_checks() -> None:
    saved = {k: v for k, v in sys.modules.items() if k == "opentelemetry" or k.startswith("opentelemetry.")}
    for k in saved:
        del sys.modules[k]
    sys.modules["opentelemetry"] = None  # type: ignore[assignment]  # makes every opentelemetry import fail
    try:
        check("without OpenTelemetry installed the SDK is reported missing", otel.sdk_available() is False)
        rec = otel.receipt_record(*otel.read_receipts(vector_receipt("agent-tool-allow"))[0])
        check("without OpenTelemetry installed emit_spans says so", raises(otel.emit_spans, [rec]))
        check("without OpenTelemetry installed sdk_tracer_provider says so", raises(otel.sdk_tracer_provider))
    finally:
        del sys.modules["opentelemetry"]
        sys.modules.update(saved)


def main() -> int:
    write = "--write" in sys.argv[1:]
    with tempfile.TemporaryDirectory() as d:
        golden_checks(Path(d), write)
        failure_checks(Path(d))
    shape_checks()
    naming_checks()
    roundtrip_checks()
    tamper_checks()
    leak_checks()
    evaluation_checks()
    identifier_checks()
    no_sdk_checks()
    print(f"OpenTelemetry export: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
