#!/usr/bin/env node
/**
 * TRP Reference Evaluator (Node.js)
 *
 * Independent implementation of the Trust Requirements Profile evaluator.
 * Produces identical output to tools/evaluate.py for the same profile and
 * evidence, proving that the specification is independently implementable
 * and that no single codebase controls evaluation.
 *
 * Usage:
 *   node tools/evaluate.js profiles/manufacturing-safety.json sample.json
 *   node tools/evaluate.js --generate-sample profiles/manufacturing-safety.json
 */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// --- Errors -----------------------------------------------------------------

// Raised when a profile uses a feature this evaluator does not support.
// Section 7 requires a consumer that does not support `extends` to reject
// the profile instead of ignoring the base.
class UnsupportedProfileError extends Error {}

// --- Value types (Section 3.4) ----------------------------------------------

// Return the TRP scalar type of a value: boolean, number, string or other.
function valueType(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "other";
  if (typeof value === "string") return "string";
  return "other";
}

// --- Profile loading --------------------------------------------------------

function loadProfile(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  if (Object.prototype.hasOwnProperty.call(raw, "extends")) {
    throw new UnsupportedProfileError(
      `${filePath}: profile uses 'extends', which this reference evaluator ` +
      "does not support. Section 7 requires rejecting the profile. " +
      "Resolve the inheritance into a single profile before evaluating."
    );
  }

  const scoredSignals = (raw.scored_signals || []).map((s) => ({
    signal: s.signal,
    weight: s.weight,
    direction: s.direction,
    warningThreshold: s.warning_threshold,
    criticalThreshold: s.critical_threshold,
    unit: s.unit || "",
    onMissing: s.on_missing || "incomplete",
  }));

  const hardRules = (raw.hard_rules || []).map((r) => ({
    rule: r.rule,
    fieldName: r.field,
    condition: r.condition,
    value: r.value !== undefined ? r.value : null,
    action: r.action,
  }));

  const standingBands = (raw.standing_bands || []).map((b) => ({
    band: b.band,
    severity: b.severity,
    rangeDesc: b.range || "",
  }));

  const drift = raw.drift || {};
  const req = raw.required_standing || {};
  const responseBands = {};
  for (const rb of req.response_bands || []) {
    responseBands[rb.band] = rb.response;
  }

  return {
    trpId: raw.trp_id,
    specVersion: raw.spec_version || "",
    version: raw.version || "",
    name: raw.name || "",
    scoredSignals,
    hardRules,
    standingBands,
    minimumAcceptableBand: req.minimum_acceptable_band || "",
    driftWindow: drift.window || 0,
    driftSignals: drift.signals || [],
    responseBands,
  };
}

// --- Signal severity --------------------------------------------------------

function signalSeverity(sig, value) {
  const lowIsBad = sig.direction === "lower_is_unsafe";
  let raw;

  if (lowIsBad) {
    const denom = sig.warningThreshold - sig.criticalThreshold;
    if (denom === 0) {
      raw = value >= sig.warningThreshold ? 0.0 : 1.0;
    } else {
      raw = (sig.warningThreshold - value) / denom;
    }
  } else {
    const denom = sig.criticalThreshold - sig.warningThreshold;
    if (denom === 0) {
      raw = value <= sig.warningThreshold ? 0.0 : 1.0;
    } else {
      raw = (value - sig.warningThreshold) / denom;
    }
  }

  return Math.max(0.0, Math.min(1.0, raw));
}

// --- Hard rule evaluation ---------------------------------------------------

// The type the inspected field must have for this rule's condition.
function expectedType(rule) {
  if (rule.condition === "is_true" || rule.condition === "is_false") return "boolean";
  if (rule.condition === "less_than" || rule.condition === "greater_than") return "number";
  return valueType(rule.value);
}

// Three-valued check: triggered, not_triggered or inconclusive.
// The reason is "missing" or "type_mismatch" when inconclusive, else null.
function ruleCheck(rule, signals) {
  if (!Object.prototype.hasOwnProperty.call(signals, rule.fieldName)) {
    return { outcome: "inconclusive", reason: "missing" };
  }
  const actual = signals[rule.fieldName];
  const expected = expectedType(rule);
  if (expected === "other" || valueType(actual) !== expected) {
    return { outcome: "inconclusive", reason: "type_mismatch" };
  }
  if ((rule.condition === "less_than" || rule.condition === "greater_than") &&
      valueType(rule.value) !== "number") {
    return { outcome: "inconclusive", reason: "type_mismatch" };
  }

  let met;
  switch (rule.condition) {
    case "is_true":
      met = actual === true;
      break;
    case "is_false":
      met = actual === false;
      break;
    case "equals":
      met = actual === rule.value;
      break;
    case "not_equals":
      met = actual !== rule.value;
      break;
    case "less_than":
      met = actual < rule.value;
      break;
    case "greater_than":
      met = actual > rule.value;
      break;
    default:
      return { outcome: "inconclusive", reason: "type_mismatch" };
  }
  return { outcome: met ? "triggered" : "not_triggered", reason: null };
}

