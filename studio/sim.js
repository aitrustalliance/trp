/**
 * TRP Studio simulator.
 *
 * Turns a scenario pack into a live stream of evidence. Each signal starts at
 * its base value, moves smoothly toward the target set by the viewer's
 * controls, and carries a small amount of noise from a seeded generator so a
 * replay looks the same every time. Toggles can set a value, ramp it, or omit
 * it from the evidence to show how a TRP treats missing data.
 *
 * Signals can also be stochastic. Three optional fields on a signal spec:
 *   process  { type: "ou", theta, sigma }  Ornstein-Uhlenbeck deviation that
 *            wanders around the level and reverts at rate theta (1/s) with
 *            volatility sigma (units per square-root second).
 *   shocks   { rate, size, spread, decay_s }  Poisson arrivals at `rate` per
 *            second. Each adds a deviation of `size` plus Gaussian `spread`
 *            that decays with time constant `decay_s`. An effect may carry
 *            `shock_rate` to multiply the rate while it is active.
 *   derive   { from, scale, offset }  The level follows offset + scale times
 *            the current value of another signal, unless an effect sets it.
 *   wave     { amplitude, period_s, phase }  A periodic component, such as
 *            breathing or a heartbeat. It draws no random numbers.
 * Packs without these fields draw the same random sequence as before.
 */
