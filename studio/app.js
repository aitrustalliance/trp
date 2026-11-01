/**
 * TRP Studio application. Loads scenario packs, runs the simulator, evaluates
 * every tick with the open TRP engine, and renders the scene and readout.
 */
(function () {
  "use strict";

  const E = window.TRPEngine;
  const S = window.TRPSim;
  const SCENES = window.TRPScenes;
  const $ = (id) => document.getElementById(id);

  const RESPONSE_TEXT = { full: "Full operation", restricted: "Restricted operation", suspended: "Suspended", unknown: "No response defined" };
  const ACTION_WORD = { halt: "Halted", block_startup: "Startup blocked", require_review: "Held for review" };
  const ACTION_PRIORITY = ["halt", "block_startup", "require_review"];

  const app = {
    packs: [],          // { id, title, source, pack }
    current: null,      // active pack entry
    profile: null,      // engine profile
    sim: null,
    drift: null,
    result: null,
    paused: false,
    tickAcc: 0,
    events: [],
    frames: [],
    lastKey: null,
    story: null,
    sceneState: {},
    controlEls: {},
  };

  // ------------------------------------------------------------------ Loading

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
    return res.json();
  }

  async function loadIndex() {
    const index = await fetchJSON("packs/index.json");
    for (const item of index.packs) {
      try {
        const pack = await fetchJSON("packs/" + item.path);
        const base = new URL("packs/" + item.path, location.href);
        pack.profileObject = await fetchJSON(new URL(pack.profile, base).href);
        app.packs.push({ id: pack.id, title: pack.title, pack: pack });
      } catch (err) {
        console.warn(err);
      }
    }
  }

  function addCustomPack(pack) {
    const existing = app.packs.findIndex((p) => p.id === pack.id);
    const entry = { id: pack.id, title: pack.title, pack: pack };
    if (existing >= 0) app.packs[existing] = entry; else app.packs.push(entry);
    renderTabs();
    selectPack(pack.id, { story: false });
  }

  function packFromJSON(json) {
    if (json && json.pack_version && json.signals) {
      const profileObject = typeof json.profile === "object" ? json.profile : json.profileObject;
      if (!profileObject) throw new Error("This pack points to a profile file. Import a pack with the profile embedded, or import the profile itself.");
      E.loadProfile(profileObject);
      return Object.assign({}, json, { profileObject: profileObject });
    }
    if (json && json.trp_id) return S.autoPack(json, E);
    throw new Error("That file is not a TRP profile or a scenario pack.");
  }

  // ------------------------------------------------------------------ Tabs

  function renderTabs() {
    const nav = $("pack-tabs");
    nav.innerHTML = "";
    nav.setAttribute("role", "tablist");
    for (const p of app.packs) {
      const b = document.createElement("button");
      b.className = "pack-tab";
      b.type = "button";
      b.setAttribute("role", "tab");
      b.textContent = p.title;
      b.setAttribute("aria-selected", app.current && app.current.id === p.id ? "true" : "false");
      b.addEventListener("click", () => selectPack(p.id, { story: true }));
      nav.appendChild(b);
    }
  }

  function selectPack(id, opts) {
    const entry = app.packs.find((p) => p.id === id) || app.packs[0];
    if (!entry) return;
    app.current = entry;
    const pack = entry.pack;
    app.profile = E.loadProfile(pack.profileObject);
    const url = new URL(location.href);
    if (!pack.id.startsWith("custom-")) { url.searchParams.set("pack", pack.id); url.searchParams.delete("profile"); history.replaceState(null, "", url); }
    $("pack-title").textContent = pack.title;
    $("pack-subtitle").textContent = pack.subtitle || "";
    document.title = `${pack.title} · TRP Studio`;
    renderTabs();
    buildControls();
    buildReadout();
    reset();
    if (opts && opts.story && pack.story && pack.story.length) startStory();
  }

  function reset() {
    const pack = app.current.pack;
    app.sim = new S.Simulator(pack);
    app.drift = app.profile.driftWindow > 0 ? new E.DriftDetector(app.profile.driftWindow, app.profile.driftSignals) : null;
    app.events = [];
    app.frames = [];
    app.lastKey = null;
    app.tickAcc = 0;
    app.sceneState = {};
    const scene = SCENES[pack.scene] || SCENES.instrument;
    if (scene.init) scene.init(app.sceneState);
    stopStory(true);
    syncControls();
    tick();
    renderEvents();
  }

  // ------------------------------------------------------------------ Controls

  function buildControls() {
    const wrap = $("controls");
    wrap.innerHTML = "";
    app.controlEls = {};
    const pack = app.current.pack;
    for (const c of pack.controls) {
      const div = document.createElement("div");
      div.className = "control";
      if (c.type === "slider") {
        const spec = pack.signals[c.signal] || {};
        const label = document.createElement("label");
        label.className = "control-label";
        label.htmlFor = "ctl-" + c.id;
        const name = document.createElement("span");
        name.textContent = c.label;
        const val = document.createElement("span");
        val.className = "control-value";
        label.append(name, val);
        const input = document.createElement("input");
        input.type = "range";
        input.id = "ctl-" + c.id;
        input.min = c.min; input.max = c.max; input.step = c.step || "any";
        input.addEventListener("input", () => {
          stopStory();
          app.sim.setControl(c.id, Number(input.value));
          val.textContent = fmt(Number(input.value), spec.decimals) + unitFor(c.signal);
        });
        div.append(label, input);
        app.controlEls[c.id] = { input, val, spec, c };
      } else {
        const btn = document.createElement("button");
        btn.className = "toggle";
        btn.type = "button";
        btn.setAttribute("aria-pressed", "false");
        const sw = document.createElement("span");
        sw.className = "switch";
        const t = document.createElement("span");
        t.textContent = c.label;
        btn.append(sw, t);
        btn.addEventListener("click", () => {
          stopStory();
          const on = btn.getAttribute("aria-pressed") !== "true";
          btn.setAttribute("aria-pressed", String(on));
          app.sim.setControl(c.id, on);
        });
        div.append(btn);
        app.controlEls[c.id] = { btn, c };
      }
      wrap.appendChild(div);
    }
  }

  function syncControls() {
    for (const [id, el] of Object.entries(app.controlEls)) {
      const v = app.sim.controlState[id];
      if (el.input) {
        el.input.value = v;
        el.val.textContent = fmt(Number(v), el.spec.decimals) + unitFor(el.c.signal);
      } else {
        el.btn.setAttribute("aria-pressed", String(!!v));
      }
    }
  }

  // ------------------------------------------------------------------ Readout

  function unitFor(signal) {
    const s = app.profile.scoredSignals.find((x) => x.signal === signal);
    const u = s ? unitText(s.unit || "") : "";
    return u ? " " + u : "";
  }

  function fmt(v, decimals) {
    if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
    return v.toFixed(decimals == null ? 2 : decimals);
  }

  const UNIT_TEXT = { C: "°C", ratio: "" };
  function unitText(u) { return u in UNIT_TEXT ? UNIT_TEXT[u] : u; }

  function ruleLabel(rule) {
    const labels = app.current.pack.rule_labels || {};
    return labels[rule] || S.humanize(rule);
  }

  function labelFor(signal) {
    const spec = app.current.pack.signals[signal];
    return (spec && spec.label) || S.humanize(signal);
  }

  function sortedBands() {
    return [...app.profile.standingBands].sort((a, b) => a.severity - b.severity);
  }

  function buildReadout() {
    const labels = $("scale-labels");
    labels.innerHTML = "";
    for (const b of sortedBands()) {
      const span = document.createElement("span");
      span.textContent = b.band.replace(/[-_]/g, " ");
      labels.appendChild(span);
    }

    const ul = $("signals");
    ul.innerHTML = "";
    const pack = app.current.pack;
    for (const s of app.profile.scoredSignals) {
      const spec = pack.signals[s.signal] || {};
      const lo = typeof spec.min === "number" ? spec.min : Math.min(s.warningThreshold, s.criticalThreshold) * 0.5;
      const hi = typeof spec.max === "number" ? spec.max : Math.max(s.warningThreshold, s.criticalThreshold) * 1.5;
      const li = document.createElement("li");
      li.dataset.signal = s.signal;
      li.innerHTML =
        `<div class="sig-top"><span class="sig-name"></span><span class="sig-val"></span></div>` +
        `<div class="sig-track"><span class="line"></span><span class="tick warn"></span><span class="tick crit"></span><span class="pos"></span></div>`;
      li.querySelector(".sig-name").textContent = labelFor(s.signal);
      const pct = (v) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}%`;
      li.querySelector(".tick.warn").style.left = pct(s.warningThreshold);
      li.querySelector(".tick.crit").style.left = pct(s.criticalThreshold);
      li._pct = pct;
      li._spec = spec;
      li._sig = s;
      ul.appendChild(li);
    }

    const rules = $("rules");
    rules.innerHTML = "";
    for (const r of app.profile.hardRules) {
      const li = document.createElement("li");
      li.dataset.rule = r.rule;
      const name = document.createElement("span");
      name.textContent = ruleLabel(r.rule);
      const state = document.createElement("span");
      state.className = "state";
      li.append(name, state);
      rules.appendChild(li);
    }
    if (!app.profile.hardRules.length) rules.innerHTML = `<li><span>None in this profile</span></li>`;
  }

  function renderReadout() {
    const r = app.result;
    if (!r) return;
    const bands = sortedBands();
    const idx = Math.max(0, bands.findIndex((b) => b.band === r.standing));
    const standing = document.querySelector(".standing");
    standing.classList.toggle("best", idx === 0);
    standing.classList.toggle("mid", idx > 0 && idx < bands.length - 1);
    standing.classList.toggle("worst", idx === bands.length - 1 && bands.length > 1);
    const word = r.standing.replace(/[-_]/g, " ");
    $("standing-word").textContent = word;
    $("standing-word").classList.toggle("long", word.length > 9);
    $("standing-response").textContent = RESPONSE_TEXT[r.response] || r.response;

    const maxSev = Math.max(0, ...r.signal_results.map((s) => s.severity));
    let pos = bands.length > 1 ? (idx + (idx < bands.length - 1 ? maxSev * 0.6 : 0)) / (bands.length - 1) : 0;
    pos = Math.max(0.01, Math.min(0.99, pos));
    $("scale-dot").style.left = `${pos * 100}%`;

    const byName = {};
    for (const s of r.signal_results) byName[s.signal] = s;
    const missing = new Set(r.missing_signals.map((m) => m.signal));
    for (const li of $("signals").children) {
      const name = li.dataset.signal;
      const res = byName[name];
      const val = li.querySelector(".sig-val");
      li.classList.toggle("missing", missing.has(name));
      li.classList.toggle("warn", !!res && res.in_warning && !res.in_critical);
      li.classList.toggle("crit", !!res && res.in_critical);
      if (res) {
        const u = unitText(li._sig.unit || "");
        const unit = u ? `<span class="unit">${escapeHTML(u)}</span>` : "";
        val.innerHTML = escapeHTML(fmt(res.value, li._spec.decimals)) + unit;
        li.querySelector(".pos").style.left = li._pct(res.value);
      } else {
        val.textContent = "no reading";
      }
    }

    const trig = {};
    for (const t of r.hard_rules_triggered) trig[t.rule] = t;
    const inc = {};
    for (const t of r.hard_rules_inconclusive) inc[t.rule] = t;
    for (const li of $("rules").children) {
      const name = li.dataset.rule;
      if (!name) continue;
      const state = li.querySelector(".state");
      li.classList.toggle("on", !!trig[name]);
      li.classList.toggle("unknown", !!inc[name]);
      if (trig[name]) state.textContent = `met · ${trig[name].action.replace(/_/g, " ")}`;
      else if (inc[name]) state.textContent = inc[name].reason === "missing" ? "unknown · no reading" : "unknown · wrong type";
      else state.textContent = "clear";
    }

    // Halt overlay.
    const actions = r.hard_rules_triggered.map((t) => t.action);
    const top = ACTION_PRIORITY.find((a) => actions.includes(a));
    const halt = $("halt");
    if (top || r.response === "suspended") {
      $("halt-word").textContent = top ? ACTION_WORD[top] : "Suspended";
      $("halt-why").textContent = reasonText(r, top);
      halt.hidden = false;
    } else {
      halt.hidden = true;
    }
  }

  function reasonText(r, top) {
    if (top) {
      const rules = r.hard_rules_triggered.filter((t) => t.action === top).map((t) => ruleLabel(t.rule));
      return rules.join(". ") + ".";
    }
    const crit = r.signal_results.filter((s) => s.in_critical).map((s) => labelFor(s.signal));
    if (crit.length) return `${crit.join(" and ")} past the critical line.`;
    const miss = r.missing_signals.map((m) => labelFor(m.signal));
    const inc = r.hard_rules_inconclusive.map((t) => ruleLabel(t.rule));
    if (miss.length || inc.length) return `Evidence missing for ${miss.concat(inc).join(", ")}. Unknown is never treated as safe.`;
    return "";
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ------------------------------------------------------------------ Events

  function record(r, evidence) {
    const pos = app.sim.position();
    const t = Number(app.sim.time.toFixed(2));
    const triggered = r.hard_rules_triggered.map((x) => x.rule);
    const intervention = r.response !== "full";
    app.frames.push({
      t: t, episode_index: pos.episode_index, frame_index: pos.frame_index,
      standing: r.standing, response: r.response, intervention: intervention,
      rules_met: triggered, missing: r.missing_signals.map((m) => m.signal),
    });
    if (app.frames.length > 20000) app.frames.shift();

    const key = [r.standing, triggered.join(","), r.hard_rules_inconclusive.map((x) => x.rule).join(",")].join("|");
    if (key === app.lastKey) return;
    const first = app.lastKey === null;
    app.lastKey = key;
    if (first) return;
    app.events.unshift({
      t: t, episode_index: pos.episode_index, frame_index: pos.frame_index,
      standing: r.standing, response: r.response, rules_met: triggered,
      rules_unknown: r.hard_rules_inconclusive.map((x) => x.rule),
      signals_critical: r.signal_results.filter((s) => s.in_critical).map((s) => s.signal),
      signals_warning: r.signal_results.filter((s) => s.in_warning && !s.in_critical).map((s) => s.signal),
      missing: r.missing_signals.map((m) => m.signal),
      evidence: evidence,
    });
    if (app.events.length > 500) app.events.pop();
    renderEvents();
  }

  function renderEvents() {
    const ol = $("events");
    ol.innerHTML = "";
    if (!app.events.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Changes in standing appear here.";
      ol.appendChild(li);
      return;
    }
    const bands = sortedBands();
    const worst = bands.length ? bands[bands.length - 1].band : "";
    for (const ev of app.events.slice(0, 60)) {
      const li = document.createElement("li");
      if (ev.standing === worst) li.className = "worst";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = `${ev.t.toFixed(1)}s`;
      const what = document.createElement("span");
      what.className = "what";
      const why = ev.rules_met.length ? ev.rules_met.map(ruleLabel).join(", ")
        : ev.signals_critical.length ? ev.signals_critical.map(labelFor).join(", ") + " critical"
        : ev.missing.length || ev.rules_unknown.length ? "evidence missing"
        : ev.signals_warning.length ? ev.signals_warning.map(labelFor).join(", ") + " in warning"
        : "all clear";
      what.textContent = `${ev.standing.replace(/[-_]/g, " ")}, ${why}`;
      li.append(t, what);
      ol.appendChild(li);
    }
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function exportJSON() {
    const out = { profile: app.profile.trpId, profile_version: app.profile.version, evaluator: "trp-studio", events: [...app.events].reverse() };
    download(`${app.profile.trpId}-events.json`, JSON.stringify(out, null, 2), "application/json");
  }

  function exportCSV() {
    const head = ["t", "episode_index", "frame_index", "standing", "response", "rules_met", "rules_unknown", "signals_critical", "signals_warning", "missing"];
    const rows = [...app.events].reverse().map((e) => head.map((k) => {
      const v = Array.isArray(e[k]) ? e[k].join(" ") : e[k];
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(","));
    download(`${app.profile.trpId}-events.csv`, [head.join(",")].concat(rows).join("\n"), "text/csv");
  }

  function exportFrames() {
    const lines = app.frames.map((f) => JSON.stringify(f)).join("\n");
    download(`${app.profile.trpId}-frames.jsonl`, lines + "\n", "application/x-ndjson");
  }

  function exportProfile() {
    download(`${app.profile.trpId}.trp.json`, JSON.stringify(app.current.pack.profileObject, null, 2), "application/json");
  }

  // ------------------------------------------------------------------ Story

  function startStory() {
    const pack = app.current.pack;
    if (!pack.story || !pack.story.length) return;
    app.sim = new S.Simulator(pack);
    app.drift = app.profile.driftWindow > 0 ? new E.DriftDetector(app.profile.driftWindow, app.profile.driftSignals) : null;
    app.events = []; app.frames = []; app.lastKey = null;
    app.sceneState = {};
    const scene = SCENES[pack.scene] || SCENES.instrument;
    if (scene.init) scene.init(app.sceneState);
    app.story = { steps: pack.story.slice().sort((a, b) => a.at_s - b.at_s), next: 0 };
    $("story-btn").setAttribute("aria-pressed", "true");
    $("story-btn").textContent = "Stop story";
    syncControls();
    renderEvents();
  }

  function stopStory(silent) {
    if (!app.story && silent) return;
    app.story = null;
    $("story-btn").setAttribute("aria-pressed", "false");
    $("story-btn").textContent = "Play story";
    if (!silent) caption("");
  }

  function advanceStory() {
    const st = app.story;
    if (!st) return;
    while (st.next < st.steps.length && st.steps[st.next].at_s <= app.sim.time) {
      const step = st.steps[st.next++];
      if (step.set) for (const [id, v] of Object.entries(step.set)) app.sim.setControl(id, v);
      if (step.toggle) for (const [id, v] of Object.entries(step.toggle)) app.sim.setControl(id, v);
      if (step.caption) caption(step.caption);
      syncControls();
      if (step.end) {
        stopStory(true);
        setTimeout(() => caption("Your turn. Change any condition and watch the standing respond."), 400);
        return;
      }
    }
  }

  let captionTimer = null;
  function caption(textValue) {
    const el = $("caption");
    clearTimeout(captionTimer);
    if (!textValue) { el.classList.remove("show"); return; }
    el.classList.remove("show");
    captionTimer = setTimeout(() => { el.textContent = textValue; el.classList.add("show"); }, 180);
  }

  // ------------------------------------------------------------------ Loop

  function tick() {
    const evidence = app.sim.evidence();
    app.result = E.evaluate(app.profile, evidence, app.drift);
    record(app.result, evidence);
    renderReadout();
  }

  const canvas = $("canvas");
  const ctx = canvas.getContext("2d");
  let cw = 0, ch = 0;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = rect.width; ch = rect.height;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);

  let last = performance.now();
  let clock = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (app.current && app.sim) {
      const pack = app.current.pack;
      const tickS = (pack.tick_ms || 250) / 1000;
      if (!app.paused) {
        clock += dt;
        app.sim.step(dt);
        advanceStory();
        app.tickAcc += dt;
        if (app.tickAcc >= tickS) { app.tickAcc = 0; tick(); }
      }
      const r = app.result;
      const scene = SCENES[pack.scene] || SCENES.instrument;
      ctx.clearRect(0, 0, cw, ch);
      scene.draw({
        ctx: ctx, w: cw, h: ch, dt: app.paused ? 0 : dt, t: clock,
        values: app.sim.values, evidence: app.sim.evidence(), omitted: app.sim.omitted(),
        result: r, profile: app.profile, humanize: S.humanize, pack: pack,
        halted: !!r && (r.hard_rules_triggered.some((x) => x.action === "halt") || r.response === "suspended"),
        restricted: !!r && r.response === "restricted",
      }, app.sceneState);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ Import

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  async function importText(textValue) {
    try {
      const pack = packFromJSON(JSON.parse(textValue));
      addCustomPack(pack);
      toast(`Loaded ${pack.title}`);
    } catch (err) {
      toast(err.message || "Could not read that file.");
    }
  }

  $("file-input").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await importText(await f.text());
    e.target.value = "";
  });
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").hidden = false; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop").hidden = true; });
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("drop").hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await importText(await f.text());
  });

  $("pause-btn").addEventListener("click", () => {
    app.paused = !app.paused;
    $("pause-btn").setAttribute("aria-pressed", String(app.paused));
    $("pause-btn").textContent = app.paused ? "Resume" : "Pause";
  });
  $("reset-btn").addEventListener("click", () => { reset(); caption(""); });
  $("story-btn").addEventListener("click", () => { if (app.story) { stopStory(); } else { startStory(); } });
  $("export-json").addEventListener("click", exportJSON);
  $("export-csv").addEventListener("click", exportCSV);
  $("export-jsonl").addEventListener("click", exportFrames);
  $("export-profile").addEventListener("click", exportProfile);
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); $("pause-btn").click(); }
  });

  // ------------------------------------------------------------------ Start

  (async function start() {
    const params = new URLSearchParams(location.search);
    try {
      await loadIndex();
    } catch (err) {
      $("pack-title").textContent = "Studio needs a web server";
      $("pack-subtitle").textContent = "Run python3 -m http.server from the repository root, then open /studio/.";
      return;
    }
    renderTabs();
    const wantStory = params.get("story") !== "0";
    if (params.get("profile")) {
      try {
        const pack = packFromJSON(await fetchJSON(params.get("profile")));
        addCustomPack(pack);
      } catch (err) {
        toast(err.message);
        selectPack(params.get("pack") || (app.packs[0] && app.packs[0].id), { story: wantStory });
      }
    } else {
      selectPack(params.get("pack") || (app.packs[0] && app.packs[0].id), { story: wantStory });
    }
    requestAnimationFrame(frame);
  })();
})();
