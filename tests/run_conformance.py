#!/usr/bin/env python3
"""TRP conformance test suite.

Validates that:
1. Valid profiles pass JSON Schema validation.
2. Invalid profiles are rejected by JSON Schema validation.
3. Example profiles in examples/ pass JSON Schema validation.
4. The reference evaluator produces deterministic, expected results
   when run against known evidence samples.

Requirements:
    pip install jsonschema

Usage:
    python3 tests/run_conformance.py
    python3 tests/run_conformance.py --verbose
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import jsonschema
except ImportError:
    print("ERROR: jsonschema is required.  pip install jsonschema")
    sys.exit(1)

# Add project root to path so we can import the evaluator
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "tools"))

from evaluate import load_profile, evaluate, DriftDetector  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_schema() -> dict:
    schema_path = PROJECT_ROOT / "schema" / "trp.schema.json"
    with open(schema_path) as f:
        return json.load(f)


def validate_profile(profile_data: dict, schema: dict) -> list[str]:
    """Return a list of validation error messages (empty = valid)."""
    validator = jsonschema.Draft202012Validator(schema)
    return [e.message for e in validator.iter_errors(profile_data)]


class Results:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors: list[str] = []

    def ok(self, name: str, verbose: bool):
        self.passed += 1
        if verbose:
            print(f"  PASS  {name}")

    def fail(self, name: str, reason: str, verbose: bool):
        self.failed += 1
        msg = f"  FAIL  {name}: {reason}"
        self.errors.append(msg)
        if verbose:
            print(msg)

    @property
    def total(self):
        return self.passed + self.failed


# ---------------------------------------------------------------------------
# Test groups
# ---------------------------------------------------------------------------

def test_valid_profiles(schema: dict, results: Results, verbose: bool):
    """Every file in tests/profiles/valid/ must pass schema validation."""
    valid_dir = PROJECT_ROOT / "tests" / "profiles" / "valid"
    if not valid_dir.exists():
        results.fail("valid_profiles", "directory not found", verbose)
        return

    files = sorted(valid_dir.glob("*.json"))
    if not files:
        results.fail("valid_profiles", "no test files found", verbose)
        return

    for path in files:
        with open(path) as f:
            data = json.load(f)
        errors = validate_profile(data, schema)
        if errors:
            results.fail(
                f"valid/{path.name}",
                f"should validate but got: {errors[0]}",
                verbose,
            )
        else:
            results.ok(f"valid/{path.name}", verbose)


def test_invalid_profiles(schema: dict, results: Results, verbose: bool):
    """Every file in tests/profiles/invalid/ must fail schema validation."""
    invalid_dir = PROJECT_ROOT / "tests" / "profiles" / "invalid"
    if not invalid_dir.exists():
        results.fail("invalid_profiles", "directory not found", verbose)
        return

    files = sorted(invalid_dir.glob("*.json"))
    if not files:
        results.fail("invalid_profiles", "no test files found", verbose)
        return

    for path in files:
        with open(path) as f:
            data = json.load(f)
        errors = validate_profile(data, schema)
        if errors:
            results.ok(f"invalid/{path.name}", verbose)
        else:
            results.fail(
                f"invalid/{path.name}",
                "should be rejected but passed validation",
                verbose,
            )


def test_example_profiles(schema: dict, results: Results, verbose: bool):
    """Every profile in examples/ must pass schema validation."""
    examples_dir = PROJECT_ROOT / "examples"
    if not examples_dir.exists():
        results.fail("example_profiles", "examples/ not found", verbose)
        return

    files = sorted(examples_dir.rglob("trp.json"))
    if not files:
        results.fail("example_profiles", "no trp.json found in examples/", verbose)
        return

    for path in files:
        rel = path.relative_to(PROJECT_ROOT)
        with open(path) as f:
            data = json.load(f)
        errors = validate_profile(data, schema)
        if errors:
            results.fail(str(rel), f"schema error: {errors[0]}", verbose)
        else:
            results.ok(str(rel), verbose)


def test_evaluator_determinism(results: Results, verbose: bool):
    """Run the reference evaluator against known evidence samples and
    verify that the standing and response match the expected values
    embedded in each evidence file."""
    profile_path = PROJECT_ROOT / "tests" / "profiles" / "valid" / "full-featured.json"
    evidence_dir = PROJECT_ROOT / "tests" / "evidence"

    if not profile_path.exists():
        results.fail("evaluator", "full-featured.json not found", verbose)
        return

    profile = load_profile(profile_path)
    files = sorted(evidence_dir.glob("*.json"))

    if not files:
        results.fail("evaluator", "no evidence files found", verbose)
        return

    for path in files:
        with open(path) as f:
            data = json.load(f)

        expected_standing = data.get("_expected_standing")
        expected_response = data.get("_expected_response")
        expected_hard = data.get("_expected_hard_override")

        if expected_standing is None:
            results.fail(
                f"evidence/{path.name}",
                "missing _expected_standing in test file",
                verbose,
            )
            continue

        # Strip test metadata before evaluating
        signals = {
            k: v for k, v in data.items() if not k.startswith("_")
        }

        drift = None
        if profile.drift_window > 0:
            drift = DriftDetector(profile.drift_window, profile.drift_signals)

        result = evaluate(profile, signals, drift)

        test_name = f"evidence/{path.name}"

        # Check standing
        if result["standing"] != expected_standing:
            results.fail(
                test_name,
                f"standing: expected '{expected_standing}', got '{result['standing']}'",
                verbose,
            )
            continue

        # Check response
        if expected_response and result.get("response") != expected_response:
            results.fail(
                test_name,
                f"response: expected '{expected_response}', got '{result.get('response')}'",
                verbose,
            )
            continue

        # Check hard override
        if expected_hard is not None and result.get("hard_override") != expected_hard:
            results.fail(
                test_name,
                f"hard_override: expected {expected_hard}, got {result.get('hard_override')}",
                verbose,
            )
            continue

        results.ok(test_name, verbose)

    # Determinism check: run the same evaluation twice and compare
    with open(evidence_dir / "all-healthy.json") as f:
        healthy = {k: v for k, v in json.load(f).items() if not k.startswith("_")}

    r1 = evaluate(profile, healthy)
    r2 = evaluate(profile, healthy)
    if r1 == r2:
        results.ok("evaluator/determinism-check", verbose)
    else:
        results.fail(
            "evaluator/determinism-check",
            "same input produced different output",
            verbose,
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="TRP conformance test suite")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    schema = load_schema()
    results = Results()

    print("TRP Conformance Test Suite")
    print("=" * 50)

    print("\n1. Valid profiles (must pass schema validation)")
    test_valid_profiles(schema, results, args.verbose)

    print("\n2. Invalid profiles (must fail schema validation)")
    test_invalid_profiles(schema, results, args.verbose)

    print("\n3. Example profiles (must pass schema validation)")
    test_example_profiles(schema, results, args.verbose)

    print("\n4. Evaluator determinism (expected standings)")
    test_evaluator_determinism(results, args.verbose)

    # Summary
    print("\n" + "=" * 50)
    print(f"Results: {results.passed} passed, {results.failed} failed "
          f"({results.total} total)")

    if results.errors:
        print("\nFailures:")
        for err in results.errors:
            print(err)

    sys.exit(0 if results.failed == 0 else 1)


if __name__ == "__main__":
    main()
