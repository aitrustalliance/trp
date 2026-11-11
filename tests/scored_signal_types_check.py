#!/usr/bin/env python3
"""Scored signal value types that no evidence file can carry.

Section 3.3 accepts only a finite JSON number as a scored signal value. The
samples in tests/evidence cover every JSON type. This check covers the rest
in both reference evaluators and requires the same output and the same
result_hash from each.

1. NaN, infinity and negative infinity, which have no JSON form and can only
   reach an evaluator from a caller that passes values in memory.
2. A JSON number too large for a double, such as 1e400, read by each
   language's own JSON parser.
3. A declared signal named after an inherited object member, such as
   constructor, which is absent unless the evidence carries it.
4. A hard rule field that holds an integer too large for a double.

Requirements: Python 3.10+, Node.js 18+.

Usage:
    python3 tests/scored_signal_types_check.py
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from evaluate import evaluate, profile_from_dict  # noqa: E402

FAILS = []
COUNT = 0

# Each case reaches Node.js as text. The evidence is parsed there with
# JSON.parse, and a patch names a value JSON cannot carry.
NODE = r"""
const t = require(process.argv[1]);
const tokens = { "nan": NaN, "inf": Infinity, "-inf": -Infinity };
const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(cases.map((c) => {
  try {
    const evidence = JSON.parse(c.evidence_text);
    for (const [k, v] of Object.entries(c.patch)) evidence[k] = tokens[v];
    const { evaluation, ...out } = t.evaluate(t.profileFromObject(c.profile), evidence);
    return { out, result_hash: evaluation.result_hash };
  } catch (err) {
    return { error: String(err.message) };
  }
})));
"""

TOKENS = {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf")}


def check(name, ok, detail=""):
    global COUNT
    COUNT += 1
    if not ok:
        FAILS.append(f"{name} {detail}".strip())
        print(f"  FAIL  {name} {detail}".rstrip())


def python_run(case):
    try:
        evidence = json.loads(case["evidence_text"])
        for k, v in case["patch"].items():
            evidence[k] = TOKENS[v]
        r = evaluate(profile_from_dict(case["profile"]), evidence)
        return {"out": {k: v for k, v in r.items() if k != "evaluation"},
                "result_hash": r["evaluation"]["result_hash"]}
    except Exception as err:  # reported as a failed check below
        return {"error": f"{type(err).__name__}: {err}"}


def main() -> int:
    profile = json.loads((ROOT / "tests/profiles/valid/full-featured.json").read_text())
    healthy = {k: v for k, v in json.loads((ROOT / "tests/evidence/all-healthy.json").read_text()).items()
               if not k.startswith("_")}
    on_missing = {s["signal"]: s.get("on_missing", "incomplete") for s in profile["scored_signals"]}
    # One signal for each on_missing value, with the standing the profile gives.
    policies = [("latency_ms", "untrusted"), ("accuracy", "untrusted"), ("uptime_ratio", "trusted")]
    assert [on_missing[s] for s, _ in policies] == ["incomplete", "critical", "ignore"]

    cases = []  # (name, case, expected missing_signals, expected standing, expected inconclusive rules)

    def mismatch(signal):
        return [{"signal": signal, "on_missing": on_missing[signal], "reason": "type_mismatch"}]

    for token, label in (("nan", "NaN"), ("inf", "infinity"), ("-inf", "negative infinity")):
        for signal, standing in policies:
            cases.append((f"{label} for {signal} with on_missing {on_missing[signal]} is a type mismatch",
                          {"profile": profile, "evidence_text": json.dumps(healthy), "patch": {signal: token}},
                          mismatch(signal), standing, []))

    for literal in ("1e400", "-1e400"):
        text = json.dumps(dict(healthy, latency_ms="@")).replace('"@"', literal)
        cases.append((f"the JSON number {literal} for latency_ms is a type mismatch",
                      {"profile": profile, "evidence_text": text, "patch": {}}, mismatch("latency_ms"), "untrusted", []))

    inherited = copy.deepcopy(profile)
    for name in ("constructor", "toString"):
        inherited["scored_signals"].append({"signal": name, "weight": 5, "direction": "higher_is_unsafe",
                                            "warning_threshold": 1, "critical_threshold": 2})
    cases.append(("a declared signal named after an inherited object member is absent unless the evidence carries it",
                  {"profile": inherited, "evidence_text": json.dumps(healthy), "patch": {}},
                  [{"signal": "constructor", "on_missing": "incomplete"}, {"signal": "toString", "on_missing": "incomplete"}],
                  "untrusted", []))

    big = json.dumps(dict(healthy, error_rate="@")).replace('"@"', "1" + "0" * 400)
    cases.append(("a hard rule field holding an integer too large for a double leaves the rule inconclusive",
                  {"profile": profile, "evidence_text": big, "patch": {}}, [], "untrusted", ["excessive-error-rate"]))

    py = [python_run(c) for _, c, _, _, _ in cases]
    js = json.loads(subprocess.run(["node", "-e", NODE, str(ROOT / "tools/evaluate.js")],
                                   input=json.dumps([c for _, c, _, _, _ in cases]),
                                   capture_output=True, text=True, check=True).stdout)

    for (name, case, missing, standing, inconclusive), p, j in zip(cases, py, js):
        if "error" in p or "error" in j:
            check(name, False, f"python {p.get('error')}, node {j.get('error')}")
            continue
        out = p["out"]
        scored = {s["signal"] for s in out["signal_results"]}
        ok = (out["missing_signals"] == missing and out["standing"] == standing
              and out["hard_override"] is False
              and not scored & {m["signal"] for m in missing}
              and [r["rule"] for r in out["hard_rules_inconclusive"]] == inconclusive
              and all(r["reason"] == "type_mismatch" for r in out["hard_rules_inconclusive"]))
        check(name, ok, json.dumps({"standing": out["standing"], "missing_signals": out["missing_signals"]}))
        check(f"both evaluators agree when {name}", p == j, f"python {p}, node {j}")

    # The same mistyped signal gives the same output whatever the wrong value
    # was, since the value is never scored and never written.
    by_signal = {}
    for (name, case, _, _, _), p in zip(cases, py):
        if len(case["patch"]) == 1 and "error" not in p:
            by_signal.setdefault(next(iter(case["patch"])), set()).add(p["result_hash"])
    check("NaN, infinity and negative infinity give one result_hash for each signal",
          len(by_signal) == len(policies) and all(len(v) == 1 for v in by_signal.values()), by_signal)

    if FAILS:
        print(f"Scored signal types: {len(FAILS)} of {COUNT} checks failed")
        return 1
    print(f"Scored signal types: {COUNT} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
