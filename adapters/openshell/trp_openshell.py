#!/usr/bin/env python3
"""TRP profiles in front of NVIDIA OpenShell sandboxes.

NVIDIA OpenShell runs AI agents in kernel-enforced sandboxes under a sandbox
policy, and its sandbox supervisor records every connection and every
inspected request it allows or denies as an OCSF (Open Cybersecurity Schema
Framework) record. This adapter connects a TRP (Trust Requirements Profile) to
both sides.

    policy    A profile and a deployment file become an OpenShell sandbox
              policy in YAML, plus a coverage report that names, for every
              requirement in the profile, whether OpenShell carries it or the
              TRP gate keeps it.
    evidence  OCSF records, as JSON lines or as the supervisor's stderr lines
              with the OCSF-JSON marker, become one TRP evidence object per
              allowed or denied decision.
    evaluate  The reference evaluator judges each evidence object against the
              profile, and each result says whether the profile and OpenShell
              agreed.

The adapter needs only the Python standard library and tools/evaluate.py.
Every OpenShell field it writes or reads comes from NVIDIA's OpenShell
documentation, listed in adapters/openshell/README.md.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import evaluate as trp  # noqa: E402  the reference evaluator in tools/evaluate.py

VERSION = "0.1.0"

# The NVIDIA quickstart policy's filesystem and Landlock settings, used when a
# deployment names none.
DEFAULT_FILESYSTEM: dict[str, Any] = {
    "include_workdir": True,
    "read_only": ["/bin", "/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log"],
    "read_write": ["/sandbox", "/tmp", "/dev/null"],
}
DEFAULT_LANDLOCK: dict[str, Any] = {"compatibility": "best_effort"}

# HTTP methods the read-only preset refuses. The read-write preset allows
# POST, PUT and PATCH and still refuses DELETE.
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
RULE_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,62}$")
PLAIN_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
OCSF_MARKER = " OCSF-JSON "
DECISION_CLASSES = {4001: "network", 4002: "http"}


class DeploymentError(ValueError):
    """A deployment file that cannot become a valid policy."""


# ---------------------------------------------------------------- Policy


def hard_rules(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    rules = profile.get("hard_rules") or []
    return [r for r in rules if isinstance(r, dict)]


def has_rule(profile: Mapping[str, Any], field: str, condition: str) -> bool:
    return any(r.get("field") == field and r.get("condition") == condition for r in hard_rules(profile))


def _endpoint(raw: Mapping[str, Any], i: int, needs_read_only: bool) -> tuple[str, dict[str, Any]]:
    where = f"endpoints[{i}]"
    rule = raw.get("rule")
    if not isinstance(rule, str) or not RULE_NAME.match(rule):
        raise DeploymentError(
            f"{where}.rule must be a name of letters, digits and underscores that starts with a letter"
        )
    host = raw.get("host")
    if not isinstance(host, str) or not host or "/" in host or ":" in host or host != host.strip():
        raise DeploymentError(f"{where}.host must be a host name with no scheme, port or path")
    port = raw.get("port")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise DeploymentError(f"{where}.port must be a whole number from 1 to 65535")
    protocol = raw.get("protocol")
    if protocol not in (None, "rest"):
        raise DeploymentError(f"{where}.protocol must be rest or left out, since this version writes no other protocol")
    enforcement = raw.get("enforcement", "enforce")
    if enforcement not in ("enforce", "audit"):
        raise DeploymentError(f"{where}.enforcement must be enforce or audit")
    binaries = raw.get("binaries")
    if (
        not isinstance(binaries, list)
        or not binaries
        or not all(isinstance(b, str) and b.startswith("/") for b in binaries)
    ):
        raise DeploymentError(
            f"{where}.binaries must list at least one absolute program path, since an empty list allows nothing"
        )
    writes = raw.get("writes_approved", False)
    if not isinstance(writes, bool):
        raise DeploymentError(f"{where}.writes_approved must be true or false")
    entry: dict[str, Any] = {"host": host, "port": port}
    if protocol == "rest":
        entry["protocol"] = "rest"
        entry["enforcement"] = enforcement
        entry["access"] = "read-write" if writes else ("read-only" if needs_read_only else "full")
    policy: dict[str, Any] = {}
    name = raw.get("name")
    if name is not None:
        if not isinstance(name, str) or not name:
            raise DeploymentError(f"{where}.name must be a non-empty string")
        policy["name"] = name
    policy["endpoints"] = [entry]
    policy["binaries"] = [{"path": b} for b in binaries]
    return rule, policy


def compile_policy(profile: Mapping[str, Any], deployment: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns the OpenShell sandbox policy and the coverage report."""
    endpoints = deployment.get("endpoints")
    if not isinstance(endpoints, list):
        raise DeploymentError("endpoints must be a list, and an empty list leaves every destination denied")
    needs_read_only = has_rule(profile, "write_without_approval", "is_true")
    network: dict[str, Any] = {}
    for i, raw in enumerate(endpoints):
        if not isinstance(raw, dict):
            raise DeploymentError(f"endpoints[{i}] must be an object")
        rule, entry = _endpoint(raw, i, needs_read_only)
        if rule in network:
            raise DeploymentError(f"endpoints[{i}].rule {rule} is already used")
        network[rule] = entry
    policy: dict[str, Any] = {
        "version": 1,
        "filesystem_policy": deployment.get("filesystem_policy", DEFAULT_FILESYSTEM),
        "landlock": deployment.get("landlock", DEFAULT_LANDLOCK),
        "network_policies": network,
    }
    return policy, coverage(profile, network)


