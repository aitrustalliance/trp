#!/usr/bin/env node
// Checks studio/lerobot.js turns LeRobot-shaped rows into TRP evidence.
// The rows below are a hand-written test fixture in the documented LeRobot
// v3.0 shape, not recorded robot data.
"use strict";
const assert = require("assert");
const L = require("../studio/lerobot.js");
const E = require("../studio/engine.js");
const fs = require("fs");
const path = require("path");

const rows = [0, 1, 2, 3, 4].map((i) => ({
  episode_index: 0, frame_index: i, timestamp: i / 30,
  "observation.state": [0, 10 + i, 20, 30, 0, 5],
  action: [0, 10 + i + (i === 3 ? 30 : 0), 20, 30, 0, 5],
}));
rows.push({ episode_index: 0, frame_index: 5, timestamp: 1.0, "observation.state": [0, 15, 20, 30, 0, 5], action: [0, 15, 20, 30, 0, 5] });
const ev = L.toEvidence(rows, 30);
assert.strictEqual(ev.length, 6);
assert.strictEqual(ev[1].evidence.peak_joint_speed, 30);
assert.strictEqual(ev[3].evidence.tracking_error, 30);
assert.strictEqual(ev[5].evidence.frame_gap, true);
const profile = E.loadProfile(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "examples", "arm-motion", "trp.json"), "utf-8")));
assert.strictEqual(E.evaluate(profile, ev[0].evidence).standing, "good");
assert.strictEqual(E.evaluate(profile, ev[3].evidence).standing, "failing");
assert.strictEqual(E.evaluate(profile, ev[5].evidence).standing, "failing");

// fetchEpisode against a stubbed API response.
const page = { features: [{ name: "observation.state", type: { feature: { names: ["a", "b", "c", "d", "e", "f"] } } }], num_rows_total: 6, rows: rows.map((r) => ({ row: r })) };
L.fetchEpisode("example/dataset", 0, { fetch: async () => ({ ok: true, json: async () => page }) }).then((r) => {
  assert.strictEqual(r.frames.length, 6);
  assert.deepStrictEqual(r.names, ["a", "b", "c", "d", "e", "f"]);
  console.log("LeRobot parsing: all checks passed");
});

// Webcam distance math.
const W = require("../studio/webcam.js");
const lm = []; lm[11] = { x: 0.4, y: 0.5 }; lm[12] = { x: 0.6, y: 0.5 };
const width = W.shoulderWidth(lm);
assert.ok(Math.abs(width - 0.2) < 1e-9);
const kk = W.calibrate(width, 1.5);
assert.ok(Math.abs(W.distanceFrom(0.1, kk) - 3) < 1e-9);
assert.strictEqual(W.shoulderWidth([]), null);
console.log("Webcam distance: all checks passed");
