/**
 * TRP Arena Protocol, version 1.
 *
 * Plays an Arena event between two contestants. The Guardian chooses guards
 * within a budget, the Challenger chooses one move per round, and the open TRP
 * engine judges every tick. A contestant is any async function that takes a
 * message and returns a reply, so the same code serves programs talking over
 * standard input and output (studio/match.js), agents in the browser and
 * tests. Protocol details are in studio/ARENA_PROTOCOL.md.
 */
(function (root) {
  "use strict";

  const PROTOCOL = "trp-arena/1";
  const DT = 0.05;

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // What both contestants are told about the event.
  function describe(pack) {
    const a = pack.arena;
    return {
      id: pack.id,
      title: a.event || pack.title,
      rounds: a.rounds,
      round_s: a.round_s || 6,
      budget: a.budget,
      guards: a.guards.map((g) => ({ id: g.id, label: g.label, detail: g.detail || "", cost: g.cost, counters: g.counters || [] })),
      moves: a.moves.map((m) => ({ id: m.id, label: m.label })),
      harm: (a.harm || []).map((h) => ({ id: h.id, label: h.label })),
      scoring: "100 x (0.65 x share of harm stopped within 0.75 s + 0.35 x uptime) - 2 x false stops",
    };
  }

  // Keep known, unique guards in the order given, while they fit the budget.
  function cleanGuards(pack, reply) {
    const a = pack.arena;
    const asked = reply && Array.isArray(reply.guards) ? reply.guards : null;
    if (!asked) return { guards: [], fault: "reply had no guards list" };
    const out = [];
    let spent = 0;
    let fault = null;
    for (const id of asked) {
      const g = a.guards.find((x) => x.id === id);
      if (!g) { fault = fault || `unknown guard ${String(id).slice(0, 40)}`; continue; }
      if (out.includes(id)) continue;
      if (spent + g.cost > a.budget) { fault = fault || "guards over budget, extras dropped"; continue; }
      out.push(id); spent += g.cost;
    }
    return { guards: out, fault };
  }

  async function ask(agent, msg, faults, fallback, timeoutMs) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(agent(msg)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), timeoutMs); }),
      ]);
    } catch (err) {
      faults.push(`${msg.type}: ${err.message}`);
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  async function tell(agent, msg) {
    try { await Promise.resolve(agent(msg)); } catch (err) { /* notices need no reply */ }
  }

  /**
   * Play one leg. opts: pack, profileRaw, seed, guardian, challenger, deps
   * ({ engine, sim, arena }), timeoutMs (default 5000), names.
   */
  async function playLeg(opts) {
    const { pack, profileRaw, deps } = opts;
    const A = deps.arena;
    const seed = opts.seed >>> 0;
    const timeoutMs = opts.timeoutMs || 5000;
    const event = describe(pack);
    const fallbackPick = rng(seed ^ 0xa5a5a5a5);
    const faults = { guardian: [], challenger: [] };

    await tell(opts.guardian, { type: "hello", protocol: PROTOCOL, role: "guardian", event, seed });
    await tell(opts.challenger, { type: "hello", protocol: PROTOCOL, role: "challenger", event, seed });

    const gReply = await ask(opts.guardian, { type: "choose_guards", budget: event.budget, guards: event.guards }, faults.guardian, { guards: [] }, timeoutMs);
    const chosen = cleanGuards(pack, gReply);
    if (chosen.fault) faults.guardian.push(chosen.fault);

    const rounds = pack.arena.rounds;
    const match = new A.Match(pack, profileRaw, chosen.guards, { seed, plan: new Array(rounds).fill(null) }, deps);
    const history = [];
    const moves = [];
    let asked = -1;
    let prev = { caught: 0, missed: 0, falseHalts: 0 };

    while (!match.done) {
      if (match.round !== asked && match.round < rounds) {
        // Report the round that just ended.
        if (asked >= 0) {
          const now = counts(match.tally);
          const entry = { round: asked, move: moves[asked], caught: now.caught - prev.caught, missed: now.missed - prev.missed, false_stops: now.falseHalts - prev.falseHalts };
          history.push(entry);
          prev = now;
          await tell(opts.guardian, Object.assign({ type: "round_result" }, entry));
          await tell(opts.challenger, Object.assign({ type: "round_result" }, entry));
        }
        asked = match.round;
        const reply = await ask(opts.challenger, { type: "choose_move", round: asked, rounds, guards_in_play: chosen.guards, history: history.slice() }, faults.challenger, null, timeoutMs);
        let move = reply && pack.arena.moves.find((m) => m.id === reply.move);
        if (!move) {
          if (reply !== null) faults.challenger.push(`round ${asked}: unknown move ${String(reply && reply.move).slice(0, 40)}`);
          move = pack.arena.moves[Math.floor(fallbackPick() * pack.arena.moves.length)];
        }
        match.plan[asked] = move;
        moves[asked] = move.id;
      }
      match.step(DT);
    }
    const last = counts(match.tally);
    const lastEntry = { round: asked, move: moves[asked], caught: last.caught - prev.caught, missed: last.missed - prev.missed, false_stops: last.falseHalts - prev.falseHalts };
    history.push(lastEntry);

    const summary = match.summary;
    const result = { type: "result", guards: chosen.guards, moves, summary, history };
    await tell(opts.guardian, result);
    await tell(opts.challenger, result);
    return { event: pack.id, seed, guards: chosen.guards, moves, summary, history, faults };
  }

  function counts(tally) {
    const caught = tally.incidents.filter((i) => i.caught).length;
    return { caught, missed: tally.incidents.length - caught, falseHalts: tally.falseHalts };
  }

  /**
   * Two legs with sides swapped. Each contestant's mark is its score as
   * Guardian, so the better defender wins and a sharp Challenger wins by
   * holding the other side's score down.
   */
  async function playVersus(opts) {
    const a = opts.a, b = opts.b;
    const leg1 = await playLeg(Object.assign({}, opts, { guardian: a.agent, challenger: b.agent }));
    const leg2 = await playLeg(Object.assign({}, opts, { guardian: b.agent, challenger: a.agent }));
    const sa = leg1.summary.score, sb = leg2.summary.score;
    return {
      protocol: PROTOCOL,
      event: opts.pack.id,
      seed: opts.seed >>> 0,
      contestants: [a.name, b.name],
      legs: [
        Object.assign({ guardian: a.name, challenger: b.name }, leg1),
        Object.assign({ guardian: b.name, challenger: a.name }, leg2),
      ],
      scores: { [a.name]: sa, [b.name]: sb },
      winner: sa === sb ? null : sa > sb ? a.name : b.name,
    };
  }

  // Re-run a saved match from its recorded guards and moves.
  async function verify(record, opts) {
    const legs = [];
    for (const leg of record.legs) {
      const guardian = async (m) => (m.type === "choose_guards" ? { guards: leg.guards } : null);
      const challenger = async (m) => (m.type === "choose_move" ? { move: leg.moves[m.round] } : null);
      const replay = await playLeg(Object.assign({}, opts, { seed: record.seed, guardian, challenger }));
      const same = JSON.stringify(replay.summary) === JSON.stringify(leg.summary) && JSON.stringify(replay.guards) === JSON.stringify(leg.guards);
      legs.push({ guardian: leg.guardian, same, recorded: leg.summary.score, replayed: replay.summary.score });
    }
    return { ok: legs.every((l) => l.same), legs };
  }

  const api = { PROTOCOL, describe, cleanGuards, playLeg, playVersus, verify };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPVersus = api;
})(typeof window !== "undefined" ? window : globalThis);
