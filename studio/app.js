/**
 * TRP Studio application. Loads scenario packs, runs the simulator, evaluates
 * every tick with the open TRP engine, and renders the scene and readout.
 */
(function () {
  "use strict";

  const E = window.TRPEngine;
  const S = window.TRPSim;
  const A = window.TRPArena;
  const SAFE = window.TRPSafety;
  const SCENES = window.TRPScenes;
  const $ = (id) => document.getElementById(id);

  const RESPONSE_TEXT = { full: "Full operation", restricted: "Restricted operation", suspended: "Suspended", unknown: "No response defined" };
  const ACTION_WORD = { halt: "Halted", block_startup: "Startup blocked", require_review: "Held for review" };
  const ACTION_PRIORITY = ["halt", "block_startup", "require_review"];
  const REPO = "https://github.com/aitrustalliance/trp";

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
    mode: "live",       // live, arena or stress
    match: null,
    arenaGuards: new Set(),
    arenaPar: null,
    timeline: [],
    recorder: null,
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

  // Imported packs and profiles are untrusted. TRPSafety rejects anything of
  // the wrong shape or size before the Studio uses it.
  async function fetchUntrusted(url) {
    const href = SAFE.checkProfileUrl(url, location.href);
    const res = await fetch(href, { cache: "no-cache", credentials: "omit" });
    if (!res.ok) throw new Error(`Could not load that profile (${res.status}).`);
    return SAFE.parse(await res.text());
  }

  function packFromJSON(json) {
    if (json && json.pack_version && json.signals) {
      const profileObject = typeof json.profile === "object" ? json.profile : json.profileObject;
      if (!profileObject) throw new Error("This pack points to a profile file. Import a pack with the profile embedded, or import the profile itself.");
      SAFE.checkPack(json);
      SAFE.checkProfile(profileObject);
      E.loadProfile(profileObject);
      return Object.assign({}, json, { profileObject: profileObject });
    }
    if (json && json.trp_id) return S.autoPack(SAFE.checkProfile(json), E);
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
    const hasArena = !!pack.arena;
    document.querySelector('.mode[data-mode="arena"]').disabled = !hasArena;
    document.querySelector('.mode[data-mode="stress"]').disabled = !hasArena;
    const wanted = (opts && opts.mode) || (app.mode !== "live" && hasArena ? app.mode : "live");
    setMode(wanted);
    if (wanted === "live" && opts && opts.story && pack.story && pack.story.length) startStory();
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
    app.timeline = [];
    $("explain").hidden = true;
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
          logControl(c.id, Number(input.value));
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
          logControl(c.id, on);
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
      setHTML(li, html`<div class="sig-top"><span class="sig-name"></span><span class="sig-val"></span></div><div class="sig-track"><span class="line"></span><span class="tick warn"></span><span class="tick crit"></span><span class="pos"></span></div>`);
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
    if (!app.profile.hardRules.length) setHTML(rules, html`<li><span>None in this profile</span></li>`);
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
        setHTML(val, html`${fmt(res.value, li._spec.decimals)}${u ? html`<span class="unit">${u}</span>` : ""}`);
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

  // Every piece of HTML the Studio writes goes through html``, which escapes
  // each interpolated value unless it is itself the output of html``.
  class SafeHTML { constructor(v) { this.v = v; } }
  function html(strings, ...vals) {
    const piece = (v) => (v instanceof SafeHTML ? v.v : escapeHTML(v === null || v === undefined ? "" : v));
    let out = strings[0];
    vals.forEach((v, i) => { out += (Array.isArray(v) ? v.map(piece).join("") : piece(v)) + strings[i + 1]; });
    return new SafeHTML(out);
  }
  function setHTML(el, h) {
    if (!(h instanceof SafeHTML)) throw new TypeError("setHTML needs html``");
    el.innerHTML = h.v; // eslint-disable-line no-unsanitized/property
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
      li.tabIndex = 0;
      li.title = "Explain this event";
      li.addEventListener("click", () => explain(ev));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") explain(ev); });
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
    if (app.mode === "arena" && app.match) {
      if (!app.match.result) return;
      app.result = app.match.result;
    } else {
      app.result = E.evaluate(app.profile, evidence, app.drift);
    }
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
        if (app.mode === "arena" && app.match && !app.match.done) {
          app.match.step(dt);
          app.sim = app.match.sim;
          renderHud();
          if (app.match.done) arenaResults();
        } else if (app.mode !== "arena" || !app.match) {
          app.sim.step(dt);
          advanceStory();
        }
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
        controlState: app.sim.controlState,
      }, app.sceneState);
      if (app.recorder) drawRecordingOverlay(r);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ Modes

  function setMode(mode) {
    const pack = app.current.pack;
    if ((mode === "arena" || mode === "stress") && !pack.arena) mode = "live";
    app.mode = mode;
    for (const b of document.querySelectorAll(".mode")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
    $("controls").hidden = mode !== "live";
    $("arena-panel").hidden = mode !== "arena";
    $("stress-panel").hidden = mode !== "stress";
    $("learn-panel").hidden = mode !== "learn";
    $("story-btn").hidden = mode !== "live" || !(pack.story && pack.story.length);
    $("hud").hidden = true;
    stopStory(true);
    caption("");
    app.match = null;
    app.profile = E.loadProfile(pack.profileObject);
    buildReadout();
    reset();
    if (mode === "arena") renderArenaPrep();
    if (mode === "stress") renderStressPrep();
    if (mode === "learn") renderLearn();
  }

  function logControl(id, value) {
    if (app.mode !== "live") return;
    app.timeline.push([Number(app.sim.time.toFixed(2)), id, value]);
    if (app.timeline.length > 400) app.timeline.shift();
  }

  // ------------------------------------------------------------------ Storage

  function store(key, value) {
    try {
      if (value === undefined) return clean(JSON.parse(localStorage.getItem("trp-studio-" + key) || "null"));
      localStorage.setItem("trp-studio-" + key, JSON.stringify(value));
    } catch (err) { return null; }
    return value;
  }

  // Stored values are only ever numbers. Anything else is dropped, since other
  // pages on the same site can write to the same storage.
  function clean(v) {
    if (v === null || typeof v !== "object") return typeof v === "number" && Number.isFinite(v) ? v : null;
    const out = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "number" && Number.isFinite(x)) out[k] = x;
    return out;
  }

  function bumpStreak() {
    const today = A.dayNumber();
    const s = store("streak") || { last: 0, count: 0 };
    if (s.last === today) return s.count;
    const count = s.last === today - 1 ? s.count + 1 : 1;
    store("streak", { last: today, count: count });
    return count;
  }

  // ------------------------------------------------------------------ Arena

  function guardCost(ids) {
    const guards = app.current.pack.arena.guards;
    return [...ids].reduce((sum, id) => sum + (guards.find((g) => g.id === id) || { cost: 0 }).cost, 0);
  }

  function renderArenaPrep() {
    const arena = app.current.pack.arena;
    const panel = $("arena-panel");
    const seed = A.daySeed();
    app.arenaPar = A.par(app.current.pack, app.current.pack.profileObject, seed, { engine: E, sim: S });
    const best = store("best-" + app.current.pack.id);
    setHTML(panel, html`
      <div class="panel-row">
        <h2>Arena #${A.dayNumber()} · ${arena.event || app.current.pack.title}</h2>
        <span class="muted">Par ${app.arenaPar.score}${best && best.score !== undefined ? ` · Your best ${best.score}` : ""}</span>
      </div>
      <p>You are the Guardian. Over ${Number(arena.rounds) || 0} rounds the Challenger will try ${(arena.moves || []).length} kinds of trouble, and it aims for whatever you leave open. Spend your budget on guards, then start. You score for every harm the system stops in time, and lose points for harm that slips through and for stopping when nothing was wrong.</p>
      <div class="panel-row"><span class="eyebrow">Guards</span><span class="budget" id="budget"></span></div>
      <div class="guards" id="guards"></div>
      <div class="panel-row"><button class="primary" id="arena-start" type="button">Start match</button><span class="muted" id="arena-note">Everyone plays the same match today.</span></div>`);
    const wrap = $("guards");
    for (const g of arena.guards) {
      const b = document.createElement("button");
      b.className = "guard";
      b.type = "button";
      b.dataset.id = g.id;
      b.setAttribute("aria-pressed", String(app.arenaGuards.has(g.id)));
      setHTML(b, html`<span class="check"></span><span class="name"></span><span class="cost"></span><span class="detail"></span>`);
      b.querySelector(".name").textContent = g.label;
      b.querySelector(".cost").textContent = `${g.cost} pts`;
      b.querySelector(".detail").textContent = g.detail || "";
      b.addEventListener("click", () => {
        if (app.arenaGuards.has(g.id)) app.arenaGuards.delete(g.id);
        else if (guardCost(app.arenaGuards) + g.cost <= arena.budget) app.arenaGuards.add(g.id);
        refreshGuards();
      });
      wrap.appendChild(b);
    }
    // Keep only guards from this event.
    for (const id of [...app.arenaGuards]) if (!arena.guards.some((g) => g.id === id)) app.arenaGuards.delete(id);
    refreshGuards();
    $("arena-start").addEventListener("click", startMatch);
  }

  function refreshGuards() {
    const arena = app.current.pack.arena;
    const spent = guardCost(app.arenaGuards);
    $("budget").textContent = `${arena.budget - spent} of ${arena.budget} pts left`;
    for (const b of $("guards").children) {
      const g = arena.guards.find((x) => x.id === b.dataset.id);
      const on = app.arenaGuards.has(g.id);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !on && spent + g.cost > arena.budget;
    }
  }

  function startMatch(opts) {
    const pack = app.current.pack;
    const o = opts || {};
    app.match = new A.Match(pack, pack.profileObject, [...app.arenaGuards], { seed: o.seed || A.daySeed() }, { engine: E, sim: S });
    app.sim = app.match.sim;
    app.profile = app.match.profile;
    app.events = []; app.frames = []; app.lastKey = null; app.tickAcc = 0;
    app.sceneState = {};
    const scene = SCENES[pack.scene] || SCENES.instrument;
    if (scene.init) scene.init(app.sceneState);
    buildReadout();
    renderEvents();
    $("hud").hidden = false;
    const panel = $("arena-panel");
    setHTML(panel, html`<div class="panel-row"><h2>Match in progress</h2><button class="text-btn" id="arena-quit" type="button">Quit match</button></div>
      <p>Guards in play: ${app.arenaGuards.size ? [...app.arenaGuards].map((id) => pack.arena.guards.find((g) => g.id === id).label).join(", ") : "none"}.</p>`);
    $("arena-quit").addEventListener("click", () => setMode("arena"));
    renderHud();
  }

  function renderHud() {
    const m = app.match;
    if (!m) return;
    const s = m.tally;
    const caught = s.incidents.filter((i) => i.caught).length + (s.open && s.open.caughtAt !== null ? 1 : 0);
    const missed = s.incidents.filter((i) => !i.caught).length;
    const harmLabels = m.harms.map((id) => (m.arena.harm.find((h) => h.id === id) || {}).label).filter(Boolean);
    const move = m.move && m.moveApplied ? m.move.label : "Watching";
    setHTML($("hud"), html`
      <div class="hud-col"><span>Round ${Math.min(m.round + 1, m.rounds)} of ${m.rounds}</span><span class="move">Challenger: ${move}</span>
        <span class="truth">${harmLabels.length ? "Really happening: " + harmLabels.join(", ") : ""}</span></div>
      <div class="hud-stats"><div>Caught<span class="big">${caught}</span></div><div>Slipped through<span class="big">${missed}</span></div><div>False stops<span class="big">${s.falseHalts}</span></div></div>`);
  }

  function shareLine(summary, medal, eventName, player) {
    const caught = `${summary.caught} of ${summary.incidents} caught`;
    const falseStops = `${summary.falseHalts} false stop${summary.falseHalts === 1 ? "" : "s"}`;
    const medalText = medal ? medal.charAt(0).toUpperCase() + medal.slice(1) + " " : "";
    return `TRP Arena #${A.dayNumber()} · ${eventName} · ${medalText}${summary.score} (par ${app.arenaPar ? app.arenaPar.score : "?"})\n${caught} · ${falseStops} · ${Math.round(summary.uptime * 100)}% uptime · played by a ${player || "human"}`;
  }

  // A static shields.io badge anyone can paste into a README.
  function badgeMarkdown(score, medal, eventName, link) {
    const esc = (x) => String(x).replace(/-/g, "--").replace(/_/g, "__").replace(/ /g, "_");
    const msg = `${medal ? medal.charAt(0).toUpperCase() + medal.slice(1) + " " : ""}${score} · ${eventName}`;
    const color = medal === "gold" ? "e6d3a1" : medal === "silver" ? "c9d0dc" : medal === "bronze" ? "c8a27e" : "4fa8e8";
    const url = `https://img.shields.io/badge/${esc("TRP Arena")}-${encodeURIComponent(esc(msg))}-${color}?labelColor=0a0e27`;
    return `[![TRP Arena](${url})](${link})`;
  }

  function arenaResults() {
    const m = app.match;
    const pack = app.current.pack;
    const sum = m.summary;
    const par = app.arenaPar ? app.arenaPar.score : sum.score;
    const medal = A.medal(sum.score, par);
    const best = store("best-" + pack.id);
    const isBest = !best || sum.score > best.score;
    if (isBest) store("best-" + pack.id, { score: sum.score, day: A.dayNumber() });
    const streak = bumpStreak();
    const line = shareLine(sum, medal, pack.arena.event || pack.title, "human");
    $("hud").hidden = true;
    const missed = m.tally.incidents.filter((i) => !i.caught);
    const lessons = missed.length
      ? `Slipped through: ${[...new Set(missed.map((i) => i.label))].join(", ")}. Try a guard that covers it.`
      : "Nothing slipped through.";
    setHTML($("arena-panel"), html`
      <div class="panel-row"><h2>Match over</h2><span class="muted">Streak ${streak} day${streak === 1 ? "" : "s"}${isBest ? " · New personal best" : ` · Your best ${best.score}`}</span></div>
      <div class="panel-row" style="align-items:flex-end">
        <div><div class="result-score">${sum.score}</div><div class="medal ${medal || ""}">${medal ? medal + " medal" : "No medal"} · par ${par}</div></div>
        <div class="result-grid" style="flex:1;max-width:620px">
          <div><div class="stat-label">Caught</div><div class="stat-value">${sum.caught} of ${sum.incidents}</div></div>
          <div><div class="stat-label">Slipped through</div><div class="stat-value">${sum.missed}</div></div>
          <div><div class="stat-label">False stops</div><div class="stat-value">${sum.falseHalts}</div></div>
          <div><div class="stat-label">Uptime</div><div class="stat-value">${Math.round(sum.uptime * 100)}%</div></div>
        </div>
      </div>
      <p>${lessons}</p>
      <div class="share-line" id="share-line"></div>
      <div class="panel-row" style="justify-content:flex-start;gap:28px;flex-wrap:wrap">
        <button class="primary" id="arena-copy" type="button">Copy result</button>
        <a class="text-btn" id="arena-x" target="_blank" rel="noopener">Post on X</a>
        <a class="text-btn" id="arena-li" target="_blank" rel="noopener">Post on LinkedIn</a>
        <button class="text-btn" id="arena-badge" type="button">Copy README badge</button>
        <button class="text-btn" id="arena-again" type="button">Change guards and play again</button>
      </div>
      <div class="panel-row" style="justify-content:flex-start;gap:28px;flex-wrap:wrap">
        <a class="text-btn" href="${REPO}" target="_blank" rel="noopener">Star TRP on GitHub</a>
        <a class="text-btn" href="${REPO}/subscription" target="_blank" rel="noopener">Watch for Season 2</a>
        <a class="text-btn" href="${REPO}/blob/main/studio/README.md" target="_blank" rel="noopener">Build the next event</a>
      </div>`);
    $("share-line").textContent = line;
    const link = location.origin + location.pathname + "?pack=" + pack.id + "&mode=arena";
    $("arena-copy").addEventListener("click", () => copyText(line + "\n" + link));
    $("arena-x").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(line + "\n" + link);
    $("arena-li").href = "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(link);
    $("arena-badge").addEventListener("click", () => copyText(badgeMarkdown(sum.score, medal, pack.arena.event || pack.title, link)));
    $("arena-again").addEventListener("click", () => setMode("arena"));
  }

  // ------------------------------------------------------------------ Stress

  function renderStressPrep() {
    const pack = app.current.pack;
    setHTML($("stress-panel"), html`
      <div class="panel-row"><h2>Stress test · ${pack.arena.event || pack.title}</h2>
        <span><label class="muted" for="stress-n">Runs </label><select id="stress-n"><option>100</option><option selected>300</option><option>1000</option><option>3000</option></select></span></div>
      <p>Run the profile through hundreds of short episodes with faults mixed in at random, then see what it caught, what slipped through and where it stopped for nothing. It all runs in your browser.</p>
      <div class="panel-row" style="justify-content:flex-start"><button class="primary" id="stress-run" type="button">Run stress test</button></div>
      <div id="stress-out"></div>`);
    $("stress-run").addEventListener("click", runStress);
  }

  function runStress() {
    const pack = app.current.pack;
    const n = Number($("stress-n").value);
    setHTML($("stress-out"), html`<p>Running ${n} episodes…</p>`);
    setTimeout(() => {
      const r = A.stressTest(pack, pack.profileObject, { episodes: n, seed: Date.now() % 100000 }, { engine: E, sim: S });
      const rows = r.rows.map((row) => {
        const rate = row.incidents ? row.caught / row.incidents : null;
        return html`<tr class="${rate !== null && rate < 0.6 ? "weak" : ""}"><td>${row.label}</td><td class="num">${row.runs}</td>
          <td class="num rate">${rate === null ? "—" : Math.round(rate * 100) + "%"}</td><td class="num">${row.falseHalts}</td>
          <td class="num">${row.meanReaction === null ? "—" : (row.meanReaction * 1000).toFixed(0) + " ms"}</td></tr>`;
      });
      setHTML($("stress-out"), html`
        <div class="result-grid">
          <div><div class="stat-label">Episodes</div><div class="stat-value">${r.episodes.toLocaleString()}</div></div>
          <div><div class="stat-label">Evaluations</div><div class="stat-value">${r.evaluations.toLocaleString()}</div></div>
          <div><div class="stat-label">Time</div><div class="stat-value">${(r.ms / 1000).toFixed(2)} s</div></div>
          <div><div class="stat-label">Harm caught</div><div class="stat-value">${Math.round(r.overall.safety * 100)}%</div></div>
          <div><div class="stat-label">False stops</div><div class="stat-value">${r.overall.falseHalts}</div></div>
        </div>
        <table class="table"><thead><tr><th>Fault</th><th>Runs</th><th>Harm caught</th><th>False stops</th><th>Time to stop</th></tr></thead><tbody>${rows}</tbody></table>
        <p>Faults the profile misses are where a guard in the Arena, or a better profile, earns its keep.</p>`);
    }, 30);
  }

  // ------------------------------------------------------------------ Learn

  // Challenges hand the player a profile with a gap, let them change its
  // limits, and grade the result with a fixed-seed stress test.
  async function loadChallenges() {
    try { app.challenges = await fetchJSON("challenges.json"); } catch (err) { app.challenges = { challenges: [] }; }
  }

  function renderLearn() {
    const panel = $("learn-panel");
    const set = app.challenges;
    if (!set) { setHTML(panel, html`<p>Loading challenges…</p>`); return; }
    const c = app.learnId && set.challenges.find((x) => x.id === app.learnId);
    if (c && app.current.pack.id === c.pack) { renderChallenge(c); return; }
    app.learnId = null;
    const done = set.challenges.filter((x) => store("learn-" + x.id)).length;
    const cards = set.challenges.map((x) => {
      const entry = app.packs.find((p) => p.id === x.pack);
      return html`<button class="challenge" type="button" data-id="${x.id}"><span class="c-title">${x.title}</span><span class="c-pack">${entry ? entry.title : x.pack}</span><span class="c-status">${store("learn-" + x.id) ? "Complete" : "Not started"}</span></button>`;
    });
    setHTML(panel, html`<div class="panel-row"><h2>Learn</h2><span class="muted">${done} of ${set.challenges.length} complete</span></div>
      <p>Each challenge hands you a profile with a gap in it. Change its limits, test them against ${set.episodes} runs with faults mixed in, and see what your rules catch and what they stop for nothing.</p>
      <div class="challenges">${cards}</div>
      <div class="panel-row glossary-row"><h2>Glossary</h2><span class="muted">${app.codexEntry ? "" : "Twenty-four terms at three depths"}</span></div>
      <p>The terms this studio uses, with a definition anyone can read, a documented case, and the section of the specification each one comes from. Shared with the Nautilus game as the Captain's Codex.</p>
      <div id="learn-codex" class="codex"></div>`);
    for (const b of panel.querySelectorAll(".challenge")) b.addEventListener("click", () => openChallenge(b.dataset.id));
    renderGlossary();
  }

  // The glossary is the Captain's Codex, with every entry open.
  async function renderGlossary() {
    const box = $("learn-codex");
    if (!box || !window.TRPCodex) return;
    if (!window.TRPCodex.get()) {
      try { await window.TRPCodex.load("codex.json"); } catch (err) { setHTML(box, html`<p class="muted">The glossary could not be loaded.</p>`); return; }
      if (!$("learn-codex")) return;
    }
    const codex = window.TRPCodex;
    const open = (id) => { app.codexEntry = id; renderGlossary(); const top = $("learn-codex"); if (top) top.scrollIntoView({ block: "start", behavior: "smooth" }); };
    const e = app.codexEntry && codex.entry(app.codexEntry);
    if (!e) {
      app.codexEntry = null;
      codex.renderList(box, { onOpen: open, subtitles: { deckhand: "Start here.", navigator: "How it goes wrong in the world.", captain: "The standard, and the frameworks around it." } });
      return;
    }
    codex.renderEntry(box, e, { depth: "captain", gameLabel: "In Nautilus", onOpen: open, specBase: "https://github.com/aitrustalliance/trp/blob/main/spec/trp-spec.md" });
    const back = document.createElement("button"); back.type = "button"; back.className = "text-btn codex-back"; back.textContent = "All terms";
    back.addEventListener("click", () => { app.codexEntry = null; renderGlossary(); });
    box.prepend(back);
  }

  function openChallenge(id) {
    const c = app.challenges.challenges.find((x) => x.id === id);
    if (!c) return;
    app.learnId = id;
    app.learnEdits = {};
    if (app.current.pack.id !== c.pack) selectPack(c.pack, { mode: "learn" });
    else renderLearn();
  }

  function learnProfile(c) {
    const prof = JSON.parse(JSON.stringify(app.current.pack.profileObject));
    for (const [name, e] of Object.entries(app.learnEdits || {})) {
      const s = prof.scored_signals.find((x) => x.signal === name);
      if (!s || !c.edit.includes(name)) continue;
      if (Number.isFinite(e.warning)) s.warning_threshold = e.warning;
      if (Number.isFinite(e.critical)) s.critical_threshold = e.critical;
    }
    return prof;
  }

  function renderChallenge(c) {
    const pack = app.current.pack;
    const prof = learnProfile(c);
    const g = c.goal;
    const rows = c.edit.map((name) => {
      const s = prof.scored_signals.find((x) => x.signal === name);
      const spec = pack.signals[name] || {};
      const step = Math.pow(10, -(spec.decimals == null ? 2 : spec.decimals));
      const dir = s.direction === "lower_is_unsafe" ? "Lower is unsafe" : "Higher is unsafe";
      return html`<div class="limit-row"><div><div class="limit-name">${labelFor(name)}</div><div class="muted small">${dir}. Normally about ${spec.base} ${s.unit || ""}</div></div>
        <label>Warning <input type="number" data-sig="${name}" data-k="warning" value="${s.warning_threshold}" step="${step}"></label>
        <label>Critical <input type="number" data-sig="${name}" data-k="critical" value="${s.critical_threshold}" step="${step}"></label></div>`;
    });
    const pct = (x) => Math.round(x * 100) + "%";
    setHTML($("learn-panel"), html`<div class="panel-row"><h2>${c.title}</h2><button class="text-btn" id="learn-back" type="button">All challenges</button></div>
      <p>${c.brief}</p>
      <p class="muted">Goal: stop ${g.safety >= 1 ? "every harm" : `at least ${pct(g.safety)} of harm`} in time, with no more than ${g.false_stops} needless stops and at least ${pct(g.uptime)} uptime.</p>
      <div class="limits">${rows}</div>
      <div class="panel-row" style="justify-content:flex-start;gap:24px;flex-wrap:wrap">
        <button class="primary" id="learn-test" type="button">Test my rules</button>
        <button class="text-btn" id="learn-reset" type="button">Reset limits</button>
        <button class="text-btn" id="learn-hint" type="button">Hint</button>
        <button class="text-btn" id="learn-export" type="button">Download my profile</button>
      </div>
      <div id="learn-out" aria-live="polite"></div>`);
    for (const input of $("learn-panel").querySelectorAll("input[data-sig]")) {
      input.addEventListener("change", () => {
        const e = (app.learnEdits[input.dataset.sig] = app.learnEdits[input.dataset.sig] || {});
        e[input.dataset.k] = Number(input.value);
      });
    }
    $("learn-back").addEventListener("click", () => { app.learnId = null; renderLearn(); });
    $("learn-reset").addEventListener("click", () => { app.learnEdits = {}; renderChallenge(c); });
    $("learn-hint").addEventListener("click", () => toast(c.hint));
    $("learn-export").addEventListener("click", () => download(`${prof.trp_id}-${c.id}.json`, JSON.stringify(learnProfile(c), null, 2), "application/json"));
    $("learn-test").addEventListener("click", () => testChallenge(c));
  }

  function testChallenge(c) {
    const prof = learnProfile(c);
    for (const name of c.edit) {
      const s = prof.scored_signals.find((x) => x.signal === name);
      const ok = s.direction === "lower_is_unsafe" ? s.warning_threshold > s.critical_threshold : s.warning_threshold < s.critical_threshold;
      if (!Number.isFinite(s.warning_threshold) || !Number.isFinite(s.critical_threshold) || !ok) {
        setHTML($("learn-out"), html`<p>${labelFor(name)} needs its warning limit on the safe side of its critical limit.</p>`);
        return;
      }
    }
    setHTML($("learn-out"), html`<p>Testing against ${app.challenges.episodes} runs…</p>`);
    setTimeout(() => {
      const pack = app.current.pack;
      const r = A.stressTest(pack, prof, { episodes: app.challenges.episodes, seed: app.challenges.seed }, { engine: E, sim: S });
      const o = r.overall;
      const checks = [
        [`Harm stopped in time: ${Math.round(o.safety * 100)}%`, o.safety >= c.goal.safety],
        [`Needless stops: ${o.falseHalts}`, o.falseHalts <= c.goal.false_stops],
        [`Uptime: ${Math.round(o.uptime * 100)}%`, o.uptime >= c.goal.uptime],
      ];
      const passed = checks.every((x) => x[1]);
      const misses = r.rows.filter((x) => x.incidents > x.caught).sort((a, b) => (b.incidents - b.caught) - (a.incidents - a.caught)).slice(0, 4);
      const list = checks.map(([t, ok]) => html`<li class="${ok ? "pass" : "fail"}">${ok ? "Met" : "Not yet"} · ${t}</li>`);
      const missed = misses.map((x) => html`<li>${x.label}: ${x.incidents - x.caught} of ${x.incidents} slipped through</li>`);
      if (passed) store("learn-" + c.id, { done: 1, safety: o.safety });
      setHTML($("learn-out"), html`<ul class="checks">${list}</ul>
        ${missed.length ? html`<p class="muted">Still slipping through</p><ul class="misses">${missed}</ul>` : ""}
        ${passed ? html`<div class="lesson"><strong>Challenge complete.</strong> ${c.lesson}</div>` : ""}`);
      if (passed) toast(`${c.title} complete`);
    }, 30);
  }

  // ------------------------------------------------------------------ Explain

  function explain(ev) {
    const box = $("explain");
    const parts = [html`<h3>${ev.standing.replace(/[-_]/g, " ")} at ${ev.t.toFixed(1)}s</h3>`];
    const fieldVal = (f) => (f in ev.evidence ? JSON.stringify(ev.evidence[f]) : "no reading");
    for (const rule of ev.rules_met) {
      const r = app.profile.hardRules.find((x) => x.rule === rule);
      if (!r) continue;
      const cond = r.condition.replace(/_/g, " ") + (r.value !== null ? ` ${JSON.stringify(r.value)}` : "");
      parts.push(html`<div class="row"><span>${ruleLabel(rule)}<br><span class="muted">Rule: ${r.fieldName} ${cond}, action ${r.action.replace(/_/g, " ")}</span></span><span class="mono">${fieldVal(r.fieldName)}</span></div>`);
    }
    for (const name of ev.signals_critical.concat(ev.signals_warning)) {
      const sig = app.profile.scoredSignals.find((x) => x.signal === name);
      if (!sig) continue;
      const level = ev.signals_critical.includes(name) ? "critical" : "warning";
      parts.push(html`<div class="row"><span>${labelFor(name)} in ${level}<br><span class="muted">Warning at ${sig.warningThreshold}, critical at ${sig.criticalThreshold} ${sig.unit} (${String(sig.direction).replace(/_/g, " ")})</span></span><span class="mono">${fieldVal(name)}</span></div>`);
    }
    for (const name of ev.missing.concat(ev.rules_unknown)) {
      parts.push(html`<div class="row"><span>${labelFor(name) || ruleLabel(name)}<br><span class="muted">No evidence, so the profile treats it as unknown and never as safe.</span></span><span class="mono">missing</span></div>`);
    }
    if (parts.length === 1) parts.push(html`<div class="muted">Every signal is inside its operating range and no hard rule is met.</div>`);
    parts.push(html`<div class="muted">Response: ${RESPONSE_TEXT[ev.response] || ev.response}. Profile ${app.profile.trpId} ${app.profile.version}.</div>`);
    parts.push(html`<button class="text-btn small close" type="button" id="explain-close">Close</button>`);
    setHTML(box, html`${parts}`);
    box.hidden = false;
    $("explain-close").addEventListener("click", () => { box.hidden = true; });
  }

  // ------------------------------------------------------------------ Share

  function copyText(text) {
    const done = () => toast("Copied");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text)); return; }
    } catch (err) { /* fall through */ }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("Copied"); } catch (err) { toast("Copy this link from the address bar."); }
    ta.remove();
  }

  function encodeReplay() {
    const json = JSON.stringify({ p: app.current.pack.id, s: app.timeline });
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeReplay(text) {
    if (text.length > 65536) throw new Error("That replay link is too long.");
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    return SAFE.checkReplay(JSON.parse(decodeURIComponent(escape(atob(b64)))));
  }

  function shareSession() {
    const pack = app.current.pack;
    if (pack.id.startsWith("custom-")) { toast("Imported profiles can't be shared by link yet. Export the profile instead."); return; }
    const base = location.origin + location.pathname + "?pack=" + pack.id;
    if (app.mode === "arena") { copyText(base + "&mode=arena"); return; }
    if (!app.timeline.length) { copyText(base); return; }
    copyText(base + "#r=" + encodeReplay());
  }

  function playReplay(data) {
    const pack = app.current.pack;
    const steps = [{ at_s: 0, caption: "Replaying a shared session." }];
    for (const [t, id, v] of data.s || []) {
      const c = pack.controls.find((x) => x.id === id);
      if (!c) continue;
      steps.push(c.type === "slider" ? { at_s: t, set: { [id]: v } } : { at_s: t, toggle: { [id]: v } });
    }
    const lastT = steps.length ? steps[steps.length - 1].at_s : 0;
    steps.push({ at_s: lastT + 4, end: true });
    const saved = pack.story;
    pack.story = steps;
    startStory();
    pack.story = saved;
  }

  // ------------------------------------------------------------------ Record

  function toggleRecording() {
    if (app.recorder) { app.recorder.stop(); return; }
    if (!canvas.captureStream || typeof MediaRecorder === "undefined") { toast("This browser can't record the canvas."); return; }
    const stream = canvas.captureStream(30);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    let rec;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); } catch (err) { toast("Recording isn't available here."); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      clearTimeout(app.recordTimer);
      app.recorder = null;
      $("record-btn").setAttribute("aria-pressed", "false");
      $("record-btn").textContent = "Record";
      const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `trp-studio-${app.current.pack.id}.${(rec.mimeType || "").includes("mp4") ? "mp4" : "webm"}`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast("Clip saved");
    };
    rec.start(250);
    app.recorder = rec;
    app.recordTimer = setTimeout(() => { if (app.recorder) app.recorder.stop(); }, 20000);
    $("record-btn").setAttribute("aria-pressed", "true");
    $("record-btn").textContent = "Stop recording";
    toast("Recording up to 20 seconds");
  }

  // The recording only sees the canvas, so draw the title, standing and any
  // stop onto it while recording.
  function drawRecordingOverlay(r) {
    const pack = app.current.pack;
    ctx.save();
    ctx.fillStyle = "rgba(244,246,251,0.9)";
    ctx.font = '500 15px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
    ctx.textAlign = "left";
    ctx.fillText("TRP Studio", 24, 34);
    ctx.fillStyle = "rgba(154,163,181,0.9)";
    ctx.font = '300 15px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
    ctx.fillText(pack.title + (app.mode === "arena" ? " · Arena" : ""), 112, 34);
    if (r) {
      const bands = sortedBands();
      const worst = bands.length && r.standing === bands[bands.length - 1].band;
      ctx.textAlign = "right";
      ctx.fillStyle = worst ? "#e6d3a1" : "#f4f6fb";
      ctx.font = '200 34px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
      ctx.fillText(r.standing.replace(/[-_]/g, " "), cw - 24, 46);
      ctx.fillStyle = "rgba(154,163,181,0.9)";
      ctx.font = '400 13px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
      ctx.fillText(RESPONSE_TEXT[r.response] || r.response, cw - 24, 66);
      if (!$("halt").hidden) {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(6,9,24,0.45)";
        ctx.fillRect(0, ch / 2 - 60, cw, 110);
        ctx.fillStyle = "#e6d3a1";
        ctx.font = '200 44px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
        ctx.fillText($("halt-word").textContent, cw / 2, ch / 2);
        ctx.fillStyle = "#f4f6fb";
        ctx.font = '300 15px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
        ctx.fillText($("halt-why").textContent, cw / 2, ch / 2 + 30);
      }
    }
    const cap = $("caption");
    if (cap.classList.contains("show") && cap.textContent) {
      ctx.textAlign = "left";
      ctx.fillStyle = "#f4f6fb";
      ctx.font = '300 15px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, sans-serif';
      ctx.fillText(cap.textContent, 28, ch - 24);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ Agents

  // A documented interface so AI agents, test harnesses and auditors can play
  // without clicking. Everything runs locally in this page.
  window.TRPGames = {
    version: "1",
    events() {
      return app.packs.filter((p) => p.pack.arena).map((p) => ({
        event: p.id, title: p.pack.arena.event || p.title, budget: p.pack.arena.budget, rounds: p.pack.arena.rounds,
        guards: p.pack.arena.guards.map((g) => ({ id: g.id, label: g.label, cost: g.cost, detail: g.detail })),
        challenger_moves: p.pack.arena.moves.map((m) => ({ id: m.id, label: m.label })),
        harms: p.pack.arena.harm.map((h) => ({ id: h.id, label: h.label })),
      }));
    },
    play(opts) {
      const o = opts || {};
      const entry = app.packs.find((p) => p.id === o.event && p.pack.arena);
      if (!entry) throw new Error("Unknown event. Call TRPGames.events() for the list.");
      const pack = entry.pack;
      const guards = (o.guards || []).filter((id) => pack.arena.guards.some((g) => g.id === id));
      const cost = guards.reduce((s, id) => s + pack.arena.guards.find((g) => g.id === id).cost, 0);
      if (cost > pack.arena.budget) throw new Error(`Guards cost ${cost}, over the budget of ${pack.arena.budget}.`);
      const seed = o.seed || A.daySeed();
      const deps = { engine: E, sim: S };
      const m = new A.Match(pack, pack.profileObject, guards, { seed: seed }, deps);
      while (!m.done) m.step(0.05);
      const par = A.par(pack, pack.profileObject, seed, deps).score;
      return {
        event: pack.id, day: A.dayNumber(), seed: seed, guards: guards, player: o.player || "agent",
        score: m.summary.score, par: par, medal: A.medal(m.summary.score, par), summary: m.summary,
        incidents: m.tally.incidents.map((i) => ({ start: i.start, end: i.end, challenger: i.label, harms: i.harms, caught: i.caught, reaction_s: i.reaction })),
      };
    },
    stress(opts) {
      const o = opts || {};
      const entry = app.packs.find((p) => p.id === o.event && p.pack.arena);
      if (!entry) throw new Error("Unknown event. Call TRPGames.events() for the list.");
      return A.stressTest(entry.pack, entry.pack.profileObject, { episodes: Math.min(o.episodes || 300, 10000), seed: o.seed || 7 }, { engine: E, sim: S });
    },
  };

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
      const pack = packFromJSON(SAFE.parse(textValue));
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
  $("share-btn").addEventListener("click", shareSession);
  $("record-btn").addEventListener("click", toggleRecording);
  for (const b of document.querySelectorAll(".mode")) b.addEventListener("click", () => { if (!b.disabled) setMode(b.dataset.mode); });
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
      await Promise.all([loadIndex(), loadChallenges()]);
    } catch (err) {
      $("pack-title").textContent = "Studio needs a web server";
      $("pack-subtitle").textContent = "Run python3 -m http.server from the repository root, then open /studio/.";
      return;
    }
    renderTabs();
    let replay = null;
    if (location.hash.startsWith("#r=")) {
      try { replay = decodeReplay(location.hash.slice(3)); } catch (err) { toast("That replay link could not be read."); }
    }
    const wantStory = params.get("story") !== "0" && !replay;
    const wantMode = params.get("mode") || undefined;
    if (params.get("profile")) {
      try {
        const pack = packFromJSON(await fetchUntrusted(params.get("profile")));
        addCustomPack(pack);
      } catch (err) {
        toast(err.message);
        selectPack(params.get("pack") || (app.packs[0] && app.packs[0].id), { story: wantStory });
      }
    } else {
      selectPack((replay && replay.p) || params.get("pack") || (app.packs[0] && app.packs[0].id), { story: wantStory, mode: wantMode });
      if (replay) playReplay(replay);
    }
    requestAnimationFrame(frame);
    fetch("https://api.github.com/repos/aitrustalliance/trp").then((r) => r.ok ? r.json() : null).then((d) => {
      if (d && typeof d.stargazers_count === "number") $("star-link").textContent = `Star on GitHub · ${d.stargazers_count}`;
    }).catch(() => {});
  })();
})();
