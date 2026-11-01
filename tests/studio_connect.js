#!/usr/bin/env node
// Checks the Studio's outside-evidence path: the parsers, the replay
// source, the stochastic simulator, the synthetic LeRobot episode and the
// evidence bridge end to end over HTTP.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const C = require("../studio/connect.js");
const S = require("../studio/sim.js");
const E = require("../studio/engine.js");
const L = require("../studio/lerobot.js");

const root = path.join(__dirname, "..");
let passed = 0;
const tests = [];
const ok = (name, fn) => tests.push([name, fn]);

ok("JSON lines with and without a wrapper", () => {
  const f = C.parseJSONL('{"a":1,"b":true}\n{"t":0.5,"evidence":{"a":2}}\n\n{"a":3,"t":1}\n', { hz: 4 });
  assert.strictEqual(f.length, 3);
  assert.deepStrictEqual(f[0], { t: 0, evidence: { a: 1, b: true } });
  assert.deepStrictEqual(f[1], { t: 0.5, evidence: { a: 2 } });
  assert.deepStrictEqual(f[2], { t: 1, evidence: { a: 3 } });
});

ok("a JSON array is accepted", () => assert.strictEqual(C.parseJSONL('[{"a":1},{"a":2}]').length, 2));

ok("a bad line is reported by number", () => assert.throws(() => C.parseJSONL('{"a":1}\n{nope'), /Line 2/));

ok("CSV with a time column, typed cells and missing readings", () => {
  const f = C.parseCSV("timestamp,human_distance_m,estop_active,status\n0,2.5,false,valid\n0.25,,true,expired\n");
  assert.strictEqual(f.length, 2);
  assert.deepStrictEqual(f[0], { t: 0, evidence: { human_distance_m: 2.5, estop_active: false, status: "valid" } });
  assert.deepStrictEqual(f[1], { t: 0.25, evidence: { estop_active: true, status: "expired" } });
});

ok("OTLP/JSON metrics become evidence by timestamp, renamed and carried forward", () => {
  const line = (ns, pts) => JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: pts.map(([name, kind, v]) => ({ name, [kind]: { dataPoints: [{ timeUnixNano: String(ns), [typeof v === "string" ? "asInt" : "asDouble"]: v }] } })) }] }] });
  const text = [line(1e18, [["robot.balance.margin", "gauge", 0.07], ["robot.contact.force", "gauge", 12]]), line(1e18 + 5e8, [["robot.contact.force", "sum", "95"]])].join("\n");
  const f = C.parseOTLP(text, { map: { "robot.balance.margin": "balance_margin_m", "robot.contact.force": "contact_force_N" } });
  assert.strictEqual(f.length, 2);
  assert.deepStrictEqual(f[0], { t: 0, evidence: { balance_margin_m: 0.07, contact_force_N: 12 } });
  assert.deepStrictEqual(f[1], { t: 0.5, evidence: { balance_margin_m: 0.07, contact_force_N: 95 } });
  assert.strictEqual(C.parseAny(text, "metrics.jsonl").length, 2);
});

ok("hostile keys and values are dropped", () => {
  const ev = C.cleanEvidence(JSON.parse('{"__proto__":{"x":1},"constructor":1,"ok":1,"nan":null,"obj":{"a":1},"big":"' + "x".repeat(300) + '"}'));
  assert.deepStrictEqual(ev, { ok: 1 });
  assert.strictEqual({}.x, undefined);
});

ok("a replay source steps through frames at their timestamps and loops", () => {
  const frames = [{ t: 0, evidence: { a: 1 } }, { t: 1, evidence: { a: 2 } }, { t: 2, evidence: { a: 3 } }];
  const profile = E.loadProfile(JSON.parse(fs.readFileSync(path.join(root, "examples/humanoid-workforce/trp.json"), "utf-8")));
  const src = new C.ReplaySource("x", frames, profile);
  assert.deepStrictEqual(src.evidence(), { a: 1 });
  src.step(1.05); assert.deepStrictEqual(src.evidence(), { a: 2 });
  src.step(1); assert.deepStrictEqual(src.evidence(), { a: 3 });
  src.step(0.5); assert.deepStrictEqual(src.evidence(), { a: 1 });
  assert.ok(src.omitted().has("human_distance_m"));
  assert.throws(() => new C.ReplaySource("x", [], profile), /No readings/);
});

ok("the stochastic simulator is seeded, wanders, shocks and couples", () => {
  const pack = JSON.parse(fs.readFileSync(path.join(root, "studio/packs/humanoid-floor/pack.json"), "utf-8"));
  const run = () => { const sim = new S.Simulator(pack); const out = []; for (let i = 0; i < 2400; i++) { sim.step(0.05); out.push(sim.values.balance_margin_m); } return { out, sim }; };
  const a = run(), b = run();
  assert.deepStrictEqual(a.out, b.out, "same seed, same path");
  const min = Math.min(...a.out), max = Math.max(...a.out);
  assert.ok(max - min > 0.03, `balance wandered ${(max - min).toFixed(3)} m`);
  assert.ok(a.sim.shocksSeen > 0, "shocks arrived");
  const sim = new S.Simulator(pack);
  sim.setControl("payload", 20);
  for (let i = 0; i < 200; i++) sim.step(0.05);
  assert.ok(sim.values.payload_kg > 19 && sim.level.joint_torque_ratio > 0.9, `torque level ${sim.level.joint_torque_ratio} follows payload`);
});

ok("packs without stochastic fields draw the same sequence as before", () => {
  const pack = JSON.parse(fs.readFileSync(path.join(root, "studio/packs/robot-cell/pack.json"), "utf-8"));
  const sim = new S.Simulator(pack);
  for (let i = 0; i < 100; i++) sim.step(0.1);
  assert.strictEqual(sim.shocksSeen, 0);
  assert.deepStrictEqual(Object.keys(sim.ou), []);
});

