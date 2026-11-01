#!/usr/bin/env node
// Checks studio/safety.js accepts every shipped pack and profile and rejects
// malformed or oversized input.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const S = require("../studio/safety.js");
const root = path.join(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf-8"));
let passed = 0;
const ok = (name, fn) => { fn(); passed++; };
const rejects = (name, fn) => ok(name, () => assert.throws(fn, S.ImportError, name));

const index = read("studio/packs/index.json");
for (const item of index.packs) {
  const file = path.join("studio/packs", item.path);
  const pack = read(file);
  ok(`pack ${pack.id}`, () => S.checkPack(pack));
  ok(`profile for ${pack.id}`, () => S.checkProfile(JSON.parse(fs.readFileSync(path.resolve(root, path.dirname(file), pack.profile), "utf-8"))));
}
for (const dir of fs.readdirSync(path.join(root, "examples"))) {
  const f = path.join("examples", dir, "trp.json");
  if (fs.existsSync(path.join(root, f))) ok(f, () => S.checkProfile(read(f)));
}

// Hostile text is allowed through as data, since the page escapes it, but
// hostile types are rejected.
ok("hostile strings parse", () => S.checkProfile(read("tests/fixtures/hostile-profile.json")));
rejects("string threshold", () => S.checkProfile(read("tests/fixtures/hostile-threshold.json")));
rejects("oversized file", () => S.parse(" ".repeat(S.LIMITS.bytes + 1)));
rejects("not JSON", () => S.parse("{nope"));
rejects("profile as array", () => S.checkProfile([]));
rejects("too many signals", () => S.checkProfile(Object.assign(read("examples/manufacturing-safety/trp.json"), { scored_signals: new Array(65).fill(read("examples/manufacturing-safety/trp.json").scored_signals[0]) })));
rejects("long text", () => S.checkProfile(Object.assign(read("examples/manufacturing-safety/trp.json"), { name: "x".repeat(401) })));
rejects("unknown scene", () => S.checkPack(Object.assign(read("studio/packs/robot-cell/pack.json"), { scene: "../../evil" })));
rejects("bad pack id", () => S.checkPack(Object.assign(read("studio/packs/robot-cell/pack.json"), { id: "<x>" })));
rejects("arena rounds as text", () => S.checkPack(Object.assign(read("studio/packs/robot-cell/pack.json"), { arena: Object.assign(read("studio/packs/robot-cell/pack.json").arena, { rounds: "<b>8</b>" }) })));
rejects("tick too fast", () => S.checkPack(Object.assign(read("studio/packs/robot-cell/pack.json"), { tick_ms: 1 })));
ok("the stochastic humanoid pack passes", () => S.checkPack(read("studio/packs/humanoid-floor/pack.json")));
const hp = () => read("studio/packs/humanoid-floor/pack.json");
rejects("runaway shock rate", () => { const pk = hp(); pk.signals.balance_margin_m.shocks.rate = 1e6; S.checkPack(pk); });
rejects("unknown process type", () => { const pk = hp(); pk.signals.balance_margin_m.process.type = "brownian"; S.checkPack(pk); });
rejects("derive from an unknown signal", () => { const pk = hp(); pk.signals.joint_torque_ratio.derive.from = "nope"; S.checkPack(pk); });
rejects("derive from the prototype", () => { const pk = hp(); pk.signals.joint_torque_ratio.derive.from = "__proto__"; S.checkPack(pk); });
rejects("a Command floor of thousands", () => { const pk = hp(); pk.command.count = 5000; S.checkPack(pk); });

rejects("prototype signal name", () => S.checkProfile(JSON.parse(JSON.stringify(read("examples/manufacturing-safety/trp.json")).replace('"human_distance_m"', '"__proto__"'))));
rejects("prototype key in pack signals", () => S.checkPack(Object.assign(read("studio/packs/robot-cell/pack.json"), { signals: JSON.parse('{"__proto__": {"base": 1}}') })));
rejects("prototype key in effects", () => { const pk = read("studio/packs/robot-cell/pack.json"); pk.controls.find((c) => c.effects).effects = JSON.parse('{"constructor": {"set": 1}}'); S.checkPack(pk); });

// Links.
const base = "https://example.org/studio/";
ok("https link", () => assert.strictEqual(S.checkProfileUrl("https://a.org/p.json", base), "https://a.org/p.json"));
ok("same-site link", () => assert.strictEqual(S.checkProfileUrl("../examples/p.json", base), "https://example.org/examples/p.json"));
rejects("http link", () => S.checkProfileUrl("http://a.org/p.json", base));
rejects("javascript link", () => S.checkProfileUrl("javascript:alert(1)", base));
rejects("data link", () => S.checkProfileUrl("data:application/json,{}", base));
rejects("credentials in link", () => S.checkProfileUrl("https://u:p@a.org/p.json", base));

// Replays keep only well-formed steps.
ok("replay cleaned", () => {
  const r = S.checkReplay({ p: "robot-cell", s: [[1, "speed", 900], [2, "x", "<b>"], [-1, "y", 1], [3, "z", true], "junk"] });
  assert.deepStrictEqual(r.s, [[1, "speed", 900], [3, "z", true]]);
});
rejects("replay pack name", () => S.checkReplay({ p: "<script>", s: [] }));
rejects("replay too long", () => S.checkReplay({ p: "robot-cell", s: new Array(2001).fill([1, "a", 1]) }));

console.log(`Studio safety: ${passed} passed, 0 failed`);
