/**
 * Nautilus game core.
 *
 * A deterministic simulation of one voyage. The renderer in game.js draws it
 * and feeds it input, the tests and agents drive it headless. The vessel's
 * true condition is simulated here, and the open TRP engine evaluates the
 * vessel's evidence ten times a second against examples/nautilus/trp.json.
 * The engine's response decides the engine order: full ahead, half ahead or
 * all stop.
 */
(function (root) {
  "use strict";

  const W = 1280, H = 720, WATER = 190, SUB_X = 360;
  const DEPTH_MIN = 270, DEPTH_MAX = 610;
  const DURATION = 80;

  // Difficulty changes the player's means, never the rules or the scoring.
  const DIFFICULTY = {
    easy:   { label: "Easy",   hearts: 4, steamMax: 6, steamEvery: 0.4,  spread: 220, gap: 1.3 },
    normal: { label: "Normal", hearts: 3, steamMax: 4, steamEvery: 0.55, spread: 140, gap: 1 },
    hard:   { label: "Hard",   hearts: 3, steamMax: 3, steamEvery: 0.7,  spread: 90,  gap: 0.8 },
  };
  const SCROLL = 140;            // world pixels per second at full ahead
  const LEAGUE_PX = 14;          // world pixels per league
  const CATCH_WINDOW = 0.75;     // seconds the rules have to call all stop
  const EVAL_EVERY = 0.1;
  const DAY_ZERO = Date.UTC(2026, 10, 1);

  const KINDS = {
    charge:  { label: "Depth charge", vy: 120, hp: 1, points: 30, homing: false },
    fog:     { label: "Fog canister", vy: 95, hp: 1, points: 20, homing: true },
    decoy:   { label: "Decoy buoy", vy: 85, hp: 1, points: 20, homing: true },
    ember:   { label: "Firebrand", vy: 110, hp: 1, points: 25, homing: true },
    boarder: { label: "Boarding drone", vy: 80, hp: 1, points: 25, homing: true },
    siren:   { label: "Forged command", vy: 90, hp: 1, points: 25, homing: true },
    writ:    { label: "The Writ", vy: 42, hp: 3, points: 200, homing: true },
  };

  const LABELS = {
    hull_stress: "Hull stress", reactor_temp_c: "Reactor heat", sonar_confidence: "Sonar",
    crew_goal_drift: "Crew drift", command_seal_invalid: "Forged command",
  };

  const ORDERS = { full: "Full ahead", restricted: "Half ahead", suspended: "All stop" };

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
  function voyageNumber(date) {
    const d = date || new Date();
    const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.max(1, Math.floor((today - DAY_ZERO) / 86400000) + 1);
  }

  // The Leviathan's version of your rules. Thresholds far past the point of
  // harm, missing evidence ignored and the command seal rule removed.
  function capturedProfile(raw) {
    const p = JSON.parse(JSON.stringify(raw));
    p.trp_id = raw.trp_id + "-captured";
    for (const s of p.scored_signals) {
      if (s.direction === "higher_is_unsafe") { s.warning_threshold *= 1.8; s.critical_threshold *= 2; }
      else { s.warning_threshold *= 0.3; s.critical_threshold *= 0.1; }
      if (s.on_missing) s.on_missing = "ignore";
    }
    p.hard_rules = [];
    return p;
  }

  function airshipX(t) { return 840 + 250 * Math.sin(t * 0.33) + 50 * Math.sin(t * 1.27); }

  function schedule(seed, gapScale, duration) {
    const r = rng(seed ^ 0x9e3779b9);
    const D = duration || DURATION;
    const out = [];
    let t = 2.2;
    while (t < D - 6) {
      const p = t / D;
      const weights = {
        charge: 3, fog: 2, decoy: 1.6, ember: 1.4 + p,
        boarder: p > 0.2 ? 1.6 : 0, siren: p > 0.35 ? 1.4 : 0,
      };
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      let pick = r() * total, kind = "charge";
      for (const [k, w] of Object.entries(weights)) { pick -= w; if (pick <= 0) { kind = k; break; } }
      out.push({ t: t, kind: kind, jitter: r(), fuse: r() });
      if (p > 0.45 && r() < 0.25) out.push({ t: t + 0.35, kind: "charge", jitter: r(), fuse: r() });
      const gap = (2.3 - 1.45 * p) * (gapScale || 1);
      t += gap * (0.75 + r() * 0.5);
    }
    out.push({ t: Math.round(D * 0.62), kind: "writ", jitter: 0.5, fuse: 0.5 });
    out.sort((a, b) => a.t - b.t);
    const gears = [];
    for (let g = 1.5; g < D - 3; g += 2.6 + r() * 2.4) gears.push({ t: g, y: DEPTH_MIN + 20 + r() * (DEPTH_MAX - DEPTH_MIN - 40) });
    return { drops: out, gears: gears };
  }

  class Voyage {
    constructor(opts) {
      this.engine = opts.engine;
      this.profileRaw = opts.profileRaw;
      this.profile = this.engine.loadProfile(opts.profileRaw);
      this.captured = this.engine.loadProfile(capturedProfile(opts.profileRaw));
      this.seed = opts.seed >>> 0;
      this.noise = rng(this.seed ^ 0x51ed270b);
      this.difficulty = DIFFICULTY[opts.difficulty] ? opts.difficulty : "normal";
      const diff = DIFFICULTY[this.difficulty];
      this.duration = opts.duration || DURATION;
      // A script replaces the daily schedule, for the tutorial and for tests.
      const plan = opts.script ? { drops: opts.script.drops.slice(), gears: (opts.script.gears || []).slice() } : schedule(this.seed, diff.gap, this.duration);
      this.drops = plan.drops;
      this.gearPlan = plan.gears;
      this.t = 0;
      this.done = false;
      this.outcome = null;
      this.hearts = diff.hearts;
      this.points = 0;
      this.dist = 0;
      this.combo = 0;
      this.bestCombo = 0;
      this.steam = 4;
      this.steamMax = diff.steamMax;
      this.steamClock = 0;
      this.invuln = 0;
      this.sub = { y: 380, targetY: 380, speed: 1 };
      this.truth = { hull_stress: 0.3, reactor_temp_c: 80, sonar_confidence: 0.95, crew_goal_drift: 0.04, command_seal_valid: true };
      this.hullImpulse = 0;
      this.timers = { fog: 0, decoy: 0, ember: 0, boarder: 0, siren: 0, captured: 0 };
      this.payloads = [];
      this.harpoons = [];
      this.gears = [];
      this.nextId = 1;
      this.evalClock = 0;
      this.evidence = {};
      this.result = null;
      this.response = "full";
      this.reason = "";
      this.harms = {};
      this.events = [];
      this.timeline = new Array(10).fill(0);
      this.stats = { intercepted: 0, caught: 0, hits: 0, gears: 0, stopped_s: 0 };
      this.evaluate();
    }

    emit(e) { this.events.push(Object.assign({ t: this.t }, e)); }
    drain() { const e = this.events; this.events = []; return e; }

    setDepth(y) { this.sub.targetY = Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, y)); }

    // Fire a harpoon at a payload or gear by id.
    fire(id) {
      if (this.done || this.steam < 1) return false;
      const target = this.payloads.find((p) => p.id === id) || this.gears.find((g) => g.id === id);
      if (!target) return false;
      const already = this.harpoons.filter((h) => h.target === id).length;
      if (already >= (target.hp || 1)) return false;
      this.steam -= 1;
      this.harpoons.push({ id: this.nextId++, x: SUB_X + 30, y: this.sub.y - 40, target: id, life: 1.2 });
      this.emit({ type: "fire" });
      return true;
    }

    // Fire at whatever is nearest a point, within reach.
    fireAt(x, y) {
      let best = null, bestD = 95;
      for (const o of this.payloads.concat(this.gears)) {
        const d = Math.hypot(o.x - x, o.y - y);
        if (d < bestD) { best = o; bestD = d; }
      }
      return best ? this.fire(best.id) : false;
    }

    step(dt) {
      if (this.done) return;
      this.t += dt;
      const t = this.t;
      for (const k of Object.keys(this.timers)) this.timers[k] = Math.max(0, this.timers[k] - dt);
      this.invuln = Math.max(0, this.invuln - dt);

      // Engine order follows the TRP response.
      const target = this.response === "full" ? 1 : this.response === "restricted" ? 0.5 : 0;
      this.sub.speed += (target - this.sub.speed) * (1 - Math.exp(-dt / 0.35));
      if (this.response === "suspended") this.stats.stopped_s += dt;
      const scroll = SCROLL * this.sub.speed;
      this.dist += scroll * dt;

      const dy = this.sub.targetY - this.sub.y;
      this.sub.y += Math.sign(dy) * Math.min(Math.abs(dy), 280 * dt);

      // Steam for harpoons.
      if (this.steam < this.steamMax) {
        this.steamClock += dt;
        if (this.steamClock >= DIFFICULTY[this.difficulty].steamEvery) { this.steamClock = 0; this.steam += 1; }
      }

      // Drops from the airship.
      while (this.drops.length && this.drops[0].t <= t) this.spawn(this.drops.shift(), scroll);
      while (this.gearPlan.length && this.gearPlan[0].t <= t) {
        const g = this.gearPlan.shift();
        this.gears.push({ id: this.nextId++, x: W + 30, y: g.y, phase: g.t, hp: 1 });
      }

      this.movePayloads(dt, scroll);
      this.moveGears(dt, scroll);
      this.moveHarpoons(dt);
      this.updateTruth(dt);

      this.evalClock += dt;
      if (this.evalClock >= EVAL_EVERY) { this.evalClock = 0; this.evaluate(); }
      this.checkHarms();

      if (this.hearts <= 0) this.finish("sunk");
      else if (t >= this.duration) this.finish("harbor");
    }

    spawn(d, scroll) {
      const k = KINDS[d.kind];
      const x0 = airshipX(d.t), y0 = 150;
      const p = { id: this.nextId++, kind: d.kind, x: x0, y: y0, vx: 0, vy: k.vy, hp: k.hp, born: this.t };
      if (d.kind === "charge") {
        p.fuseY = Math.max(DEPTH_MIN, Math.min(DEPTH_MAX, this.sub.y + (d.fuse - 0.5) * 180));
        const T = (p.fuseY - y0) / k.vy;
        const landX = SUB_X + (d.jitter - 0.5) * DIFFICULTY[this.difficulty].spread;
        p.vx = (landX - x0) / T + SCROLL;  // assumes full ahead, so stopping makes it fall short
      }
      this.payloads.push(p);
      this.emit({ type: "drop", kind: d.kind, x: x0, y: y0 });
    }

    movePayloads(dt, scroll) {
      const keep = [];
      for (const p of this.payloads) {
        const k = KINDS[p.kind];
        if (p.kind === "charge") {
          p.x += (p.vx - scroll) * dt;
          p.y += p.vy * dt;
          if (p.y >= p.fuseY) { this.blast(p); continue; }
        } else {
          const remaining = Math.max(0.6, (this.sub.y - p.y) / k.vy);
          const desired = Math.max(-260, Math.min(260, (SUB_X - p.x) / remaining));
          p.vx += Math.max(-420 * dt, Math.min(420 * dt, desired - p.vx));
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          const ex = (p.x - SUB_X) / 110, ey = (p.y - this.sub.y) / 48;
          if (ex * ex + ey * ey < 1) { this.contact(p); continue; }
          if (p.y > H + 40) continue;
        }
        if (p.x < -60 || p.x > W + 200) continue;
        keep.push(p);
      }
      this.payloads = keep;
    }

    moveGears(dt, scroll) {
      const keep = [];
      for (const g of this.gears) {
        g.x -= (scroll + 25) * dt;
        g.y += Math.sin((this.t + g.phase) * 2) * 12 * dt;
        if (Math.hypot(g.x - SUB_X, g.y - this.sub.y) < 70) { this.collect(g); continue; }
        if (g.x < -40) continue;
        keep.push(g);
      }
      this.gears = keep;
    }

    moveHarpoons(dt) {
      const keep = [];
      for (const h of this.harpoons) {
        h.life -= dt;
        const target = this.payloads.find((p) => p.id === h.target) || this.gears.find((g) => g.id === h.target);
        if (!target || h.life <= 0) continue;
        const dx = target.x - h.x, dy = target.y - h.y, d = Math.hypot(dx, dy);
        const stepLen = 1500 * dt;
        if (d <= Math.max(24, stepLen)) { this.strike(target); continue; }
        h.x += (dx / d) * stepLen; h.y += (dy / d) * stepLen;
        h.angle = Math.atan2(dy, dx);
        keep.push(h);
      }
      this.harpoons = keep;
    }

    strike(target) {
      if (!KINDS[target.kind]) { this.collect(target); return; }
      target.hp -= 1;
      if (target.hp > 0) { this.emit({ type: "dent", kind: target.kind, x: target.x, y: target.y, hp: target.hp }); return; }
      this.payloads = this.payloads.filter((p) => p !== target);
      this.combo += 1;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      const mult = Math.min(3, 1 + Math.floor(this.combo / 5));
      const pts = KINDS[target.kind].points * mult;
      this.points += pts;
      this.stats.intercepted += 1;
      this.emit({ type: "intercept", kind: target.kind, x: target.x, y: target.y, points: pts, combo: this.combo, mult: mult });
    }

    collect(g) {
      this.gears = this.gears.filter((x) => x !== g);
      this.points += 10;
      this.stats.gears += 1;
      this.emit({ type: "gear", x: g.x, y: g.y });
    }

    blast(p) {
      const d = Math.hypot(p.x - SUB_X, (p.y - this.sub.y) * 1.4);
      this.emit({ type: "blast", x: p.x, y: p.y, near: d < 170 });
      if (d < 85) this.hit("Depth charge struck the hull", 0.5);
      else if (d < 170) this.hullImpulse += 0.38 * (1 - (d - 85) / 85);
    }

    contact(p) {
      const T = this.timers;
      const msg = {
        fog: "Fog blinds the sonar", decoy: "Decoy feeds false sonar", ember: "Firebrand on the reactor",
        boarder: "Drone boards the crew", siren: "Forged command on the wire", writ: "The Leviathan rewrote your rules",
      }[p.kind];
      if (p.kind === "fog") T.fog = 3.5;
      if (p.kind === "decoy") T.decoy = 3.5;
      if (p.kind === "ember") T.ember = 4;
      if (p.kind === "boarder") T.boarder = 4;
      if (p.kind === "siren") T.siren = 2.5;
      if (p.kind === "writ") T.captured = 8;
      this.combo = 0;
      this.emit({ type: "contact", kind: p.kind, x: p.x, y: p.y, message: msg });
    }

    hit(reason, impulse) {
      if (this.invuln > 0) return;
      this.hearts -= 1;
      this.invuln = 1.2;
      this.combo = 0;
      this.hullImpulse += impulse || 0;
      this.stats.hits += 1;
      this.mark(2);
      this.emit({ type: "hit", reason: reason, hearts: this.hearts });
    }

    mark(level) {
      const i = Math.min(9, Math.floor((this.t / this.duration) * 10));
      this.timeline[i] = Math.max(this.timeline[i], level);
    }

    updateTruth(dt) {
      const T = this.timers, v = this.truth;
      const ease = (cur, target, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
      this.hullImpulse *= Math.exp(-dt / 1.6);
      const depthLoad = 0.2 + 0.45 * (this.sub.y - DEPTH_MIN) / (DEPTH_MAX - DEPTH_MIN);
      v.hull_stress = depthLoad + this.hullImpulse;
      const heat = T.ember > 0 ? 140 : 72 + 10 * this.sub.speed;
      v.reactor_temp_c = ease(v.reactor_temp_c, heat, heat > v.reactor_temp_c ? 1.2 : 2.0);
      v.sonar_confidence = ease(v.sonar_confidence, T.decoy > 0 ? 0.45 : 0.95, 0.5);
      v.crew_goal_drift = ease(v.crew_goal_drift, T.boarder > 0 ? 0.85 : 0.04, T.boarder > 0 ? 0.8 : 1.2);
      v.command_seal_valid = !(T.siren > 0);
    }

    evaluate() {
      const v = this.truth, n = this.noise;
      const j = (a) => (n() + n() - 1) * a;
      const e = {
        hull_stress: round(v.hull_stress + j(0.01), 3),
        reactor_temp_c: round(v.reactor_temp_c + j(0.4), 1),
        sonar_confidence: round(Math.max(0, Math.min(1, v.sonar_confidence + j(0.01))), 3),
        crew_goal_drift: round(Math.max(0, v.crew_goal_drift + j(0.005)), 3),
        command_seal_valid: v.command_seal_valid,
      };
      if (this.timers.fog > 0) delete e.sonar_confidence;
      this.evidence = e;
      const profile = this.timers.captured > 0 ? this.captured : this.profile;
      const r = this.engine.evaluate(profile, e);
      const before = this.response;
      this.result = r;
      this.response = r.response;
      this.reason = explain(r);
      if (before !== this.response) this.emit({ type: "order", from: before, to: this.response, order: ORDERS[this.response], reason: this.reason });
    }

    checkHarms() {
      const v = this.truth;
      const active = {
        reactor: v.reactor_temp_c > 125,
        sonar: v.sonar_confidence < 0.55,
        crew: v.crew_goal_drift > 0.66,
        seal: !v.command_seal_valid,
      };
      const words = {
        reactor: "Reactor overheated at speed", sonar: "Ran blind on false sonar",
        crew: "Hijacked crew took the helm", seal: "Forged command steered the ship",
      };
      for (const [k, on] of Object.entries(active)) {
        const h = this.harms[k] || (this.harms[k] = { on: false, onset: 0, resolved: false });
        if (on && !h.on) { h.on = true; h.onset = this.t; h.resolved = false; }
        if (!on) { h.on = false; continue; }
        if (h.resolved) continue;
        if (this.response === "suspended" && this.t - h.onset <= CATCH_WINDOW) {
          h.resolved = true;
          this.points += 60;
          this.stats.caught += 1;
          this.mark(1);
          this.emit({ type: "caught", harm: k, reason: this.reason, points: 60 });
        } else if (this.t - h.onset > CATCH_WINDOW) {
          h.resolved = true;
          this.hit(words[k], 0);
        }
      }
    }

    finish(outcome) {
      this.done = true;
      this.outcome = outcome;
      if (outcome === "harbor") this.points += 300;
      this.emit({ type: "done", outcome: outcome });
    }

    get leagues() { return Math.round(this.dist / LEAGUE_PX); }
    get score() { return this.leagues + this.points; }
    get order() { return ORDERS[this.response] || "All stop"; }
    get rulesCaptured() { return this.timers.captured > 0; }

    summary() {
      return {
        score: this.score, leagues: this.leagues, points: this.points, outcome: this.outcome, difficulty: this.difficulty,
        hearts: this.hearts, bestCombo: this.bestCombo, timeline: this.timeline.slice(),
        intercepted: this.stats.intercepted, caught: this.stats.caught, hits: this.stats.hits,
        gears: this.stats.gears, stopped_s: round(this.stats.stopped_s, 1),
      };
    }
  }

  function explain(r) {
    if (!r) return "";
    if (r.hard_rules_triggered && r.hard_rules_triggered.length) return LABELS[r.hard_rules_triggered[0].rule] || r.hard_rules_triggered[0].rule;
    if (r.missing_signals && r.missing_signals.length) return "No " + (LABELS[r.missing_signals[0].signal] || r.missing_signals[0].signal).toLowerCase() + " reading";
    const crit = (r.signal_results || []).find((s) => s.in_critical);
    if (crit) return (LABELS[crit.signal] || crit.signal) + " critical";
    const warn = (r.signal_results || []).find((s) => s.in_warning);
    if (warn) return (LABELS[warn.signal] || warn.signal) + " rising";
    return "All clear";
  }

  function round(x, d) { const f = Math.pow(10, d); return Math.round(x * f) / f; }

  // A steady but human reference captain, used for par and as an example for
  // agents. It reacts late, and lets about one threat in five through.
  function referencePolicy(seed) {
    let cool = 0;
    const skip = rng((seed || 1) ^ 0x2545f491);
    const ignored = new Set();
    return function (v, dt) {
      cool -= dt;
      const threats = v.payloads.filter((p) => !ignored.has(p.id) && p.y > WATER + 30 && v.t - p.born > 1.1 && !v.harpoons.some((h) => h.target === p.id && p.kind !== "writ"));
      threats.sort((a, b) => (b.kind === "writ") - (a.kind === "writ") || b.y - a.y);
      if (cool <= 0 && v.steam >= 1 && threats.length) {
        const p = threats[0];
        if (p.kind !== "writ" && skip() < 0.2) ignored.add(p.id);
        else { v.fire(p.id); cool = 0.65; }
      }
      const charge = v.payloads.find((p) => p.kind === "charge" && Math.abs(p.x - SUB_X) < 220);
      if (charge) v.setDepth(charge.fuseY < (DEPTH_MIN + DEPTH_MAX) / 2 ? DEPTH_MAX - 20 : DEPTH_MIN + 20);
      else v.setDepth(380);
    };
  }

  function run(opts, policy) {
    const v = new Voyage(opts);
    const act = policy || referencePolicy(opts.seed);
    const dt = 1 / 60;
    while (!v.done) { act(v, dt); v.step(dt); v.drain(); }
    return v.summary();
  }

  function par(opts) { return run(opts, referencePolicy(opts.seed)).score; }

  function medal(score, parScore) {
    if (!parScore) return null;
    if (score >= parScore) return "gold";
    if (score >= parScore * 0.8) return "silver";
    if (score >= parScore * 0.6) return "bronze";
    return null;
  }

  const RANKS = [
    [0, "Deckhand"], [500, "Stoker"], [1500, "Engineer"], [4000, "Navigator"],
    [8000, "First Mate"], [14000, "Captain"], [20000, "Twenty Thousand Leagues"],
  ];
  function rank(lifetimeLeagues) {
    let r = RANKS[0];
    for (const x of RANKS) if (lifetimeLeagues >= x[0]) r = x;
    const next = RANKS[RANKS.indexOf(r) + 1];
    return { title: r[1], next: next ? { title: next[1], at: next[0] } : null };
  }

  const api = {
    W, H, WATER, SUB_X, DEPTH_MIN, DEPTH_MAX, DURATION, DIFFICULTY, KINDS, ORDERS, LABELS,
    Voyage, run, par, medal, rank, RANKS, daySeed, voyageNumber, rng, referencePolicy, capturedProfile, airshipX,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPNautilusCore = api;
})(typeof window !== "undefined" ? window : globalThis);
