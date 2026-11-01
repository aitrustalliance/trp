/**
 * Simple Arena strategies, used as built-in contestants and as examples.
 * Each takes a protocol message and returns a reply, or null for notices.
 */
(function (root) {
  "use strict";

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Picks at random from whatever is legal.
  function random() {
    let event = null, r = rng(1);
    return function (msg) {
      if (msg.type === "hello") { event = msg.event; r = rng(msg.seed ^ 0x1234); return null; }
      if (msg.type === "choose_guards") {
        const out = []; let spent = 0;
        for (const g of msg.guards.slice().sort(() => r() - 0.5)) if (spent + g.cost <= msg.budget) { out.push(g.id); spent += g.cost; }
        return { guards: out };
      }
      if (msg.type === "choose_move") return { move: event.moves[Math.floor(r() * event.moves.length)].id };
      return null;
    };
  }

  // Guardian buys the guards that counter the most moves per point.
  // Challenger aims at moves no guard in play counters, and avoids repeats
  // of moves that were caught.
  function greedy() {
    let event = null;
    return function (msg) {
      if (msg.type === "hello") { event = msg.event; return null; }
      if (msg.type === "choose_guards") {
        const ranked = msg.guards.slice().sort((a, b) => b.counters.length / b.cost - a.counters.length / a.cost || a.cost - b.cost);
        const out = []; let spent = 0;
        for (const g of ranked) if (spent + g.cost <= msg.budget) { out.push(g.id); spent += g.cost; }
        return { guards: out };
      }
      if (msg.type === "choose_move") {
        const countered = new Set();
        for (const id of msg.guards_in_play) for (const m of (event.guards.find((g) => g.id === id) || {}).counters || []) countered.add(m);
        const caughtBefore = new Set(msg.history.filter((h) => h.caught > 0 && h.missed === 0).map((h) => h.move));
        const last = msg.history.length ? msg.history[msg.history.length - 1].move : null;
        const score = (m) => (countered.has(m.id) ? 0 : 4) + (caughtBefore.has(m.id) ? 0 : 2) + (m.id === last ? -3 : 0);
        const best = event.moves.slice().sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
        return { move: best.id };
      }
      return null;
    };
  }

  const api = { random, greedy };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPStrategies = api;
})(typeof window !== "undefined" ? window : globalThis);
