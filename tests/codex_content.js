#!/usr/bin/env node
// Checks the Captain's Codex: structure, cross-references, specification
// section references, quiz integrity and house style.
"use strict";
const assert = require("assert");
const STYLE = require("./house_style.js");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const codex = JSON.parse(fs.readFileSync(path.join(root, "studio/codex.json"), "utf-8"));
const spec = fs.readFileSync(path.join(root, "spec/trp-spec.md"), "utf-8");
const C = require("../studio/nautilus/core.js");
let passed = 0;
const ok = (name, fn) => { fn(); passed++; };

const ids = new Set(codex.entries.map((e) => e.id));
ok("ids are unique", () => assert.strictEqual(ids.size, codex.entries.length));
ok("levels are declared", () => { for (const e of codex.entries) assert.ok(e.level in codex.levels, `${e.id} level`); });

const words = (s) => String(s).trim().split(/\s+/).length;
const prose = (e) => [e.short, e.game, e.world, e.example.text, e.trp.text, e.check.why].concat(e.check.options);
for (const e of codex.entries) {
  ok(`${e.id} has every field`, () => {
    for (const k of ["term", "short", "game", "world", "example", "trp", "related", "level", "check", "aliases", "frameworks"]) assert.ok(k in e, `${e.id} lacks ${k}`);
    assert.ok(e.example.text && e.example.basis, `${e.id} example`);
    assert.ok(e.trp.text && e.trp.spec, `${e.id} trp`);
  });
  ok(`${e.id} is the right length`, () => {
    assert.ok(words(e.short) <= 32, `${e.id} short is ${words(e.short)} words`);
    assert.ok(words(e.world) >= 60 && words(e.world) <= 170, `${e.id} world is ${words(e.world)} words`);
    assert.ok(words(e.game) >= 20, `${e.id} game`);
  });
  ok(`${e.id} related entries exist`, () => { for (const r of e.related) assert.ok(ids.has(r), `${e.id} relates to unknown ${r}`); assert.ok(!e.related.includes(e.id)); });
  ok(`${e.id} cites a real specification section`, () => {
    const s = e.trp.spec;
    const re = s === "Conformance" ? /^## Conformance/m : new RegExp(`^#{2,3} ${s.replace(".", "\\.")}[. ]`, "m");
    assert.ok(re.test(spec), `${e.id} cites section ${s}, which is not in spec/trp-spec.md`);
  });
  ok(`${e.id} quiz is sound`, () => {
    const q = e.check;
    assert.strictEqual(q.options.length, 4, `${e.id} needs four options`);
    assert.ok(Number.isInteger(q.answer) && q.answer >= 0 && q.answer < 4, `${e.id} answer index`);
    assert.ok(q.question.endsWith("?"), `${e.id} question`);
    assert.ok(new Set(q.options).size === 4, `${e.id} duplicate options`);
  });
  ok(`${e.id} follows house style`, () => {
    for (const t of prose(e)) {
      const bad = STYLE.check(t);
      assert.ok(!bad, `${e.id} contains ${bad}: ${t.slice(0, 80)}`);
    }
    assert.ok(/^[A-Z]/.test(e.term), `${e.id} term case`);
  });
}

ok("every threat in the game unlocks an entry", () => {
  for (const kind of Object.keys(C.KINDS)) assert.ok(codex.unlocks[kind] && ids.has(codex.unlocks[kind]), `no unlock for ${kind}`);
  for (const [k, id] of Object.entries(codex.unlocks)) assert.ok(ids.has(id), `${k} unlocks unknown ${id}`);
});
ok("the three depths are all used", () => {
  const levels = new Set(codex.entries.map((e) => e.level));
  for (const l of Object.keys(codex.levels)) assert.ok(levels.has(l), `no ${l} entries`);
});
ok("the open repository names no commercial offering", () => {
  const text = JSON.stringify(codex).toLowerCase();
  for (const banned of ["striv", "trust academy", "\\baria\\b", "trust os", "learn.striv"]) assert.ok(!new RegExp(banned).test(text), `codex mentions ${banned}`);
});
console.log(`Codex content: ${passed} passed, 0 failed (${codex.entries.length} entries)`);
