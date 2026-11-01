#!/usr/bin/env node
/**
 * Evidence bridge for TRP Studio. Zero dependencies, Node 18 or later.
 *
 * Takes evidence from any telemetry source and serves it to the Studio as
 * Server-Sent Events at http://127.0.0.1:<port>/events. In the Studio, open
 * Connect, choose Stream, and enter that address.
 *
 * Inputs (pick one):
 *   --stdin                 JSON lines, CSV or OTLP/JSON on standard input
 *   --file <path>           replay a file at its timestamps (or --hz), with --loop
 *   --demo <pack-id>        the Studio's own stochastic generator for a pack,
 *                           with the pack's faults injected at random
 *   POST /evidence          any HTTP client can push one evidence object or
 *                           an array of them, up to 64 KB per request
 *
 * Options:
 *   --port <n>              default 8787
 *   --host <addr>           default 127.0.0.1. Bind wider only behind a proxy.
 *   --origin <url>          value for Access-Control-Allow-Origin, default *
 *   --format jsonl|csv|otlp default from the file name or the first line
 *   --map metric=signal,... rename OTLP metrics or JSON keys to TRP signals
 *   --hz <n>                readings a second for files without timestamps, default 4
 *
 * Examples:
 *   node studio/bridge/evidence-bridge.js --demo humanoid-floor
 *   mosquitto_sub -t 'plant/+/evidence' | node studio/bridge/evidence-bridge.js --stdin
 *   node studio/bridge/evidence-bridge.js --file run.otlp.jsonl --format otlp --map robot.balance.margin=balance_margin_m
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const C = require("../connect.js");

function args(argv) {
  const o = { port: 8787, host: "127.0.0.1", origin: "*", hz: 4, map: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === "--port") o.port = Number(next());
    else if (a === "--host") o.host = next();
    else if (a === "--origin") o.origin = next();
    else if (a === "--format") o.format = next();
    else if (a === "--hz") o.hz = Number(next());
    else if (a === "--file") o.file = next();
    else if (a === "--loop") o.loop = true;
    else if (a === "--stdin") o.stdin = true;
    else if (a === "--demo") o.demo = next();
    else if (a === "--map") for (const pair of next().split(",")) { const [k, v] = pair.split("="); if (k && v) o.map[k.trim()] = v.trim(); }
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const opts = args(process.argv.slice(2));
if (opts.help) { console.log(fs.readFileSync(__filename, "utf-8").split("*/")[0]); process.exit(0); }

const clients = new Set();
let sent = 0;
function rename(ev) {
  if (!Object.keys(opts.map).length) return ev;
  const out = {};
  for (const [k, v] of Object.entries(ev)) out[opts.map[k] || k] = v;
  return out;
}
function broadcast(ev, t) {
  const clean = C.cleanEvidence(rename(ev));
  if (!clean || !Object.keys(clean).length) return false;
  const line = `data: ${JSON.stringify(t === undefined ? clean : { t, evidence: clean })}\n\n`;
  for (const res of clients) res.write(line);
  sent += 1;
  return true;
}

const server = http.createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": opts.origin, "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }, cors));
    res.write(": trp evidence bridge\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
    res.end(JSON.stringify({ ok: true, clients: clients.size, sent }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/evidence") {
    let body = "";
    req.on("data", (d) => { body += d; if (body.length > C.LIMITS.message) { res.writeHead(413, cors); res.end(); req.destroy(); } });
    req.on("end", () => {
      let n = 0;
      try { const o = JSON.parse(body); for (const x of Array.isArray(o) ? o : [o]) if (broadcast(x.evidence || x)) n++; } catch (err) { res.writeHead(400, cors); res.end("Body must be JSON."); return; }
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
      res.end(JSON.stringify({ accepted: n }));
    });
    return;
  }
  res.writeHead(404, cors); res.end();
});

function parse(text, name) {
  const o = { hz: opts.hz, map: opts.map };
  if (opts.format === "csv") return C.parseCSV(text, o);
  if (opts.format === "otlp") return C.parseOTLP(text, o);
  if (opts.format === "jsonl") return C.parseJSONL(text, o);
  return C.parseAny(text, name, o);
}

function replay(frames) {
  let i = 0, start = Date.now();
  const t0 = frames[0].t;
  (function tick() {
    const now = (Date.now() - start) / 1000 + t0;
    while (i < frames.length && frames[i].t <= now) { broadcast(frames[i].evidence, frames[i].t); i++; }
    if (i >= frames.length) { if (!opts.loop) return; i = 0; start = Date.now(); }
    setTimeout(tick, 20);
  })();
}

function demo(packId) {
  const S = require("../sim.js");
  const file = path.join(__dirname, "..", "packs", packId, "pack.json");
  if (!/^[a-z0-9-]+$/.test(packId) || !fs.existsSync(file)) { console.error(`No pack named ${packId}.`); process.exit(1); }
  const pack = JSON.parse(fs.readFileSync(file, "utf-8"));
  const sim = new S.Simulator(pack);
  const random = S.makeRandom(Date.now() >>> 0);
  sim.random = S.makeRandom((Date.now() >>> 0) ^ 0x9e3779b9);
  const moves = (pack.arena && pack.arena.moves) || [];
  const tick = (pack.tick_ms || 250) / 1000;
  let until = 0;
  setInterval(() => {
    if (!sim.extraEffects && moves.length && random() < 0.04) { const m = moves[Math.floor(random() * moves.length)]; sim.extraEffects = m.effects; until = sim.time + 2 + random() * 3; console.log(`fault: ${m.label}`); }
    else if (sim.extraEffects && sim.time > until) sim.extraEffects = null;
    sim.step(tick);
    broadcast(sim.evidence(), Math.round(sim.time * 1000) / 1000);
  }, tick * 1000);
}

server.listen(opts.port, opts.host, () => {
  console.log(`TRP evidence bridge on http://${opts.host}:${server.address().port}/events`);
  if (opts.demo) demo(opts.demo);
  else if (opts.file) { const text = fs.readFileSync(opts.file, "utf-8"); const frames = parse(text, opts.file); console.log(`${frames.length} readings from ${opts.file}`); if (frames.length) replay(frames); }
  else if (opts.stdin || !process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    let header = null;
    rl.on("line", (line) => {
      if (!line.trim()) return;
      if (opts.format === "csv" || (!opts.format && !/^\s*[{[]/.test(line))) {
        if (!header) { header = line; return; }
        for (const f of C.parseCSV(header + "\n" + line, { hz: opts.hz })) broadcast(f.evidence);
        return;
      }
      try {
        const frames = opts.format === "otlp" || /"resourceMetrics"/.test(line) ? C.parseOTLP(line, { map: opts.map }) : C.parseJSONL(line, { hz: opts.hz });
        for (const f of frames) broadcast(f.evidence);
      } catch (err) { console.error(`skipped a line: ${err.message}`); }
    });
  }
});