(function (root) {
  "use strict";

  // Small seeded generator (mulberry32) so runs are reproducible.
  function makeRandom(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function roundTo(value, decimals) {
    const f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
  }

  class Simulator {
    constructor(pack) {
      this.pack = pack;
      this.random = makeRandom(20261031);
      this.values = {};
      this.controlState = {};
      this.time = 0;
      this.shielded = null;
      this.extraEffects = null;
      this.level = {};
      this.ou = {};
      this.shock = {};
      this.shocksSeen = 0;
      for (const [name, spec] of Object.entries(pack.signals)) {
        this.values[name] = spec.base;
        this.level[name] = spec.base;
        if (spec.process || spec.shocks || spec.wave) { this.ou[name] = 0; this.shock[name] = 0; }
      }
      for (const c of pack.controls) {
        this.controlState[c.id] = c.type === "slider" ? pack.signals[c.signal].base : false;
      }
    }

    setControl(id, value) {
      if (id in this.controlState) this.controlState[id] = value;
    }

    // Targets, ramps and omissions implied by the current controls.
    plan() {
      const targets = {};
      const ramps = {};
      const omitted = new Set();
      const shockRate = {};
      const fixed = new Set();
      for (const [name, spec] of Object.entries(this.pack.signals)) {
        targets[name] = spec.base;
        ramps[name] = 0.8;
      }
      for (const c of this.pack.controls) {
        const state = this.controlState[c.id];
        if (c.type === "slider") {
          targets[c.signal] = state;
          ramps[c.signal] = c.ramp_s || 1.2;
          fixed.add(c.signal);
        } else if (state) {
          for (const [name, effect] of Object.entries(c.effects || {})) {
            if (effect.omit) omitted.add(name);
            if ("set" in effect) { targets[name] = effect.set; ramps[name] = 0; fixed.add(name); }
            if ("to" in effect) { targets[name] = effect.to; ramps[name] = effect.ramp_s || 1; fixed.add(name); }
            if (typeof effect.shock_rate === "number") shockRate[name] = (shockRate[name] || 1) * effect.shock_rate;
          }
        }
      }
      // Effects injected by an Arena move or a stress run.
      for (const [name, effect] of Object.entries(this.extraEffects || {})) {
        const shielded = this.shielded && this.shielded.has(name);
        if (effect.omit && !shielded) omitted.add(name);
        if (shielded && effect.fault) continue;
        if ("set" in effect) { targets[name] = effect.set; ramps[name] = 0; fixed.add(name); }
        if ("to" in effect) { targets[name] = effect.to; ramps[name] = effect.ramp_s || 1; fixed.add(name); }
        if (typeof effect.shock_rate === "number") shockRate[name] = (shockRate[name] || 1) * effect.shock_rate;
      }
      // Coupled signals follow their source unless something set them.
      for (const [name, spec] of Object.entries(this.pack.signals)) {
        const d = spec.derive;
        if (!d || fixed.has(name) || typeof this.values[d.from] !== "number") continue;
        targets[name] = (d.offset || 0) + (d.scale || 1) * this.values[d.from];
        ramps[name] = d.ramp_s || 0.6;
      }
      return { targets, ramps, omitted, shockRate };
    }

    gauss() {
      const u = Math.max(1e-12, this.random()), v = this.random();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    step(dt) {
      this.time += dt;
      const { targets, ramps, shockRate } = this.plan();
      for (const [name, spec] of Object.entries(this.pack.signals)) {
        const target = targets[name];
        if (typeof target !== "number") { this.values[name] = target; this.level[name] = target; continue; }
        const ramp = ramps[name];
        const stochastic = name in this.ou;
        const current = stochastic ? (typeof this.level[name] === "number" ? this.level[name] : spec.base) : (typeof this.values[name] === "number" ? this.values[name] : spec.base);
        const k = ramp <= 0 ? 1 : 1 - Math.exp(-dt / (ramp / 3));
        let next = current + (target - current) * k;
        const jitter = spec.jitter || 0;
        if (jitter) next += (this.random() + this.random() - 1) * jitter;
        if (stochastic) {
          this.level[name] = next;
          const p = spec.process;
          if (p && dt > 0) this.ou[name] += -(p.theta || 1) * this.ou[name] * dt + (p.sigma || 0) * Math.sqrt(dt) * this.gauss();
          const sh = spec.shocks;
          if (sh && dt > 0) {
            this.shock[name] *= Math.exp(-dt / (sh.decay_s || 0.5));
            const rate = (sh.rate || 0) * (shockRate[name] || 1);
            if (this.random() < 1 - Math.exp(-rate * dt)) { this.shock[name] += (sh.size || 0) + (sh.spread || 0) * this.gauss(); this.shocksSeen += 1; }
          }
          const wv = spec.wave;
          const wave = wv ? (wv.amplitude || 0) * Math.sin((2 * Math.PI * this.time) / (wv.period_s || 4) + (wv.phase || 0)) : 0;
          next = next + (this.ou[name] || 0) + (this.shock[name] || 0) + wave;
        }
        if (typeof spec.min === "number") next = Math.max(spec.min, next);
        if (typeof spec.max === "number") next = Math.min(spec.max, next);
        this.values[name] = next;
      }
    }

    // Evidence as an evaluator would receive it.
    evidence() {
      const { omitted } = this.plan();
      const out = {};
      for (const [name, spec] of Object.entries(this.pack.signals)) {
        if (omitted.has(name)) continue;
        const v = this.values[name];
        out[name] = typeof v === "number" ? roundTo(v, spec.decimals == null ? 2 : spec.decimals) : v;
      }
      return out;
    }

    omitted() {
      return this.plan().omitted;
    }

    position() {
      const cycle = this.pack.cycle_s || 4;
      const tick = (this.pack.tick_ms || 250) / 1000;
      return {
        episode_index: Math.floor(this.time / cycle),
        frame_index: Math.floor((this.time % cycle) / tick),
      };
    }
  }

  // Build a playable pack from any TRP profile, so a dropped-in profile
  // becomes a live demo with one control per requirement.
  function autoPack(profileRaw, engine) {
    const profile = engine.loadProfile(profileRaw);
    const signals = {};
    const controls = [];
    const scored = new Set();
    for (const s of profile.scoredSignals) {
      scored.add(s.signal);
      const low = s.direction === "lower_is_unsafe";
      const w = s.warningThreshold;
      const c = s.criticalThreshold;
      const span = Math.abs(c - w) || Math.abs(w) || 1;
      const base = low ? w + span * 0.6 : w - span * 0.6;
      const min = low ? c - span * 0.6 : Math.min(0, base - span);
      const max = low ? Math.max(base + span, w + span) : c + span * 0.6;
      const decimals = span < 0.1 ? 3 : span < 1 ? 2 : span < 10 ? 1 : 0;
      signals[s.signal] = {
        base: base, jitter: span * 0.02, min: Math.min(min, base), max: Math.max(max, base),
        decimals: decimals, label: humanize(s.signal),
      };
      controls.push({
        id: "s-" + s.signal, label: humanize(s.signal), type: "slider", signal: s.signal,
        min: signals[s.signal].min, max: signals[s.signal].max, step: Math.pow(10, -decimals),
      });
    }
    for (const r of profile.hardRules) {
      if (scored.has(r.fieldName)) continue;
      const safe = engine.safeRuleValue(r);
      signals[r.fieldName] = { base: safe, label: humanize(r.fieldName) };
      controls.push({
        id: "r-" + r.rule, label: humanize(r.rule), type: "toggle",
        effects: { [r.fieldName]: { set: triggerValue(r) } },
      });
    }
    return {
      pack_version: "1",
      id: "custom-" + profile.trpId,
      title: profile.name,
      subtitle: profileRaw.description || "A live demo built from this profile.",
      scene: "instrument",
      profileObject: profileRaw,
      tick_ms: 250,
      cycle_s: 4,
      signals: signals,
      controls: controls,
      story: [],
    };
  }

  function triggerValue(rule) {
    switch (rule.condition) {
      case "is_true": return true;
      case "is_false": return false;
      case "equals": return rule.value;
      case "not_equals": return typeof rule.value === "string" ? rule.value + "_other" : !rule.value;
      case "less_than": return rule.value - Math.max(Math.abs(rule.value) * 0.2, 0.01);
      case "greater_than": return rule.value + Math.max(Math.abs(rule.value) * 0.2, 0.01);
      default: return null;
    }
  }

  function humanize(name) {
    const units = { m: "", mm: "", s: "", c: "", g: "", usd: "", min: "", per: "per" };
    const words = String(name).split("_").filter((w) => !(w.toLowerCase() in units) || w === "per");
    const text = words.join(" ");
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  const api = { Simulator, autoPack, humanize, makeRandom };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPSim = api;
})(typeof window !== "undefined" ? window : globalThis);
