#!/usr/bin/env node
/**
 * Parity check between the TRP Studio engine (studio/engine.js) and the
 * Node.js reference evaluator (tools/evaluate.js).
 *
 * For every example profile, it evaluates each evidence file in
 * tests/evidence plus a generated sample with both implementations and
 * requires identical output, ignoring the evaluation metadata block that
 * carries a timestamp and hash.
 *
 * Usage: node tests/studio_parity.js
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const engine = require("../studio/engine.js");

const root = path.resolve(__dirname, "..");
const evaluator = path.join(root, "tools", "evaluate.js");

function findProfiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findProfiles(full));
    else if (entry.name === "trp.json") out.push(full);
  }
  return out.sort();
}

function reference(profilePath, evidencePath) {
  const out = JSON.parse(execFileSync("node", [evaluator, profilePath, evidencePath], { encoding: "utf-8" }));
  delete out.evaluation;
  return out;
}

function studio(profilePath, evidencePath) {
  const profile = engine.loadProfile(JSON.parse(fs.readFileSync(profilePath, "utf-8")));
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf-8"));
  const drift = profile.driftWindow > 0 ? new engine.DriftDetector(profile.driftWindow, profile.driftSignals) : null;
  return engine.evaluate(profile, evidence, drift);
}

const profiles = findProfiles(path.join(root, "examples"));
const evidenceDir = path.join(root, "tests", "evidence");
const evidence = fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".json")).map((f) => path.join(evidenceDir, f)).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trp-parity-"));

let passed = 0;
let failed = 0;
for (const p of profiles) {
  const sample = path.join(tmp, path.basename(path.dirname(p)) + "-sample.json");
  const profile = engine.loadProfile(JSON.parse(fs.readFileSync(p, "utf-8")));
  fs.writeFileSync(sample, JSON.stringify(engine.generateSample(profile)));
  for (const e of [...evidence, sample]) {
    const a = JSON.stringify(reference(p, e));
    const b = JSON.stringify(studio(p, e));
    const label = `${path.relative(root, p)} with ${path.basename(e)}`;
    if (a === b) {
      passed += 1;
    } else {
      failed += 1;
      console.log(`FAIL ${label}\n  reference: ${a}\n  studio:    ${b}`);
    }
  }
}
console.log(`Studio parity: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed ? 1 : 0);