ok("the synthetic LeRobot episode has the dataset row shape and its faults show in the evidence", () => {
  const prof = E.loadProfile(JSON.parse(fs.readFileSync(path.join(root, "examples/arm-motion/trp.json"), "utf-8")));
  const clean = L.synthEpisode({ seed: 7, faults: [] });
  const row = clean.frames[0];
  for (const k of ["observation.state", "action", "timestamp", "frame_index", "episode_index"]) assert.ok(k in row, `row has ${k}`);
  assert.strictEqual(row["observation.state"].length, 6);
  assert.ok(clean.synthetic);
  const good = L.toEvidence(clean.frames, 30).every((f) => E.evaluate(prof, f.evidence).standing === "good");
  assert.ok(good, "a clean episode stays good");
  for (const fault of ["collision", "glitch", "dropout"]) {
    const ep = L.synthEpisode({ seed: 7, faults: [fault] });
    const failing = L.toEvidence(ep.frames, 30).some((f) => E.evaluate(prof, f.evidence).standing === "failing");
    assert.ok(failing, `${fault} drives the arm profile to failing`);
    assert.strictEqual(ep.faults[0].kind, fault);
  }
  const page = L.rowsPage(clean.frames);
  assert.strictEqual(page.rows[0].row, clean.frames[0]);
  assert.strictEqual(page.num_rows_total, clean.frames.length);
});

ok("fetchEpisode falls back to the synthetic episode when the network fails", async () => {
  const got = await L.fetchEpisode("x/y", 0, { fallback: true, fetch: async () => { throw new Error("network down"); } });
  assert.ok(got.synthetic && got.frames.length > 100 && /network down/.test(got.error));
  await assert.rejects(L.fetchEpisode("x/y", 0, { fetch: async () => { throw new Error("network down"); } }));
});

function get(url) { return new Promise((resolve, reject) => http.get(url, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on("error", reject)); }
function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
    req.on("error", reject); req.end(body);
  });
}
function startBridge(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(root, "studio/bridge/evidence-bridge.js"), "--port", "0"].concat(extra || []), { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { const m = /127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve({ p, port: Number(m[1]) }); });
    p.on("error", reject);
    setTimeout(() => reject(new Error("bridge did not start")), 5000);
  });
}
function readEvents(port, n) {
  return new Promise((resolve, reject) => {
    const got = [];
    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      if (res.headers["access-control-allow-origin"] !== "*") reject(new Error("no CORS header"));
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith("data: ")) got.push(JSON.parse(chunk.slice(6))); }
        if (got.length >= n) { req.destroy(); resolve(got); }
      });
    });
    req.on("error", (e) => { if (got.length < n) reject(e); });
    setTimeout(() => reject(new Error(`only ${got.length} events`)), 8000);
  });
}

ok("the bridge relays POSTed evidence to Server-Sent Events subscribers", async () => {
  const { p, port } = await startBridge(["--map", "force=contact_force_N"]);
  try {
    const events = readEvents(port, 2);
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual((await post(`http://127.0.0.1:${port}/evidence`, JSON.stringify([{ force: 12 }, { evidence: { balance_margin_m: 0.05 } }]))).body, '{"accepted":2}');
    const got = await events;
    assert.deepStrictEqual(got[0], { contact_force_N: 12 });
    assert.deepStrictEqual(got[1], { balance_margin_m: 0.05 });
    assert.strictEqual((await post(`http://127.0.0.1:${port}/evidence`, "{nope")).status, 400);
    const h = JSON.parse((await get(`http://127.0.0.1:${port}/health`)).body);
    assert.ok(h.ok && h.sent === 2);
  } finally { p.kill(); }
});

ok("the bridge relays JSON lines from standard input", async () => {
  const { p, port } = await startBridge(["--stdin"]);
  try {
    const events = readEvents(port, 2);
    await new Promise((r) => setTimeout(r, 200));
    p.stdin.write('{"human_distance_m":1.2}\n{"human_distance_m":0.4,"estop_active":false}\n');
    const got = await events;
    assert.deepStrictEqual(got, [{ human_distance_m: 1.2 }, { human_distance_m: 0.4, estop_active: false }]);
  } finally { p.kill(); }
});

ok("the bridge relays CSV from standard input", async () => {
  const { p, port } = await startBridge(["--stdin", "--format", "csv"]);
  try {
    const events = readEvents(port, 2);
    await new Promise((r) => setTimeout(r, 200));
    p.stdin.write("human_distance_m,estop_active\n2.5,false\n0.5,true\n");
    const got = await events;
    assert.deepStrictEqual(got, [{ human_distance_m: 2.5, estop_active: false }, { human_distance_m: 0.5, estop_active: true }]);
  } finally { p.kill(); }
});

ok("the bridge streams the humanoid pack's own generator in demo mode", async () => {
  const { p, port } = await startBridge(["--demo", "humanoid-floor"]);
  try {
    const got = await readEvents(port, 4);
    assert.ok(got.every((x) => typeof x.t === "number" && typeof x.evidence.balance_margin_m === "number"));
    const profile = E.loadProfile(JSON.parse(fs.readFileSync(path.join(root, "examples/humanoid-workforce/trp.json"), "utf-8")));
    assert.ok(["good", "review", "failing"].includes(E.evaluate(profile, got[3].evidence).standing));
  } finally { p.kill(); }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("PASS  " + name); }
    catch (err) { console.log("FAIL  " + name + "\n      " + (err && err.message)); process.exitCode = 1; }
  }
  console.log(`Studio connect: ${passed} passed, ${tests.length - passed} failed`);
  process.exit(process.exitCode || 0);
})();
