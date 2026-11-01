/**
 * LeRobot dataset replay (experimental).
 *
 * Loads one episode of a public LeRobot robot dataset from the Hugging Face
 * dataset viewer API, then turns each recorded frame into TRP evidence:
 *   peak_joint_speed   largest joint position change per second, from observation.state
 *   tracking_error     largest gap between commanded action and observed state
 *   action_jump        largest change in the commanded action since the previous frame
 *   frame_gap          true when a timestamp gap is more than three frame periods
 *
 * Status: written against the documented /rows API and the LeRobot v3.0
 * features (observation.state, action, timestamp, frame_index, episode_index).
 * Browser access (CORS) and datasets whose video columns block the row
 * viewer still need checking. See studio/DATA_SOURCES.md.
 *
 * Offline: synthEpisode() generates an SO-101-shaped pick-and-place episode
 * in the same row format, from a seeded trajectory generator with tracking
 * lag, sensor noise and optional injected faults. It is synthetic data and
 * says so. fetchEpisode(..., { fallback: true }) returns it when the network
 * or the dataset viewer fails.
 */
(function (root) {
  "use strict";

  const API = "https://datasets-server.huggingface.co/rows";

  async function fetchEpisode(dataset, episode, opts) {
    const o = opts || {};
    if (o.fallback) {
      try { return await fetchEpisode(dataset, episode, Object.assign({}, o, { fallback: false })); }
      catch (err) { return Object.assign(synthEpisode({ seed: o.seed || 101, episode, faults: o.faults }), { error: err.message }); }
    }
    const config = o.config || "default";
    const split = o.split || "train";
    const maxRows = o.maxRows || 1200;
    const fetchFn = o.fetch || root.fetch.bind(root);
    const frames = [];
    let names = null;
    for (let offset = 0; offset < 100000 && frames.length < maxRows; offset += 100) {
      const url = `${API}?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=100`;
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`The dataset viewer returned ${res.status} for ${dataset}.`);
      const page = await res.json();
      if (!names) names = jointNames(page.features || []);
      const rows = (page.rows || []).map((r) => r.row);
      if (!rows.length) break;
      for (const row of rows) {
        if (Number(row.episode_index) === episode) frames.push(row);
        else if (frames.length && Number(row.episode_index) > episode) return { frames, names };
      }
      if (offset + 100 >= (page.num_rows_total || 0)) break;
    }
    if (!frames.length) throw new Error(`No frames found for episode ${episode} in ${dataset}.`);
    return { frames, names };
  }

  function jointNames(features) {
    const f = features.find((x) => x.name === "observation.state");
    return f && f.type && f.type.feature && f.type.feature.names ? f.type.feature.names : null;
  }

  function vec(v) {
    if (Array.isArray(v)) return v.map(Number);
    return [];
  }

  // Turn recorded frames into a sequence of TRP evidence objects.
  function toEvidence(frames, fps) {
    const out = [];
    const period = 1 / (fps || 30);
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const prev = frames[i - 1];
      const state = vec(f["observation.state"]);
      const action = vec(f.action);
      const t = Number(f.timestamp);
      const dt = prev ? Math.max(1e-6, t - Number(prev.timestamp)) : period;
      const prevState = prev ? vec(prev["observation.state"]) : state;
      const prevAction = prev ? vec(prev.action) : action;
      const speed = state.reduce((m, v, j) => Math.max(m, Math.abs(v - (prevState[j] ?? v)) / dt), 0);
      const err = state.reduce((m, v, j) => Math.max(m, Math.abs((action[j] ?? v) - v)), 0);
      const jump = action.reduce((m, v, j) => Math.max(m, Math.abs(v - (prevAction[j] ?? v))), 0);
      out.push({
        t: t, frame_index: Number(f.frame_index), state: state, action: action,
        evidence: {
          peak_joint_speed: round(speed), tracking_error: round(err), action_jump: round(jump),
          frame_gap: !!prev && dt > period * 3,
        },
      });
    }
    return out;
  }

  function round(x) { return Math.round(x * 100) / 100; }

  // ---------------------------------------------------------------- Synthetic

  const JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"];
  function rng(seed) {
    let a = seed >>> 0;
    return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  // Minimum-jerk blend between two poses, 0 <= s <= 1.
  function minJerk(s) { return s * s * s * (10 - 15 * s + 6 * s * s); }

  // A pick-and-place episode for a six-joint arm, sampled at `fps`.
  // Faults: "rush" halves one segment, so joints move fast. "collision"
  // holds two joints while the command keeps moving, so tracking error grows.
  // "glitch" adds a two-frame jump to the command. "dropout" drops frames.
  function synthEpisode(opts) {
    const o = opts || {};
    const r = rng(o.seed || 101), fps = o.fps || 30, episode = o.episode || 0;
    const jitter = (k) => (r() - 0.5) * k;
    const home = [0, -40, 60, 20, 0, 10];
    const pick = [25 + jitter(10), 10 + jitter(6), 35 + jitter(6), 45 + jitter(6), 10, 10];
    const lift = pick.slice(); lift[1] -= 25; lift[2] += 15;
    const place = [-30 + jitter(10), 8 + jitter(6), 38 + jitter(6), 40 + jitter(6), -10, 10];
    const closed = (p) => { const q = p.slice(); q[5] = 45; return q; };
    const plan = [[home, 1.0], [pick, 2.2], [closed(pick), 0.8], [closed(lift), 1.6], [closed(place), 2.6], [place, 0.8], [home, 2.2]];
    const faults = o.faults !== undefined ? o.faults : ["rush", "collision", "glitch", "dropout"].filter(() => r() < 0.5);
    if (faults.includes("rush")) plan[4][1] *= 0.22;
    const keys = [];
    let tt = 0;
    for (let i = 1; i < plan.length; i++) { keys.push({ from: plan[i - 1][0], to: plan[i][0], t0: tt, t1: tt + plan[i][1] }); tt += plan[i][1]; }
    const total = tt + 0.6;
    const command = (t) => {
      const k = keys.find((x) => t >= x.t0 && t < x.t1) || keys[keys.length - 1];
      const s = Math.max(0, Math.min(1, (t - k.t0) / (k.t1 - k.t0)));
      const m = minJerk(s);
      return k.from.map((a, j) => a + (k.to[j] - a) * m);
    };
    // The collision lands mid-transfer, when the pan joint moves fastest.
    const transfer = keys[3], hitT = transfer.t0 + (transfer.t1 - transfer.t0) * (0.25 + r() * 0.2), holdS = 0.9;
    const glitchAt = 0.15 + r() * 0.7, dropAt = 0.2 + r() * 0.6;
    const frames = [], log = [];
    const noise = JOINTS.map(() => 0);
    let state = command(0), held = null, dropped = 0;
    for (let i = 0; i * (1 / fps) < total; i++) {
      const t = i / fps;
      const cmd = command(t);
      if (faults.includes("glitch") && Math.abs(t / total - glitchAt) < 1 / fps) { cmd[1] += 24; cmd[2] -= 18; if (!log.some((x) => x.kind === "glitch")) log.push({ kind: "glitch", t }); }
      // First-order tracking lag toward the command, with sensor noise.
      const alpha = 1 - Math.exp(-(1 / fps) / 0.06);
      state = state.map((v, j) => v + (cmd[j] - v) * alpha);
      if (faults.includes("collision") && t >= hitT && t < hitT + holdS) {
        if (!held) { held = state.slice(); log.push({ kind: "collision", t }); }
        state[0] = held[0]; state[1] = held[1];
      } else held = null;
      for (let j = 0; j < noise.length; j++) noise[j] += -noise[j] * 0.3 + (r() - 0.5) * 0.15;
      const observed = state.map((v, j) => Math.round((v + noise[j]) * 100) / 100);
      if (faults.includes("dropout") && t / total >= dropAt && dropped < 6) { dropped++; if (dropped === 1) log.push({ kind: "dropout", t }); continue; }
      frames.push({ "observation.state": observed, action: cmd.map((v) => Math.round(v * 100) / 100), timestamp: Math.round(t * 10000) / 10000, frame_index: i, episode_index: episode, index: i, task_index: 0 });
    }
    if (faults.includes("rush")) log.push({ kind: "rush", t: keys[3].t0 });
    return { frames, names: JOINTS.slice(), synthetic: true, faults: log.sort((a, b) => a.t - b.t) };
  }

  // The same frames as a dataset viewer /rows page, for an offline file.
  function rowsPage(frames) {
    return { features: [{ feature_idx: 0, name: "observation.state", type: { feature: { names: JOINTS.slice() } } }], rows: frames.map((row, i) => ({ row_idx: i, row, truncated_cells: [] })), num_rows_total: frames.length, num_rows_per_page: 100, partial: false };
  }

  const api = { fetchEpisode, toEvidence, jointNames, synthEpisode, rowsPage, JOINTS, API };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPLeRobot = api;
})(typeof window !== "undefined" ? window : globalThis);
