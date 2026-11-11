#!/usr/bin/env python3
"""Cross-evaluator agreement between tools/evaluate.py and tools/evaluate.js.

Runs every valid test profile and every example profile against every
evidence sample in tests/evidence with both reference evaluators, and
requires the same output and the same result_hash byte for byte. Every valid
profile that uses extends must be rejected by both, as Section 7 requires.

Requirements: Python 3.10+, Node.js 18+.

Usage:
    python3 tests/cross_evaluator_check.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from evaluate import (  # noqa: E402
    load_profile, evaluate, DriftDetector, UnsupportedProfileError,
)

NODE_EVALUATOR = str(ROOT / "tools" / "evaluate.js")

# result_hash is not volatile. Both evaluators hash the RFC 8785 canonical
# form of the same output, so it must match byte for byte.
VOLATILE = {"evaluated_at", "evaluator"}


def strip(d):
    if isinstance(d, dict):
        return {k: strip(v) for k, v in d.items() if k not in VOLATILE}
    if isinstance(d, list):
        return [strip(x) for x in d]
    return d


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    profiles = sorted((ROOT / "tests" / "profiles" / "valid").glob("*.json"))
    profiles += sorted((ROOT / "examples").glob("*/trp.json"))
    evidences = sorted((ROOT / "tests" / "evidence").glob("*.json"))

    passed = failed = hash_passed = hash_failed = 0

    with tempfile.TemporaryDirectory() as tmp:
        clean_path = Path(tmp) / "clean_ev.json"

        for profile_path in profiles:
            with open(profile_path) as f:
                uses_extends = "extends" in json.load(f)
            if uses_extends:
                # Section 7: both evaluators must reject a profile that uses extends.
                try:
                    load_profile(profile_path)
                    py_rejected = False
                except UnsupportedProfileError:
                    py_rejected = True
                proc = subprocess.run(
                    ["node", NODE_EVALUATOR, str(profile_path),
                     str(ROOT / "tests" / "evidence" / "all-healthy.json")],
                    capture_output=True, text=True,
                )
                node_rejected = proc.returncode == 2
                name = f"{rel(profile_path)} (extends rejected)"
                if py_rejected and node_rejected:
                    print(f"AGREE  {name}")
                    passed += 1
                else:
                    print(f"DISAGREE  {name}: python rejected={py_rejected}, "
                          f"node rejected={node_rejected}")
                    failed += 1
                continue

            profile = load_profile(profile_path)
            for evidence_path in evidences:
                with open(evidence_path) as f:
                    raw = json.load(f)
                clean = {k: v for k, v in raw.items() if not k.startswith("_")}
                clean_path.write_text(json.dumps(clean))

                drift = None
                if profile.drift_window > 0:
                    drift = DriftDetector(profile.drift_window, profile.drift_signals)
                py_result = strip(evaluate(profile, clean, drift))

                proc = subprocess.run(
                    ["node", NODE_EVALUATOR, str(profile_path), str(clean_path)],
                    capture_output=True, text=True,
                )
                name = f"{rel(profile_path)} + {rel(evidence_path)}"
                if proc.returncode != 0:
                    print(f"ERROR  {name}")
                    print(proc.stderr)
                    failed += 1
                    continue

                js_result = strip(json.loads(proc.stdout))

                py_hash = py_result["evaluation"]["result_hash"]
                js_hash = js_result["evaluation"]["result_hash"]
                if py_hash == js_hash:
                    hash_passed += 1
                else:
                    print(f"HASH DIFFERS  {name}: python {py_hash}, node {js_hash}")
                    hash_failed += 1

                if py_result == js_result:
                    print(f"AGREE  {name}")
                    passed += 1
                else:
                    print(f"DISAGREE  {name}")
                    print(f"  Python: {py_result}")
                    print(f"  NodeJS: {js_result}")
                    failed += 1

    print()
    print(f"Cross-evaluator agreement: {passed}/{passed + failed}")
    print(f"result_hash agreement: {hash_passed}/{hash_passed + hash_failed}")
    return 1 if failed or hash_failed else 0


if __name__ == "__main__":
    sys.exit(main())
