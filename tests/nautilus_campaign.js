#!/usr/bin/env node
// Checks the Nautilus campaign: every chapter is complete and well formed,
// every port effect uses a known vocabulary, every rule book is a profile
// the open engine accepts, and the reference captain can make port in every
// chapter under every rule book.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const C = require("../studio/nautilus/core.js");
const E = require("../studio/engine.js");

const ROOT = path.join(__dirname, "..");
const camp = JSON.parse(fs.readFileSync(path.join(ROOT, "studio/nautilus/campaign.json"), "utf-8"));
const codex = JSON.parse(fs.readFileSync(path.join(ROOT, "studio/codex.json"), "utf-8"));
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("PASS  " + name); };

const SEAS = ["city", "kelp", "reef", "tunnel", "ice", "vortex", "open"];
const WEATHER = ["dusk", "night", "bright", "current", "dark", "storm", "clear"];
const KINDS = ["charge", "fog", "decoy", "ember", "boarder", "siren"];
const HAZARDS = ["barrage", "night", "reef", "current", "ice", "vortex", "storm", "decrees"];
const EFFECTS = ["brass", "rules", "system", "crew", "pennant", "skin", "pages", "reveal"];
const PENNANTS = ["free", "open", "crew", "gear", "scholar"];
const SKINS = ["brass", "copper", "verdigris", "silver", "gilded"];
const LEVELS = codex.levels ? Object.keys(codex.levels) : ["deckhand", "navigator", "captain"];

const ids = (list) => list.map((x) => x.id);
const house = (text, where) => {
  assert.ok(!/—|–/.test(text), `${where} uses a dash`);
  assert.ok(!/\b(Striv|Trust Academy|ARIA|Trust OS)\b/.test(text), `${where} names a company or product`);
};

ok("the campaign has a version, a season and six chapters in order", () => {
  assert.strictEqual(camp.campaign_version, "1");
  assert.ok(camp.season && camp.season.length > 4);
  assert.strictEqual(camp.chapters.length, 6);
  camp.chapters.forEach((ch, i) => assert.strictEqual(ch.id, i + 1, `chapter ${i + 1} is out of order`));
});

ok("every chapter is complete and uses known seas, weather, threats and hazards", () => {
  for (const ch of camp.chapters) {
    const w = `chapter ${ch.id}`;
    for (const k of ["title", "port", "verne", "sea", "weather", "brief"]) assert.ok(typeof ch[k] === "string" && ch[k].length > 2, `${w} lacks ${k}`);
    assert.ok(SEAS.includes(ch.sea), `${w} sea ${ch.sea}`);
    assert.ok(WEATHER.includes(ch.weather), `${w} weather ${ch.weather}`);
    assert.ok(ch.duration >= 60 && ch.duration <= 120, `${w} duration`);
    assert.deepStrictEqual(Object.keys(ch.weights).sort(), [...KINDS].sort(), `${w} weights`);
    for (const v of Object.values(ch.weights)) assert.ok(v >= 0 && v <= 3, `${w} weight ${v}`);
    for (const k of Object.keys(ch.hazards)) assert.ok(HAZARDS.includes(k), `${w} hazard ${k}`);
    if (ch.hazards.barrage) for (const [a, b] of ch.hazards.barrage) assert.ok(a >= 0 && b > a && b <= ch.duration, `${w} barrage window`);
    house(ch.brief, w); house(ch.scene.text, `${w} scene`);
  }
});

ok("every port offers two choices with distinct, known effects", () => {
  const rules = ids(camp.fittings.rules), systems = ids(camp.fittings.systems), crew = ids(camp.fittings.crew);
  for (const ch of camp.chapters) {
    const w = `chapter ${ch.id}`;
    assert.ok(ch.scene && ch.scene.text.length > 40, `${w} has no scene`);
    assert.strictEqual(ch.scene.choices.length, 2, `${w} choices`);
    const seen = new Set();
    for (const c of ch.scene.choices) {
      assert.ok(c.label && c.detail, `${w} choice text`);
      assert.ok(!seen.has(c.label), `${w} repeats a choice`); seen.add(c.label);
      house(c.detail, `${w} choice`);
      const keys = Object.keys(c.effects);
      assert.ok(keys.length >= 1, `${w} choice has no effect`);
      for (const k of keys) assert.ok(EFFECTS.includes(k), `${w} effect ${k}`);
      if (c.effects.rules) assert.ok(rules.includes(c.effects.rules), `${w} rules ${c.effects.rules}`);
      if (c.effects.system) assert.ok(systems.includes(c.effects.system), `${w} system ${c.effects.system}`);
      if (c.effects.crew) assert.ok(crew.includes(c.effects.crew), `${w} crew ${c.effects.crew}`);
      if (c.effects.pennant) assert.ok(PENNANTS.includes(c.effects.pennant), `${w} pennant`);
      if (c.effects.skin) assert.ok(SKINS.includes(c.effects.skin), `${w} skin`);
      if (c.effects.pages) assert.ok(LEVELS.includes(c.effects.pages.level) && c.effects.pages.n >= 1 && c.effects.pages.n <= 3, `${w} pages`);
      if (c.effects.brass) assert.ok(c.effects.brass > 0 && c.effects.brass <= 200, `${w} brass`);
      if (c.effects.reveal) assert.strictEqual(c.effects.reveal, "all");
    }
  }
});

