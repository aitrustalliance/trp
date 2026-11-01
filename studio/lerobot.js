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
 */
(function (root) {
  "use strict";

  const API = "https://datasets-server.huggingface.co/rows";

  async function fetchEpisode(dataset, episode, opts) {
    const o = opts || {};
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

  const api = { fetchEpisode, toEvidence, jointNames, API };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.TRPLeRobot = api;
})(typeof window !== "undefined" ? window : globalThis);
