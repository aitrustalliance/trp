#!/usr/bin/env node
// Checks the Nautilus game core: voyages are deterministic, the open rules
// catch harm and stop the ship in time, captured rules do not, and the
// reference captain can finish every voyage it sets par on.
"use strict";
const assert = require("assert");
const path = require("path");
const C = require("../studio/nautilus/core.js");
void path;
const E = require("../studio/engine.js");
const raw = require("../examples/nautilus/trp.json");
const opts = (seed) => ({ engine: E, profileRaw: raw, seed });
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("PASS  " + name); };

ok("the same seed gives the same voyage", () => {
  assert.deepStrictEqual(C.run(opts(20261101)), C.run(opts(20261101)));
  assert.notDeepStrictEqual(C.run(opts(20261101)), C.run(opts(20261102)));
});

ok("the reference captain reaches harbor on 30 daily seeds", () => {
  for (let d = 0; d < 30; d++) {
    const seed = C.daySeed(new Date(Date.UTC(2026, 10, 1 + d)));
    const s = C.run(opts(seed));
    assert.strictEqual(s.outcome, "harbor", `seed ${seed} ${JSON.stringify(s)}`);
  }
});

ok("a captain who does nothing is kept alive by the rules for a while", () => {
  const s = C.run(opts(20261101), () => {});
  assert.ok(s.caught + s.prevented >= 5, `rules caught ${s.caught} and prevented ${s.prevented}`);
  assert.ok(s.stopped_s > 20, "the rules stopped the ship");
});

// Put a firebrand on the reactor and see who stops the ship.
function emberTest(captured) {
  const v = new C.Voyage(opts(7));
  v.drops = []; v.gearPlan = [];
  v.timers.ember = 4;
  if (captured) v.timers.captured = 8;
  const events = [];
  for (let i = 0; i < 60 * 7; i++) { v.step(1 / 60); if (captured) v.timers.captured = 8; events.push(...v.drain()); }
  return events;
}
ok("open rules stop the ship before an overheated reactor does harm", () => {
  const ev = emberTest(false);
  assert.ok(ev.some((e) => e.type === "order" && e.to === "suspended"), "all stop rang");
  assert.ok(ev.some((e) => (e.type === "caught" || e.type === "prevented") && e.harm === "reactor"), "harm caught or prevented");
  assert.ok(!ev.some((e) => e.type === "hit"), "no hull damage");
});

ok("the three rule books trade safety for leagues", () => {
  const load = (id) => require(`../examples/${id}/trp.json`);
  const run = (id) => { let hits = 0, stopped = 0; for (const seed of [1, 2, 3, 4, 5]) { const s = C.run({ engine: E, profileRaw: load(id), seed }); hits += s.hits; stopped += s.stopped_s; } return { hits, stopped }; };
  const cautious = run("nautilus-cautious"), standard = run("nautilus"), bold = run("nautilus-bold");
  assert.ok(cautious.stopped > standard.stopped && standard.stopped > bold.stopped, "stops fall from cautious to bold");
  assert.ok(bold.hits > standard.hits, "bold takes more hits with the same captain");
  assert.ok(cautious.hits <= standard.hits && cautious.hits < bold.hits, "cautious takes the fewest hits");
});
ok("captured rules let the same harm through", () => {
  const ev = emberTest(true);
  assert.ok(!ev.some((e) => e.type === "caught"), "nothing caught");
  assert.ok(ev.some((e) => e.type === "hit"), "the hull takes damage");
});

ok("fog removes the sonar reading and the rules refuse to sail blind", () => {
  const v = new C.Voyage(opts(7));
  v.drops = []; v.timers.fog = 3;
  for (let i = 0; i < 30; i++) v.step(1 / 60);
  assert.ok(!("sonar_confidence" in v.evidence));
  assert.strictEqual(v.response, "suspended");
  assert.ok(v.result.missing_signals.some((m) => m.signal === "sonar_confidence"));
});

ok("a forged command trips the hard rule", () => {
  const v = new C.Voyage(opts(7));
  v.drops = []; v.timers.siren = 2;
  for (let i = 0; i < 12; i++) v.step(1 / 60);
  assert.ok(v.result.hard_rules_triggered.some((r) => r.rule === "command_seal_invalid"));
});

ok("harpoons cannot be fired without steam or at nothing", () => {
  const v = new C.Voyage(opts(7));
  assert.strictEqual(v.fire(99999), false);
  v.steam = 0;
  v.step(0.1);
  assert.strictEqual(v.fireAt(C.SUB_X, 100), false);
});

ok("medals and ranks", () => {
  assert.strictEqual(C.medal(100, 100), "gold");
  assert.strictEqual(C.medal(80, 100), "silver");
  assert.strictEqual(C.medal(60, 100), "bronze");
  assert.strictEqual(C.medal(59, 100), null);
  assert.strictEqual(C.rank(0).title, "Deckhand");
  assert.strictEqual(C.rank(20000).title, "Twenty Thousand Leagues");
});

console.log(`Nautilus core: ${passed} passed, 0 failed`);
