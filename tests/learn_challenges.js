#!/usr/bin/env node
// Every Learn challenge must fail with the shipped profile and pass with at
// least one known set of limits, so no challenge is impossible or already won.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const E = require("../studio/engine.js");
const S = require("../studio/sim.js");
const A = require("../studio/arena.js");
const root = path.join(__dirname, "..");
const set = JSON.parse(fs.readFileSync(path.join(root, "studio/challenges.json"), "utf-8"));

// [signal, warning, critical] that solve each challenge.
const SOLUTIONS = {
  "rush-job": [["human_distance_m", 2.2, 1.75]],
  "jam-line": [["jam_rate_per_hour", 1.84, 3.08], ["line_speed_units_min", 130.5, 151]],
  "quiet-drift": [["data_deidentification_confidence", 0.931, 0.892], ["consent_coverage_ratio", 0.93, 0.874], ["model_subgroup_performance_gap", 0.0685, 0.107]],
  "agent-guardrails": [["grounding_score", 0.836, 0.741], ["records_beyond_need", 0.11, 0.199], ["steps_per_task", 21.7, 34.4]],
};

function grade(c, pack, prof) {
  const r = A.stressTest(pack, prof, { episodes: set.episodes, seed: set.seed }, { engine: E, sim: S });
  const o = r.overall;
  return { pass: o.safety >= c.goal.safety && o.falseHalts <= c.goal.false_stops && o.uptime >= c.goal.uptime, o };
}

let passed = 0;
for (const c of set.challenges) {
  const file = path.join(root, "studio/packs", c.pack, "pack.json");
  const pack = JSON.parse(fs.readFileSync(file, "utf-8"));
  const shipped = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), pack.profile), "utf-8"));
  for (const name of c.edit) assert.ok(shipped.scored_signals.some((s) => s.signal === name), `${c.id} edits unknown signal ${name}`);
  const before = grade(c, pack, shipped);
  assert.ok(!before.pass, `${c.id} is already won with the shipped profile`);
  const solved = JSON.parse(JSON.stringify(shipped));
  for (const [name, w, cr] of SOLUTIONS[c.id]) {
    assert.ok(c.edit.includes(name), `${c.id} solution edits a locked signal`);
    const s = solved.scored_signals.find((x) => x.signal === name);
    s.warning_threshold = w; s.critical_threshold = cr;
  }
  const after = grade(c, pack, solved);
  assert.ok(after.pass, `${c.id} solution fails: ${JSON.stringify(after.o)}`);
  passed++;
  console.log(`PASS  ${c.id}  shipped ${Math.round(before.o.safety * 100)}% → solved ${Math.round(after.o.safety * 100)}%, ${after.o.falseHalts} needless stops`);
}
console.log(`Learn challenges: ${passed} passed, 0 failed`);
