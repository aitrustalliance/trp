#!/usr/bin/env node
/**
 * Headless playtest. Sails every chapter under every rule book with several
 * kinds of captain and prints what happened, so balance decisions rest on
 * numbers. No drawing, no browser.
 *
 *   node studio/nautilus/playtest.js            # the table
 *   node studio/nautilus/playtest.js --json     # one record per run
 */
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("./core.js");
const E = require("../engine.js");

const ROOT = path.join(__dirname, "..", "..");
const camp = JSON.parse(fs.readFileSync(path.join(__dirname, "campaign.json"), "utf-8"));
const books = {};
for (const rb of camp.fittings.rules) if (rb.profile) books[rb.id] = JSON.parse(fs.readFileSync(path.normalize(path.join(__dirname, rb.profile)), "utf-8"));

// Captains. Each returns a policy (voyage, dt).
const CAPTAINS = {
  // Does nothing. Shows what the rules do on their own.
  idle: () => () => {},
  // Slow to notice, misses often, dodges late, never touches the lever.
  novice: (seed) => {
    let cool = 0; const r = C.rng((seed || 1) ^ 0x51ed27);
    const ignored = new Set();
    return (v, dt) => {
      cool -= dt;
      const threats = v.payloads.filter((p) => !ignored.has(p.id) && p.y > C.WATER + 60 && v.t - p.born > 2.0 && !v.harpoons.some((h) => h.target === p.id));
      threats.sort((a, b) => b.y - a.y);
      if (cool <= 0 && v.steam >= 1 && threats.length) {
        const p = threats[0];
        if (r() < 0.45) ignored.add(p.id); else { v.fire(p.id); cool = 1.2; }
      }
      const charge = v.payloads.find((p) => p.kind === "charge" && Math.abs(p.x - C.SUB_X) < 110);
      if (charge) v.setDepth(charge.fuseY < 440 ? v.depthMax - 20 : v.depthMin + 20);
    };
  },
  // The reference captain that sets par.
  steady: (seed) => C.referencePolicy(seed),
  // Quick, accurate, and deliberate about the Decree.
  expert: (seed) => {
    let cool = 0; const r = C.rng((seed || 1) ^ 0x9e3779b9);
    const ignored = new Set();
    return (v, dt) => {
      cool -= dt;
      const threats = v.payloads.filter((p) => !ignored.has(p.id) && p.y > C.WATER + 10 && v.t - p.born > 0.5 && !v.harpoons.some((h) => h.target === p.id && p.kind !== "writ"));
      threats.sort((a, b) => (b.kind === "writ") - (a.kind === "writ") || Math.abs(a.x - C.SUB_X) - Math.abs(b.x - C.SUB_X));
      if (cool <= 0 && v.steam >= 1 && threats.length) {
        const p = threats[0];
        if (p.kind !== "writ" && r() < 0.04) ignored.add(p.id); else { v.fire(p.id); cool = 0.4; }
      }
      const charge = v.payloads.find((p) => p.kind === "charge" && Math.abs(p.x - C.SUB_X) < 280);
      if (charge) v.setDepth(charge.fuseY < 440 ? v.depthMax - 20 : v.depthMin + 20);
      else v.setDepth(380);
    };
  },
  // Steady, and pulls the lever when a threat is about to land or a clam is near.
  lever: (seed) => {
    const base = C.referencePolicy(seed);
    let hold = 0;
    return (v, dt) => {
      base(v, dt);
      hold -= dt;
      const close = v.payloads.some((p) => p.kind !== "charge" && p.y > v.sub.y - 90 && Math.abs(p.x - C.SUB_X) < 70);
      const clam = v.clams.some((cl) => !cl.done && Math.abs(cl.x - C.SUB_X) < 160);
      if (clam) v.setDepth(v.depthMax);
      if ((close || clam) && !v.manualStop) { v.setManualStop(true); hold = clam ? 2.2 : 1.4; }
      else if (v.manualStop && hold <= 0 && !clam) v.setManualStop(false);
    };
  },
};

function sail(ch, book, captain, difficulty, seed) {
  const v = new C.Voyage({ engine: E, profileRaw: books[book], seed, difficulty, chapter: ch, duration: ch.duration });
  const act = CAPTAINS[captain](seed);
  const dt = 1 / 60;
  let quiet = 0, half = 0, sunkAt = null, firstHit = null, decreeFor = 0;
  while (!v.done) {
    act(v, dt); v.step(dt);
    for (const e of v.drain()) { if (e.type === "hit" && firstHit === null) firstHit = v.t; }
    if (!v.payloads.length && !v.chests.length && !v.clams.length) quiet += dt;
    if (v.response === "restricted") half += dt;
    if (v.rulesCaptured) decreeFor += dt;
    if (v.done && v.outcome === "sunk") sunkAt = v.t;
  }
  const s = v.summary();
  return Object.assign({ chapter: ch.id, book, captain, difficulty, seed, quiet_s: +quiet.toFixed(1), half_s: +half.toFixed(1), sunk_at: sunkAt && +sunkAt.toFixed(1), first_hit: firstHit && +firstHit.toFixed(1), decree_s: +decreeFor.toFixed(1), t: +v.t.toFixed(1) }, s);
}

const json = process.argv.includes("--json");
const rows = [];
for (const ch of camp.chapters) for (const book of Object.keys(books)) for (const captain of Object.keys(CAPTAINS)) {
  rows.push(sail(ch, book, captain, "normal", 7000 + ch.id * 13));
}
for (const ch of camp.chapters) for (const difficulty of ["easy", "hard"]) rows.push(sail(ch, "standard", "steady", difficulty, 7000 + ch.id * 13));

if (json) { for (const r of rows) console.log(JSON.stringify(r)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
const num = (x, n) => String(x == null ? "-" : x).padStart(n);
console.log(pad("ch", 3) + pad("book", 9) + pad("captain", 8) + pad("diff", 7) + num("out", 5) + num("score", 7) + num("lgs", 5) + num("hits", 5) + num("cgt", 4) + num("prv", 4) + num("stop", 6) + num("idle", 5) + num("half", 6) + num("quiet", 6) + num("sunk@", 6) + num("brass", 6) + num("pages", 6) + num("decree", 7));
for (const r of rows) {
  console.log(pad(r.chapter, 3) + pad(r.book, 9) + pad(r.captain, 8) + pad(r.difficulty, 7) + num(r.outcome === "harbor" ? "port" : "SUNK", 5) + num(r.score, 7) + num(r.leagues, 5) + num(r.hits, 5) + num(r.caught, 4) + num(r.prevented, 4) + num(r.stopped_s, 6) + num(r.needless_s, 5) + num(r.half_s, 6) + num(r.quiet_s, 6) + num(r.sunk_at, 6) + num(r.gears, 6) + num(r.relics + r.chests + r.pearls, 6) + num(r.decree_s, 7));
}
