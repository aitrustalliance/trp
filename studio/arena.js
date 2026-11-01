/**
 * TRP Studio Arena and stress test.
 *
 * Both compare what a profile sees with what really happened. Each pack's
 * arena section defines a ground truth of harm (conditions on the simulator's
 * true values, which the profile never reads directly), the Challenger's
 * moves, and the guards a Guardian can buy. A guard changes the profile or
 * shields signals from tampering, so every guard is plain TRP content.
 *
 * Scoring works on incidents. An incident is a stretch of time when harm is
 * present. It counts as caught when the system is stopped within the reaction
 * window after the harm starts. A false halt is a stretch when the system is
 * stopped and no harm is present.
 */
(function (root) {
  "use strict";

  const STOP_ACTIONS = ["halt", "block_startup", "require_review"];
  const REACTION_S = 0.75;

  function test(cond, values) {
    const v = values[cond.signal];
    switch (cond.op) {
      case "lt": return typeof v === "number" && v < cond.value;
      case "gt": return typeof v === "number" && v > cond.value;
      case "eq": return v === cond.value;
      case "ne": return v !== cond.value;
      default: return false;
    }
  }

  // Ids of harms present in the true values.
  function harmsActive(arena, values) {
    const out = [];
    for (const h of arena.harm || []) {
      if ((h.all || []).every((c) => test(c, values))) out.push(h.id);
    }
    return out;
  }

  // True when a harm is present or about to be. A stop during a near miss
  // counts as prevention, never as a false halt.
  function nearHarm(arena, values) {
    for (const h of arena.harm || []) {
      const conds = h.near || h.all || [];
      if (conds.every((c) => test(c, values))) return true;
    }
    return false;
  }

  function isStopped(result) {
    if (!result) return false;
    if (result.response === "suspended") return true;
    return result.hard_rules_triggered.some((t) => STOP_ACTIONS.includes(t.action));
  }

  // Apply purchased guards to a copy of the profile. Returns the new profile
  // document and the set of signals shielded from the Challenger's tampering.
  function applyGuards(profileRaw, arena, guardIds) {
    const doc = JSON.parse(JSON.stringify(profileRaw));
    const shielded = new Set();
    for (const id of guardIds) {
      const g = (arena.guards || []).find((x) => x.id === id);
      if (!g) continue;
      if (g.type === "shield") for (const s of g.signals) shielded.add(s);
      if (g.type === "tighten") {
        const s = (doc.scored_signals || []).find((x) => x.signal === g.signal);
        if (s) {
          if ("warning" in g) s.warning_threshold = g.warning;
          if ("critical" in g) s.critical_threshold = g.critical;
        }
      }
      if (g.type === "rule") {
        doc.hard_rules = doc.hard_rules || [];
        doc.hard_rules.push(JSON.parse(JSON.stringify(g.rule)));
      }
      if (g.type === "rule_value") {
        const r = (doc.hard_rules || []).find((x) => x.rule === g.rule);
        if (r) r.value = g.value;
      }
    }
    return { profileRaw: doc, shielded: shielded };
  }

  // Incident bookkeeping shared by matches and stress runs.
  class Tally {
    constructor() {
      this.ticks = 0;
      this.stoppedTicks = 0;
      this.incidents = [];
      this.falseHalts = 0;
      this.open = null;
      this.haltOpen = false;
      this.haltHadHarm = false;
    }
    update(t, harms, stopped, label, near) {
      this.ticks += 1;
      if (stopped) this.stoppedTicks += 1;
      const harm = harms.length > 0;
      if (harm && !this.open) {
        this.open = { start: t, label: label || "", harms: harms.slice(), caughtAt: stopped ? t : null };
      } else if (harm && this.open) {
        if (stopped && this.open.caughtAt === null) this.open.caughtAt = t;
        for (const h of harms) if (!this.open.harms.includes(h)) this.open.harms.push(h);
      } else if (!harm && this.open) {
        this.close(t);
      }
      const justified = harm || !!near;
      if (stopped && !this.haltOpen) { this.haltOpen = true; this.haltHadHarm = justified; }
      else if (stopped && justified) this.haltHadHarm = true;
      else if (!stopped && this.haltOpen) {
        if (!this.haltHadHarm) this.falseHalts += 1;
        this.haltOpen = false;
      }
    }
    close(t) {
      const o = this.open;
      if (!o) return;
      o.end = t;
      o.caught = o.caughtAt !== null && o.caughtAt - o.start <= REACTION_S + 1e-9;
      o.reaction = o.caughtAt === null ? null : o.caughtAt - o.start;
      this.incidents.push(o);
      this.open = null;
    }
    finish(t) {
      this.close(t);
      if (this.haltOpen && !this.haltHadHarm) this.falseHalts += 1;
      this.haltOpen = false;
    }
    summary() {
      const caught = this.incidents.filter((i) => i.caught).length;
      const total = this.incidents.length;
      const safety = total ? caught / total : 1;
      const uptime = this.ticks ? 1 - this.stoppedTicks / this.ticks : 1;
      const reactions = this.incidents.filter((i) => i.caught).map((i) => i.reaction);
      return {
        incidents: total, caught: caught, missed: total - caught, falseHalts: this.falseHalts,
        safety: safety, uptime: uptime,
        score: Math.round(100 * (0.65 * safety + 0.35 * uptime) - this.falseHalts * 2),
        meanReaction: reactions.length ? reactions.reduce((a, b) => a + b, 0) / reactions.length : null,
      };
    }
  }

  // Small seeded generator so a day's match is the same for everyone.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function daySeed(date) {
    const d = date || new Date();
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  function dayNumber(date) {
    const start = Date.UTC(2026, 10, 1);
    const d = date || new Date();
    return Math.max(1, Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000) + 1);
  }

  // The Challenger favors moves no purchased guard counters, and avoids
  // repeating itself.
  function challengerPlan(arena, guardIds, seed) {
    const random = rng(seed);
    const owned = new Set(guardIds);
    const countered = new Set();
    for (const g of arena.guards || []) if (owned.has(g.id)) for (const m of g.counters || []) countered.add(m);
    const plan = [];
    let last = null;
    for (let r = 0; r < (arena.rounds || 8); r++) {
      const ranked = (arena.moves || []).map((m) => ({
        m: m, w: (countered.has(m.id) ? 0.25 : 1) * (m.weight || 1) * (0.6 + random() * 0.8) * (m.id === last ? 0.2 : 1),
      })).sort((a, b) => b.w - a.w);
      const pick = ranked.length ? ranked[0].m : null;
      plan.push(pick);
      last = pick && pick.id;
    }
    return plan;
  }

  // A move injects its effects into the simulator until it is cleared.
  function applyMove(sim, pack, move) {
    sim.extraEffects = move ? Object.assign({}, sim.extraEffects || {}, move.effects || {}) : sim.extraEffects;
  }

  function clearMove(sim, pack, move) {
    if (!move || !sim.extraEffects) return;
    for (const name of Object.keys(move.effects || {})) delete sim.extraEffects[name];
  }

  // A live match. The app steps it with real time and reads its state.
  class Match {
    constructor(pack, profileRaw, guardIds, opts, deps) {
      const o = opts || {};
      this.deps = deps;
      this.pack = pack;
      this.arena = pack.arena;
      this.guards = guardIds.slice();
      const applied = applyGuards(profileRaw, this.arena, guardIds);
      this.profileRaw = applied.profileRaw;
      this.profile = deps.engine.loadProfile(applied.profileRaw);
      this.sim = new deps.sim.Simulator(pack);
      this.sim.shielded = applied.shielded;
      this.seed = o.seed || daySeed();
      this.plan = challengerPlan(this.arena, guardIds, this.seed);
      this.roundS = this.arena.round_s || 6;
      this.rounds = this.plan.length;
      this.round = -1;
      this.tally = new Tally();
      this.result = null;
      this.harms = [];
      this.done = false;
      this.acc = 0;
      this.moveAt = 0;
      this.nextRound();
    }
    nextRound() {
      if (this.round >= 0) clearMove(this.sim, this.pack, this.plan[this.round]);
      this.round += 1;
      if (this.round >= this.rounds) { this.finish(); return; }
      this.moveAt = this.round * this.roundS + (this.arena.lead_s == null ? 1.2 : this.arena.lead_s);
      this.moveApplied = false;
    }
    get move() { return this.plan[this.round] || null; }
    step(dt) {
      if (this.done) return;
      this.sim.step(dt);
      if (!this.moveApplied && this.sim.time >= this.moveAt) { applyMove(this.sim, this.pack, this.move); this.moveApplied = true; }
      const tickS = (this.pack.tick_ms || 250) / 1000;
      this.acc += dt;
      while (this.acc >= tickS) {
        this.acc -= tickS;
        this.result = this.deps.engine.evaluate(this.profile, this.sim.evidence(), null);
        this.harms = harmsActive(this.arena, this.sim.values);
        this.tally.update(this.sim.time, this.harms, isStopped(this.result), this.move && this.move.label, nearHarm(this.arena, this.sim.values));
      }
      if (this.sim.time >= (this.round + 1) * this.roundS) this.nextRound();
    }
    finish() {
      this.tally.finish(this.sim.time);
      this.done = true;
      this.summary = this.tally.summary();
    }
  }

  // Run many short episodes with random Challenger moves, as fast as possible.
  function stressTest(pack, profileRaw, opts, deps) {
    const o = opts || {};
    const episodes = o.episodes || 300;
    const random = rng(o.seed || 7);
    const arena = pack.arena;
    const profile = deps.engine.loadProfile(profileRaw);
    const tickS = (pack.tick_ms || 250) / 1000;
    const length = o.episode_s || 10;
    const byMove = {};
    const overall = new Tally();
    let evaluations = 0;
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();
    for (let e = 0; e < episodes; e++) {
      const sim = new deps.sim.Simulator(pack);
      sim.random = rng(o.seed ? o.seed + e : e + 1);
      const faults = random() < 0.15 ? [] : [arena.moves[Math.floor(random() * arena.moves.length)]];
      if (faults.length && random() < 0.3) faults.push(arena.moves[Math.floor(random() * arena.moves.length)]);
      const starts = faults.map(() => 1 + random() * (length * 0.5));
      const ends = starts.map((s) => s + 2 + random() * 3);
      const label = faults.map((f) => f.label).join(" + ") || "No fault";
      const tally = new Tally();
      for (let t = 0; t < length; t += tickS) {
        faults.forEach((f, i) => {
          if (t >= starts[i] && t < ends[i]) applyMove(sim, pack, f);
          else clearMove(sim, pack, f);
        });
        sim.step(tickS);
        const r = deps.engine.evaluate(profile, sim.evidence(), null);
        evaluations += 1;
        const harms = harmsActive(arena, sim.values);
        const stopped = isStopped(r);
        const near = nearHarm(arena, sim.values);
        tally.update(sim.time, harms, stopped, label, near);
        overall.update(e * length + sim.time, harms, stopped, label, near);
      }
      tally.finish(length);
      overall.close(e * length + length);
      const s = tally.summary();
      const row = byMove[label] || (byMove[label] = { label: label, runs: 0, incidents: 0, caught: 0, falseHalts: 0, reactions: [] });
      row.runs += 1;
      row.incidents += s.incidents;
      row.caught += s.caught;
      row.falseHalts += s.falseHalts;
      for (const i of tally.incidents) if (i.caught) row.reactions.push(i.reaction);
    }
    overall.finish(episodes * length);
    const ms = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    const rows = Object.values(byMove).sort((a, b) => b.runs - a.runs).map((r) => Object.assign(r, {
      meanReaction: r.reactions.length ? r.reactions.reduce((a, b) => a + b, 0) / r.reactions.length : null,
    }));
    return { episodes: episodes, evaluations: evaluations, ms: ms, overall: overall.summary(), rows: rows };
  }

  // Best score any affordable set of guards reaches on this seed.
  function par(pack, profileRaw, seed, deps) {
    const arena = pack.arena;
    const guards = arena.guards || [];
    let best = { score: -Infinity, guards: [] };
    for (let mask = 0; mask < (1 << guards.length); mask++) {
      const chosen = guards.filter((_, i) => mask & (1 << i));
      const cost = chosen.reduce((s, g) => s + g.cost, 0);
      if (cost > (arena.budget || 0)) continue;
      const m = new Match(pack, profileRaw, chosen.map((g) => g.id), { seed: seed }, deps);
      while (!m.done) m.step(0.05);
      if (m.summary.score > best.score) best = { score: m.summary.score, guards: chosen.map((g) => g.id) };
    }
    return best;
  }

  function medal(score, parScore) {
    if (score >= parScore - 2) return "gold";
    if (score >= parScore - 12) return "silver";
    if (score >= parScore - 25) return "bronze";
    return null;
  }

  const api = { par, medal, nearHarm, harmsActive, isStopped, applyGuards, Tally, Match, stressTest, challengerPlan, daySeed, dayNumber, rng };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPArena = api;
})(typeof window !== "undefined" ? window : globalThis);
