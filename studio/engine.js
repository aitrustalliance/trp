/**
 * TRP Studio evaluation engine.
 *
 * A browser port of the Node.js reference evaluator in tools/evaluate.js.
 * It applies the same rules from the specification: hard rules with
 * three-valued checks (Section 3.4), scored signal severity, standing band
 * assignment and the moving-average drift placeholder. tests/studio_parity.js
 * checks that it returns the same result as tools/evaluate.js for every
 * example profile and evidence sample in the repository.
 *
 * Works in the browser (window.TRPEngine) and in Node (module.exports).
 */
(function (root) {
  "use strict";

  class UnsupportedProfileError extends Error {}

  function valueType(value) {
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return Number.isFinite(value) ? "number" : "other";
    if (typeof value === "string") return "string";
    return "other";
  }

  // Normalize a raw TRP document into the evaluator's internal form.
  function loadProfile(raw) {
    if (!raw || typeof raw !== "object") {
      throw new UnsupportedProfileError("A profile must be a JSON object.");
    }
    if (Object.prototype.hasOwnProperty.call(raw, "extends")) {
      throw new UnsupportedProfileError(
        "This profile uses 'extends'. Section 7 requires rejecting it. " +
        "Resolve the inheritance into a single profile first."
      );
    }
    if (!raw.trp_id || !Array.isArray(raw.standing_bands)) {
      throw new UnsupportedProfileError(
        "This does not look like a TRP profile. It needs trp_id and standing_bands."
      );
    }
    const req = raw.required_standing || {};
    const responseBands = {};
    for (const rb of req.response_bands || []) responseBands[rb.band] = rb.response;
    const drift = raw.drift || {};
    return {
      raw: raw,
      trpId: raw.trp_id,
      specVersion: raw.spec_version || "",
      version: raw.version || "",
      name: raw.name || raw.trp_id,
      scoredSignals: (raw.scored_signals || []).map((s) => ({
        signal: s.signal,
        weight: s.weight,
        direction: s.direction,
        warningThreshold: s.warning_threshold,
        criticalThreshold: s.critical_threshold,
        unit: s.unit || "",
        reason: s.reason || "",
        onMissing: s.on_missing || "incomplete",
      })),
      hardRules: (raw.hard_rules || []).map((r) => ({
        rule: r.rule,
        fieldName: r.field,
        condition: r.condition,
        value: r.value !== undefined ? r.value : null,
        action: r.action,
      })),
      standingBands: (raw.standing_bands || []).map((b) => ({
        band: b.band,
        severity: b.severity,
        rangeDesc: b.range || "",
      })),
      minimumAcceptableBand: req.minimum_acceptable_band || "",
      driftWindow: drift.window || 0,
      driftSignals: drift.signals || [],
      responseBands: responseBands,
    };
  }

  function signalSeverity(sig, value) {
    let raw;
    if (sig.direction === "lower_is_unsafe") {
      const denom = sig.warningThreshold - sig.criticalThreshold;
      raw = denom === 0 ? (value >= sig.warningThreshold ? 0 : 1) : (sig.warningThreshold - value) / denom;
    } else {
      const denom = sig.criticalThreshold - sig.warningThreshold;
      raw = denom === 0 ? (value <= sig.warningThreshold ? 0 : 1) : (value - sig.warningThreshold) / denom;
    }
    return Math.max(0, Math.min(1, raw));
  }

  function expectedType(rule) {
    if (rule.condition === "is_true" || rule.condition === "is_false") return "boolean";
    if (rule.condition === "less_than" || rule.condition === "greater_than") return "number";
    return valueType(rule.value);
  }

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
      case "is_true": met = actual === true; break;
      case "is_false": met = actual === false; break;
      case "equals": met = actual === rule.value; break;
      case "not_equals": met = actual !== rule.value; break;
      case "less_than": met = actual < rule.value; break;
      case "greater_than": met = actual > rule.value; break;
      default: return { outcome: "inconclusive", reason: "type_mismatch" };
    }
    return { outcome: met ? "triggered" : "not_triggered", reason: null };
  }

  // Python round() ties to even. Matches the reference evaluators.
  function round4(x) {
    const scaled = x * 10000;
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    let n;
    if (Math.abs(diff - 0.5) < Number.EPSILON) n = floor % 2 === 0 ? floor : floor + 1;
    else n = Math.round(scaled);
    return n / 10000;
  }

  class DriftDetector {
    constructor(window, signals) {
      this.window = window;
      this.signals = signals;
      this.history = {};
      for (const s of signals) this.history[s] = [];
    }
    update(signal, value) {
      const h = this.history[signal];
      if (!h) return;
      h.push(value);
      while (h.length > this.window) h.shift();
    }
  }

  function evaluate(profile, signals, driftDetector) {
    const result = { trp_id: profile.trpId, trp_version: profile.version };

    const triggered = [];
    const inconclusive = [];
    for (const rule of profile.hardRules) {
      const c = ruleCheck(rule, signals);
      if (c.outcome === "triggered") {
        triggered.push({ rule: rule.rule, action: rule.action, field: rule.fieldName, condition: rule.condition });
      } else if (c.outcome === "inconclusive") {
        inconclusive.push({ rule: rule.rule, field: rule.fieldName, condition: rule.condition, reason: c.reason });
      }
    }
    result.hard_rules_triggered = triggered;
    result.hard_rules_inconclusive = inconclusive;
    const hardOverride = triggered.length > 0;

    const signalResults = [];
    const missing = [];
    for (const ss of profile.scoredSignals) {
      if (!(ss.signal in signals)) {
        missing.push({ signal: ss.signal, on_missing: ss.onMissing });
        continue;
      }
      const value = Number(signals[ss.signal]);
      const sev = signalSeverity(ss, value);
      const penalty = ss.weight * sev;
      const lowIsBad = ss.direction === "lower_is_unsafe";
      signalResults.push({
        signal: ss.signal,
        value: value,
        unit: ss.unit,
        severity: Number(sev.toFixed(4)),
        penalty: Number(penalty.toFixed(4)),
        in_warning: sev > 0,
        in_critical: lowIsBad ? value <= ss.criticalThreshold : value >= ss.criticalThreshold,
      });
      if (driftDetector && driftDetector.signals.includes(ss.signal)) driftDetector.update(ss.signal, value);
    }
    result.signal_results = signalResults;
    result.missing_signals = missing;

    const bands = [...profile.standingBands].sort((a, b) => a.severity - b.severity);
    const worst = bands.length ? bands[bands.length - 1].band : "failing";
    let band;
    if (hardOverride) {
      band = worst;
    } else {
      const anyCritical = signalResults.some((s) => s.in_critical);
      const anyWarning = signalResults.some((s) => s.in_warning);
      const incomplete = missing.some((m) => m.on_missing === "incomplete") || inconclusive.length > 0;
      if (anyCritical || incomplete) band = worst;
      else if (anyWarning) band = bands.length ? bands[Math.floor(bands.length / 2)].band : "review";
      else band = bands.length ? bands[0].band : "good";
    }
    result.standing = band;
    result.hard_override = hardOverride;
    result.response = profile.responseBands[band] || "unknown";

    if (driftDetector) {
      const drift = {};
      for (const name of driftDetector.signals) {
        const h = driftDetector.history[name];
        drift[name] = {
          moving_average: h.length ? round4(h.reduce((a, b) => a + b, 0) / h.length) : null,
          samples: h.length,
          window: driftDetector.window,
        };
      }
      result.drift = drift;
    }
    return result;
  }

  // A value of the expected type that leaves a hard rule unmet.
  function safeRuleValue(rule) {
    if (rule.condition === "is_true") return false;
    if (rule.condition === "is_false") return true;
    if (rule.condition === "less_than" || rule.condition === "greater_than" || rule.condition === "not_equals") return rule.value;
    if (rule.condition === "equals") {
      const kind = valueType(rule.value);
      if (kind === "boolean") return !rule.value;
      if (kind === "number") return rule.value + 1;
      if (kind === "string") return rule.value !== "__safe__" ? "__safe__" : "__safe_value__";
    }
    return null;
  }

  function generateSample(profile) {
    const sample = {};
    for (const ss of profile.scoredSignals) {
      sample[ss.signal] = Number((ss.warningThreshold * (ss.direction === "lower_is_unsafe" ? 1.2 : 0.8)).toFixed(4));
    }
    for (const rule of profile.hardRules) {
      if (Object.prototype.hasOwnProperty.call(sample, rule.fieldName) &&
          ruleCheck(rule, sample).outcome === "not_triggered") continue;
      sample[rule.fieldName] = safeRuleValue(rule);
    }
    return sample;
  }

  const api = {
    UnsupportedProfileError, loadProfile, evaluate, generateSample,
    signalSeverity, ruleCheck, safeRuleValue, DriftDetector, valueType,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
