/**
 * Checks for anything the Studio did not ship with: imported profiles and
 * packs, ?profile= links and replay links. Everything from outside is treated
 * as untrusted. These checks reject files that are too large, too deep or of
 * the wrong shape before any of it reaches the page.
 */
(function (root) {
  "use strict";

  const LIMITS = {
    bytes: 1024 * 1024,
    text: 400,
    signals: 64,
    rules: 64,
    controls: 48,
    story: 200,
    moves: 32,
    guards: 24,
    replaySteps: 2000,
    replaySeconds: 3600,
  };
  const SCENES = ["robot-cell", "machine-line", "data-flow", "agent-trace", "instrument", "fleet", "humanoid-floor"];

  const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

  class ImportError extends Error {}

  // Names become object keys in the simulator, so the three names that reach
  // an object's prototype are refused everywhere.
  function name(v, where) {
    str(v, where);
    if (RESERVED.has(v)) fail(`${where} may not be "${v}".`);
  }
  function keys(obj, where) {
    for (const k of Object.keys(obj)) if (RESERVED.has(k)) fail(`${where} may not use the name "${k}".`);
  }

  function fail(msg) { throw new ImportError(msg); }
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function str(v, where, optional) {
    if (v === undefined && optional) return;
    if (typeof v !== "string") fail(`${where} must be text.`);
    if (v.length > LIMITS.text) fail(`${where} is too long.`);
  }
  function num(v, where, optional) {
    if (v === undefined && optional) return;
    if (!isNum(v)) fail(`${where} must be a number.`);
  }
  function list(v, where, max, optional) {
    if (v === undefined && optional) return [];
    if (!Array.isArray(v)) fail(`${where} must be a list.`);
    if (v.length > max) fail(`${where} has more than ${max} entries.`);
    return v;
  }
  function scalar(v, where) {
    if (v === null || typeof v === "boolean" || isNum(v)) return;
    if (typeof v === "string") { str(v, where); return; }
    fail(`${where} must be a number, text, true, false or null.`);
  }

  // Parse JSON text with a size limit.
  function parse(text) {
    if (typeof text !== "string") fail("That file could not be read.");
    if (text.length > LIMITS.bytes) fail("That file is larger than 1 MB.");
    try { return JSON.parse(text); } catch (err) { fail("That file is not valid JSON."); }
  }

  function checkProfile(p) {
    if (!isObj(p)) fail("A profile must be a JSON object.");
    str(p.trp_id, "trp_id");
    str(p.name, "name", true);
    str(p.version, "version", true);
    str(p.description, "description", true);
    for (const [i, s] of list(p.scored_signals, "scored_signals", LIMITS.signals).entries()) {
      if (!isObj(s)) fail(`Signal ${i + 1} must be an object.`);
      name(s.signal, `Signal ${i + 1} name`);
      num(s.weight, `${s.signal} weight`);
      num(s.warning_threshold, `${s.signal} warning_threshold`);
      num(s.critical_threshold, `${s.signal} critical_threshold`);
      if (!["higher_is_unsafe", "lower_is_unsafe"].includes(s.direction)) fail(`${s.signal} direction is not recognized.`);
      str(s.unit, `${s.signal} unit`, true);
      str(s.reason, `${s.signal} reason`, true);
      str(s.on_missing, `${s.signal} on_missing`, true);
    }
    for (const [i, r] of list(p.hard_rules, "hard_rules", LIMITS.rules, true).entries()) {
      if (!isObj(r)) fail(`Hard rule ${i + 1} must be an object.`);
      name(r.rule, `Hard rule ${i + 1} name`);
      name(r.field, `${r.rule} field`);
      str(r.condition, `${r.rule} condition`);
      str(r.action, `${r.rule} action`);
      if ("value" in r) scalar(r.value, `${r.rule} value`);
    }
    for (const [i, b] of list(p.standing_bands, "standing_bands", 16).entries()) {
      if (!isObj(b)) fail(`Standing band ${i + 1} must be an object.`);
      str(b.band, `Standing band ${i + 1}`);
      num(b.severity, `${b.band} severity`);
    }
    return p;
  }

  function checkPack(pk) {
    if (!isObj(pk)) fail("A pack must be a JSON object.");
    str(pk.id, "Pack id");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(pk.id)) fail("Pack id may only use letters, numbers and dashes.");
    str(pk.title, "Pack title");
    str(pk.subtitle, "Pack subtitle", true);
    if (pk.scene !== undefined && !SCENES.includes(pk.scene)) fail("Pack scene is not one the Studio knows.");
    num(pk.tick_ms, "tick_ms", true);
    if (pk.tick_ms !== undefined && (pk.tick_ms < 50 || pk.tick_ms > 5000)) fail("tick_ms must be between 50 and 5000.");
    num(pk.cycle_s, "cycle_s", true);
    if (!isObj(pk.signals)) fail("Pack signals must be an object.");
    keys(pk.signals, "Pack signals");
    const names = Object.keys(pk.signals);
    if (names.length > LIMITS.signals) fail(`Pack has more than ${LIMITS.signals} signals.`);
    for (const name of names) {
      const s = pk.signals[name];
      if (!isObj(s)) fail(`Signal ${name} must be an object.`);
      scalar(s.base, `${name} base`);
      for (const k of ["jitter", "min", "max", "decimals"]) num(s[k], `${name} ${k}`, true);
      str(s.label, `${name} label`, true);
      // Stochastic fields are numbers inside small bounds, so an imported pack
      // cannot stall the page with a runaway process.
      if (s.process !== undefined) {
        if (!isObj(s.process) || s.process.type !== "ou") fail(`${name} process must be { "type": "ou", ... }.`);
        num(s.process.theta, `${name} theta`, true); num(s.process.sigma, `${name} sigma`, true);
        if ((s.process.theta || 0) < 0 || (s.process.theta || 0) > 50 || (s.process.sigma || 0) < 0) fail(`${name} process is out of range.`);
      }
      if (s.shocks !== undefined) {
        if (!isObj(s.shocks)) fail(`${name} shocks must be an object.`);
        for (const k of ["rate", "size", "spread", "decay_s"]) num(s.shocks[k], `${name} shocks ${k}`, true);
        if ((s.shocks.rate || 0) < 0 || (s.shocks.rate || 0) > 20 || (s.shocks.decay_s !== undefined && s.shocks.decay_s <= 0)) fail(`${name} shocks are out of range.`);
      }
      if (s.derive !== undefined) {
        if (!isObj(s.derive)) fail(`${name} derive must be an object.`);
        const from = s.derive.from;
        if (typeof from !== "string" || RESERVED.has(from) || !Object.prototype.hasOwnProperty.call(pk.signals, from) || from === name) fail(`${name} derives from an unknown signal.`);
        for (const k of ["scale", "offset", "ramp_s"]) num(s.derive[k], `${name} derive ${k}`, true);
      }
    }
    if (pk.command !== undefined) {
      const c = pk.command;
      if (!isObj(c)) fail("command must be an object.");
      str(c.group, "command group", true); str(c.unit, "command unit", true);
      num(c.count, "command count"); num(c.fault_rate, "command fault_rate", true); num(c.benign_rate, "command benign_rate", true);
      if (c.count < 1 || c.count > 64 || !Number.isInteger(c.count)) fail("command count must be a whole number from 1 to 64.");
      if ((c.fault_rate || 0) < 0 || (c.fault_rate || 0) > 1 || (c.benign_rate || 0) < 0 || (c.benign_rate || 0) > 1) fail("command rates must be between 0 and 1.");
      for (const m of list(c.benign, "command benign", LIMITS.moves, true)) { if (!isObj(m)) fail("Each benign excursion must be an object."); str(m.label, "Benign label", true); if (!isObj(m.effects)) fail("Benign effects must be an object."); keys(m.effects, "Benign effects"); }
    }
    for (const c of list(pk.controls, "controls", LIMITS.controls)) {
      if (!isObj(c)) fail("Each control must be an object.");
      name(c.id, "Control id"); str(c.label, `${c.id} label`);
      if (!["slider", "toggle"].includes(c.type)) fail(`${c.id} type must be slider or toggle.`);
      for (const k of ["min", "max", "step", "ramp_s"]) num(c[k], `${c.id} ${k}`, true);
      if (c.effects !== undefined) {
        if (!isObj(c.effects)) fail(`${c.id} effects must be an object.`);
        keys(c.effects, `${c.id} effects`);
        for (const e of Object.values(c.effects)) { if (!isObj(e)) fail(`${c.id} effect must be an object.`); scalar(e.set === undefined ? null : e.set, `${c.id} effect value`); num(e.to, `${c.id} effect target`, true); }
      }
    }
    for (const s of list(pk.story, "story", LIMITS.story, true)) {
      if (!isObj(s)) fail("Each story step must be an object.");
      for (const k of ["set", "toggle"]) if (s[k] !== undefined) { if (!isObj(s[k])) fail(`Story ${k} must be an object.`); keys(s[k], `Story ${k}`); }
      num(s.at_s, "Story step time");
      str(s.caption, "Story caption", true);
    }
    if (pk.rule_labels !== undefined) {
      if (!isObj(pk.rule_labels)) fail("rule_labels must be an object.");
      keys(pk.rule_labels, "rule_labels");
      for (const v of Object.values(pk.rule_labels)) str(v, "Rule label");
    }
    if (pk.arena !== undefined) checkArena(pk.arena);
    return pk;
  }

  function checkArena(a) {
    if (!isObj(a)) fail("arena must be an object.");
    str(a.event, "Arena event", true);
    num(a.rounds, "Arena rounds"); if (a.rounds < 1 || a.rounds > 20 || !Number.isInteger(a.rounds)) fail("Arena rounds must be a whole number from 1 to 20.");
    num(a.round_s, "Arena round_s", true);
    num(a.budget, "Arena budget"); if (a.budget < 0 || a.budget > 100) fail("Arena budget must be from 0 to 100.");
    for (const m of list(a.moves, "Arena moves", LIMITS.moves)) {
      if (!isObj(m)) fail("Each move must be an object.");
      name(m.id, "Move id"); str(m.label, "Move label");
      if (m.effects !== undefined) { if (!isObj(m.effects)) fail("Move effects must be an object."); keys(m.effects, "Move effects"); }
    }
    for (const h of list(a.harm, "Arena harm", LIMITS.moves, true)) { if (!isObj(h)) fail("Each harm must be an object."); name(h.id, "Harm id"); str(h.label, "Harm label", true); }
    for (const g of list(a.guards, "Arena guards", LIMITS.guards)) {
      if (!isObj(g)) fail("Each guard must be an object.");
      name(g.id, "Guard id"); str(g.label, "Guard label"); str(g.detail, "Guard detail", true); num(g.cost, `${g.id} cost`);
    }
  }

  // A shared replay link. Returns a clean copy or throws.
  function checkReplay(r) {
    if (!isObj(r)) fail("That replay link could not be read.");
    if (typeof r.p !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(r.p)) fail("That replay link names an unknown pack.");
    const steps = [];
    for (const s of list(r.s, "Replay", LIMITS.replaySteps, true)) {
      if (!Array.isArray(s) || s.length !== 3) continue;
      const [t, id, v] = s;
      if (!isNum(t) || t < 0 || t > LIMITS.replaySeconds) continue;
      if (typeof id !== "string" || id.length > 64) continue;
      if (!(isNum(v) || typeof v === "boolean")) continue;
      steps.push([t, id, v]);
    }
    return { p: r.p, s: steps };
  }

  // Only https links, or links on the page's own site, may be loaded.
  function checkProfileUrl(value, base) {
    let u;
    try { u = new URL(value, base); } catch (err) { fail("That profile link is not a valid address."); }
    const sameSite = base && u.origin === new URL(base).origin;
    if (u.protocol !== "https:" && !sameSite) fail("Profile links must use https.");
    if (u.username || u.password) fail("Profile links may not carry a user name or password.");
    return u.href;
  }

  const api = { LIMITS, ImportError, parse, checkProfile, checkPack, checkReplay, checkProfileUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPSafety = api;
})(typeof window !== "undefined" ? window : globalThis);