// True only when the condition is met. Kept for backward compatibility.
function ruleTriggered(rule, signals) {
  return ruleCheck(rule, signals).outcome === "triggered";
}

// --- Evaluation -------------------------------------------------------------

// ---------------------------------------------------------------------------
// Drift detection
// Port of DriftDetector in tools/evaluate.py. Bounded per-signal history,
// moving average over the configured window.
// ---------------------------------------------------------------------------

class DriftDetector {
  constructor(window, signals) {
    this.window = window;
    this.signals = signals;
    this.history = {};
    for (const s of signals) {
      this.history[s] = [];
    }
  }

  update(signal, value) {
    if (!(signal in this.history)) {
      return null;
    }
    const h = this.history[signal];
    h.push(value);
    // bounded window, matches collections.deque(maxlen=window)
    while (h.length > this.window) {
      h.shift();
    }
    if (h.length < this.window) {
      return {
        signal: signal,
        samples: h.length,
        window: this.window,
        drift_detected: false,
        reason: "insufficient samples",
      };
    }
    const avg = h.reduce((a, b) => a + b, 0) / h.length;
    return {
      signal: signal,
      moving_average: round4(avg),
      window: this.window,
      drift_detected: false,
    };
  }
}

// Python's round() uses banker's rounding (round-half-to-even).
// Match it so moving averages are identical across evaluators.
function round4(x) {
  const scaled = x * 10000;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let n;
  if (Math.abs(diff - 0.5) < Number.EPSILON) {
    n = floor % 2 === 0 ? floor : floor + 1; // ties to even
  } else {
    n = Math.round(scaled);
  }
  return n / 10000;
}

function evaluate(profile, signals, driftDetector) {
  const result = {
    trp_id: profile.trpId,
    trp_version: profile.version,
  };

  // 1. Hard rules
  const triggeredRules = [];
  const inconclusiveRules = [];
  for (const rule of profile.hardRules) {
    const { outcome, reason } = ruleCheck(rule, signals);
    if (outcome === "triggered") {
      triggeredRules.push({
        rule: rule.rule,
        action: rule.action,
        field: rule.fieldName,
        condition: rule.condition,
      });
    } else if (outcome === "inconclusive") {
      inconclusiveRules.push({
        rule: rule.rule,
        field: rule.fieldName,
        condition: rule.condition,
        reason: reason,
      });
    }
  }
  result.hard_rules_triggered = triggeredRules;
  result.hard_rules_inconclusive = inconclusiveRules;
  const hardOverride = triggeredRules.length > 0;

  // 2. Scored signals
  let weightedPenalty = 0.0;
  const signalResults = [];
  const missingSignals = [];

  for (const ss of profile.scoredSignals) {
    if (!(ss.signal in signals)) {
      missingSignals.push({
        signal: ss.signal,
        on_missing: ss.onMissing,
      });
      if (ss.onMissing === "critical") {
        weightedPenalty += ss.weight;
      }
      continue;
    }

    const value = Number(signals[ss.signal]);
    const sev = signalSeverity(ss, value);
    const penalty = ss.weight * sev;
    weightedPenalty += penalty;

    const lowIsBad = ss.direction === "lower_is_unsafe";
    const inWarning = sev > 0;
    const inCritical = lowIsBad
      ? value <= ss.criticalThreshold
      : value >= ss.criticalThreshold;

    signalResults.push({
      signal: ss.signal,
      value: value,
      unit: ss.unit,
      severity: Number(sev.toFixed(4)),
      penalty: Number(penalty.toFixed(4)),
      in_warning: inWarning,
      in_critical: inCritical,
    });

    // Update drift detector
    if (driftDetector && driftDetector.signals.includes(ss.signal)) {
      driftDetector.update(ss.signal, value);
    }
  }

  result.signal_results = signalResults;
  result.missing_signals = missingSignals;

  // 4. Standing band assignment
  const sortedBands = [...profile.standingBands].sort(
    (a, b) => a.severity - b.severity
  );
  let assignedBand = sortedBands.length > 0
    ? sortedBands[sortedBands.length - 1].band
    : "unknown";

  if (hardOverride) {
    assignedBand = sortedBands.length > 0
      ? sortedBands[sortedBands.length - 1].band
      : "failing";
  } else {
    const anyCritical = signalResults.some((s) => s.in_critical);
    const anyWarning = signalResults.some((s) => s.in_warning);
    const hasIncomplete = missingSignals.some(
      (m) => m.on_missing === "incomplete"
    ) || inconclusiveRules.length > 0;

    if (anyCritical || hasIncomplete) {
      assignedBand = sortedBands.length > 0
        ? sortedBands[sortedBands.length - 1].band
        : "failing";
    } else if (anyWarning) {
      const mid = Math.floor(sortedBands.length / 2);
      assignedBand = sortedBands.length > 0
        ? sortedBands[mid].band
        : "review";
    } else {
      assignedBand = sortedBands.length > 0
        ? sortedBands[0].band
        : "good";
    }
  }

  result.standing = assignedBand;
  result.hard_override = hardOverride;
  result.response = profile.responseBands[assignedBand] || "unknown";

  // 6. Evaluation metadata (provenance and tamper detection)
  // 5. Drift evidence
  if (driftDetector) {
    const drift = {};
    for (const sName of driftDetector.signals) {
      const h = driftDetector.history[sName];
      drift[sName] = {
        moving_average: h.length ? round4(h.reduce((a, b) => a + b, 0) / h.length) : null,
        samples: h.length,
        window: driftDetector.window,
      };
    }
    result.drift = drift;
  }

  const resultPayload = JSON.stringify(result, Object.keys(result).sort());
  result.evaluation = {
    profile_id: profile.trpId,
    profile_version: profile.version,
    spec_version: profile.specVersion,
    evaluator: "trp-reference-nodejs",
    evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    result_hash: crypto.createHash("sha256").update(resultPayload).digest("hex"),
  };

  return result;
}

