"""Reference TRP evaluator.

Loads a Trust Requirements Profile, evaluates a data sample against its
scored signals, hard rules, and drift window, and produces a standing
from the profile's declared bands.

This is a reference implementation, not a production evaluation source.
It demonstrates that TRP profiles are machine-actionable: any conforming
evaluator reading the same profile and evidence reaches the same result.

Usage:
    python3 evaluate.py profiles/manufacturing-safety.json sample.json
    python3 evaluate.py --generate-sample profiles/manufacturing-safety.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
import hashlib
import datetime
from typing import Any


# ---------------------------------------------------------------------------
# Profile loading
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ScoredSignal:
    signal: str
    weight: float
    direction: str
    warning_threshold: float
    critical_threshold: float
    unit: str = ""
    on_missing: str = "incomplete"

    @property
    def low_is_bad(self) -> bool:
        return self.direction == "lower_is_unsafe"

    def severity(self, value: float) -> float:
        if self.low_is_bad:
            denom = self.warning_threshold - self.critical_threshold
            if denom == 0:
                raw = 0.0 if value >= self.warning_threshold else 1.0
            else:
                raw = (self.warning_threshold - value) / denom
        else:
            denom = self.critical_threshold - self.warning_threshold
            if denom == 0:
                raw = 0.0 if value <= self.warning_threshold else 1.0
            else:
                raw = (value - self.warning_threshold) / denom
        return max(0.0, min(1.0, raw))


@dataclass(frozen=True)
class HardRule:
    rule: str
    field_name: str
    condition: str
    value: Any = None
    action: str = "halt"

    def triggered(self, signals: dict[str, Any]) -> bool:
        if self.field_name not in signals:
            return False
        actual = signals[self.field_name]
        if self.condition == "is_true":
            return bool(actual) is True
        if self.condition == "is_false":
            return bool(actual) is False
        if self.condition == "equals":
            return actual == self.value
        if self.condition == "not_equals":
            return actual != self.value
        if self.condition == "less_than":
            return float(actual) < float(self.value)
        if self.condition == "greater_than":
            return float(actual) > float(self.value)
        return False


@dataclass(frozen=True)
class StandingBand:
    band: str
    severity: int
    range_desc: str = ""


@dataclass(frozen=True)
class Profile:
    trp_id: str
    spec_version: str
    version: str
    name: str
    scored_signals: tuple[ScoredSignal, ...]
    hard_rules: tuple[HardRule, ...]
    standing_bands: tuple[StandingBand, ...]
    minimum_acceptable_band: str = ""
    drift_window: int = 0
    drift_signals: tuple[str, ...] = ()
    response_bands: dict[str, str] = field(default_factory=dict)


def load_profile(path: Path) -> Profile:
    with open(path) as f:
        raw = json.load(f)

    signals = tuple(
        ScoredSignal(
            signal=s["signal"],
            weight=s["weight"],
            direction=s["direction"],
            warning_threshold=s["warning_threshold"],
            critical_threshold=s["critical_threshold"],
            unit=s.get("unit", ""),
            on_missing=s.get("on_missing", "incomplete"),
        )
        for s in raw.get("scored_signals", [])
    )

    rules = tuple(
        HardRule(
            rule=r["rule"],
            field_name=r["field"],
            condition=r["condition"],
            value=r.get("value"),
            action=r["action"],
        )
        for r in raw.get("hard_rules", [])
    )

    bands = tuple(
        StandingBand(
            band=b["band"],
            severity=b["severity"],
            range_desc=b.get("range", ""),
        )
        for b in raw.get("standing_bands", [])
    )

    drift = raw.get("drift", {})
    req = raw.get("required_standing", {})
    resp = {}
    for rb in req.get("response_bands", []):
        resp[rb["band"]] = rb["response"]

    return Profile(
        trp_id=raw["trp_id"],
        spec_version=raw.get("spec_version", ""),
        version=raw.get("version", ""),
        name=raw.get("name", ""),
        scored_signals=signals,
        hard_rules=rules,
        standing_bands=bands,
        minimum_acceptable_band=req.get("minimum_acceptable_band", ""),
        drift_window=drift.get("window", 0),
        drift_signals=tuple(drift.get("signals", [])),
        response_bands=resp,
    )


# ---------------------------------------------------------------------------
# Drift detection
# ---------------------------------------------------------------------------

class DriftDetector:
    def __init__(self, window: int, signals: tuple[str, ...]):
        self.window = window
        self.signals = signals
        self.history: dict[str, deque[float]] = {
            s: deque(maxlen=window) for s in signals
        }

    def update(self, signal: str, value: float) -> dict[str, Any] | None:
        if signal not in self.history:
            return None
        self.history[signal].append(value)
        if len(self.history[signal]) < self.window:
            return {"signal": signal, "samples": len(self.history[signal]),
                    "window": self.window, "drift_detected": False,
                    "reason": "insufficient samples"}
        avg = sum(self.history[signal]) / len(self.history[signal])
        return {"signal": signal, "moving_average": round(avg, 4),
                "window": self.window, "drift_detected": False}


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(profile: Profile, signals: dict[str, Any],
             drift_detector: DriftDetector | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "trp_id": profile.trp_id,
        "trp_version": profile.version,
    }

    # 1. Hard rules (checked first, override everything)
    triggered_rules = []
    for rule in profile.hard_rules:
        if rule.triggered(signals):
            triggered_rules.append({
                "rule": rule.rule,
                "action": rule.action,
                "field": rule.field_name,
                "condition": rule.condition,
            })

    result["hard_rules_triggered"] = triggered_rules
    hard_override = len(triggered_rules) > 0

    # 2. Scored signals
    total_weight = sum(s.weight for s in profile.scored_signals)
    weighted_penalty = 0.0
    signal_results = []
    missing_signals = []

    for ss in profile.scored_signals:
        if ss.signal not in signals:
            missing_signals.append({
                "signal": ss.signal,
                "on_missing": ss.on_missing,
            })
            if ss.on_missing == "critical":
                weighted_penalty += ss.weight
            continue

        value = float(signals[ss.signal])
        sev = ss.severity(value)
        penalty = ss.weight * sev
        weighted_penalty += penalty

        in_warning = sev > 0
        in_critical = (
            value <= ss.critical_threshold if ss.low_is_bad
            else value >= ss.critical_threshold
        )

        signal_results.append({
            "signal": ss.signal,
            "value": value,
            "unit": ss.unit,
            "severity": round(sev, 4),
            "penalty": round(penalty, 4),
            "in_warning": in_warning,
            "in_critical": in_critical,
        })

        # Update drift detector
        if drift_detector and ss.signal in drift_detector.signals:
            drift_detector.update(ss.signal, value)

    # 3. Aggregate penalty (internal, not exposed in output)
    result["signal_results"] = signal_results
    result["missing_signals"] = missing_signals

    # 4. Standing band assignment
    sorted_bands = sorted(profile.standing_bands, key=lambda b: b.severity)
    assigned_band = sorted_bands[-1].band if sorted_bands else "unknown"

    if hard_override:
        assigned_band = sorted_bands[-1].band if sorted_bands else "failing"
    else:
        any_critical = any(s.get("in_critical") for s in signal_results)
        any_warning = any(s.get("in_warning") for s in signal_results)
        has_incomplete = any(
            m["on_missing"] == "incomplete" for m in missing_signals
        )

        if any_critical or has_incomplete:
            # Worst band
            assigned_band = sorted_bands[-1].band if sorted_bands else "failing"
        elif any_warning:
            # Middle band (or worst if only two)
            mid = len(sorted_bands) // 2
            assigned_band = sorted_bands[mid].band if sorted_bands else "review"
        else:
            # Best band
            assigned_band = sorted_bands[0].band if sorted_bands else "good"

    result["standing"] = assigned_band
    result["hard_override"] = hard_override
    result["response"] = profile.response_bands.get(assigned_band, "unknown")

    # 5. Drift evidence
    if drift_detector:
        result["drift"] = {
            s: {"moving_average": round(
                sum(drift_detector.history[s]) / len(drift_detector.history[s]), 4
            ) if drift_detector.history[s] else None,
                "samples": len(drift_detector.history[s]),
                "window": drift_detector.window}
            for s in drift_detector.signals
        }

    # 6. Evaluation metadata (provenance and tamper detection)
    result_payload = json.dumps(result, sort_keys=True, separators=(",", ":"))
    result["evaluation"] = {
        "profile_id": profile.trp_id,
        "profile_version": profile.version,
        "spec_version": profile.spec_version,
        "evaluator": "trp-reference-python",
        "evaluated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "result_hash": hashlib.sha256(result_payload.encode()).hexdigest(),
    }

    return result


# ---------------------------------------------------------------------------
# Sample data generation
# ---------------------------------------------------------------------------

def generate_sample(profile: Profile) -> dict[str, Any]:
    """Generate a sample data point with all signals at normal values."""
    sample: dict[str, Any] = {}
    for ss in profile.scored_signals:
        if ss.low_is_bad:
            # Normal = well above warning threshold
            sample[ss.signal] = round(
                ss.warning_threshold * 1.2, 4
            )
        else:
            # Normal = well below warning threshold
            sample[ss.signal] = round(
                ss.warning_threshold * 0.8, 4
            )

    # Set boolean fields used by hard rules to safe defaults
    for rule in profile.hard_rules:
        if rule.condition == "is_true":
            sample[rule.field_name] = False
        elif rule.condition == "is_false":
            sample[rule.field_name] = True
        elif rule.condition == "equals":
            sample[rule.field_name] = "__safe__"

    return sample


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Evaluate a data sample against a TRP profile."
    )
    parser.add_argument("profile", type=Path, help="Path to the TRP profile JSON.")
    parser.add_argument("sample", type=Path, nargs="?",
                        help="Path to the sample data JSON.")
    parser.add_argument("--generate-sample", action="store_true",
                        help="Generate and print a sample with safe values.")
    args = parser.parse_args()

    profile = load_profile(args.profile)

    if args.generate_sample:
        sample = generate_sample(profile)
        print(json.dumps(sample, indent=2))
        return

    if not args.sample:
        parser.error("Provide a sample data file or use --generate-sample.")

    with open(args.sample) as f:
        signals = json.load(f)

    drift = None
    if profile.drift_window > 0:
        drift = DriftDetector(profile.drift_window, profile.drift_signals)

    result = evaluate(profile, signals, drift)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
