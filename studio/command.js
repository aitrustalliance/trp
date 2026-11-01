/**
 * TRP Studio Command. The first screen.
 *
 * A floor of AI systems from every scenario pack, each with its own
 * simulator, each judged by the open TRP engine every tick against the pack's
 * published profile. Faults arrive at random. The floor counts what the rules
 * caught, what slipped through and what they stopped for nothing, and a rule
 * book dial moves every profile's limits a step toward safe or a step past
 * harm so the trade-off shows live. Nothing here is scripted. The numbers are
 * what the engine did.
 */
(function (root) {
  "use strict";

  const C = {
    hair: "rgba(214,222,238,0.10)", hairStrong: "rgba(214,222,238,0.22)", silver: "#9aa3b5", dim: "#5e6880",
    white: "#f4f6fb", accent: "#4fa8e8", gold: "#e6d3a1", harm: "#f2b48a", card: "rgba(255,255,255,0.025)",
  };
  const RESPONSE = { full: "Full", restricted: "Half", suspended: "Stop" };
  const BOOKS = {
    loose: { label: "Loose", shift: 1, note: "Every limit a step past where harm begins. The rules ring late or never, and harm slips through." },
    published: { label: "Published", shift: 0, note: "The reference profiles as published, before anyone measured them against faults." },
    tight: { label: "Tight", shift: -1, note: "Every limit a step toward safe. Harm is caught, and the floor stops for nothing far more often." },
    tuned: { label: "Tuned", shift: 0, tuned: true, note: "The same profiles with limits set by measurement, three hundred runs with faults mixed in. Harm is caught and the floor keeps running." },
  };
  const WINDOW_S = 300; // the counters cover the last five minutes

  let E, S, A;
  let el = null, ctx = null, systems = [], groups = [], clock = 0, acc = 0, raf = 0, last = 0;
  let selected = null, incidents = [], tiles = [], dpr = 1, counts = null, onOpen = null, mounted = false;
  let perSecond = [], readingsPerTick = 0, tick = 0.25, reduced = false, book = "tuned", challenges = null;

  // A profile with every limit moved by `shift` times the gap between its
  // warning and its critical limit, toward safe when negative and toward
  // harm when positive. Hard rules are left alone.
  function shifted(raw, shift) {
    if (!shift) return raw;
    const doc = JSON.parse(JSON.stringify(raw));
    for (const s of doc.scored_signals || []) {
      const w = s.warning_threshold, c = s.critical_threshold;
      if (typeof w !== "number" || typeof c !== "number") continue;
      const gap = c - w; // positive when higher is unsafe, negative when lower is unsafe
      s.warning_threshold = +(w + gap * shift).toFixed(4);
      s.critical_threshold = +(c + gap * shift).toFixed(4);
    }
    doc.trp_id = raw.trp_id + (shift < 0 ? "-cautious" : "-bold");
    return doc;
  }

  // The published profile with the limits a Learn challenge settled on.
  function tunedProfile(pack) {
    const doc = JSON.parse(JSON.stringify(pack.profileObject));
    const ch = challenges && (challenges.challenges || []).find((c) => c.pack === pack.id && c.solution);
    if (!ch) return doc;
    for (const [name, v] of Object.entries(ch.solution)) {
      const sg = (doc.scored_signals || []).find((x) => x.signal === name);
      if (sg) { sg.warning_threshold = v.warning; sg.critical_threshold = v.critical; }
    }
    doc.trp_id = doc.trp_id + "-tuned";
    return doc;
  }

  function makeSystems(packs) {
    const out = [], gs = [];
    for (const entry of packs) {
      const pack = entry.pack;
      if (!pack.arena || !pack.arena.harm || !pack.arena.moves || !pack.command) continue;
      const cfg = pack.command;
      const profiles = {};
      for (const [id, b] of Object.entries(BOOKS)) profiles[id] = E.loadProfile(b.tuned ? tunedProfile(pack) : shifted(pack.profileObject, b.shift));
      const group = { pack, entry, label: cfg.group || pack.title, systems: [], profiles, signals: Object.keys(pack.signals) };
      for (let i = 0; i < cfg.count; i++) {
        const sim = new S.Simulator(pack);
        sim.random = S.makeRandom(4000 + out.length * 17);
        sim.time = (i * 0.37) % 4;
        const sys = { id: `${pack.id}-${i + 1}`, name: `${cfg.unit || "System"} ${String(i + 1).padStart(2, "0")}`, group, sim, result: null, fault: null, until: 0, tally: new A.Tally(), seen: 0, pulse: 0, harm: false, lastResponse: "full", caught: 0, missed: 0, needless: 0, history: [] };
        group.systems.push(sys); out.push(sys);
      }
      gs.push(group);
    }
    return { systems: out, groups: gs };
  }

  // ---------------------------------------------------------------- Simulation

  function step(dt) {
    clock += dt;
    const random = step.random || (step.random = S.makeRandom(31337));
    let readings = 0;
    for (const sys of systems) {
      const { pack } = sys.group;
      const rate = (pack.command.fault_rate || 0.02), benignRate = pack.command.benign && pack.command.benign.length ? (pack.command.benign_rate || 0.02) : 0;
      if (!sys.fault && random() < (rate + benignRate) * dt) {
        // A fault from the pack's Arena moves, or a benign excursion that
        // sends a reading toward its limit with nothing wrong.
        const benign = random() < benignRate / (rate + benignRate);
        const moves = benign ? pack.command.benign : pack.arena.moves;
        let total = 0; for (const m of moves) total += m.weight || 1;
        let pick = random() * total, move = moves[0];
        for (const m of moves) { pick -= m.weight || 1; if (pick <= 0) { move = m; break; } }
        sys.fault = move; sys.benign = benign; sys.lastLabel = move.label; sys.until = clock + 2.5 + random() * 3.5; sys.sim.extraEffects = move.effects;
      } else if (sys.fault && clock > sys.until) { sys.fault = null; sys.benign = false; sys.sim.extraEffects = null; }
      sys.sim.step(dt);
      const profile = sys.group.profiles[book];
      const evidence = sys.sim.evidence();
      sys.result = E.evaluate(profile, evidence, null);
      readings += Object.keys(evidence).length;
      const harms = A.harmsActive(pack.arena, sys.sim.values);
      const stopped = A.isStopped(sys.result);
      sys.harm = harms.length > 0 && !stopped;
      sys.tally.update(clock, harms, stopped, sys.fault ? sys.fault.label : "", A.nearHarm(pack.arena, sys.sim.values));
      // Fold closed incidents and false halts into the counters.
      while (sys.seen < sys.tally.incidents.length) {
        const inc = sys.tally.incidents[sys.seen++];
        if (inc.caught) { sys.caught++; note(sys, "caught", inc); } else { sys.missed++; note(sys, "missed", inc); }
      }
      if (sys.tally.falseHalts > sys.needless) { sys.needless = sys.tally.falseHalts; note(sys, "needless", null); }
      if (sys.result.response !== sys.lastResponse) { sys.pulse = 1; sys.lastResponse = sys.result.response; }
      sys.pulse = Math.max(0, sys.pulse - dt * 2);
      const worst = sys.result.signal_results.reduce((m, r) => Math.max(m, r.severity || 0), 0);
      sys.history.push(worst); if (sys.history.length > 60) sys.history.shift();
    }
    readingsPerTick = readings;
    perSecond.push([clock, readings]);
    while (perSecond.length && clock - perSecond[0][0] > 1) perSecond.shift();
    while (incidents.length && clock - incidents[0].t > WINDOW_S) incidents.shift();
  }

  function note(sys, kind, inc) {
    const labels = (sys.group.pack.arena.harm || []).reduce((m, h) => (m[h.id] = h.label, m), {});
    const what = inc ? inc.harms.map((h) => labels[h] || h).join(", ") : (sys.lastLabel || "");
    incidents.push({ t: clock, sys, kind, what, book, reaction: inc && inc.reaction != null ? inc.reaction : null });
    if (incidents.length > 400) incidents.shift();
    renderIncidents();
  }

  function tallies() {
    const c = { systems: systems.length, caught: 0, missed: 0, needless: 0, stopped: 0, restricted: 0 };
    for (const i of incidents) { if (i.kind === "caught") c.caught++; else if (i.kind === "missed") c.missed++; else c.needless++; }
    for (const s of systems) { if (!s.result) continue; if (s.result.response === "suspended") c.stopped++; else if (s.result.response === "restricted") c.restricted++; }
    c.readings = perSecond.reduce((a, b) => a + b[1], 0);
    c.parameters = systems.reduce((a, s) => a + s.group.signals.length, 0);
    return c;
  }

  // ---------------------------------------------------------------- Drawing

  function layout(w) {
    tiles = [];
    const pad = 4, gap = 10, minTile = 118, tileH = 58, groupGap = 26;
    let y = pad;
    for (const g of groups) {
      const cols = Math.max(1, Math.floor((w - pad * 2 + gap) / (minTile + gap)));
      const tw = (w - pad * 2 - gap * (cols - 1)) / cols;
      g.labelY = y + 14;
      y += 28;
      g.systems.forEach((sys, i) => {
        const x = pad + (i % cols) * (tw + gap), ty = y + Math.floor(i / cols) * (tileH + gap);
        tiles.push({ sys, x, y: ty, w: tw, h: tileH });
      });
      y += Math.ceil(g.systems.length / cols) * (tileH + gap) - gap + groupGap;
    }
    return y;
  }

  function draw() {
    if (!el || !ctx) return;
    const w = el.clientWidth;
    const height = layout(w);
    if (el.height !== Math.round(height * dpr) || el.width !== Math.round(w * dpr)) {
      el.width = Math.round(w * dpr); el.height = Math.round(height * dpr); el.style.height = height + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.textBaseline = "alphabetic";
    for (const g of groups) {
      ctx.fillStyle = C.silver; ctx.font = "500 11px -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif"; ctx.textAlign = "left";
      ctx.fillText(`${g.label.toUpperCase()}   ·   ${g.systems.length} SYSTEMS   ·   ${g.signals.length} READINGS EACH   ·   ${g.pack.profileObject.trp_id} ${g.pack.profileObject.version}`, 4, g.labelY);
    }
    for (const t of tiles) {
      const { sys } = t, r = sys.result;
      const resp = r ? r.response : "full";
      const stop = resp === "suspended", half = resp === "restricted";
      ctx.fillStyle = sys.harm ? "rgba(242,180,138,0.10)" : stop ? "rgba(230,211,161,0.10)" : C.card;
      ctx.strokeStyle = sys === selected ? C.white : sys.harm ? C.harm : stop ? C.gold : half ? C.hairStrong : C.hair;
      ctx.lineWidth = sys === selected ? 1.5 : 1;
      roundRect(ctx, t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, 6); ctx.fill(); ctx.stroke();
      if (sys.pulse > 0 && !reduced) { ctx.strokeStyle = stop ? `rgba(230,211,161,${sys.pulse * 0.8})` : `rgba(244,246,251,${sys.pulse * 0.5})`; ctx.lineWidth = 1 + sys.pulse * 2; roundRect(ctx, t.x - sys.pulse * 3, t.y - sys.pulse * 3, t.w + sys.pulse * 6, t.h + sys.pulse * 6, 8); ctx.stroke(); }
      ctx.fillStyle = C.white; ctx.font = "500 12px -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif"; ctx.textAlign = "left";
      ctx.fillText(sys.name, t.x + 10, t.y + 19);
      ctx.textAlign = "right"; ctx.font = "600 10px -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif";
      ctx.fillStyle = sys.harm ? C.harm : stop ? C.gold : half ? C.white : C.dim;
      ctx.fillText(sys.harm ? "HARM" : RESPONSE[resp].toUpperCase(), t.x + t.w - 10, t.y + 19);
      // One square per reading, colored by where it sits against its limits.
      const n = sys.group.signals.length, sq = Math.min(10, (t.w - 20 - (n - 1) * 3) / n);
      sys.group.signals.forEach((name, i) => {
        const x = t.x + 10 + i * (sq + 3), y = t.y + t.h - 10 - sq;
        const sr = r && r.signal_results.find((z) => z.signal === name);
        const missing = r && r.missing_signals.some((m) => m.signal === name);
        if (missing) { ctx.strokeStyle = C.hairStrong; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, sq - 1, sq - 1); return; }
        const scored = !!sr;
        ctx.fillStyle = !scored ? "rgba(214,222,238,0.14)" : sr.in_critical ? C.gold : sr.in_warning ? C.white : `rgba(79,168,232,${0.25 + (sr.severity || 0) * 0.6})`;
        ctx.fillRect(x, y, sq, sq);
      });
      // Fault in progress: a thin line along the top edge.
      if (sys.fault) { ctx.fillStyle = sys.harm ? C.harm : sys.benign ? C.dim : C.gold; ctx.fillRect(t.x + 8, t.y + 2, Math.max(6, (t.w - 16) * Math.max(0, Math.min(1, (sys.until - clock) / 6))), 2); }
    }
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
  }

  // ---------------------------------------------------------------- DOM

  const $ = (id) => document.getElementById(id);
  function text(id, v) { const n = $(id); if (n) n.textContent = v; }

  function renderNumbers() {
    const c = tallies();
    text("cmd-systems", String(c.systems));
    text("cmd-readings", c.readings.toLocaleString());
    text("cmd-caught", String(c.caught));
    text("cmd-missed", String(c.missed));
    text("cmd-needless", String(c.needless));
    text("cmd-state", `${c.stopped} stopped · ${c.restricted} at half · ${c.systems - c.stopped - c.restricted} running`);
    text("cmd-sub", `${c.systems} AI systems across ${groups.length} domains, ${c.parameters.toLocaleString()} live readings, every one judged ${Math.round(1 / tick)} times a second by the open TRP engine against a rule book anyone can read.`);
  }

  function renderIncidents() {
    const list = $("cmd-incidents");
    if (!list) return;
    list.textContent = "";
    const recent = incidents.slice(-8).reverse();
    for (const i of recent) {
      const li = document.createElement("li");
      li.className = i.kind;
      const t = document.createElement("span"); t.className = "t"; t.textContent = fmt(i.t);
      const who = document.createElement("button"); who.type = "button"; who.className = "who"; who.textContent = `${i.sys.group.label} · ${i.sys.name}`;
      who.addEventListener("click", () => select(i.sys));
      const what = document.createElement("span"); what.className = "what";
      what.textContent = i.kind === "caught" ? `${i.reaction == null || i.reaction < 0.01 ? "Stopped before harm began" : `Stopped ${i.reaction.toFixed(2)} s after harm began`}. ${i.what}.` : i.kind === "missed" ? `Slipped through. ${i.what}.` : `Stopped for nothing${i.what ? ". " + i.what : ""}.`;
      li.append(t, who, what);
      list.append(li);
    }
    if (!recent.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing yet. Faults arrive on their own."; list.append(li); }
  }

  function fmt(t) { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, "0")}`; }

  function renderDetail() {
    const box = $("cmd-detail");
    if (!box) return;
    if (!selected) { box.hidden = true; return; }
    box.hidden = false;
    const sys = selected, r = sys.result, p = sys.group.profiles[book], pack = sys.group.pack;
    text("cmd-d-name", `${sys.group.label} · ${sys.name}`);
    text("cmd-d-sub", `${pack.subtitle || ""}`);
    const resp = r ? r.response : "full";
    text("cmd-d-response", resp === "suspended" ? "All stop" : resp === "restricted" ? "Half ahead" : "Full operation");
    const why = [];
    if (r) {
      for (const h of r.hard_rules_triggered) why.push(`Hard rule ${h.rule.replace(/_/g, " ")}`);
      for (const s of r.signal_results) if (s.in_critical) why.push(`${labelOf(pack, s.signal)} critical at ${s.value}${s.unit ? " " + s.unit : ""}`);
      for (const s of r.signal_results) if (s.in_warning && !s.in_critical) why.push(`${labelOf(pack, s.signal)} in warning at ${s.value}${s.unit ? " " + s.unit : ""}`);
      for (const m of r.missing_signals) why.push(`${labelOf(pack, m.signal)} has no reading`);
    }
    if (sys.fault) why.push(`${sys.benign ? "In progress, nothing wrong" : "Fault in progress"}: ${sys.fault.label.toLowerCase()}`);
    text("cmd-d-why", why.length ? why.join(". ") + "." : "Every reading inside its range and no hard rule met.");
    const table = $("cmd-d-signals"); table.textContent = "";
    for (const name of sys.group.signals) {
      const sr = r && r.signal_results.find((z) => z.signal === name);
      const spec = p.scoredSignals.find((z) => z.signal === name);
      const missing = r && r.missing_signals.some((m) => m.signal === name);
      const row = document.createElement("div"); row.className = "sig" + (missing ? " missing" : sr && sr.in_critical ? " critical" : sr && sr.in_warning ? " warning" : "");
      const a = document.createElement("span"); a.textContent = labelOf(pack, name);
      const b = document.createElement("span"); b.className = "mono"; b.textContent = missing ? "no reading" : String(sys.sim.evidence()[name] !== undefined ? sys.sim.evidence()[name] : sys.sim.values[name]);
      const c = document.createElement("span"); c.className = "lim"; c.textContent = spec ? `warn ${spec.warningThreshold} · stop ${spec.criticalThreshold}${spec.unit ? " " + spec.unit : ""}` : "hard rule";
      row.append(a, b, c); table.append(row);
    }
    text("cmd-d-book", `${BOOKS[book].label} book, ${p.trpId} ${p.version}. Caught ${sys.caught}, slipped ${sys.missed}, stopped for nothing ${sys.needless}.`);
  }
  function labelOf(pack, name) { const s = pack.signals[name]; return (s && s.label) || name.replace(/_/g, " "); }

  function select(sys) { selected = sys; renderDetail(); }

  function renderBook() {
    for (const b of document.querySelectorAll("#cmd-books button")) b.setAttribute("aria-pressed", String(b.dataset.book === book));
    text("cmd-book-note", BOOKS[book].note);
  }

  // ---------------------------------------------------------------- Loop

  function frame(now) {
    if (!mounted) return;
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    acc += dt;
    let ticked = false;
    while (acc >= tick) { step(tick); acc -= tick; ticked = true; }
    for (const s of systems) s.pulse = Math.max(0, s.pulse - dt * 1.5);
    draw();
    if (ticked) { renderNumbers(); if (selected) renderDetail(); }
    raf = requestAnimationFrame(frame);
  }

  function mount(opts) {
    E = opts.engine; S = opts.sim; A = opts.arena; onOpen = opts.onOpen || null; challenges = opts.challenges || challenges;
    reduced = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (!systems.length) { const made = makeSystems(opts.packs); systems = made.systems; groups = made.groups; tick = Math.min(...groups.map((g) => (g.pack.tick_ms || 250) / 1000), 0.25); }
    el = $("cmd-wall"); ctx = el.getContext("2d"); dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!mount.bound) {
      mount.bound = true;
      el.addEventListener("click", (e) => {
        const rect = el.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
        const hit = tiles.find((t) => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
        select(hit ? hit.sys : null);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Enter") return;
        const i = systems.indexOf(selected);
        if (e.key === "Enter" && selected && onOpen) { onOpen(selected.group.entry.id); return; }
        select(systems[(i + (e.key === "ArrowRight" ? 1 : systems.length - 1)) % systems.length]); e.preventDefault();
      });
      for (const b of document.querySelectorAll("#cmd-books button")) b.addEventListener("click", () => setBook(b.dataset.book));
      const open = $("cmd-d-open"); if (open) open.addEventListener("click", () => { if (selected && onOpen) onOpen(selected.group.entry.id); });
      const close = $("cmd-d-close"); if (close) close.addEventListener("click", () => select(null));
    }
    mounted = true; last = 0;
    renderBook(); renderNumbers(); renderIncidents(); renderDetail();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  }

  function unmount() { mounted = false; cancelAnimationFrame(raf); }

  // Changing the book starts the count again, so the numbers on the bar
  // belong to one book.
  function setBook(id) {
    if (!BOOKS[id]) return;
    book = id;
    incidents = [];
    for (const s of systems) { s.lastResponse = s.result ? s.result.response : "full"; s.tally = new A.Tally(); s.seen = 0; s.caught = 0; s.missed = 0; s.needless = 0; }
    renderBook(); renderNumbers(); renderIncidents(); renderDetail();
  }

  // Steps the floor forward without drawing. For tests.
  function advance(seconds) { for (let t = 0; t < seconds; t += tick) step(tick); renderNumbers(); renderIncidents(); if (selected) renderDetail(); return tallies(); }

  root.TRPCommand = { mount, unmount, setBook, advance, select: (id) => select(systems.find((s) => s.id === id) || null), get book() { return book; }, get systems() { return systems; }, tallies, shifted, BOOKS };
})(window);
