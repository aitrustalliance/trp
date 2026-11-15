#!/usr/bin/env python3
"""Checks the NVIDIA OpenShell adapter on NVIDIA's own documentation examples.

The policy written for the example deployment must match the network rule in
NVIDIA's sandbox policy quickstart member for member and parse back to the same
object. OCSF (Open Cybersecurity Schema Framework) records from NVIDIA's OCSF
export page must become evidence that the reference evaluator judges the same
way OpenShell decided.

    pip install jsonschema "pyyaml==6.0.3" && python tests/openshell_check.py
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import jsonschema  # type: ignore[import-untyped]
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "adapters" / "openshell"))
import trp_openshell as osh  # noqa: E402

HERE = ROOT / "adapters" / "openshell"
PROFILE = HERE / "profiles" / "openshell-egress.trp.json"
DEPLOYMENT = HERE / "deployment.example.json"
DOCS = HERE / "fixtures" / "nvidia-docs"

passed = 0
failures: list[str] = []


def check(name: str, ok: bool, detail: object = "") -> None:
    global passed
    if ok:
        passed += 1
        print(f"PASS  {name}")
    else:
        failures.append(name)
        print(f"FAIL  {name}  {detail}")


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def raises(fn: Any) -> bool:
    try:
        fn()
    except osh.DeploymentError:
        return True
    return False


def main() -> int:
    schema = load(ROOT / "schema" / "trp.schema.json")
    profile = load(PROFILE)
    deployment = load(DEPLOYMENT)
    errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(profile), key=str)
    check("the OpenShell profile is a valid TRP profile", not errors, [e.message for e in errors])

    # ------------------------------------------------------------ policy
    policy, cov = osh.compile_policy(profile, deployment)
    quick = yaml.safe_load((DOCS / "quickstart-policy.yaml").read_text(encoding="utf-8"))
    ours = policy["network_policies"]["github_api"]
    theirs = quick["network_policies"]["github_api"]
    check("the GitHub rule equals NVIDIA's quickstart rule member for member", ours == theirs, (ours, theirs))
    check(
        "filesystem and Landlock settings equal NVIDIA's quickstart policy",
        policy["filesystem_policy"] == quick["filesystem_policy"] and policy["landlock"] == quick["landlock"],
    )
    check("the policy declares version 1", policy["version"] == 1 == quick["version"])
    text = osh.to_yaml(policy, profile)
    check("the written YAML parses back to the same policy", yaml.safe_load(text) == policy)
    check("the YAML names the profile it came from", "openshell-egress 0.1.0." in text.splitlines()[1])

    by = {c["clause"]: c for c in cov["clauses"]}
    check("OpenShell carries the destination rule", by["unapproved_destination"]["carried_by"] == "openshell")
    check(
        "OpenShell carries the write rule when every endpoint is inspected and enforced",
        by["write_without_approval"]["carried_by"] == "openshell",
    )
    check("the review step stays with the TRP gate", "review" in by["write_without_approval"]["stays_with_trp_gate"])

    mixed = json.loads(json.dumps(deployment))
    mixed["endpoints"].append({"rule": "pypi", "host": "pypi.org", "port": 443, "binaries": ["/usr/bin/pip"]})
    mixed["endpoints"].append(
        {
            "rule": "docs_api",
            "host": "docs.example.org",
            "port": 443,
            "protocol": "rest",
            "enforcement": "audit",
            "binaries": ["/usr/bin/curl"],
        }
    )
    p2, c2 = osh.compile_policy(profile, mixed)
    w2 = {c["clause"]: c for c in c2["clauses"]}["write_without_approval"]
    check(
        "an endpoint without inspection has no protocol, access or enforcement",
        p2["network_policies"]["pypi"]["endpoints"][0] == {"host": "pypi.org", "port": 443},
    )
    check(
        "an uninspected or audited endpoint leaves the write rule only partly with OpenShell",
        w2["carried_by"] == "openshell_in_part"
        and "pypi.org:443" in w2["stays_with_trp_gate"]
        and "docs.example.org:443" in w2["stays_with_trp_gate"],
    )
    writes = json.loads(json.dumps(deployment))
    writes["endpoints"][0]["writes_approved"] = True
    p3, _ = osh.compile_policy(profile, writes)
    check(
        "an endpoint approved for writes gets the read-write preset",
        p3["network_policies"]["github_api"]["endpoints"][0]["access"] == "read-write",
    )
    no_write_rule = {
        **profile,
        "hard_rules": [r for r in profile["hard_rules"] if r["field"] != "write_without_approval"],
    }
    p4, _ = osh.compile_policy(no_write_rule, deployment)
    check(
        "without a write rule an inspected endpoint gets the full preset",
        p4["network_policies"]["github_api"]["endpoints"][0]["access"] == "full",
    )
    scored = {
        **profile,
        "scored_signals": [
            {
                "signal": "calls_per_minute",
                "weight": 1,
                "direction": "higher_is_unsafe",
                "warning_threshold": 30,
                "critical_threshold": 60,
            }
        ],
    }
    _, c5 = osh.compile_policy(scored, deployment)
    check(
        "a scored signal stays with the TRP gate",
        {c["clause"]: c for c in c5["clauses"]}["calls_per_minute"]["carried_by"] == "trp_gate",
    )

    def bad(change: dict[str, Any]) -> bool:
        d = json.loads(json.dumps(deployment))
        d["endpoints"][0].update(change)
        return raises(lambda: osh.compile_policy(profile, d))

    check("a host with a scheme is refused", bad({"host": "https://api.github.com"}))
    check("a port out of range is refused", bad({"port": 70000}))
    check("an empty program list is refused", bad({"binaries": []}))
    check("a relative program path is refused", bad({"binaries": ["curl"]}))
    check("a protocol this version does not write is refused", bad({"protocol": "mcp"}))
    check("an unknown enforcement mode is refused", bad({"enforcement": "block"}))
    dup = json.loads(json.dumps(deployment))
    dup["endpoints"].append(dict(dup["endpoints"][0]))
    check("a repeated rule name is refused", raises(lambda: osh.compile_policy(profile, dup)))

    # ------------------------------------------------------------ OCSF
    stderr_lines = (DOCS / "supervisor-stderr.log").read_text(encoding="utf-8").splitlines()
    recs, bad_lines = osh.read_ocsf(stderr_lines, "stderr")
    check(
        "the stderr reader takes the OCSF-JSON lines and passes over the shorthand line",
        len(recs) == 2 and bad_lines == 0,
        (len(recs), bad_lines),
    )
    jl, bad_jl = osh.read_ocsf(
        [*(DOCS / "ocsf-examples.jsonl").read_text(encoding="utf-8").splitlines(), "not json"], "jsonl"
    )
    check("the JSON lines reader counts an unreadable line", len(jl) == 2 and bad_jl == 1)
    auto, _ = osh.read_ocsf(stderr_lines + (DOCS / "ocsf-examples.jsonl").read_text(encoding="utf-8").splitlines())
    items = osh.evidence_lines(auto)
    check("a record seen twice by its metadata.uid counts once", len(items) == 2, len(items))
    allowed, denied = items
    check(
        "an allowed connection approves the destination and writes nothing",
        allowed["evidence"] == {"output_destination_approved": True, "write_without_approval": False},
    )
    check(
        "a denied connection is an unapproved destination",
        denied["evidence"]["output_destination_approved"] is False and denied["openshell"]["disposition"] == "Blocked",
    )

    def http(action: str, method: str | None) -> dict[str, Any]:
        rec: dict[str, Any] = {
            "class_uid": 4002,
            "action": action,
            "metadata": {"uid": f"{action}-{method}"},
            "dst_endpoint": {"domain": "api.github.com", "port": 443},
            "firewall_rule": {"name": "github_api"},
        }
        if method:
            rec["http_request"] = {"http_method": method}
        return rec

    post = osh.evidence_from_record(http("Denied", "POST"))
    get = osh.evidence_from_record(http("Allowed", "GET"))
    blind = osh.evidence_from_record(http("Denied", None))
    check(
        "a denied write request is a write without approval",
        post is not None and post["evidence"] == {"output_destination_approved": True, "write_without_approval": True},
    )
    check(
        "an allowed request is no write without approval",
        get is not None and get["evidence"]["write_without_approval"] is False,
    )
    check(
        "a denied request with no method leaves the write field out",
        blind is not None and "write_without_approval" not in blind["evidence"],
    )
    check(
        "records that decide nothing give no evidence",
        osh.evidence_from_record({"class_uid": 4007, "action": "Allowed"}) is None
        and osh.evidence_from_record({"class_uid": 4002, "action": "Other", "disposition": "Allowed"}) is None,
    )

    # ------------------------------------------------------------ evaluate
    built = [x for x in (post, get, blind) if x is not None]
    results, summary = osh.evaluate_lines(PROFILE, items + built)
    check(
        "the profile and OpenShell agree on every documented and built decision",
        summary["decisions"] == 5 and summary["agree"] == 4 and summary["disagree"] == 0 and summary["incomplete"] == 1,
        summary,
    )
    check(
        "the denied destination halts the agent",
        results[1]["response"] == "suspended" and results[1]["hard_rules_triggered"] == ["unapproved_destination"],
    )
    check(
        "a missing write field is inconclusive",
        results[4]["agree"] is None and results[4]["hard_rules_inconclusive"] == ["write_without_approval"],
    )

    # ------------------------------------------------------------ live run
    live = HERE / "fixtures" / "live-run"
    run = load(live / "RUN.json")
    digests = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in live.iterdir() if p.name != "RUN.json"}
    check("every live run file matches the digest in RUN.json", digests == run["sha256"], digests)
    check(
        "the live run used the policy this adapter writes from the profile",
        (live / "policy.yaml").read_text(encoding="utf-8") == osh.to_yaml(policy, profile),
    )
    stderr = (live / "supervisor-stderr.log").read_text(encoding="utf-8").splitlines()
    live_records, live_bad = osh.read_ocsf(stderr, "auto")
    live_http = [r for r in live_records if r.get("class_uid") == 4002]
    check(
        "OpenShell 0.1.8 writes the HTTP method in http_request.http_method",
        bool(live_http) and all(isinstance(osh._get(r, "http_request", "http_method"), str) for r in live_http),
        len(live_http),
    )
    live_items = osh.evidence_lines(live_records)
    committed = [json.loads(x) for x in (live / "evidence.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    check("the supervisor log gives the recorded evidence line for line", live_bad == 0 and live_items == committed)
    results_live, summary_live = osh.evaluate_lines(PROFILE, live_items)
    committed = [json.loads(x) for x in (live / "results.jsonl").read_text(encoding="utf-8").splitlines() if x.strip()]
    check("the reference evaluator gives the recorded results", results_live == committed)
    check(
        "TRP and OpenShell agree on all 18 recorded decisions",
        summary_live == load(live / "summary.json")
        and summary_live["decisions"] == 18
        and summary_live["agree"] == 18
        and summary_live["openshell_denied"] == 9,
        summary_live,
    )

    # ------------------------------------------------------------ command line
    tool = str(HERE / "trp_openshell.py")
    with tempfile.TemporaryDirectory() as tmp:
        t = Path(tmp)
        r1 = subprocess.run(
            [
                sys.executable,
                tool,
                "policy",
                "--profile",
                str(PROFILE),
                "--deployment",
                str(DEPLOYMENT),
                "--policy-out",
                str(t / "policy.yaml"),
                "--coverage-out",
                str(t / "coverage.json"),
            ],
            capture_output=True,
            text=True,
        )
        check(
            "the policy command writes the policy and the coverage report",
            r1.returncode == 0
            and yaml.safe_load((t / "policy.yaml").read_text()) == policy
            and load(t / "coverage.json") == cov,
            r1.stderr,
        )
        r2 = subprocess.run(
            [sys.executable, tool, "evidence", str(DOCS / "supervisor-stderr.log"), "--out", str(t / "ev.jsonl")],
            capture_output=True,
            text=True,
        )
        r3 = subprocess.run(
            [
                sys.executable,
                tool,
                "evaluate",
                str(t / "ev.jsonl"),
                "--profile",
                str(PROFILE),
                "--out",
                str(t / "res.jsonl"),
            ],
            capture_output=True,
            text=True,
        )
        check(
            "the evidence and evaluate commands run end to end",
            r2.returncode == 0 and r3.returncode == 0 and json.loads(r3.stdout)["agree"] == 2,
            (r2.stderr, r3.stderr),
        )
        broken = t / "broken.json"
        broken.write_text(json.dumps({"endpoints": [{"rule": "x", "host": "a.b", "port": 443, "binaries": []}]}))
        r4 = subprocess.run(
            [sys.executable, tool, "policy", "--profile", str(PROFILE), "--deployment", str(broken)],
            capture_output=True,
            text=True,
        )
        check("a broken deployment exits 2 with the reason", r4.returncode == 2 and "binaries" in r4.stderr, r4.stderr)

    for f in failures:
        print(f"FAIL  {f}")
    print(f"OpenShell adapter: {passed} passed, {len(failures)} failed ({passed + len(failures)} total)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
