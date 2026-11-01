/**
 * Nautilus game controller.
 *
 * Owns the voyage from core.js, input, sound, the heads-up display, the
 * screens, the captain's ledger, the codex, the shakedown cruise, settings,
 * sharing and the crew sign-up. The world is drawn by a renderer, World3D
 * (world3d.js, WebGL) when it loads, otherwise World2D below, which uses
 * art.js.
 */
(function () {
  "use strict";

  const C = window.TRPNautilusCore;
  const E = window.TRPEngine;
  const ART = window.NautilusArt;
  const SND = window.NautilusAudio;
  const CREW = window.NautilusCrew;
  const CODEX = window.TRPCodex;
  const TUT = window.NautilusTutorial;
  const CFG = window.NAUTILUS_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const W = C.W, H = C.H;
  const STEP = 1 / 60;
  const HUD_FONT = '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

  const GAUGES = [
    { signal: "hull_stress", label: "Hull", min: 0, max: 1.2 },
    { signal: "reactor_temp_c", label: "Reactor", min: 40, max: 160 },
    { signal: "sonar_confidence", label: "Sonar", min: 0, max: 1 },
    { signal: "crew_goal_drift", label: "Crew", min: 0, max: 1 },
  ];
  const UNLOCKS = { bronze: "copper", silver: "verdigris", gold: "gilded" };
  const MEDAL_BRASS = { gold: 30, silver: 20, bronze: 10 };
  const TEXT_SIZES = [["Standard", 1], ["Large", 1.15], ["Larger", 1.3]];
  const EXAM_N = 10, EXAM_PASS = 7;

  const game = {
    state: "loading",
    profileRaw: null,
    voyage: null,
    official: false,
    tutorial: null,
    pendingFinish: null,
    renderer: null,
    hud: null, hudCtx: null, hudW: 1, hudH: 1,
    captions: [], floats: [],
    shake: 0, flash: 0, telegraph: 0,
    acc: 0, last: 0,
    par: {},
    lastSummary: null,
    discoveredThisVoyage: new Set(),
    returnTo: null,
    exam: null,
  };

  // ------------------------------------------------------------ Ledger

  const LKEY = "nautilus.v1";
  function freshLedger() {
    return {
      brass: 0, lifetimeLeagues: 0, bestEver: 0, best: {}, streak: { last: 0, count: 0 },
      medals: { gold: 0, silver: 0, bronze: 0 }, skins: ["brass"], skin: "brass",
      pennants: ["none"], pennant: "none", captain: "", joined: false, played: {},
      tutorialDone: false,
      codex: { discovered: [], checked: [], examBest: 0 },
      settings: { difficulty: "normal", reduceMotion: null, textScale: 1, sound: true },
    };
  }
  const own = (o, k) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
  const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  // Storage is shared with other pages on the same site, so every field is
  // checked and anything unexpected falls back to the default.
  function loadLedger() {
    const L = freshLedger();
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LKEY) || "null"); } catch (err) { raw = null; }
    if (!raw || typeof raw !== "object") return L;
    L.brass = num(raw.brass, 0);
    L.lifetimeLeagues = num(raw.lifetimeLeagues, 0);
    L.bestEver = num(raw.bestEver, 0);
    if (raw.streak) L.streak = { last: num(raw.streak.last, 0), count: num(raw.streak.count, 0) };
    if (raw.medals) for (const k of ["gold", "silver", "bronze"]) L.medals[k] = num(raw.medals[k], 0);
    if (Array.isArray(raw.skins)) L.skins = [...new Set(raw.skins.filter((s) => own(ART.SKINS, s)))];
    if (!L.skins.includes("brass")) L.skins.unshift("brass");
    if (own(ART.SKINS, raw.skin) && L.skins.includes(raw.skin)) L.skin = raw.skin;
    if (Array.isArray(raw.pennants)) L.pennants = [...new Set(raw.pennants.filter((p) => own(ART.PENNANTS, p)))];
    if (!L.pennants.includes("none")) L.pennants.unshift("none");
    if (own(ART.PENNANTS, raw.pennant) && L.pennants.includes(raw.pennant)) L.pennant = raw.pennant;
    if (typeof raw.captain === "string") L.captain = raw.captain.slice(0, 40);
    L.joined = raw.joined === true;
    L.tutorialDone = raw.tutorialDone === true;
    if (raw.best && typeof raw.best === "object") for (const [k, v] of Object.entries(raw.best)) if (/^\d{8}$/.test(k)) L.best[k] = num(v, 0);
    if (raw.played && typeof raw.played === "object") for (const k of Object.keys(raw.played)) if (/^\d{8}$/.test(k)) L.played[k] = true;
    if (raw.codex && typeof raw.codex === "object") {
      const idOk = (x) => typeof x === "string" && /^[a-z0-9-]{1,40}$/.test(x);
      L.codex.discovered = Array.isArray(raw.codex.discovered) ? [...new Set(raw.codex.discovered.filter(idOk))] : [];
      L.codex.checked = Array.isArray(raw.codex.checked) ? [...new Set(raw.codex.checked.filter(idOk))] : [];
      L.codex.examBest = num(raw.codex.examBest, 0);
    }
    const s = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
    if (own(C.DIFFICULTY, s.difficulty)) L.settings.difficulty = s.difficulty;
    if (s.reduceMotion === true || s.reduceMotion === false) L.settings.reduceMotion = s.reduceMotion;
    if (TEXT_SIZES.some((t) => t[1] === s.textScale)) L.settings.textScale = s.textScale;
    L.settings.sound = s.sound !== false;
    return L;
  }
  let ledger = loadLedger();
  function saveLedger() { try { localStorage.setItem(LKEY, JSON.stringify(ledger)); } catch (err) { /* private mode */ } }

  function reducedMotion() {
    if (ledger.settings.reduceMotion !== null) return ledger.settings.reduceMotion;
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function applySettings() {
    document.documentElement.style.setProperty("--text-scale", String(ledger.settings.textScale));
    document.body.classList.toggle("reduce-motion", reducedMotion());
    SND.setMuted(!ledger.settings.sound);
  }

  // ------------------------------------------------------------ World2D

  function World2D() {
    let ctx = null, layers = null, cw = 0, ch = 0, s = 1, ox = 0, oy = 0;
    const parts = [];
    const flakes = [];
    return {
      name: "2d",
      init(canvas) {
        ctx = canvas.getContext("2d");
        layers = ART.buildLayers(W, H, C.WATER);
        for (let i = 0; i < 90; i++) flakes.push({ x: Math.random() * W, y: C.WATER + Math.random() * (H - C.WATER), r: 1 + Math.random() * 1.5, s: 0.5 + Math.random() });
      },
      resize(w, h, dpr) {
        cw = w; ch = h;
        ctx.canvas.width = Math.round(w * dpr); ctx.canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        s = Math.min(w / W, h / H); ox = (w - W * s) / 2; oy = (h - H * s) / 2;
      },
      project(x, y) { return { x: ox + x * s, y: oy + y * s }; },
      unproject(x, y) { return { x: (x - ox) / s, y: (y - oy) / s }; },
      event(e, v, view) { burst2d(parts, e, v, view); },
      render(v, dt, view) {
        const g = ctx;
        const band = g.createLinearGradient(0, 0, 0, ch);
        band.addColorStop(0, "#060918"); band.addColorStop(Math.max(0.01, Math.min(0.99, (oy + C.WATER * s) / ch)), "#103059"); band.addColorStop(1, "#040b19");
        g.fillStyle = band; g.fillRect(0, 0, cw, ch);
        g.save();
        const shake = view.reduced ? 0 : view.shake;
        g.translate(ox + (Math.random() - 0.5) * shake * 12, oy + (Math.random() - 0.5) * shake * 12);
        g.scale(s, s);
        const scroll = 140 * v.sub.speed;
        ART.background(g, { W, H, WATER: C.WATER, t: v.t, dist: v.dist, layers, captured: v.rulesCaptured, flash: view.reduced ? 0 : view.flash });
        ART.snow(g, flakes, W, H, C.WATER, dt, scroll);
        ART.airship(g, C.airshipX(v.t), 92, v.t, { captured: v.rulesCaptured });
        for (const p of v.payloads) {
          if (p.kind === "charge") { g.strokeStyle = "rgba(230, 211, 161, 0.25)"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(p.x - 40, p.fuseY); g.lineTo(p.x + 40, p.fuseY); g.stroke(); g.setLineDash([]); }
          ART.payload(g, p, v.t);
        }
        for (const gr of v.gears) ART.gear(g, gr, v.t);
        for (const h of v.harpoons) ART.harpoon(g, h, C.SUB_X + 30, v.sub.y - 40);
        if (!view.reduced && v.sub.speed > 0.05 && Math.random() < v.sub.speed * 0.8) parts.push({ x: C.SUB_X - 125, y: v.sub.y + (Math.random() - 0.5) * 10, vx: -40 - Math.random() * 40, vy: -20 - Math.random() * 20, life: 1.2, max: 1.2, r: 2 + Math.random() * 3, kind: "bubble" });
        ART.sub(g, C.SUB_X, v.sub.y, { skin: view.skin, pennant: view.pennant, prop: v.t * (4 + 16 * v.sub.speed), time: v.t, tilt: (v.sub.targetY - v.sub.y) * 0.0012, blink: v.invuln > 0 && Math.floor(v.t * 12) % 2 === 0 });
        drawParts2d(g, parts, dt);
        g.restore();
      },
    };
  }

  function burst2d(parts, e, v, view) {
    const k = view && view.reduced ? 0.3 : 1;
    const add = (n, f) => { for (let i = 0; i < Math.ceil(n * k); i++) parts.push(f(i)); };
    const rnd = (a) => (Math.random() - 0.5) * a;
    if (e.type === "intercept" || e.type === "dent") {
      add(e.type === "dent" ? 8 : 22, () => ({ x: e.x, y: e.y, vx: rnd(500), vy: rnd(500), life: 0.6, max: 0.6, r: 2.5, kind: "spark", color: "#f0d9a0" }));
      parts.push({ x: e.x, y: e.y, life: 0.45, max: 0.45, r: 10, kind: "ring", color: "rgba(240, 217, 160, " });
    } else if (e.type === "blast") {
      add(40, () => ({ x: e.x, y: e.y, vx: rnd(700), vy: rnd(700), life: 0.9, max: 0.9, r: 3, kind: "spark", color: "#ffd99a" }));
      add(30, () => ({ x: e.x + rnd(40), y: e.y + rnd(40), vx: rnd(80), vy: -60 - Math.random() * 80, life: 1.6, max: 1.6, r: 3 + Math.random() * 4, kind: "bubble" }));
      parts.push({ x: e.x, y: e.y, life: 0.7, max: 0.7, r: 30, kind: "ring", color: "rgba(255, 230, 190, " });
    } else if (e.type === "contact") {
      const color = { fog: "#8a86b5", decoy: "#c9d4ff", ember: "#ff9a4a", boarder: "#9fd0ff", siren: "#b9a6ff", writ: "#d8ccff" }[e.kind] || "#fff";
      add(26, () => ({ x: e.x, y: e.y, vx: rnd(300), vy: rnd(300), life: 1, max: 1, r: 4, kind: "spark", color }));
    } else if (e.type === "gear") {
      add(10, () => ({ x: e.x, y: e.y, vx: rnd(200), vy: rnd(200), life: 0.5, max: 0.5, r: 2, kind: "spark", color: "#e6c27a" }));
    } else if (e.type === "caught") {
      parts.push({ x: C.SUB_X, y: e.subY, life: 0.9, max: 0.9, r: 60, kind: "ring", color: "rgba(230, 211, 161, " });
    }
    if (parts.length > 600) parts.splice(0, parts.length - 600);
  }

  function drawParts2d(g, parts, dt) {
    g.save(); g.globalCompositeOperation = "lighter";
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      const k = p.life / p.max;
      if (p.kind === "ring") {
        g.strokeStyle = p.color + (k * 0.8).toFixed(3) + ")"; g.lineWidth = 3 * k + 1;
        g.beginPath(); g.arc(p.x, p.y, p.r + (1 - k) * p.r * 3, 0, Math.PI * 2); g.stroke();
        continue;
      }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.kind === "spark") { p.vx *= 0.92; p.vy *= 0.92; g.fillStyle = p.color; g.globalAlpha = k; g.beginPath(); g.arc(p.x, p.y, p.r * k + 0.5, 0, Math.PI * 2); g.fill(); }
      else { g.globalAlpha = k * 0.6; g.strokeStyle = "rgba(200, 225, 255, 0.9)"; g.lineWidth = 1; g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.stroke(); }
    }
    g.restore();
  }

  // ------------------------------------------------------------ HUD

  function drawHud(v, dt) {
    const g = game.hudCtx, w = game.hudW, h = game.hudH;
    g.clearRect(0, 0, w, h);
    const live = game.state === "playing" || game.state === "paused" || game.state === "lesson" || game.state === "explain";
    for (let i = game.floats.length - 1; i >= 0; i--) {
      const f = game.floats[i];
      f.life -= dt; f.y -= 40 * dt;
      if (f.life <= 0) { game.floats.splice(i, 1); continue; }
      const p = game.renderer.project(f.x, f.y);
      g.globalAlpha = Math.min(1, f.life * 2);
      g.font = `600 ${f.size || 16}px ${HUD_FONT}`; g.textAlign = "center";
      g.fillStyle = f.color || "#f0d9a0"; g.fillText(f.text, p.x, p.y);
      g.globalAlpha = 1;
    }
    if (!live) return;
    const k = Math.max(0.62, Math.min(1.15, Math.min(w / 1150, h / 680)));
    g.save();
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.shadowColor = "rgba(0,0,0,0.7)"; g.shadowBlur = 6;
    g.fillStyle = "#f4f6fb"; g.font = `400 ${Math.round(40 * k)}px ${HUD_FONT}`;
    g.fillText(v.score.toLocaleString(), 20 * k, 92 * k);
    g.fillStyle = "#c9b27d"; g.font = `600 ${Math.round(11 * k)}px ${HUD_FONT}`;
    const mult = Math.min(3, 1 + Math.floor(v.combo / 5));
    const spaced = (t) => t.toUpperCase().split("").join(" ");
    g.fillText(spaced(`${v.leagues} leagues${v.combo > 1 ? `  ·  combo ${v.combo}${mult > 1 ? `  ×${mult}` : ""}` : ""}`), 22 * k, 112 * k);
    const left = Math.max(0, v.duration - v.t);
    g.fillText(spaced(game.tutorial ? "shakedown cruise" : `free harbor in ${Math.ceil(left)}s`), 22 * k, 130 * k);
    g.textAlign = "right";
    for (let i = 0; i < Math.max(3, v.hearts); i++) {
      const x = w - (24 + i * 34) * k, y = 78 * k;
      g.fillStyle = i < v.hearts ? "#e6c27a" : "rgba(230, 194, 122, 0.18)";
      g.beginPath(); g.ellipse(x - 12 * k, y, 14 * k, 6 * k, 0, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < v.steamMax; i++) {
      const x = w - (24 + i * 18) * k - 4 * k, y = 100 * k;
      g.fillStyle = i < Math.floor(v.steam) ? "#cfe2ff" : "rgba(207, 226, 255, 0.15)";
      g.beginPath(); g.arc(x - 8 * k, y, 5 * k, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = "#c9b27d"; g.font = `600 ${Math.round(10 * k)}px ${HUD_FONT}`;
    g.fillText(spaced("hull"), w - (24 + Math.max(3, v.hearts) * 34) * k + 6 * k, 82 * k);
    g.fillText(spaced("steam"), w - (24 + v.steamMax * 18) * k - 2 * k, 104 * k);
    g.shadowBlur = 0;
    const target = v.response === "full" ? 0 : v.response === "restricted" ? 0.5 : 1;
    game.telegraph += (target - game.telegraph) * (1 - Math.exp(-dt / 0.15));
    const by = h - 30 * k;
    g.save(); g.scale(k, k);
    ART.telegraph(g, 86, by / k - 30, 62, game.telegraph, v.order);
    const prof = v.rulesCaptured ? v.captured : v.profile;
    GAUGES.forEach((gs, i) => {
      const sig = prof.scoredSignals.find((x) => x.signal === gs.signal);
      const val = v.evidence[gs.signal];
      ART.gauge(g, 200 + i * 86, by / k - 52, 32, { min: gs.min, max: gs.max, value: val === undefined ? null : val, warning: sig.warningThreshold, critical: sig.criticalThreshold, direction: sig.direction, label: gs.label, captured: v.rulesCaptured });
    });
    const sealOk = v.evidence.command_seal_valid !== false;
    const lx = 200 + 4 * 86 - 10, ly = by / k - 52;
    g.fillStyle = "#6e522a"; g.beginPath(); g.arc(lx, ly, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = sealOk ? "#9fd0ff" : "#c8643c"; g.beginPath(); g.arc(lx, ly, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#c9d0dc"; g.font = `600 10px ${HUD_FONT}`; g.textAlign = "center";
    g.fillText("SEAL", lx, ly + 31);
    g.restore();
    game.telegraphHit = { x: 86 * k, y: by - 30 * k, r: 70 * k };
    if (v.rulesCaptured) {
      g.textAlign = "center"; g.fillStyle = "rgba(185, 166, 255, 0.95)";
      g.font = `700 ${Math.round(13 * k)}px ${HUD_FONT}`;
      g.fillText(spaced(`rules overwritten by the leviathan · ${Math.ceil(v.timers.captured)}s`), w / 2, h - 120 * k);
    }
    g.restore();
    const cap = game.captions[0];
    if (cap) {
      cap.life -= dt;
      if (cap.life <= 0) game.captions.shift();
      const a = Math.min(1, cap.life * 3, (cap.max - cap.life) * 6);
      g.globalAlpha = a; g.textAlign = "center";
      g.shadowColor = "rgba(0,0,0,0.8)"; g.shadowBlur = 8;
      g.fillStyle = cap.color || "#f4f6fb"; g.font = `400 ${Math.round(26 * k)}px ${HUD_FONT}`;
      g.fillText(cap.text, w / 2, 150 * k);
      if (cap.sub) { g.fillStyle = "#c9b27d"; g.font = `600 ${Math.round(11 * k)}px ${HUD_FONT}`; g.fillText(spaced(cap.sub), w / 2, 172 * k); }
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
  }

  function caption(text, sub, color, life) {
    if (game.captions.length > 3) game.captions.splice(1, game.captions.length - 2);
    game.captions.push({ text, sub, color, life: life || 2.2, max: life || 2.2 });
  }
  function float(x, y, text, color, size) { game.floats.push({ x, y, text, color, size, life: 1.1 }); }

  // ------------------------------------------------------------ Codex discovery

  function discover(id, quiet) {
    if (!id || !CODEX.entry(id)) return;
    if (!ledger.codex.discovered.includes(id)) {
      ledger.codex.discovered.push(id);
      saveLedger();
      if (!quiet) toast(`Codex: ${CODEX.entry(id).term}`);
    }
    game.discoveredThisVoyage.add(id);
  }

  // ------------------------------------------------------------ Events

  function handle(events, v) {
    const codex = CODEX.get();
    const view = { reduced: reducedMotion() };
    for (const e of events) {
      if (e.type === "caught") e.subY = v.sub.y;
      game.renderer.event(e, v, view);
      if (game.state !== "playing") continue;
      switch (e.type) {
        case "fire": SND.fire(); break;
        case "intercept":
          SND.intercept(e.combo);
          float(e.x, e.y - 20, `+${e.points}`, "#f0d9a0", e.mult > 1 ? 20 : 16);
          if (e.kind === "writ") caption("The Writ is destroyed", "Your rules stay your own", "#e6d3a1", 2.6);
          if (codex && !game.tutorial) discover(codex.unlocks[e.kind], true);
          break;
        case "dent": SND.fire(); float(e.x, e.y - 30, `${e.hp} more`, "#d8ccff"); break;
        case "blast": SND.blast(e.near); if (e.near && !view.reduced) game.shake = Math.max(game.shake, 0.5); break;
        case "hit": SND.hit(); if (!view.reduced) game.shake = 1; caption(e.reason, `${e.hearts} hull plate${e.hearts === 1 ? "" : "s"} left`, "#f2b48a"); break;
        case "contact":
          if (e.kind === "writ") { SND.alarm(); if (!view.reduced) game.flash = 1; caption("Your rules were overwritten", "The Leviathan decides what is safe now", "#d8ccff", 3); }
          else caption(e.message, "", "#c9d0dc", 1.8);
          if (codex) discover(codex.unlocks[e.kind], !!game.tutorial);
          break;
        case "caught": SND.caught(); float(C.SUB_X, v.sub.y - 70, "Saved by the rules +60", "#e6d3a1", 18); if (codex) discover(codex.unlocks.caught, true); break;
        case "order":
          SND.bell();
          if (e.to === "suspended") caption("All stop", e.reason, "#f4f6fb", 1.8);
          else if (e.to === "restricted") caption("Half ahead", e.reason, "#e6d3a1", 1.4);
          else caption("Full ahead", "", "#cfe2ff", 1);
          if (codex) discover(codex.unlocks.order, true);
          break;
        case "gear": SND.gear(); float(e.x, e.y - 16, "+1 brass", "#e6c27a", 14); break;
        case "done":
          if (codex && e.outcome === "harbor") discover(codex.unlocks.harbor, true);
          if (game.tutorial) { const L = game.tutorial.on(e); if (L) { game.pendingFinish = v; showLesson(L); break; } }
          finishVoyage(v);
          break;
        default: break;
      }
      if (game.tutorial && game.state === "playing" && e.type !== "done") {
        const L = game.tutorial.on(e);
        if (L) showLesson(L);
      }
    }
  }

  // ------------------------------------------------------------ Flow

  function newVoyage(seed, extra) {
    return new C.Voyage(Object.assign({ engine: E, profileRaw: game.profileRaw, seed, difficulty: ledger.settings.difficulty }, extra || {}));
  }

  function startAttract() {
    game.voyage = newVoyage((Math.random() * 1e9) >>> 0);
    game.attractPolicy = C.referencePolicy(game.voyage.seed);
    game.tutorial = null;
    game.captions = []; game.floats = [];
  }

  const SCREENS = { title: "title-screen", how: "how-screen", log: "log-screen", yard: "yard-screen", paused: "pause-screen", explain: "explain-screen", lesson: "lesson-screen", codex: "codex-screen", exam: "exam-screen", settings: "settings-screen" };
  function setState(s) {
    game.state = s;
    for (const id of Object.values(SCREENS)) $(id).hidden = true;
    if (SCREENS[s]) $(SCREENS[s]).hidden = false;
    const inVoyage = game.voyage && !game.attractPolicy;
    $("pause-btn").hidden = !(inVoyage && (s === "playing" || s === "paused" || s === "explain" || s === "lesson"));
    $("pause-btn").textContent = s === "paused" ? "Resume" : "Pause";
    if (s !== "playing") SND.silence();
    if (s === "title") renderTitle();
    if (s === "yard") renderYard();
    if (s === "settings") renderSettings();
  }

  function sail(opts) {
    const o = opts || {};
    SND.init();
    applySettings();
    game.captions = []; game.floats = []; game.telegraph = 0; game.discoveredThisVoyage = new Set(); game.pendingFinish = null;
    if (o.tutorial) {
      game.voyage = newVoyage(1870, { script: TUT.SCRIPT, duration: TUT.DURATION });
      game.tutorial = TUT.tracker();
      game.official = false;
    } else {
      const seed = C.daySeed();
      game.official = !ledger.played[seed];
      game.voyage = newVoyage(seed);
      game.tutorial = null;
    }
    game.attractPolicy = null;
    setState("playing");
    SND.ping();
    if (game.tutorial) {
      const L = game.tutorial.on({ type: "start" });
      if (L) showLesson(L);
    } else caption(game.official ? `Voyage No. ${C.voyageNumber()}` : "Practice voyage", "Reach Free Harbor", "#e6d3a1", 2.6);
  }

  function showLesson(L) {
    setState("lesson");
    $("lesson-stamp").textContent = `Shakedown cruise · lesson ${game.tutorial.done} of ${game.tutorial.total}`;
    $("lesson-h").textContent = L.title;
    $("lesson-text").textContent = L.text;
    $("lesson-tip").hidden = !L.tip;
    $("lesson-tip").textContent = L.tip || "";
    const cb = $("lesson-codex");
    cb.hidden = !L.codex;
    if (L.codex) { discover(L.codex, true); cb.onclick = () => openCodex(L.codex, "lesson"); }
    $("lesson-continue").textContent = game.pendingFinish ? "Open the log" : "Carry on";
  }

  function continueLesson() {
    if (game.pendingFinish) {
      const v = game.pendingFinish;
      game.pendingFinish = null;
      ledger.tutorialDone = true;
      saveLedger();
      finishVoyage(v, true);
      return;
    }
    setState("playing");
    game.last = performance.now();
  }

  function parFor(seed) {
    const key = `${seed}:${ledger.settings.difficulty}`;
    if (!game.par[key]) game.par[key] = C.par({ engine: E, profileRaw: game.profileRaw, seed, difficulty: ledger.settings.difficulty });
    return game.par[key];
  }

  function finishVoyage(v, immediate) {
    const sum = v.summary();
    const seed = v.seed;
    const tutorial = !!game.tutorial;
    const parScore = tutorial ? C.par({ engine: E, profileRaw: game.profileRaw, seed, difficulty: ledger.settings.difficulty, script: TUT.SCRIPT, duration: TUT.DURATION }) : parFor(seed);
    const medal = tutorial ? null : C.medal(sum.score, parScore);
    const rewards = [];
    const before = C.rank(ledger.lifetimeLeagues).title;
    ledger.lifetimeLeagues += sum.leagues;
    const brass = sum.gears + (sum.outcome === "harbor" ? 10 : 0) + (medal ? MEDAL_BRASS[medal] : 0);
    ledger.brass += brass;
    if (medal) {
      ledger.medals[medal] += 1;
      const skin = UNLOCKS[medal];
      if (skin && !ledger.skins.includes(skin)) { ledger.skins.push(skin); rewards.push(`${ART.SKINS[skin].name} hull unlocked`); }
    }
    if (ledger.lifetimeLeagues >= 4000 && !ledger.skins.includes("silver")) { ledger.skins.push("silver"); rewards.push("Abyss Silver hull unlocked"); }
    const after = C.rank(ledger.lifetimeLeagues).title;
    if (after !== before) rewards.push(`Promoted to ${after}`);
    if (game.official) {
      ledger.played[seed] = true;
      const day = C.voyageNumber();
      ledger.streak.count = ledger.streak.last === day - 1 ? ledger.streak.count + 1 : ledger.streak.last === day ? ledger.streak.count : 1;
      ledger.streak.last = day;
    }
    if (!tutorial) { ledger.best[seed] = Math.max(ledger.best[seed] || 0, sum.score); ledger.bestEver = Math.max(ledger.bestEver, sum.score); }
    saveLedger();
    game.lastSummary = Object.assign({ medal, par: parScore, brass, rewards, voyageNo: C.voyageNumber(), official: game.official, tutorial, discovered: [...game.discoveredThisVoyage] }, sum);
    if (sum.outcome === "harbor") SND.harbor();
    game.tutorial = null;
    setTimeout(() => { renderLog(); setState("log"); }, immediate ? 0 : sum.outcome === "harbor" ? 900 : 1600);
  }

  // ------------------------------------------------------------ Screens

  function renderTitle() {
    $("voyage-label").textContent = `Voyage No. ${C.voyageNumber()} · ${ledger.played[C.daySeed()] ? "Practice" : "Today's voyage"} · ${C.DIFFICULTY[ledger.settings.difficulty].label}`;
    const r = C.rank(ledger.lifetimeLeagues);
    const row = $("captain-row");
    row.textContent = "";
    const item = (label, value) => { const s = document.createElement("span"); s.append(label + " "); const b = document.createElement("b"); b.textContent = value; s.append(b); row.append(s); };
    item("Rank", r.title);
    item("Leagues", ledger.lifetimeLeagues.toLocaleString());
    item("Brass", ledger.brass.toLocaleString());
    item("Streak", `${ledger.streak.count} day${ledger.streak.count === 1 ? "" : "s"}`);
    item("Codex", `${ledger.codex.discovered.length} of ${CODEX.get() ? CODEX.get().entries.length : 0}`);
    $("first-note").hidden = ledger.tutorialDone;
    $("shakedown-btn").classList.toggle("brass", !ledger.tutorialDone);
    $("shakedown-btn").classList.toggle("iron", ledger.tutorialDone);
    $("sail-btn").classList.toggle("brass", true);
  }

  function timelineGlyphs(sum) {
    return sum.timeline.map((x) => (x === 2 ? "💥" : x === 1 ? "⚓" : "🌊")).join("") + (sum.outcome === "harbor" ? "🏝" : "🌑");
  }

  function shareText(sum) {
    const medalText = sum.medal ? sum.medal.charAt(0).toUpperCase() + sum.medal.slice(1) + " · " : "";
    const head = sum.tutorial ? "Nautilus · Shakedown cruise" : sum.official ? `Nautilus · Voyage No. ${sum.voyageNo}` : "Nautilus · Practice voyage";
    const diff = sum.difficulty && sum.difficulty !== "normal" ? ` · ${C.DIFFICULTY[sum.difficulty].label}` : "";
    return `${head}${diff}\n${timelineGlyphs(sum)}\n${sum.score.toLocaleString()} · ${medalText}${sum.caught} saved by the open rules\n${location.origin}${location.pathname}`;
  }

  function renderLog() {
    const s = game.lastSummary;
    $("log-voyage").textContent = s.tutorial ? "Shakedown cruise complete" : s.official ? `Voyage No. ${s.voyageNo}` : "Practice voyage";
    $("log-h").textContent = s.outcome === "harbor" ? "Free Harbor Reached" : "The Nautilus Went Down";
    const medal = $("log-medal");
    medal.className = "medal " + (s.medal || "none");
    medal.textContent = s.medal ? s.medal : s.tutorial ? "Cruise" : "No medal";
    $("log-score").textContent = s.score.toLocaleString();
    $("log-par").textContent = s.tutorial ? "The shakedown cruise is not scored against par. Your first voyage is." : `Par ${s.par.toLocaleString()}, set by a steady reference captain on the same voyage at ${C.DIFFICULTY[s.difficulty].label.toLowerCase()} difficulty`;
    const tl = $("log-timeline");
    tl.textContent = "";
    s.timeline.forEach((x) => { const b = document.createElement("span"); b.className = x === 2 ? "hit" : x === 1 ? "caught" : ""; tl.append(b); });
    const end = document.createElement("span"); end.className = s.outcome === "harbor" ? "harbor" : "hit"; tl.append(end);
    const stats = $("log-stats");
    stats.textContent = "";
    for (const [k, val] of [["Leagues", s.leagues], ["Intercepted", s.intercepted], ["Saved by the rules", s.caught], ["Hull hits", s.hits], ["Best combo", s.bestCombo], ["Brass earned", s.brass]]) {
      const d = document.createElement("div"); d.className = "stat";
      const a = document.createElement("div"); a.className = "v"; a.textContent = String(val);
      const b = document.createElement("div"); b.className = "k"; b.textContent = k;
      d.append(a, b); stats.append(d);
    }
    const r = C.rank(ledger.lifetimeLeagues);
    const rank = $("log-rank");
    rank.textContent = "";
    const line = document.createElement("div");
    line.textContent = `${r.title} · ${ledger.lifetimeLeagues.toLocaleString()} leagues${r.next ? ` · ${(r.next.at - ledger.lifetimeLeagues).toLocaleString()} to ${r.next.title}` : ""}${s.rewards.length ? " · " + s.rewards.join(" · ") : ""}`;
    const track = document.createElement("div"); track.className = "bar-track";
    const fill = document.createElement("div"); fill.className = "bar-fill";
    fill.style.width = `${Math.min(100, (ledger.lifetimeLeagues / 20000) * 100)}%`;
    track.append(fill); rank.append(line, track);
    const disc = $("log-discovered");
    const chips = $("log-discovered-chips");
    chips.textContent = "";
    disc.hidden = !s.discovered.length;
    for (const id of s.discovered) {
      const e = CODEX.entry(id);
      if (!e) continue;
      const b = document.createElement("button"); b.type = "button"; b.className = "chip"; b.textContent = e.term;
      b.addEventListener("click", () => openCodex(id, "log"));
      chips.append(b);
    }
    $("x-btn").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText(s));
    $("join-form").hidden = ledger.joined;
    if (ledger.captain) $("join-captain").value = ledger.captain;
  }

  function renderYard() {
    $("yard-brass").textContent = `${ledger.brass.toLocaleString()} brass · Rank ${C.rank(ledger.lifetimeLeagues).title}`;
    const hulls = $("yard-hulls"); hulls.textContent = "";
    const how = { brass: "Standard", copper: "Win a bronze medal", verdigris: "Win a silver medal", gilded: "Win a gold medal", silver: "Sail 4,000 leagues" };
    for (const [id, sk] of Object.entries(ART.SKINS)) {
      const owned = ledger.skins.includes(id);
      const b = yardItem(sk.name, owned ? (ledger.skin === id ? "Sailing" : "Owned") : how[id], `linear-gradient(90deg, ${sk.light}, ${sk.mid}, ${sk.dark})`, ledger.skin === id, !owned);
      b.addEventListener("click", () => { ledger.skin = id; saveLedger(); renderYard(); });
      hulls.append(b);
    }
    const pens = $("yard-pennants"); pens.textContent = "";
    for (const [id, p] of Object.entries(ART.PENNANTS)) {
      const owned = ledger.pennants.includes(id);
      const label = owned ? (ledger.pennant === id ? "Flying" : "Owned") : p.join ? "Join the crew" : p.exam ? "Pass the examination" : `${p.cost} brass`;
      const canBuy = !owned && !p.join && !p.exam && ledger.brass >= p.cost;
      const b = yardItem(p.name, label, p.a ? `linear-gradient(90deg, ${p.a}, ${p.b})` : "rgba(255,255,255,0.05)", ledger.pennant === id, !owned && !canBuy);
      b.addEventListener("click", () => {
        if (!owned && canBuy) { ledger.brass -= p.cost; ledger.pennants.push(id); }
        if (ledger.pennants.includes(id)) ledger.pennant = id;
        saveLedger(); renderYard();
      });
      pens.append(b);
    }
  }

  function yardItem(name, sub, swatch, on, disabled) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "yard-item" + (on ? " on" : ""); b.disabled = !!disabled;
    const sw = document.createElement("div"); sw.className = "sw"; sw.style.background = swatch;
    const n = document.createElement("div"); n.textContent = name;
    const l = document.createElement("span"); l.className = "lock"; l.textContent = sub;
    b.append(sw, n, l);
    return b;
  }

  // Explain the current engine order from the engine's own result.
  function renderExplain() {
    const v = game.voyage;
    const r = v.result;
    const box = $("explain-body");
    box.textContent = "";
    const add = (title, detail) => { const d = document.createElement("div"); d.className = "ex-row"; const a = document.createElement("b"); a.textContent = title; const b = document.createElement("span"); b.textContent = detail; d.append(a, b); box.append(d); return d; };
    add("Engine order", `${v.order}. Standing ${r.standing}, response ${r.response}.`);
    for (const t of r.hard_rules_triggered || []) add(C.LABELS[t.rule] || t.rule, `Hard rule met: ${t.field} ${t.condition.replace(/_/g, " ")}. Action ${t.action}.`);
    for (const m of r.missing_signals || []) add(C.LABELS[m.signal] || m.signal, `No reading. The rules treat missing evidence as ${m.on_missing}, so the ship will not sail blind.`);
    const prof = v.rulesCaptured ? v.captured : v.profile;
    for (const s of r.signal_results || []) {
      if (!s.in_warning) continue;
      const def = prof.scoredSignals.find((x) => x.signal === s.signal);
      add(C.LABELS[s.signal] || s.signal, `${s.value} ${s.unit || ""}. Warning threshold ${def.warningThreshold}, critical threshold ${def.criticalThreshold}. ${s.in_critical ? "Critical" : "Warning"}.`);
    }
    if (box.children.length === 1) add("All clear", "Every scored signal is inside its limits and no hard rule is met. Standing is good, so the graduated response is full.");
    if (v.rulesCaptured) add("Captured rules", "The Leviathan's version of your rules is in force. Its limits sit past the point of harm, so nothing stops the ship.");
    CODEX.markTerms(box, (id) => openCodex(id, "explain"), { max: 8 });
    $("explain-rules").href = "../../examples/nautilus/trp.json";
    discover(CODEX.get().unlocks.explain, true);
  }

  // ------------------------------------------------------------ Codex screens

  function openCodex(id, from) {
    game.returnTo = from || (game.state === "playing" ? "paused" : game.state === "codex" || game.state === "exam" ? game.returnTo : game.state);
    setState("codex");
    renderCodex(id);
  }

  function closeCodex() {
    const to = game.returnTo || "title";
    game.returnTo = null;
    if (to === "playing" || to === "paused") { setState("paused"); return; }
    if (to === "lesson" || to === "explain" || to === "log" || to === "settings" || to === "yard") { setState(to); return; }
    if (game.voyage && !game.attractPolicy) { setState("paused"); return; }
    startAttract();
    setState("title");
  }

  function renderCodex(id) {
    const codex = CODEX.get();
    const list = $("codex-list"), view = $("codex-entry");
    $("codex-intro").textContent = codex.intro;
    const pr = $("codex-principles");
    pr.textContent = "";
    for (const p of codex.principles) { const q = document.createElement("p"); q.textContent = p; pr.append(q); }
    if (id && CODEX.entry(id)) {
      list.hidden = true; pr.hidden = true; $("codex-intro").hidden = true; view.hidden = false; $("codex-back").hidden = false;
      CODEX.renderEntry(view, CODEX.entry(id), {
        depth: "deckhand",
        gameLabel: "On the voyage",
        onOpen: (next) => renderCodex(next),
        onCheck: (eid, right) => { if (right && !ledger.codex.checked.includes(eid)) { ledger.codex.checked.push(eid); saveLedger(); } },
        learnMore: CFG.learnMoreUrl ? { url: CFG.learnMoreUrl, label: CFG.learnMoreLabel || "Go further" } : null,
      });
      discover(id, true);
      $("codex-screen").scrollTop = 0;
    } else {
      list.hidden = false; pr.hidden = false; $("codex-intro").hidden = false; view.hidden = true; $("codex-back").hidden = true;
      CODEX.renderList(list, {
        done: new Set(ledger.codex.checked),
        subtitles: { deckhand: "For anyone aboard.", navigator: "For people learning how AI is governed.", captain: "For people who write and enforce the rules." },
        onOpen: (next) => renderCodex(next),
      });
    }
  }

  function startExam() {
    const codex = CODEX.get();
    const qs = CODEX.examination(EXAM_N, new Set(ledger.codex.discovered));
    game.exam = { qs, answers: new Array(qs.length).fill(null) };
    const body = $("exam-body");
    body.textContent = "";
    qs.forEach((e, i) => {
      const q = document.createElement("div"); q.className = "exam-q";
      const n = document.createElement("div"); n.className = "n"; n.textContent = `Question ${i + 1} · ${e.term}`;
      const p = document.createElement("p"); p.className = "codex-question"; p.textContent = e.check.question;
      const opts = document.createElement("div"); opts.className = "codex-options";
      e.check.options.forEach((text, k) => {
        const b = document.createElement("button"); b.type = "button"; b.className = "codex-option"; b.textContent = text;
        b.addEventListener("click", () => { game.exam.answers[i] = k; for (const x of opts.children) x.classList.remove("right"); b.classList.add("right"); });
        opts.append(b);
      });
      q.append(n, p, opts);
      body.append(q);
    });
    $("exam-intro").textContent = `${qs.length} questions. ${EXAM_PASS} right earns the Scholar pennant. Your best so far is ${ledger.codex.examBest} of ${EXAM_N}.`;
    $("exam-start").textContent = "Hand in";
    $("exam-start").onclick = gradeExam;
    void codex;
  }

  function gradeExam() {
    const ex = game.exam;
    if (!ex) return;
    if (ex.answers.some((a) => a === null)) { toast("Answer every question first"); return; }
    let right = 0;
    const body = $("exam-body");
    ex.qs.forEach((e, i) => {
      const q = body.children[i];
      const opts = q.querySelector(".codex-options");
      const ok = ex.answers[i] === e.check.answer;
      if (ok) right++;
      for (const [k, b] of [...opts.children].entries()) { b.disabled = true; b.classList.remove("right"); if (k === e.check.answer) b.classList.add("right"); else if (k === ex.answers[i]) b.classList.add("wrong"); }
      const why = document.createElement("p"); why.className = "codex-result"; why.textContent = (ok ? "Right. " : "Not quite. ") + e.check.why;
      q.append(why);
      if (ok && !ledger.codex.checked.includes(e.id)) ledger.codex.checked.push(e.id);
    });
    const res = document.createElement("div"); res.className = "exam-result"; res.textContent = `${right} of ${ex.qs.length}`;
    const note = document.createElement("p"); note.className = "muted";
    if (right >= EXAM_PASS) {
      note.textContent = "Passed. The Scholar pennant is yours, and it flies from the shipyard.";
      if (!ledger.pennants.includes("scholar")) { ledger.pennants.push("scholar"); ledger.pennant = "scholar"; }
    } else note.textContent = `Not yet. ${EXAM_PASS} right passes, and every answer above explains itself. Sit it again whenever you like.`;
    body.prepend(res, note);
    ledger.codex.examBest = Math.max(ledger.codex.examBest, right);
    saveLedger();
    $("exam-start").textContent = "Sit it again";
    $("exam-start").onclick = startExam;
    game.exam = null;
    $("exam-screen").scrollTop = 0;
  }

  // ------------------------------------------------------------ Settings

  function renderSettings() {
    const seg = (el, items, current, onPick) => {
      el.textContent = "";
      for (const [label, value] of items) {
        const b = document.createElement("button"); b.type = "button";
        b.className = "btn " + (value === current ? "brass" : "iron");
        b.textContent = label; b.setAttribute("aria-pressed", String(value === current));
        b.addEventListener("click", () => { onPick(value); renderSettings(); });
        el.append(b);
      }
    };
    seg($("set-difficulty"), Object.entries(C.DIFFICULTY).map(([k, d]) => [d.label, k]), ledger.settings.difficulty, (v) => { ledger.settings.difficulty = v; saveLedger(); });
    seg($("set-text"), TEXT_SIZES, ledger.settings.textScale, (v) => { ledger.settings.textScale = v; saveLedger(); applySettings(); });
    const current2d = /[?&]renderer=2d/.test(location.search);
    seg($("set-renderer"), [["Auto", "auto"], ["2D only", "2d"]], current2d ? "2d" : "auto", (v) => {
      const url = new URL(location.href);
      if (v === "2d") url.searchParams.set("renderer", "2d"); else url.searchParams.delete("renderer");
      if (url.href !== location.href) location.href = url.href;
    });
    const motion = $("set-motion"); motion.checked = reducedMotion();
    motion.onchange = () => { ledger.settings.reduceMotion = motion.checked; saveLedger(); applySettings(); };
    const sound = $("set-sound"); sound.checked = ledger.settings.sound;
    sound.onchange = () => { ledger.settings.sound = sound.checked; saveLedger(); SND.init(); applySettings(); };
    const reset = $("set-reset");
    reset.textContent = "Forget my progress on this device";
    reset.onclick = () => {
      if (reset.dataset.armed) { try { localStorage.removeItem(LKEY); } catch (err) { /* ignore */ } ledger = freshLedger(); saveLedger(); applySettings(); delete reset.dataset.armed; toast("Progress cleared"); renderSettings(); return; }
      reset.dataset.armed = "1"; reset.textContent = "Tap again to confirm";
      setTimeout(() => { delete reset.dataset.armed; reset.textContent = "Forget my progress on this device"; }, 4000);
    };
  }

  // ------------------------------------------------------------ Share card

  function shareCard(s) {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 630;
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, 630); bg.addColorStop(0, "#0a1636"); bg.addColorStop(1, "#040b19");
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
    g.strokeStyle = "#c49a55"; g.lineWidth = 3; g.strokeRect(18, 18, 1164, 594);
    g.strokeStyle = "#6b4b22"; g.lineWidth = 1; g.strokeRect(26, 26, 1148, 578);
    g.save(); g.translate(880, 330); g.scale(1.6, 1.6); ART.sub(g, 0, 0, { skin: ledger.skin, pennant: ledger.pennant, prop: 0.5, time: 0, tilt: -0.04 }); g.restore();
    g.fillStyle = "#e6c27a"; g.font = `600 22px ${HUD_FONT}`; g.fillText(s.tutorial ? "SHAKEDOWN CRUISE" : s.official ? `VOYAGE NO. ${s.voyageNo}` : "PRACTICE VOYAGE", 70, 110);
    g.fillStyle = "#f0d9a0"; g.font = `400 96px ${HUD_FONT}`; g.fillText("NAUTILUS", 64, 210);
    g.fillStyle = "#f4f6fb"; g.font = `400 120px ${HUD_FONT}`; g.fillText(s.score.toLocaleString(), 64, 360);
    g.fillStyle = "#aab3c5"; g.font = `600 26px ${HUD_FONT}`;
    g.fillText(`${s.medal ? s.medal.toUpperCase() + " · " : ""}${s.leagues} LEAGUES · ${s.caught} SAVED BY THE OPEN RULES`, 70, 410);
    s.timeline.forEach((x, i) => { g.fillStyle = x === 2 ? "#c8643c" : x === 1 ? "#e6c27a" : "rgba(170,179,197,0.4)"; g.fillRect(70 + i * 52, 450, 44, 14); });
    g.fillStyle = s.outcome === "harbor" ? "#5fb3a0" : "#c8643c"; g.fillRect(70 + 10 * 52, 450, 44, 14);
    g.fillStyle = "#aab3c5"; g.font = `500 22px ${HUD_FONT}`;
    g.fillText("A free vessel on open trust rules. Can you beat my voyage?", 70, 540);
    g.fillText(location.host + location.pathname, 70, 575);
    return c;
  }

  async function share() {
    const s = game.lastSummary;
    const text = shareText(s);
    try {
      const blob = await new Promise((res) => shareCard(s).toBlob(res, "image/png"));
      const file = new File([blob], "nautilus-voyage.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ text, files: [file] }); return; }
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "nautilus-voyage.png"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast("Copied, and the voyage card is downloading");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      copy(text);
    }
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text).then(() => toast("Copied"), () => toast("Copy failed")); } catch (err) { toast("Copy failed"); }
  }

  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------ Input

  function bindInput() {
    const target = $("hud");
    let down = null;
    target.addEventListener("pointerdown", (e) => {
      if (game.state !== "playing") return;
      const th = game.telegraphHit;
      if (th && Math.hypot(e.clientX - th.x, e.clientY - th.y) < th.r) { openExplain(); return; }
      down = { x: e.clientX, y: e.clientY, t: performance.now(), drag: false };
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener("pointermove", (e) => {
      if (!down || game.state !== "playing") return;
      if (!down.drag && Math.abs(e.clientY - down.y) > 14) down.drag = true;
      if (down.drag) game.voyage.setDepth(game.renderer.unproject(e.clientX, e.clientY).y);
    });
    target.addEventListener("pointerup", (e) => {
      if (!down || game.state !== "playing") { down = null; return; }
      if (!down.drag && performance.now() - down.t < 450) {
        const p = game.renderer.unproject(e.clientX, e.clientY);
        if (!game.voyage.fireAt(p.x, p.y)) fireNearest();
      }
      down = null;
    });
    window.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA")) return;
      if (game.state === "playing") {
        const v = game.voyage;
        if (e.key === "ArrowUp" || e.key === "w") { v.setDepth(v.sub.targetY - 60); e.preventDefault(); }
        if (e.key === "ArrowDown" || e.key === "s") { v.setDepth(v.sub.targetY + 60); e.preventDefault(); }
        if (e.key === " " || e.key === "f") { fireNearest(); e.preventDefault(); }
        if (e.key === "e") openExplain();
      }
      if (e.key === "Enter" && game.state === "lesson") continueLesson();
      if (e.key === "p" || e.key === "Escape") togglePause();
    });
    window.addEventListener("blur", () => { if (game.state === "playing") togglePause(); });
  }

  function fireNearest() {
    const v = game.voyage;
    const threats = v.payloads.filter((p) => !v.harpoons.some((h) => h.target === p.id && p.kind !== "writ"));
    threats.sort((a, b) => (b.kind === "writ") - (a.kind === "writ") || Math.hypot(a.x - C.SUB_X, a.y - v.sub.y) - Math.hypot(b.x - C.SUB_X, b.y - v.sub.y));
    if (threats.length) v.fire(threats[0].id);
  }

  function togglePause() {
    if (game.state === "playing") setState("paused");
    else if (game.state === "paused" || game.state === "explain") { setState("playing"); game.last = performance.now(); }
  }

  function openExplain() { renderExplain(); setState("explain"); }

  // ------------------------------------------------------------ Loop

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    game.renderer.resize(w, h, dpr);
    game.hud.width = Math.round(w * dpr); game.hud.height = Math.round(h * dpr);
    game.hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    game.hudW = w; game.hudH = h;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - (game.last || now)) / 1000);
    game.last = now;
    const v = game.voyage;
    if (v) {
      const running = game.state === "playing" || (game.attractPolicy && game.state !== "codex" && game.state !== "exam");
      if (running && !v.done) {
        game.acc += dt;
        while (game.acc >= STEP) {
          if (game.attractPolicy) game.attractPolicy(v, STEP);
          v.step(STEP);
          handle(v.drain(), v);
          game.acc -= STEP;
          if (game.state !== "playing" && !game.attractPolicy) break;
        }
      }
      if (game.attractPolicy && v.done) startAttract();
      if (game.state === "playing") SND.engine(v.sub.speed);
      game.shake = Math.max(0, game.shake - dt * 2.5);
      game.flash = Math.max(0, game.flash - dt * 1.5);
      const paused = !(game.state === "playing" || game.attractPolicy);
      game.renderer.render(v, paused ? 0 : dt, { skin: ledger.skin, pennant: ledger.pennant, shake: game.shake, flash: game.flash, reduced: reducedMotion() });
      drawHud(v, paused ? 0 : dt);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ Wiring

  function bindUi() {
    $("sail-btn").addEventListener("click", () => sail());
    $("shakedown-btn").addEventListener("click", () => sail({ tutorial: true }));
    $("how-sail").addEventListener("click", () => sail());
    $("yard-sail").addEventListener("click", () => sail());
    $("again-btn").addEventListener("click", () => sail());
    $("how-btn").addEventListener("click", () => setState("how"));
    $("yard-btn").addEventListener("click", () => setState("yard"));
    $("log-yard").addEventListener("click", () => setState("yard"));
    $("log-codex").addEventListener("click", () => openCodex(null, "log"));
    $("codex-btn").addEventListener("click", () => { if (game.state === "playing") setState("paused"); openCodex(null, game.state === "paused" ? "paused" : game.state); });
    $("pause-codex").addEventListener("click", () => openCodex(null, "paused"));
    $("codex-back").addEventListener("click", () => renderCodex(null));
    $("exam-btn").addEventListener("click", () => { setState("exam"); $("exam-body").textContent = ""; $("exam-start").textContent = "Begin"; $("exam-start").onclick = startExam; $("exam-intro").textContent = `${EXAM_N} questions drawn from the codex entries you have discovered. ${EXAM_PASS} right earns the Scholar pennant. There is no penalty for trying again.`; });
    $("exam-close").addEventListener("click", () => { game.exam = null; setState("codex"); renderCodex(null); });
    $("settings-btn").addEventListener("click", () => { if (game.state === "playing") setState("paused"); game.returnTo = game.state === "paused" ? "paused" : game.state; setState("settings"); });
    for (const b of document.querySelectorAll("[data-back]")) b.addEventListener("click", () => {
      if (game.state === "codex") { closeCodex(); return; }
      if (game.state === "settings" && game.returnTo && game.returnTo !== "title") { const to = game.returnTo; game.returnTo = null; setState(to === "playing" ? "paused" : to); return; }
      game.returnTo = null;
      if (game.voyage && !game.attractPolicy && game.state !== "settings") { setState("paused"); return; }
      startAttract(); setState("title");
    });
    $("lesson-continue").addEventListener("click", continueLesson);
    $("pause-btn").addEventListener("click", togglePause);
    $("resume-btn").addEventListener("click", togglePause);
    $("explain-close").addEventListener("click", togglePause);
    $("quit-btn").addEventListener("click", () => { game.tutorial = null; game.pendingFinish = null; startAttract(); setState("title"); });
    $("share-btn").addEventListener("click", share);
    $("copy-btn").addEventListener("click", () => copy(shareText(game.lastSummary)));
    $("join-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = $("join-msg");
      const captain = $("join-captain").value.trim().slice(0, 40);
      const email = $("join-email").value.trim();
      if (!captain) { msg.textContent = "Choose a captain name."; return; }
      if (!CREW.validEmail(email)) { msg.textContent = "Check the email address."; return; }
      if (!$("join-consent").checked) { msg.textContent = "Please tick the box to agree to updates and the privacy note."; return; }
      $("join-btn").disabled = true; msg.textContent = "Signing you on…";
      const res = await CREW.join({ captain, email, role: $("join-role").value, botcheck: e.target.botcheck.checked }, ledger);
      $("join-btn").disabled = false;
      msg.textContent = res.message;
      ledger.captain = captain;
      if (res.ok) {
        ledger.joined = true;
        if (!ledger.pennants.includes("crew")) ledger.pennants.push("crew");
        ledger.pennant = "crew";
        saveLedger();
        toast("Welcome aboard. The Crew Roll pennant is yours.");
        setTimeout(() => { $("join-form").hidden = true; }, 1600);
      } else saveLedger();
    });
    if (CFG.repo) $("star-btn").href = CFG.repo;
  }

  // For agents, tests and the curious.
  window.TRPNautilus = {
    version: "2",
    rules: () => JSON.parse(JSON.stringify(game.profileRaw)),
    play(opts) {
      const o = opts || {};
      return C.run({ engine: E, profileRaw: game.profileRaw, seed: o.seed || C.daySeed(), difficulty: o.difficulty || ledger.settings.difficulty }, o.policy);
    },
    par(seed, difficulty) { return C.par({ engine: E, profileRaw: game.profileRaw, seed: seed || C.daySeed(), difficulty: difficulty || ledger.settings.difficulty }); },
    // Steps the voyage on screen forward with a fair captain at the helm.
    // Used by tests and screenshots.
    advance(seconds) {
      if (game.state !== "playing") return false;
      const v = game.voyage, pilot = C.referencePolicy(v.seed);
      for (let s = 0; s < seconds && !v.done && game.state === "playing"; s += STEP) { pilot(v, STEP); v.step(STEP); handle(v.drain(), v); }
      return v.summary();
    },
    get state() { return game.state; },
    get ledger() { return JSON.parse(JSON.stringify(ledger)); },
  };

  async function boot() {
    try {
      const [profile] = await Promise.all([
        fetch("../../examples/nautilus/trp.json", { cache: "no-cache" }).then((r) => r.json()),
        CODEX.load("../codex.json"),
      ]);
      game.profileRaw = profile;
    } catch (err) {
      toast("The vessel rules could not be loaded.");
      return;
    }
    applySettings();
    game.hud = $("hud");
    game.hudCtx = game.hud.getContext("2d");
    let renderer = null;
    if (window.NautilusWorld3D && !/[?&]renderer=2d/.test(location.search)) {
      try { renderer = window.NautilusWorld3D(); renderer.init($("world")); } catch (err) { console.warn("3D unavailable, using 2D", err); renderer = null; }
    }
    if (!renderer) {
      const old = $("world");
      const fresh = document.createElement("canvas"); fresh.id = "world"; fresh.className = old.className;
      old.replaceWith(fresh);
      renderer = World2D(); renderer.init(fresh);
    }
    game.renderer = renderer;
    document.body.dataset.renderer = renderer.name;
    window.addEventListener("resize", resize);
    resize();
    bindUi();
    bindInput();
    startAttract();
    setTimeout(() => parFor(C.daySeed()), 50);
    setState("title");
    requestAnimationFrame(frame);
  }

  // world3d.js is a module and may finish loading after this script, so wait
  // briefly for it, then fall back to 2D.
  let waited = 0;
  const wait = () => { waited += 30; if (window.NautilusWorld3D || window.NautilusWorld3DFailed || waited > 4000) boot(); else setTimeout(wait, 30); };
  wait();
})();