def coverage(profile: Mapping[str, Any], network: Mapping[str, Any]) -> dict[str, Any]:
    entries = [e for p in network.values() for e in p["endpoints"]]
    uninspected = [f"{e['host']}:{e['port']}" for e in entries if e.get("protocol") != "rest"]
    audited = [f"{e['host']}:{e['port']}" for e in entries if e.get("enforcement") == "audit"]
    clauses: list[dict[str, Any]] = []
    for r in hard_rules(profile):
        field, cond, name = r.get("field"), r.get("condition"), r.get("rule", r.get("field"))
        item: dict[str, Any] = {"clause": name, "field": field, "condition": cond, "action": r.get("action")}
        if field == "output_destination_approved" and cond == "is_false":
            item["carried_by"] = "openshell"
            item["how"] = (
                "OpenShell denies every outbound connection that no network policy allows, and the policy allows only "
                "the deployment's endpoints for the programs it names."
            )
            item["stays_with_trp_gate"] = (
                "Addresses inside tool arguments that a tool fetches from outside the sandbox."
            )
        elif field == "write_without_approval" and cond == "is_true":
            item["carried_by"] = "openshell" if not uninspected and not audited else "openshell_in_part"
            item["how"] = (
                "Endpoints with request inspection use the read-only preset, which allows GET, HEAD and "
                "OPTIONS, or the read-write preset where the deployment approves writes, which also allows "
                "POST, PUT and PATCH."
            )
            gaps = [
                "The review the profile asks for, since OpenShell blocks or logs a request and never pauses "
                "one for a person."
            ]
            if uninspected:
                gaps.append("Writes to endpoints without request inspection: " + ", ".join(uninspected) + ".")
            if audited:
                gaps.append(
                    "Writes to endpoints in audit, which OpenShell logs and lets through: " + ", ".join(audited) + "."
                )
            item["stays_with_trp_gate"] = " ".join(gaps)
        else:
            item["carried_by"] = "trp_gate"
            item["how"] = "OpenShell's network policy has no field for this requirement."
        clauses.append(item)
    for s in profile.get("scored_signals") or []:
        if isinstance(s, dict):
            clauses.append(
                {
                    "clause": s.get("signal"),
                    "field": s.get("signal"),
                    "carried_by": "trp_gate",
                    "how": "Scored signals need the evaluator's thresholds, which an OpenShell policy cannot express.",
                }
            )
    return {
        "adapter": f"trp-openshell {VERSION}",
        "profile": {"trp_id": profile.get("trp_id"), "version": profile.get("version")},
        "network_rules": sorted(network),
        "clauses": clauses,
    }


# ---------------------------------------------------------------- YAML


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value)
    raise TypeError(f"cannot write {type(value).__name__} as a YAML scalar")


def _key(k: str) -> str:
    return k if PLAIN_KEY.match(k) else json.dumps(k)


def _yaml(value: Any, indent: int) -> list[str]:
    pad = " " * indent
    lines: list[str] = []
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{_key(k)}:")
                lines.extend(_yaml(v, indent + 2))
            else:
                lines.append(f"{pad}{_key(k)}: {_empty(v) if isinstance(v, (dict, list)) else _scalar(v)}")
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and item:
                inner = _yaml(item, indent + 2)
                lines.append(f"{pad}- {inner[0].lstrip()}")
                lines.extend(inner[1:])
            elif isinstance(item, list) and item:
                lines.append(f"{pad}-")
                lines.extend(_yaml(item, indent + 2))
            else:
                lines.append(f"{pad}- {_empty(item) if isinstance(item, (dict, list)) else _scalar(item)}")
    else:
        lines.append(pad + _scalar(value))
    return lines