ok("fittings have unique ids, costs and details", () => {
  for (const [kind, list] of Object.entries(camp.fittings)) {
    assert.strictEqual(new Set(ids(list)).size, list.length, `${kind} repeats an id`);
    for (const it of list) {
      assert.ok(/^[a-z0-9-]{2,40}$/.test(it.id), `${kind} id ${it.id}`);
      assert.ok(typeof it.cost === "number" && it.cost >= 0 && it.cost <= 200, `${kind} ${it.id} cost`);
      assert.ok(it.label && it.detail && it.detail.length > 10, `${kind} ${it.id} text`);
      house(it.detail, `${kind} ${it.id}`);
    }
  }
  assert.deepStrictEqual(ids(camp.fittings.rules), ["cautious", "standard", "bold"]);
  assert.ok(camp.fittings.systems.length >= 4 && camp.fittings.crew.length >= 3);
});

const profiles = {};
ok("every rule book is a profile file the open engine accepts", () => {
  for (const rb of camp.fittings.rules) {
    const file = path.normalize(path.join(ROOT, "studio/nautilus", rb.profile));
    assert.ok(file.startsWith(path.join(ROOT, "examples")), `${rb.id} profile lives outside examples`);
    assert.ok(fs.existsSync(file), `${rb.id} profile missing at ${file}`);
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const p = E.loadProfile(raw);
    assert.ok(p.scoredSignals.length >= 4, `${rb.id} has too few signals`);
    for (const s of ["hull_stress", "reactor_temp_c", "sonar_confidence", "crew_goal_drift"]) assert.ok(p.scoredSignals.some((x) => x.signal === s), `${rb.id} lacks ${s}`);
    profiles[rb.id] = raw;
  }
});

ok("the rule books differ in the direction they promise", () => {
  const th = (id, sig) => E.loadProfile(profiles[id]).scoredSignals.find((x) => x.signal === sig).criticalThreshold;
  assert.ok(th("cautious", "reactor_temp_c") < th("standard", "reactor_temp_c") && th("standard", "reactor_temp_c") < th("bold", "reactor_temp_c"), "reactor limits");
  assert.ok(th("cautious", "sonar_confidence") > th("standard", "sonar_confidence") && th("standard", "sonar_confidence") > th("bold", "sonar_confidence"), "sonar limits");
});

// The chapter runs the game uses for par, one per rule book.
const sailed = {};
for (const ch of camp.chapters) for (const rb of camp.fittings.rules) {
  const seed = 7000 + ch.id * 13;
  sailed[`${ch.id}/${rb.id}`] = C.run({ engine: E, profileRaw: profiles[rb.id], seed, difficulty: "normal", chapter: ch, duration: ch.duration }, C.referencePolicy(seed));
}

ok("a steady captain makes port in every chapter under the cautious and standard rules", () => {
  for (const ch of camp.chapters) for (const rb of ["cautious", "standard"]) {
    const s = sailed[`${ch.id}/${rb}`];
    assert.strictEqual(s.outcome, "harbor", `chapter ${ch.id} under ${rb} rules: ${JSON.stringify(s)}`);
    assert.ok(s.caught + s.prevented >= 1, `chapter ${ch.id} under ${rb} rules: the rules never acted`);
  }
});

ok("the cautious rules stop the ship longer and never let more harm through than the standard rules", () => {
  for (const ch of camp.chapters) {
    const c = sailed[`${ch.id}/cautious`], s = sailed[`${ch.id}/standard`];
    assert.ok(c.stopped_s >= s.stopped_s, `chapter ${ch.id}: cautious stopped ${c.stopped_s}s, standard ${s.stopped_s}s`);
    assert.ok(c.hits <= s.hits, `chapter ${ch.id}: cautious took ${c.hits} hits, standard ${s.hits}`);
  }
});

ok("the bold rules sit past the point of harm, so they never catch it and a steady captain pays for that", () => {
  let sunk = 0;
  for (const ch of camp.chapters) {
    const b = sailed[`${ch.id}/bold`], s = sailed[`${ch.id}/standard`];
    // The seal is a hard rule in every book, so a forged command still halts the ship under bold rules.
    assert.strictEqual(b.prevented, 0, `chapter ${ch.id}: bold rules prevented harm`);
    assert.ok(b.caught <= s.caught, `chapter ${ch.id}: bold caught more than standard`);
    assert.ok(b.stopped_s <= s.stopped_s, `chapter ${ch.id}: bold stopped longer than standard`);
    if (b.outcome === "sunk") sunk++;
  }
  assert.ok(sunk >= 1 && sunk < camp.chapters.length, `bold sank ${sunk} of ${camp.chapters.length}`);
});

ok("chapters get harder and each one has a different threat mix", () => {
  const fp = camp.chapters.map((ch) => JSON.stringify([ch.sea, ch.weights, ch.hazards]));
  assert.strictEqual(new Set(fp).size, fp.length, "two chapters share a threat mix");
  const first = C.run({ engine: E, profileRaw: profiles.standard, seed: 7013, chapter: camp.chapters[0], duration: camp.chapters[0].duration }, () => {});
  const last = C.run({ engine: E, profileRaw: profiles.standard, seed: 7078, chapter: camp.chapters[5], duration: camp.chapters[5].duration }, () => {});
  assert.ok(last.stopped_s + last.hits * 10 >= first.stopped_s, `the last chapter should press harder than the first (${first.stopped_s}s vs ${last.stopped_s}s stopped)`);
});

console.log(`\n${passed} campaign checks passed`);
