(function () {
  "use strict";
  const E = window.TRPEngine, L = window.TRPLeRobot, W = window.TRPWebcam;
  const $ = (id) => document.getElementById(id);
  const BAND_Y = { good: 0.2, review: 0.5, failing: 0.8 };

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Could not load ${path}`);
    return r.json();
  }

  // LeRobot replay
  let armProfile = null;
  async function replay() {
    const status = $("lr-status");
    const dataset = $("lr-dataset").value.trim();
    const episode = Number($("lr-episode").value) || 0;
    try {
      armProfile = armProfile || E.loadProfile(await loadJSON("../examples/arm-motion/trp.json"));
      status.textContent = `Fetching ${dataset}, episode ${episode}.`;
      const { frames } = await L.fetchEpisode(dataset, episode);
      const ev = L.toEvidence(frames, 30);
      const results = ev.map((f) => E.evaluate(armProfile, f.evidence));
      const counts = results.reduce((m, r) => (m[r.standing] = (m[r.standing] || 0) + 1, m), {});
      status.textContent = `${frames.length} frames. ` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") +
        `\nPeak joint speed ${Math.max(...ev.map((f) => f.evidence.peak_joint_speed))}, largest tracking error ${Math.max(...ev.map((f) => f.evidence.tracking_error))}.`;
      animate(results);
    } catch (err) {
      status.textContent = `${err.message}\nIf this is a network or CORS error, see DATA_SOURCES.md for the fix.`;
    }
  }

  function animate(results) {
    const c = $("lr-chart"), ctx = c.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    c.width = c.clientWidth * dpr; c.height = c.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const w = c.clientWidth, h = c.clientHeight;
    let i = 0;
    function frame() {
      const end = Math.min(results.length, i + 3);
      for (; i < end; i++) {
        const r = results[i];
        const x = (i / Math.max(1, results.length - 1)) * (w - 20) + 10;
        ctx.fillStyle = r.standing === "good" ? "#9aa3b5" : r.standing === "review" ? "#e6d3a1" : "#f4f6fb";
        ctx.fillRect(x, BAND_Y[r.standing] * h - 2, Math.max(1.5, (w - 20) / results.length), 4);
        $("lr-standing").textContent = cap(r.standing);
      }
      if (i < results.length) requestAnimationFrame(frame);
    }
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#626b80"; ctx.font = "11px sans-serif";
    for (const [k, y] of Object.entries(BAND_Y)) ctx.fillText(cap(k), 10, y * h - 8);
    frame();
  }

  // Webcam
  let cellProfile = null, k = null, lastWidth = null, distance = 2.6, camOn = false;
  async function cellEval() {
    cellProfile = cellProfile || E.loadProfile(await loadJSON("../examples/manufacturing-safety/trp.json"));
    const pack = await packBase();
    const evidence = Object.assign({}, pack, { human_distance_m: Math.round(distance * 100) / 100 });
    const r = E.evaluate(cellProfile, evidence);
    $("cam-distance").textContent = distance.toFixed(2) + " m";
    $("cam-standing").textContent = cap(r.standing);
  }
  let baseCache = null;
  async function packBase() {
    if (baseCache) return baseCache;
    const pack = await loadJSON("packs/robot-cell/pack.json");
    baseCache = {};
    for (const [name, s] of Object.entries(pack.signals)) baseCache[name] = s.base;
    return baseCache;
  }

  async function startCam() {
    const status = $("cam-status");
    try {
      await W.start($("cam-video"), (width) => {
        lastWidth = width;
        if (width && k) { distance = W.distanceFrom(width, k); cellEval(); }
        else if (!width) status.textContent = "No person in view.";
        else status.textContent = "Stand 1.5 m from the camera and press calibrate.";
      }, (msg) => { status.textContent = msg; });
      camOn = true;
      $("cam-cal").disabled = false;
    } catch (err) {
      status.textContent = `${err.message}\nUsing the slider instead. See DATA_SOURCES.md.`;
    }
  }

  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—"; }

  $("lr-load").addEventListener("click", replay);
  $("cam-start").addEventListener("click", startCam);
  $("cam-cal").addEventListener("click", () => {
    if (lastWidth) { k = W.calibrate(lastWidth, 1.5); $("cam-status").textContent = "Calibrated. Walk toward the camera."; }
  });
  $("cam-slider").addEventListener("input", (e) => { if (!camOn || !k) { distance = Number(e.target.value); cellEval(); } });
  cellEval();
})();