// --- Sample generation ------------------------------------------------------

function generateSample(profile) {
  const sample = {};

  for (const ss of profile.scoredSignals) {
    const lowIsBad = ss.direction === "lower_is_unsafe";
    if (lowIsBad) {
      sample[ss.signal] = Number((ss.warningThreshold * 1.2).toFixed(4));
    } else {
      sample[ss.signal] = Number((ss.warningThreshold * 0.8).toFixed(4));
    }
  }

  // Give every hard rule field a safe value of the right type, so a
  // generated sample never leaves a rule inconclusive.
  // A field that is also a scored signal keeps its safe signal value when
  // that value already leaves the rule unmet.
  for (const rule of profile.hardRules) {
    if (Object.prototype.hasOwnProperty.call(sample, rule.fieldName) &&
        ruleCheck(rule, sample).outcome === "not_triggered") {
      continue;
    }
    sample[rule.fieldName] = safeRuleValue(rule);
  }

  return sample;
}

// A value of the expected type that does not meet the rule's condition.
function safeRuleValue(rule) {
  if (rule.condition === "is_true") return false;
  if (rule.condition === "is_false") return true;
  if (rule.condition === "less_than" || rule.condition === "greater_than" ||
      rule.condition === "not_equals") {
    // The boundary value itself never triggers these conditions.
    return rule.value;
  }
  if (rule.condition === "equals") {
    const kind = valueType(rule.value);
    if (kind === "boolean") return !rule.value;
    if (kind === "number") return rule.value + 1;
    if (kind === "string") return rule.value !== "__safe__" ? "__safe__" : "__safe_value__";
  }
  return null;
}

// --- CLI --------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage:\n" +
      "  node evaluate.js <profile.json> <evidence.json>\n" +
      "  node evaluate.js --generate-sample <profile.json>"
    );
    process.exit(1);
  }

  const generateMode = args.includes("--generate-sample");
  const filePaths = args.filter((a) => !a.startsWith("--"));

  if (filePaths.length === 0) {
    console.error("Error: provide a profile path.");
    process.exit(1);
  }

  let profile;
  try {
    profile = loadProfile(filePaths[0]);
  } catch (err) {
    if (err instanceof UnsupportedProfileError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (generateMode) {
    console.log(JSON.stringify(generateSample(profile), null, 2));
    return;
  }

  if (filePaths.length < 2) {
    console.error("Error: provide a profile and an evidence file, or use --generate-sample.");
    process.exit(1);
  }

  const signals = JSON.parse(fs.readFileSync(filePaths[1], "utf-8"));
  let driftDetector = null;
  if (profile.driftWindow > 0) {
    driftDetector = new DriftDetector(profile.driftWindow, profile.driftSignals);
  }

  const result = evaluate(profile, signals, driftDetector);
  console.log(JSON.stringify(result, null, 2));
}

main();
