#!/usr/bin/env node
// Checks the TRP Arena Protocol runner: matches agree with the browser Arena,
// saved matches verify, tampered records fail, and misbehaving contestants
// cannot break a match or overspend.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const root = path.join(__dirname, "..");
const runner = path.join(root, "studio", "match.js");
const fx = (n) => `node ${path.join(root, "tests", "fixtures", "agents", n)}`;
let passed = 0;
function run(args) {
  const r = spawnSync("node", [runner].concat(args), { encoding: "utf-8", timeout: 120000 });
  return { code: r.status, out: r.stdout ? (() => { try { return JSON.parse(r.stdout); } catch (e) { return null; } })() : null, err: r.stderr };
}
function ok(name, fn) { fn(); passed++; console.log("PASS  " + name); }

ok("scripted Challenger matches the browser Arena par", () => {
  const r = run(["--event", "robot-cell", "--seed", "20261101", "--guardian", "builtin:guards=second-sensor,speed-limit", "--challenger", "builtin:scripted"]);
  assert.strictEqual(r.out.legs[0].summary.score, r.out.par);
  assert.strictEqual(r.out.medal, "gold");
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trp-arena-"));
const rec = path.join(tmp, "match.json");
ok("versus across languages saves a record", () => {
  const r = run(["--event", "agno", "--seed", "7", "--versus", `node ${path.join(root, "studio/agents/greedy.js")}`, `python3 ${path.join(root, "studio/agents/random_agent.py")}`, "--out", rec]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out.legs.length, 2);
  assert.ok(r.out.legs.every((l) => l.moves.length === 8 && l.faults.guardian.length === 0 && l.faults.challenger.length === 0));
});
ok("saved record verifies", () => assert.strictEqual(run(["--verify", rec]).code, 0));
ok("tampered record fails verification", () => {
  const d = JSON.parse(fs.readFileSync(rec, "utf-8"));
  d.legs[0].summary.score += 10;
  fs.writeFileSync(rec, JSON.stringify(d));
  assert.strictEqual(run(["--verify", rec]).code, 1);
});

for (const [name, agent, side] of [["silent", "silent.js", "guardian"], ["crash", "crash.js", "challenger"], ["flood", "flood.js", "challenger"], ["cheat", "cheat.js", "guardian"], ["cheat", "cheat.js", "challenger"]]) {
  ok(`${name} ${side} cannot break the match`, () => {
    const other = side === "guardian" ? "--challenger" : "--guardian";
    const r = run(["--event", "machine-line", "--seed", "3", "--timeout", "400", "--" + side, fx(agent), other, "builtin:greedy"]);
    assert.strictEqual(r.code, 0, r.err);
    const leg = r.out.legs[0];
    assert.ok(leg.faults[side].length > 0, "fault recorded");
    assert.strictEqual(leg.moves.length, 8);
    const pack = JSON.parse(fs.readFileSync(path.join(root, "studio/packs/machine-line/pack.json"), "utf-8"));
    const cost = leg.guards.reduce((s, id) => s + pack.arena.guards.find((g) => g.id === id).cost, 0);
    assert.ok(cost <= pack.arena.budget, "within budget");
    assert.ok(leg.guards.every((id) => pack.arena.guards.some((g) => g.id === id)), "only real guards");
  });
}

ok("no contestant processes are left running", () => {
  const ps = execFileSync("ps", ["-eo", "args"], { encoding: "utf-8" }).split("\n").filter((l) => /^node .*tests\/fixtures\/agents\//.test(l));
  assert.deepStrictEqual(ps, []);
});

console.log(`Arena protocol: ${passed} passed, 0 failed`);