def _empty(value: dict[str, Any] | list[Any]) -> str:
    return "{}" if isinstance(value, dict) else "[]"


def to_yaml(policy: Mapping[str, Any], profile: Mapping[str, Any]) -> str:
    head = [
        f"# OpenShell sandbox policy written by trp-openshell {VERSION}",
        f"# from TRP profile {profile.get('trp_id')} {profile.get('version')}.",
        "# Check the coverage report before applying it.",
    ]
    return "\n".join(head + _yaml(dict(policy), 0)) + "\n"


# ---------------------------------------------------------------- OCSF


def read_ocsf(lines: Iterable[str], fmt: str = "auto") -> tuple[list[dict[str, Any]], int]:
    """Returns the OCSF records found and the count of lines that could not be read.

    jsonl reads one JSON object per line. stderr reads the payload after the
    OCSF-JSON marker that follows each line's UTC timestamp. auto accepts both
    and passes over the shorthand copy of each event.
    """
    records: list[dict[str, Any]] = []
    bad = 0
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        payload: str | None = None
        if fmt in ("stderr", "auto") and OCSF_MARKER in f" {line} ":
            payload = line.split("OCSF-JSON", 1)[1].strip()
        elif fmt in ("jsonl", "auto") and line.startswith("{"):
            payload = line
        if payload is None:
            if fmt == "jsonl":
                bad += 1
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            bad += 1
            continue
        if isinstance(obj, dict) and "class_uid" in obj:
            records.append(obj)
        else:
            bad += 1
    return records, bad


def _get(obj: Mapping[str, Any], *path: str) -> Any:
    cur: Any = obj
    for p in path:
        if not isinstance(cur, Mapping):
            return None
        cur = cur.get(p)
    return cur


def evidence_from_record(rec: Mapping[str, Any]) -> dict[str, Any] | None:
    """One TRP evidence object for an allowed or denied decision, or None.

    A connection record (class 4001) answers whether the destination was
    approved, and opening a connection writes nothing. A request record (class
    4002) comes only after its connection was allowed, so the destination was
    approved, and a denied request with a write method is a write without
    approval. When a denied request carries no method, the write field is left
    out and the evaluator reports that rule as inconclusive.
    """
    kind = DECISION_CLASSES.get(rec.get("class_uid"))  # type: ignore[arg-type]
    action = rec.get("action")
    if kind is None or action not in ("Allowed", "Denied"):
        return None
    method = _get(rec, "http_request", "http_method")
    method = method.upper() if isinstance(method, str) else None
    evidence: dict[str, Any]
    if kind == "network":
        evidence = {"output_destination_approved": action == "Allowed", "write_without_approval": False}
    else:
        evidence = {"output_destination_approved": True}
        if action == "Allowed":
            evidence["write_without_approval"] = False
        elif method is not None:
            evidence["write_without_approval"] = method in WRITE_METHODS
    source = {
        "uid": _get(rec, "metadata", "uid"),
        "time_ms": rec.get("time"),
        "class_uid": rec.get("class_uid"),
        "action": action,
        "disposition": rec.get("disposition"),
        "rule": _get(rec, "firewall_rule", "name"),
        "host": _get(rec, "dst_endpoint", "domain") or _get(rec, "dst_endpoint", "ip"),
        "port": _get(rec, "dst_endpoint", "port"),
        "process": _get(rec, "actor", "process", "name"),
        "method": method,
        "sandbox": _get(rec, "device", "container", "name"),
        "message": rec.get("message"),
        "status_detail": rec.get("status_detail"),
        "product_version": _get(rec, "metadata", "product", "version"),
    }
    return {"evidence": evidence, "openshell": {k: v for k, v in source.items() if v is not None}}


