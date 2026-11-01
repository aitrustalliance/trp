#!/usr/bin/env node
/**
 * Run TRP Arena matches between contestants on your own machine.
 *
 *   node studio/match.js --event robot-cell --guardian builtin:greedy --challenger builtin:random
 *   node studio/match.js --event agno --versus "node studio/agents/greedy.js" "python3 studio/agents/random_agent.py"
 *   node studio/match.js --event robot-cell --versus builtin:greedy builtin:random --out match.json
 *   node studio/match.js --verify match.json
 *
 * A contestant is builtin:greedy, builtin:random, builtin:scripted (the
 * Studio's own Challenger, Challenger side only), builtin:guards=a,b (a
 * Guardian that always buys those guards), or a command that speaks
 * the TRP Arena Protocol over standard input and output. See
 * studio/ARENA_PROTOCOL.md.
 *
 * Commands you pass run as ordinary programs with your permissions. The
 * runner limits reply time and line length and stops every program when the
 * match ends, but it does not sandbox them. Run contestants you did not write
 * inside a container.
 *
 * Options: --seed <n> (default today's UTC date), --timeout <ms> per reply
 * (default 5000), --names a,b, --out <file> saves the match record.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const E = require("./engine.js");
const S = require("./sim.js");
const A = require("./arena.js");
const V = require("./versus.js");
const STRATS = require("./agents/strategies.js");

const MAX_LINE = 64 * 1024;
const MAX_MATCH_MS = 10 * 60 * 1000;
const deps = { engine: E, sim: S, arena: A };

function args() {
  const a = process.argv.slice(2);
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const key = a[i].slice(2);
      if (key === "versus") { out.versus = [a[i + 1], a[i + 2]]; i += 2; continue; }
      const v = a[i + 1];
      if (v === undefined || v.startsWith("--")) out[key] = true; else { out[key] = v; i++; }
    } else out._.push(a[i]);
  }
  return out;
}

function loadEvents() {
  const dir = __dirname;
  const index = JSON.parse(fs.readFileSync(path.join(dir, "packs", "index.json"), "utf-8"));
  const events = {};
  for (const item of index.packs) {
    const file = path.join(dir, "packs", item.path);
    const pack = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!pack.arena) continue;
    pack.profileObject = JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), pack.profile), "utf-8"));
    events[pack.id] = pack;
  }
  return events;
}

// The Studio's scripted Challenger, wrapped as a contestant, so a match here
// plays exactly like the Arena in the browser.
function scripted(pack, seed) {
  let plan = null;
  return function (msg) {
    if (msg.type === "choose_move") {
      if (!plan) plan = A.challengerPlan(pack.arena, msg.guards_in_play, seed);
      return { move: plan[msg.round].id };
    }
    if (msg.type === "choose_guards") return { guards: [] };
    return null;
  };
}

// A Guardian that always buys the same guards.
function fixed(ids) {
  return (msg) => (msg.type === "choose_guards" ? { guards: ids } : null);
}

// A program speaking the protocol over standard input and output.
function program(command, name, procs) {
  // Each contestant runs in its own process group, so stopping it also stops
  // anything its command line started.
  const child = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "inherit"] });
  child.stop = () => {
    try { if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill(); } catch (err) { /* already gone */ }
  };
  procs.push(child);
  const waiting = new Map();
  let nextId = 1;
  let dead = null;
  child.on("exit", (code) => { dead = `${name} exited with code ${code}`; for (const w of waiting.values()) w.reject(new Error(dead)); waiting.clear(); });
  child.on("error", (err) => { dead = `${name} could not start: ${err.message}`; });
  child.stdin.on("error", () => {});
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.length > MAX_LINE) { dead = `${name} sent a line over ${MAX_LINE} bytes`; child.stop(); return; }
    let msg;
    try { msg = JSON.parse(line); } catch (err) { return; }
    if (!msg || typeof msg !== "object") return;
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w.resolve(msg); }
  });
  return function (msg) {
    if (dead) return Promise.reject(new Error(dead));
    const needsReply = msg.type === "choose_guards" || msg.type === "choose_move";
    const out = needsReply ? Object.assign({ id: nextId++ }, msg) : msg;
    child.stdin.write(JSON.stringify(out) + "\n");
    if (!needsReply) return Promise.resolve(null);
    return new Promise((resolve, reject) => waiting.set(out.id, { resolve, reject }));
  };
}

function contestant(spec, name, procs, pack, seed) {
  if (spec === "builtin:greedy") return STRATS.greedy();
  if (spec === "builtin:random") return STRATS.random();
  if (spec === "builtin:scripted") return scripted(pack, seed);
  if (typeof spec === "string" && spec.startsWith("builtin:guards=")) return fixed(spec.slice(15).split(",").filter(Boolean));
  if (typeof spec !== "string" || !spec.trim()) throw new Error(`No command given for ${name}.`);
  return program(spec, name, procs);
}

async function main() {
  const o = args();
  const events = loadEvents();

  if (o.verify) {
    const record = JSON.parse(fs.readFileSync(o.verify, "utf-8"));
    const pack = events[record.event];
    if (!pack) throw new Error(`Unknown event ${record.event}.`);
    const r = await V.verify(record, { pack, profileRaw: pack.profileObject, deps });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  const pack = events[o.event];
  if (!pack) { console.error(`Choose an event with --event: ${Object.keys(events).join(", ")}`); process.exit(2); }
  const seed = o.seed ? Number(o.seed) >>> 0 : A.daySeed();
  const timeoutMs = o.timeout ? Math.max(100, Math.min(120000, Number(o.timeout))) : 5000;
  const procs = [];
  const killAll = () => { for (const p of procs) p.stop(); };
  const guard = setTimeout(() => { console.error("Match took longer than 10 minutes and was stopped."); killAll(); process.exit(1); }, MAX_MATCH_MS);
  process.on("SIGINT", () => { killAll(); process.exit(130); });

  try {
    let record;
    if (o.versus) {
      const names = o.names ? String(o.names).split(",") : [o.versus[0], o.versus[1]].map((c, i) => (c.startsWith("builtin:") ? c.slice(8) : "contestant-" + (i + 1)));
      if (names[0] === names[1]) names[1] += "-2";
      // Fresh contestants for each leg, so no state carries across sides.
      const fresh = (spec, name) => { let current = null; return { name, agent: (msg) => { if (msg.type === "hello") current = contestant(spec, name, procs, pack, seed); return current(msg); } }; };
      record = await V.playVersus({ pack, profileRaw: pack.profileObject, seed, deps, timeoutMs, a: fresh(o.versus[0], names[0]), b: fresh(o.versus[1], names[1]) });
    } else {
      const g = contestant(o.guardian || "builtin:greedy", "guardian", procs, pack, seed);
      const c = contestant(o.challenger || "builtin:scripted", "challenger", procs, pack, seed);
      const leg = await V.playLeg({ pack, profileRaw: pack.profileObject, seed, deps, timeoutMs, guardian: g, challenger: c });
      const par = A.par(pack, pack.profileObject, seed, deps);
      record = { protocol: V.PROTOCOL, event: pack.id, seed, legs: [Object.assign({ guardian: o.guardian || "builtin:greedy", challenger: o.challenger || "builtin:scripted" }, leg)], par: par.score, medal: A.medal(leg.summary.score, par.score) };
    }
    if (o.out) fs.writeFileSync(o.out, JSON.stringify(record, null, 2));
    console.log(JSON.stringify(record, null, 2));
  } finally {
    clearTimeout(guard);
    killAll();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
