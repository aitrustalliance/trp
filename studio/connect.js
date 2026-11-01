/**
 * TRP Studio Connect. Evidence from outside the Studio.
 *
 * Every source yields the same thing: evidence objects, one per reading,
 * mapping signal names to values, judged by the engine against the profile
 * of the open pack. A source stands in for the simulator, so the scene, the
 * readout, the event log and the exports all work unchanged.
 *
 *   Source interface (what app.js calls):
 *     values         latest values, for the scene
 *     evidence()     latest evidence object, as received
 *     omitted()      Set of profile signals missing from the latest evidence
 *     step(dt)       advance a replay, no-op for a live stream
 *     time           seconds since the source started
 *     position()     { episode_index, frame_index }
 *     controlState, setControl()  present and inert
 *     label, status, close()
 *
 * Parsers are pure functions and run in Node for tests.
 */
(function (root) {
  "use strict";

  const LIMITS = { frames: 200000, bytes: 32 * 1024 * 1024, signals: 128, message: 64 * 1024 };
  const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

  // Keeps only scalar values under safe keys. Unknown keys are kept, since a
  // profile may not use every field a system reports.
  function cleanEvidence(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (RESERVED.has(k) || k.length > 80) continue;
      if (typeof v === "number" ? Number.isFinite(v) : typeof v === "boolean" || (typeof v === "string" && v.length <= 200)) { out[k] = v; if (++n >= LIMITS.signals) break; }
    }
    return out;
  }

  // A line may be a bare evidence object, or { t, evidence }.
  function fromObject(o, i, hz) {
    if (!o || typeof o !== "object") return null;
    const inner = o.evidence && typeof o.evidence === "object" ? o.evidence : o;
    const ev = cleanEvidence(inner);
    if (!ev) return null;
    const t = typeof o.t === "number" ? o.t : typeof ev.t === "number" ? ev.t : i / hz;
    delete ev.t;
    return { t, evidence: ev };
  }

  function parseJSONL(text, opts) {
    const hz = (opts && opts.hz) || 4;
    if (text.length > LIMITS.bytes) throw new Error("That file is larger than 32 MB.");
    const trimmed = text.trim();
    // A JSON array of evidence objects is accepted too.
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed);
      return arr.slice(0, LIMITS.frames).map((o, i) => fromObject(o, i, hz)).filter(Boolean);
    }
    const out = [];
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < LIMITS.frames; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (err) { throw new Error(`Line ${i + 1} is not JSON.`); }
      const f = fromObject(o, out.length, hz);
      if (f) out.push(f);
    }
    return out;
  }

  function cell(v) {
    const s = v.trim();
    if (s === "") return undefined;
    if (s === "true" || s === "false") return s === "true";
    const n = Number(s);
    return Number.isFinite(n) && /^[-+.\d]/.test(s) ? n : s.replace(/^"|"$/g, "");
  }

  // CSV with a header row of signal names. An optional t, time or timestamp
  // column gives seconds. Empty cells are missing readings.
  function parseCSV(text, opts) {
    const hz = (opts && opts.hz) || 4;
    if (text.length > LIMITS.bytes) throw new Error("That file is larger than 32 MB.");
    const lines = text.trim().split(/\r?\n/);
    const head = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const tcol = head.findIndex((h) => /^(t|time|timestamp)$/i.test(h));
    const out = [];
    for (let i = 1; i < lines.length && out.length < LIMITS.frames; i++) {
      if (!lines[i].trim()) continue;
      const cells = lines[i].split(",");
      const o = {};
      head.forEach((h, j) => { if (j !== tcol && cells[j] !== undefined) { const v = cell(cells[j]); if (v !== undefined) o[h] = v; } });
      const ev = cleanEvidence(o);
      const t = tcol >= 0 ? Number(cells[tcol]) : out.length / hz;
      out.push({ t: Number.isFinite(t) ? t : out.length / hz, evidence: ev });
    }
    return out;
  }

  // OpenTelemetry metrics as OTLP/JSON, one MetricsData object per line, as
  // written by a Collector file exporter. Gauge and sum data points become
  // signals named by metric name, or by `map` when given. Points that share
  // a timestamp form one evidence object.
  function parseOTLP(text, opts) {
    const map = (opts && opts.map) || {};
    const byTime = new Map();
    for (const line of text.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const doc = JSON.parse(line);
      for (const rm of doc.resourceMetrics || []) for (const sm of rm.scopeMetrics || []) for (const m of sm.metrics || []) {
        const points = (m.gauge && m.gauge.dataPoints) || (m.sum && m.sum.dataPoints) || [];
        const name = map[m.name] || m.name;
        if (!name || RESERVED.has(name)) continue;
        for (const p of points) {
          const v = p.asDouble !== undefined ? Number(p.asDouble) : p.asInt !== undefined ? Number(p.asInt) : NaN;
          if (!Number.isFinite(v)) continue;
          const ns = String(p.timeUnixNano || "0");
          if (!byTime.has(ns)) byTime.set(ns, {});
          byTime.get(ns)[name] = v;
        }
      }
    }
    const times = [...byTime.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    if (!times.length) return [];
    const t0 = BigInt(times[0]);
    // Carry readings forward, so a signal reported less often stays present.
    const out = [], last = {};
    for (const ns of times) { Object.assign(last, byTime.get(ns)); out.push({ t: Number(BigInt(ns) - t0) / 1e9, evidence: cleanEvidence(Object.assign({}, last)) }); }
    return out;
  }

  function parseAny(text, name, opts) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".csv")) return parseCSV(text, opts);
    const head = text.slice(0, 400);
    if (/"resourceMetrics"/.test(head)) return parseOTLP(text, opts);
    if (/^\s*[{[]/.test(head)) return parseJSONL(text, opts);
    return parseCSV(text, opts);
  }

  // ---------------------------------------------------------------- Sources

  class Source {
    constructor(label, profile) {
      this.label = label; this.profile = profile || null;
      this.values = {}; this.latest = {}; this.time = 0; this.frame = 0;
      this.controlState = {}; this.status = ""; this.received = 0; this.onUpdate = null;
    }
    setControl() {}
    evidence() { return Object.assign({}, this.latest); }
    omitted() {
      const out = new Set();
      if (this.profile) for (const s of this.profile.scoredSignals) if (!(s.signal in this.latest)) out.add(s.signal);
      return out;
    }
    position() { return { episode_index: 0, frame_index: this.frame }; }
    accept(ev) {
      const clean = cleanEvidence(ev);
      if (!clean) return false;
      this.latest = clean;
      Object.assign(this.values, clean);
      this.received += 1;
      if (this.onUpdate) this.onUpdate(this);
      return true;
    }
    step(dt) { this.time += dt; }
    close() {}
  }

  // Replays parsed frames at their own timestamps, looping at the end.
  class ReplaySource extends Source {
    constructor(label, frames, profile, opts) {
      super(label, profile);
      if (!frames.length) throw new Error("No readings found in that file.");
      this.frames = frames; this.loop = !opts || opts.loop !== false; this.i = -1;
      this.t0 = frames[0].t; this.span = Math.max(0.25, frames[frames.length - 1].t - this.t0);
      this.status = `${frames.length.toLocaleString()} readings over ${this.span.toFixed(1)} s`;
      this.step(0);
    }
    step(dt) {
      this.time += dt;
      let t = this.time;
      if (this.loop) t = t % (this.span + 0.25);
      const target = this.t0 + t;
      let i = this.i;
      if (i >= 0 && this.frames[i].t > target) i = -1;
      while (i + 1 < this.frames.length && this.frames[i + 1].t <= target) i++;
      if (i !== this.i && i >= 0) { this.i = i; this.frame = i; this.accept(this.frames[i].evidence); }
    }
  }

  // A live stream. WebSocket (ws: or wss:) or Server-Sent Events (http: or
  // https:). Each message is an evidence object or { evidence }. With a
  // rosbridge topic, the Studio subscribes to a std_msgs/String topic whose
  // data field carries the evidence JSON.
  class StreamSource extends Source {
    constructor(url, profile, opts) {
      super(url, profile);
      const o = opts || {};
      const u = new URL(url, root.location ? root.location.href : undefined);
      if (!/^(wss?|https?):$/.test(u.protocol)) throw new Error("Use a ws:, wss:, http: or https: address.");
      if (u.username || u.password) throw new Error("Put credentials in the stream server, not the address.");
      this.url = u.href;
      this.status = "Connecting";
      const onText = (text) => {
        if (typeof text !== "string" || text.length > LIMITS.message) return;
        let o2; try { o2 = JSON.parse(text); } catch (err) { return; }
        if (o.rosTopic && o2 && o2.op === "publish") { try { o2 = JSON.parse(o2.msg && o2.msg.data); } catch (err) { return; } }
        const f = fromObject(o2, this.received, 4);
        if (f && this.accept(f.evidence)) { this.frame = this.received; this.status = `Live, ${this.received.toLocaleString()} readings`; }
      };
      if (/^wss?:$/.test(u.protocol)) {
        const ws = new root.WebSocket(this.url);
        this.conn = ws;
        ws.onopen = () => {
          this.status = "Connected, waiting for readings";
          if (o.rosTopic) ws.send(JSON.stringify({ op: "subscribe", topic: o.rosTopic, type: "std_msgs/msg/String" }));
          if (this.onUpdate) this.onUpdate(this);
        };
        ws.onmessage = (m) => onText(m.data);
        ws.onerror = () => { this.status = "Connection failed"; if (this.onUpdate) this.onUpdate(this); };
        ws.onclose = () => { if (!this.closed) { this.status = `Closed after ${this.received.toLocaleString()} readings`; if (this.onUpdate) this.onUpdate(this); } };
      } else {
        const es = new root.EventSource(this.url);
        this.conn = es;
        es.onopen = () => { this.status = "Connected, waiting for readings"; if (this.onUpdate) this.onUpdate(this); };
        es.onmessage = (m) => onText(m.data);
        es.onerror = () => { this.status = this.received ? `Reconnecting after ${this.received.toLocaleString()} readings` : "Connection failed"; if (this.onUpdate) this.onUpdate(this); };
      }
    }
    close() { this.closed = true; try { this.conn.close(); } catch (err) { /* already closed */ } }
  }

  // Readings pushed by a script on the page: window.TRPStudio.ingest(obj).
  class IngestSource extends Source {
    constructor(profile) { super("Page API", profile); this.status = "Waiting for window.TRPStudio.ingest(evidence)"; }
    push(ev) { if (this.accept(ev)) { this.frame = this.received; this.status = `${this.received.toLocaleString()} readings from the page API`; return true; } return false; }
  }

  root.TRPConnect = { parseJSONL, parseCSV, parseOTLP, parseAny, cleanEvidence, ReplaySource, StreamSource, IngestSource, LIMITS };
  if (typeof module !== "undefined" && module.exports) module.exports = root.TRPConnect;
})(typeof window !== "undefined" ? window : globalThis);