def evidence_lines(records: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for rec in records:
        # A record keeps its metadata.uid when it is written again, so the same
        # event read from stderr and from a file counts once. A record with no
        # uid counts once per identical body.
        uid = _get(rec, "metadata", "uid")
        key = uid if isinstance(uid, str) else json.dumps(rec, sort_keys=True, separators=(",", ":"))
        if key in seen:
            continue
        seen.add(key)
        item = evidence_from_record(rec)
        if item is not None:
            out.append(item)
    out.sort(key=lambda x: (x["openshell"].get("time_ms") or 0, str(x["openshell"].get("uid") or "")))
    return out


# ---------------------------------------------------------------- Evaluate


def evaluate_lines(
    profile_path: Path, items: Iterable[Mapping[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    profile = trp.load_profile(profile_path)
    results: list[dict[str, Any]] = []
    tally = {"decisions": 0, "agree": 0, "disagree": 0, "incomplete": 0, "openshell_allowed": 0, "openshell_denied": 0}
    for item in items:
        evidence = dict(item.get("evidence") or {})
        source = dict(item.get("openshell") or {})
        r = trp.evaluate(profile, evidence)
        triggered = [h["rule"] for h in r.get("hard_rules_triggered", [])]
        inconclusive = [h["rule"] for h in r.get("hard_rules_inconclusive", [])]
        allowed = source.get("action") == "Allowed"
        tally["decisions"] += 1
        tally["openshell_allowed" if allowed else "openshell_denied"] += 1
        if inconclusive:
            agree: bool | None = None
            tally["incomplete"] += 1
        else:
            agree = (not triggered) if allowed else bool(triggered)
            tally["agree" if agree else "disagree"] += 1
        results.append(
            {
                "openshell": source,
                "evidence": evidence,
                "standing": r.get("standing"),
                "response": r.get("response"),
                "hard_rules_triggered": triggered,
                "hard_rules_inconclusive": inconclusive,
                "agree": agree,
            }
        )
    summary = {
        "adapter": f"trp-openshell {VERSION}",
        "profile": {"trp_id": profile.trp_id, "version": profile.version},
        **tally,
    }
    return results, summary


# ---------------------------------------------------------------- CLI


def _read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path} must hold a JSON object")
    return data


def _write(text: str, out: Path | None) -> None:
    if out is None:
        sys.stdout.write(text)
    else:
        out.write_text(text, encoding="utf-8")


def _jsonl(items: Iterable[Mapping[str, Any]]) -> str:
    return "".join(json.dumps(i, sort_keys=True, separators=(",", ":")) + "\n" for i in items)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Put a TRP profile in front of an NVIDIA OpenShell sandbox.")
    ap.add_argument("--version", action="version", version=f"trp-openshell {VERSION}")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("policy", help="Write an OpenShell sandbox policy and a coverage report.")
    p.add_argument("--profile", type=Path, required=True)
    p.add_argument("--deployment", type=Path, required=True)
    p.add_argument("--policy-out", type=Path)
    p.add_argument("--coverage-out", type=Path)

    e = sub.add_parser("evidence", help="Turn OpenShell OCSF records into TRP evidence lines.")
    e.add_argument("inputs", type=Path, nargs="+")
    e.add_argument("--format", choices=["auto", "jsonl", "stderr"], default="auto")
    e.add_argument("--out", type=Path)

    v = sub.add_parser("evaluate", help="Judge evidence lines against a profile and compare with OpenShell.")
    v.add_argument("evidence", type=Path)
    v.add_argument("--profile", type=Path, required=True)
    v.add_argument("--out", type=Path)

    args = ap.parse_args(argv)
    if args.command == "policy":
        profile = _read_json(args.profile)
        try:
            policy, cov = compile_policy(profile, _read_json(args.deployment))
        except DeploymentError as err:
            print(f"deployment: {err}", file=sys.stderr)
            return 2
        _write(to_yaml(policy, profile), args.policy_out)
        if args.coverage_out:
            args.coverage_out.write_text(json.dumps(cov, indent=2) + "\n", encoding="utf-8")
        return 0
    if args.command == "evidence":
        records: list[dict[str, Any]] = []
        bad = 0
        for path in args.inputs:
            with path.open(encoding="utf-8", errors="replace") as fh:
                got, b = read_ocsf(fh, args.format)
            records.extend(got)
            bad += b
        items = evidence_lines(records)
        _write(_jsonl(items), args.out)
        print(json.dumps({"records": len(records), "decisions": len(items), "unreadable_lines": bad}), file=sys.stderr)
        return 0
    with args.evidence.open(encoding="utf-8") as fh:
        items = [json.loads(line) for line in fh if line.strip()]
    results, summary = evaluate_lines(args.profile, items)
    if args.out:
        args.out.write_text(_jsonl(results), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
