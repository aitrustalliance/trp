#!/usr/bin/env node
/**
 * Play the TRP Arena or run a stress test from the command line.
 * Built for AI agents, test harnesses and auditors. Output is JSON.
 *
 *   node studio/games-cli.js --list
 *   node studio/games-cli.js --event robot-cell --guards second-sensor,speed-limit
 *   node studio/games-cli.js --event agno --stress 1000
 *   node studio/games-cli.js --event healthcare --par
 *
 * Options: --seed <n> plays a specific seed (default today's UTC date),
 * --player <name> labels the result.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const E = require("./engine.js");
const S = require("./sim.js");
const A = require("./arena.js");

const dir = __dirname;
const deps = { engine: E, sim: S };

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

function loadEvents() {
  const index = JSON.parse(fs.readFileSync(path.join(dir, "packs", "index.json"), "utf-8"));
  const out = {};
  for (const item of index.packs) {
    const file = path.join(dir, "packs", item.path);
    const pack = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!pack.arena) continue;
    pack.profileObject = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), pack.profile), "utf-8"));
    out[pack.id] = pack;
  }
  return out;
}

function main() {
  const events = loadEvents();
  if (arg("list")) {
    const list = Object.values(events).map((p) => ({
      event: p.id, title: p.arena.event, budget: p.arena.budget, rounds: p.arena.rounds,
      guards: p.arena.guards.map((g) => ({ id: g.id, label: g.label, cost: g.cost, detail: g.detail })),
      challenger_moves: p.arena.moves.map((m) => ({ id: m.id, label: m.label })),
    }));
    console.log(JSON.stringify({ day: A.dayNumber(), seed: A.daySeed(), events: list }, null, 2));
    return;
  }
  const pack = events[arg("event", "")];
  if (!pack) {
    console.error(`Unknown event. Choose one of: ${Object.keys(events).join(", ")}`);
    process.exit(2);
  }
  const seed = Number(arg("seed", A.daySeed()));
  if (arg("stress")) {
    const n = Math.min(Number(arg("stress")) || 300, 100000);
    const r = A.stressTest(pack, pack.profileObject, { episodes: n, seed: seed }, deps);
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const par = A.par(pack, pack.profileObject, seed, deps);
  if (arg("par")) {
    console.log(JSON.stringify({ event: pack.id, seed: seed, par: par.score, guards: par.guards }, null, 2));
    return;
  }
  const guards = String(arg("guards", "") || "").split(",").filter(Boolean);
  const unknown = guards.filter((g) => !pack.arena.guards.some((x) => x.id === g));
  if (unknown.length) { console.error(`Unknown guards: ${unknown.join(", ")}`); process.exit(2); }
  const cost = guards.reduce((s, id) => s + pack.arena.guards.find((g) => g.id === id).cost, 0);
  if (cost > pack.arena.budget) { console.error(`Guards cost ${cost}, over the budget of ${pack.arena.budget}.`); process.exit(2); }
  const m = new A.Match(pack, pack.profileObject, guards, { seed: seed }, deps);
  while (!m.done) m.step(0.05);
  console.log(JSON.stringify({
    event: pack.id, day: A.dayNumber(), seed: seed, guards: guards, player: arg("player", "agent"),
    score: m.summary.score, par: par.score, medal: A.medal(m.summary.score, par.score), summary: m.summary,
    incidents: m.tally.incidents.map((i) => ({ start: i.start, end: i.end, challenger: i.label, harms: i.harms, caught: i.caught, reaction_s: i.reaction })),
  }, null, 2));
}

main();
