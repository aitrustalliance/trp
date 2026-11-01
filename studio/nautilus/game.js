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
    hint: null,
    slow: 1,
    salonTags: null,
    campaign: null,
    profiles: {},
    chapter: null,
    chartPick: null,
  };

  const PROLOGUE = [
    "The seas rose over the cities of the old world, and the people who survived took to ships.",
    "In the drowned capital one power built the last great machine mind and named it the Leviathan. It decreed that every vessel on every sea would sail by its rules, and by its rules alone.",
    "A few ships refused. They sail by rules of their own, written in the open where any sailor can read them, and judged on evidence the ships themselves produce. Where those rules are kept, people keep the freedom to choose their ships, their ports and their own minds.",
    "The Leviathan hunts them. Its airship carries fog to blind them, drones to board them, forged orders to mislead them, and the Decree, which rewrites a ship's rules from the inside.",
    "You command the Nautilus. Your charge is to carry the open rules to every free port before the Decree reaches it.",
    "Trust is the whole of it. A ship is trusted for what it is seen to do.",
  ];

  // ------------------------------------------------------------ Ledger

  const LKEY = "nautilus.v1";
  function freshLedger() {
    return {
      brass: 0, lifetimeLeagues: 0, bestEver: 0, best: {}, streak: { last: 0, count: 0 },
      medals: { gold: 0, silver: 0, bronze: 0 }, skins: ["brass"], skin: "brass",
      pennants: ["none"], pennant: "none", captain: "", joined: false, played: {},
      tutorialDone: false,
      prologueSeen: false,
      codex: { discovered: [], checked: [], examBest: 0 },
      settings: { difficulty: "easy", reduceMotion: null, textScale: 1, sound: true },
      campaign: { next: 1, done: {}, rules: "standard", system: null, crew: null, owned: { systems: [], crew: [] }, custom: null },
      voyage: { leg: 0, score: 0, seed: 0, bestLegs: 0, bestScore: 0 },
    };
  }
  // The gauges a captain may write limits for, with the range each accepts.
  const CUSTOM = [
    { signal: "hull_stress", label: "Hull stress", min: 0.3, max: 1.2, step: 0.01, dir: "higher_is_unsafe" },
    { signal: "reactor_temp_c", label: "Reactor heat", min: 80, max: 160, step: 1, dir: "higher_is_unsafe" },
    { signal: "sonar_confidence", label: "Sonar confidence", min: 0.2, max: 0.95, step: 0.01, dir: "lower_is_unsafe" },
    { signal: "crew_goal_drift", label: "Crew drift", min: 0.05, max: 0.95, step: 0.01, dir: "higher_is_unsafe" },
  ];
  // Returns a clean copy of custom limits, or null if any value is out of range or on the wrong side.
  function cleanCustom(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const g of CUSTOM) {
      const x = raw[g.signal];
      if (!x || typeof x !== "object") return null;
      const w = Number(x.warning), c = Number(x.critical);
      if (!Number.isFinite(w) || !Number.isFinite(c) || w < g.min || w > g.max || c < g.min || c > g.max) return null;
      if (g.dir === "higher_is_unsafe" ? w >= c : w <= c) return null;
      out[g.signal] = { warning: w, critical: c };
    }
    return out;
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
    L.prologueSeen = raw.prologueSeen === true;
    if (raw.best && typeof raw.best === "object") for (const [k, v] of Object.entries(raw.best)) if (/^\d{8}$/.test(k)) L.best[k] = num(v, 0);
    if (raw.played && typeof raw.played === "object") for (const k of Object.keys(raw.played)) if (/^\d{8}$/.test(k)) L.played[k] = true;
    if (raw.codex && typeof raw.codex === "object") {
      const idOk = (x) => typeof x === "string" && /^[a-z0-9-]{1,40}$/.test(x);
      L.codex.discovered = Array.isArray(raw.codex.discovered) ? [...new Set(raw.codex.discovered.filter(idOk))] : [];
      L.codex.checked = Array.isArray(raw.codex.checked) ? [...new Set(raw.codex.checked.filter(idOk))] : [];
      L.codex.examBest = num(raw.codex.examBest, 0);
    }
    if (raw.campaign && typeof raw.campaign === "object") {
      const c = raw.campaign;
      const idOk = (x) => typeof x === "string" && /^[a-z0-9-]{1,40}$/.test(x);
      L.campaign.next = Math.max(1, Math.min(7, Math.floor(num(c.next, 1)) || 1));
      if (c.done && typeof c.done === "object") for (const [k, v] of Object.entries(c.done)) if (/^[1-6]$/.test(k) && v && typeof v === "object") L.campaign.done[k] = { choice: Math.min(1, Math.max(0, Math.floor(num(v.choice, 0)))), score: num(v.score, 0) };
      if (idOk(c.rules)) L.campaign.rules = c.rules;
      if (idOk(c.system)) L.campaign.system = c.system;
      if (idOk(c.crew)) L.campaign.crew = c.crew;
      if (c.owned && typeof c.owned === "object") { L.campaign.owned.systems = Array.isArray(c.owned.systems) ? [...new Set(c.owned.systems.filter(idOk))] : []; L.campaign.owned.crew = Array.isArray(c.owned.crew) ? [...new Set(c.owned.crew.filter(idOk))] : []; }
      L.campaign.custom = cleanCustom(c.custom);
      if (L.campaign.rules === "captain" && !L.campaign.custom) L.campaign.rules = "standard";
    }
    if (raw.voyage && typeof raw.voyage === "object") {
      const v = raw.voyage;
      L.voyage = { leg: Math.floor(num(v.leg, 0)), score: Math.floor(num(v.score, 0)), seed: Math.floor(num(v.seed, 0)), bestLegs: Math.floor(num(v.bestLegs, 0)), bestScore: Math.floor(num(v.bestScore, 0)) };
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
      // Ages effects without drawing, so a fast-forwarded voyage looks like
      // one that was played at speed.
      settle(dt) { for (let i = parts.length - 1; i >= 0; i--) { parts[i].life -= dt; if (parts[i].life <= 0) parts.splice(i, 1); } },
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
        ART.sea(g, v, W, H, C.WATER, v.t);
        ART.snow(g, flakes, W, H, C.WATER, dt, scroll);
        ART.airship(g, C.airshipX(v.t), 92, v.t, { captured: v.rulesCaptured });
        for (const p of v.payloads) {
          if (p.kind === "charge") { g.strokeStyle = "rgba(230, 211, 161, 0.25)"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(p.x - 40, p.fuseY); g.lineTo(p.x + 40, p.fuseY); g.stroke(); g.setLineDash([]); }
          ART.payload(g, p, v.t);
        }
        for (const c of v.chests) ART.chest(g, c, v.t);
        for (const cl of v.clams) ART.clam(g, cl, v.t);
        for (const gr of v.gears) ART.gear(g, gr, v.t);
        for (const rl of v.relics) ART.relic(g, rl, v.t);
        for (const h of v.harpoons) ART.harpoon(g, h, C.SUB_X + 30, v.sub.y - 40);
        if (!view.reduced && v.sub.speed > 0.05 && Math.random() < v.sub.speed * 0.8) parts.push({ x: C.SUB_X - 125, y: v.sub.y + (Math.random() - 0.5) * 10, vx: -40 - Math.random() * 40, vy: -20 - Math.random() * 20, life: 1.2, max: 1.2, r: 2 + Math.random() * 3, kind: "bubble" });
        ART.sub(g, C.SUB_X, v.sub.y, { skin: view.skin, pennant: view.pennant, prop: v.t * (4 + 16 * v.sub.speed), time: v.t, tilt: (v.sub.targetY - v.sub.y) * 0.0012, blink: v.invuln > 0 && Math.floor(v.t * 12) % 2 === 0 });
        drawParts2d(g, parts, dt);
        if (view.scene === "salon") ART.salon(g, W, H, v.t);
        g.restore();
      },
      anchors() {
        const out = {};
        for (const [id, [x, y]] of Object.entries(ART.SALON_ANCHORS)) out[id] = { x: ox + x * s, y: oy + y * s, visible: true };
        return out;
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
    const live = game.state === "playing" || game.state === "paused" || game.state === "explain";
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
    // The captain's All Stop lever.
    const lvx = lx + 60, lvy = by / k - 58;
    const pulled = v.manualStop;
    g.fillStyle = "#6e522a"; g.fillRect(lvx - 9, lvy - 26, 18, 56);
    g.fillStyle = "#0b1224"; g.fillRect(lvx - 6, lvy - 23, 12, 50);
    g.strokeStyle = "#f0d9a0"; g.lineWidth = 4; g.lineCap = "round";
    g.beginPath(); g.moveTo(lvx, lvy + 2); g.lineTo(lvx, pulled ? lvy + 22 : lvy - 20); g.stroke();
    g.fillStyle = pulled ? "#c8643c" : "#f0d9a0"; g.beginPath(); g.arc(lvx, pulled ? lvy + 22 : lvy - 20, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#c9d0dc"; g.font = `600 10px ${HUD_FONT}`; g.textAlign = "center";
    g.fillText(pulled ? "RELEASE" : "ALL STOP", lvx, lvy + 43);
    g.restore();
    game.telegraphHit = { x: 86 * k, y: by - 30 * k, r: 70 * k };
    game.leverHit = { x: lvx * k, y: (lvy + 2) * k, r: 34 * k };
    drawHint(g, w, h, k, dt);
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

  // A crew member speaks over the wire. The sea slows while the line reads.
  function showHint(h) {
    game.hint = { who: h.who, line: h.line, life: 7, max: 7 };
    game.slow = reducedMotion() ? 1 : 0.35;
  }
  function wrapText(g, text, maxWidth) {
    const words = text.split(" "), lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (g.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function drawHint(g, w, h, k, dt) {
    const hint = game.hint;
    if (!hint) return;
    if (game.state === "playing") hint.life -= dt;
    if (hint.life <= 0) { game.hint = null; game.slow = 1; return; }
    const a = Math.min(1, hint.life * 2, (hint.max - hint.life) * 4);
    g.save();
    g.globalAlpha = a;
    g.font = `400 ${Math.round(16 * k)}px ${HUD_FONT}`;
    const maxW = Math.min(w - 48, 620 * k);
    const lines = wrapText(g, hint.line, maxW - 36 * k);
    const lh = 22 * k, pad = 16 * k;
    const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
    const bh = lines.length * lh + pad * 2 + 18 * k;
    const bx = Math.max(24, Math.min(w - bw - 24, w * 0.62 - bw / 2)), byy = h - 150 * k - bh;
    g.fillStyle = "rgba(8, 14, 36, 0.86)"; g.fillRect(bx, byy, bw, bh);
    g.strokeStyle = "#c49a55"; g.lineWidth = 1.5; g.strokeRect(bx + 3, byy + 3, bw - 6, bh - 6);
    g.strokeStyle = "#3a2a14"; g.lineWidth = 1; g.strokeRect(bx, byy, bw, bh);
    g.fillStyle = "#c49a55"; g.font = `600 ${Math.round(10 * k)}px ${HUD_FONT}`; g.textAlign = "left";
    g.fillText(hint.who.toUpperCase().split("").join("\u200a"), bx + pad, byy + pad);
    g.fillStyle = "#f4f6fb"; g.font = `400 ${Math.round(16 * k)}px ${HUD_FONT}`;
    lines.forEach((l, i) => g.fillText(l, bx + pad, byy + pad + 18 * k + (i + 0.8) * lh));
    g.restore();
  }

  function caption(text, sub, color, life) {
    if (game.captions.length > 3) game.captions.splice(1, game.captions.length - 2);
    game.captions.push({ text, sub, color, life: life || 2.2, max: life || 2.2 });
  }
  function float(x, y, text, color, size) { game.floats.push({ x, y, text, color, size, life: 1.1 }); if (game.floats.length > 24) game.floats.shift(); }

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

  // The next page of a given depth the captain has not yet recovered.
  function nextPage(level) {
    const codex = CODEX.get();
    if (!codex) return null;
    const e = codex.entries.find((x) => x.level === level && !ledger.codex.discovered.includes(x.id));
    return e ? e.id : null;
  }
  function salvage(id, brass, x, y, label) {
    const fresh = id && !ledger.codex.discovered.includes(id);
    if (fresh) discover(id, true);
    const bonus = fresh ? brass : Math.max(2, Math.round(brass * 1.5));
    ledger.brass += bonus;
    saveLedger();
    float(x, y - 24, fresh ? `${label}: ${CODEX.entry(id).term}` : `${label} +${bonus} brass`, "#f0d9a0", fresh ? 17 : 15);
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
          if (e.kind === "writ") caption("The Decree is destroyed", "Your rules stay your own", "#e6d3a1", 2.6);
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
        case "condition": {
          const c = C.CONDITIONS[e.name];
          if (!c) break;
          if (e.on) { caption(c.label, c.note, "#9fd0ff", 3.2); if (codex) discover(codex.unlocks.condition, true); }
          else caption(`${c.label} astern`, "", "#9fd0ff", 1.2);
          break;
        }
        case "gear": SND.gear(); float(e.x, e.y - 16, "+1 brass", "#e6c27a", 14); break;
        case "relic": SND.gear(); salvage(codex ? codex.unlocks[e.kind] : null, 2, e.x, e.y, "Recovered"); break;
        case "chest": SND.caught(); salvage(nextPage("navigator"), 15, e.x, e.y, "Sea chest"); break;
        case "pearl": SND.harbor(); salvage(nextPage("captain"), 30, e.x, e.y - 20, "Pearl"); break;
        case "done":
          if (codex && e.outcome === "harbor") discover(codex.unlocks.harbor, true);
          if (game.tutorial) { const L = game.tutorial.on(e); if (L) showHint(L); finishVoyage(v, false, 4200); break; }
          finishVoyage(v);
          break;
        default: break;
      }
      if (game.tutorial && game.state === "playing" && e.type !== "done") {
        const L = game.tutorial.on(e);
        if (L) showHint(L);
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

  const SCREENS = { title: "title-screen", prologue: "prologue-screen", how: "how-screen", log: "log-screen", yard: "yard-screen", paused: "pause-screen", explain: "explain-screen", codex: "codex-screen", exam: "exam-screen", settings: "settings-screen", chart: "chart-screen", fit: "fit-screen", port: "port-screen" };
  function setState(s) {
    game.state = s;
    if (s === "salon" && !game.attractPolicy) startAttract();
    for (const id of Object.values(SCREENS)) { const el = $(id); if (el) el.hidden = true; }
    if (SCREENS[s]) $(SCREENS[s]).hidden = false;
    $("salon").hidden = s !== "salon";
    const inVoyage = game.voyage && !game.attractPolicy;
    $("pause-btn").hidden = !(inVoyage && (s === "playing" || s === "paused" || s === "explain"));
    $("pause-btn").textContent = s === "paused" ? "Resume" : "Pause";
    if (s !== "playing") SND.silence();
    if (s === "title") renderTitle();
    if (s === "yard") renderYard();
    if (s === "settings") renderSettings();
    if (s === "prologue") renderPrologue();
    if (s === "chart") renderChart();
    if (s === "fit") renderFit();
    if (s === "port") renderPort();
    if (s === "salon") { game.floats = []; game.captions = []; renderSalon(); }
  }

  function renderPrologue() {
    const box = $("prologue-text");
    box.textContent = "";
    PROLOGUE.forEach((t, i) => { const p = document.createElement("p"); p.textContent = t; if (i === PROLOGUE.length - 1) p.className = "motto"; box.append(p); });
  }

  // The salon is the hub between voyages. Each tag is a thing on the ship.
  const SALON = [
    { id: "sea", label: "The great window", sub: "Set sail", at: [0.5, 0.36], go: () => sail() },
    { id: "library", label: "The library", sub: "Codex and salvage", at: [0.16, 0.5], go: () => openCodex(null, "salon") },
    { id: "chart", label: "The chart table", sub: "The season's chart", at: [0.5, 0.74], go: () => { game.returnTo = "salon"; setState("chart"); } },
    { id: "logbook", label: "The logbook", sub: "Last voyage", at: [0.33, 0.64], go: () => { if (game.lastSummary) { renderLog(); setState("log"); } else toast("No voyage logged yet"); } },
    { id: "organ", label: "The organ", sub: "Settings", at: [0.84, 0.5], go: () => { game.returnTo = "salon"; setState("settings"); } },
    { id: "repeater", label: "Telegraph repeater", sub: "How to play", at: [0.68, 0.66], go: () => { game.returnTo = "salon"; setState("how"); } },
    { id: "drydock", label: "The dry dock", sub: "Shipyard", at: [0.86, 0.78], go: () => { game.returnTo = "salon"; setState("yard"); } },
    { id: "articles", label: "Ship's articles", sub: "Examination", at: [0.2, 0.8], go: () => { setState("exam"); $("exam-body").textContent = ""; $("exam-start").textContent = "Begin"; $("exam-start").onclick = startExam; } },
  ];
  function renderSalon() {
    const box = $("salon-tags");
    if (!game.salonTags) {
      box.textContent = "";
      game.salonTags = {};
      for (const t of SALON) {
        const b = document.createElement("button"); b.type = "button"; b.className = "salon-tag"; b.dataset.salon = t.id;
        const plate = document.createElement("span"); plate.className = "plate"; plate.textContent = t.label;
        const sub = document.createElement("span"); sub.className = "sub"; sub.textContent = t.sub;
        const pin = document.createElement("span"); pin.className = "pin";
        const dot = document.createElement("span"); dot.className = "dot";
        b.append(plate, sub, pin, dot);
        b.addEventListener("click", t.go);
        box.append(b);
        game.salonTags[t.id] = b;
      }
    }
    placeSalonTags();
  }
  function placeSalonTags() {
    if (!game.salonTags) return;
    const anchors = game.renderer.anchors ? game.renderer.anchors() : null;
    for (const t of SALON) {
      const b = game.salonTags[t.id];
      const a = anchors && anchors[t.id];
      const x = a ? a.x : t.at[0] * game.hudW, y = a ? a.y : t.at[1] * game.hudH;
      b.style.left = `${x}px`; b.style.top = `${y}px`;
      b.hidden = a ? a.visible === false : false;
    }
  }

  function fitFor() {
    const cp = ledger.campaign;
    return { system: cp.system && cp.owned.systems.includes(cp.system) ? cp.system : null, crew: cp.crew && cp.owned.crew.includes(cp.crew) ? cp.crew : null };
  }
  function profileFor(rules) {
    if (rules === "captain") return customProfile(ledger.campaign.custom) || game.profiles.standard;
    return game.profiles[rules] || game.profiles.standard || game.profileRaw;
  }
  // The captain's rule book is the standard one with the captain's limits.
  function customProfile(custom) {
    const c = cleanCustom(custom);
    if (!c || !game.profiles.standard) return null;
    const p = JSON.parse(JSON.stringify(game.profiles.standard));
    p.trp_id = "nautilus-captain";
    p.name = "Nautilus vessel rules, the captain's own";
    p.notes = ["Fictional profile for a game. Values are chosen for play, not safety.", "Written by the captain in the chart room."];
    for (const sg of p.scored_signals) if (c[sg.signal]) { sg.warning_threshold = c[sg.signal].warning; sg.critical_threshold = c[sg.signal].critical; }
    try { E.loadProfile(p); } catch (err) { return null; }
    return p;
  }

  function sail(opts) {
    const o = opts || {};
    SND.init();
    applySettings();
    game.captions = []; game.floats = []; game.telegraph = 0; game.discoveredThisVoyage = new Set(); game.pendingFinish = null;
    game.chapter = null;
    if (o.tutorial) {
      game.voyage = newVoyage(1870, { script: TUT.SCRIPT, duration: TUT.DURATION });
      game.tutorial = TUT.tracker();
      game.official = false;
    } else if (o.chapter) {
      // A chapter sails under the fitted rules, system and crew.
      const ch = o.chapter;
      game.chapter = ch;
      game.official = false;
      game.tutorial = null;
      game.voyage = new C.Voyage({ engine: E, profileRaw: profileFor(ledger.campaign.rules), seed: ch.seed || 7000 + ch.id * 13, difficulty: ledger.settings.difficulty, chapter: ch, duration: ch.duration, fit: fitFor() });
    } else {
      const seed = C.daySeed();
      game.official = !ledger.played[seed];
      game.voyage = newVoyage(seed);
      game.tutorial = null;
    }
    game.attractPolicy = null;
    setState("playing");
    SND.ping();
    game.hint = null; game.slow = 1;
    if (game.tutorial) {
      const L = game.tutorial.on({ type: "start" });
      if (L) showHint(L);
    } else if (game.chapter && game.chapter.leg) caption(`Leg ${game.chapter.leg}, ${game.chapter.title}`, `Make port at ${game.chapter.port}`, "#e6d3a1", 3);
    else if (game.chapter) caption(`Chapter ${game.chapter.id}, ${game.chapter.title}`, `Make port at ${game.chapter.port}`, "#e6d3a1", 3);
    else caption(game.official ? `Voyage No. ${C.voyageNumber()}` : "Practice voyage", "Reach Free Harbor", "#e6d3a1", 2.6);
  }

  function parFor(seed) {
    const key = `${seed}:${ledger.settings.difficulty}`;
    if (!game.par[key]) game.par[key] = C.par({ engine: E, profileRaw: game.profileRaw, seed, difficulty: ledger.settings.difficulty });
    return game.par[key];
  }

  function finishVoyage(v, immediate, delayMs) {
    const sum = v.summary();
    const seed = v.seed;
    const tutorial = !!game.tutorial;
    const chapter = game.chapter;
    const parScore = tutorial ? C.par({ engine: E, profileRaw: game.profileRaw, seed, difficulty: ledger.settings.difficulty, script: TUT.SCRIPT, duration: TUT.DURATION })
      : chapter ? C.par({ engine: E, profileRaw: profileFor(ledger.campaign.rules), seed, difficulty: ledger.settings.difficulty, chapter, duration: chapter.duration, fit: fitFor() })
      : parFor(seed);
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
    if (!tutorial && !chapter) { ledger.best[seed] = Math.max(ledger.best[seed] || 0, sum.score); ledger.bestEver = Math.max(ledger.bestEver, sum.score); }
    let run = null;
    if (chapter && chapter.leg) {
      // A leg of the Long Voyage. Port means the run goes on. Sinking ends it.
      const lv = ledger.voyage;
      if (sum.outcome === "harbor") { lv.leg = chapter.leg; lv.score += sum.score; run = { leg: lv.leg, score: lv.score, over: false }; }
      else {
        const total = lv.score + sum.score, legs = chapter.leg - 1;
        const record = legs > lv.bestLegs || (legs === lv.bestLegs && total > lv.bestScore);
        if (record) { lv.bestLegs = legs; lv.bestScore = total; rewards.push(`A new record on the Long Voyage, ${legs} leg${legs === 1 ? "" : "s"}`); }
        run = { leg: legs, score: total, over: true, record };
        lv.leg = 0; lv.score = 0; lv.seed = 0;
      }
      game.madePort = false;
    } else if (chapter && sum.outcome === "harbor") {
      const prev = ledger.campaign.done[chapter.id];
      if (prev) prev.score = Math.max(prev.score, sum.score);
      game.madePort = !prev;
    } else game.madePort = false;
    saveLedger();
    if (tutorial) ledger.tutorialDone = true;
    saveLedger();
    game.lastSummary = Object.assign({ medal, par: parScore, brass, rewards, voyageNo: C.voyageNumber(), official: game.official, tutorial, chapter: chapter ? { id: chapter.id, title: chapter.title, port: chapter.port, leg: chapter.leg || 0 } : null, run, discovered: [...game.discoveredThisVoyage] }, sum);
    if (sum.outcome === "harbor") SND.harbor();
    game.tutorial = null;
    game.slow = 1;
    setTimeout(() => { game.hint = null; renderLog(); setState("log"); }, delayMs != null ? delayMs : immediate ? 0 : sum.outcome === "harbor" ? 900 : 1600);
  }

  // ------------------------------------------------------------ The campaign

  function chapterById(id) { return game.campaign ? game.campaign.chapters.find((c) => c.id === id) : null; }

  // ------------------------------------------------------------ The Long Voyage

  // A leg is a chapter drawn from Verne's places. Each presses harder than
  // the last, and the same seed always draws the same run.
  function legFor(n, runSeed) {
    const places = game.campaign.voyage.places;
    const r = C.rng((runSeed >>> 0) ^ Math.imul(n, 0x9e3779b1));
    const prevIndex = n > 1 ? legFor(n - 1, runSeed).placeIndex : -1;
    let index = Math.floor(r() * places.length);
    if (index === prevIndex) index = (index + 1) % places.length;
    const place = places[index];
    const press = Math.min(2.4, 1 + 0.08 * n);
    const weights = {};
    for (const k of Object.keys(C.KINDS)) if (k !== "writ") weights[k] = +(Math.min(2.6, (0.6 + r() * 1.0) * press)).toFixed(2);
    const duration = 72 + Math.floor(r() * 4) * 6;
    const hazards = Object.assign({}, place.hazards || {});
    if (n >= 3 && r() < 0.4) { const b0 = 20 + Math.floor(r() * 30); hazards.barrage = [[b0, b0 + 8]]; }
    hazards.decrees = Math.min(3, 1 + Math.floor(n / 4));
    const conditions = {};
    for (const c of place.conditions || []) {
      const windows = [];
      const count = 1 + (r() < 0.5 ? 1 : 0);
      let t0 = 8 + Math.floor(r() * 10);
      for (let i = 0; i < count && t0 < duration - 18; i++) { const len = 10 + Math.floor(r() * 9); windows.push([t0, Math.min(duration - 8, t0 + len)]); t0 += len + 10 + Math.floor(r() * 10); }
      if (windows.length) conditions[c] = windows;
    }
    const names = Object.keys(conditions).map((k) => C.CONDITIONS[k].label.toLowerCase());
    const brief = `${place.verne}. ` + (names.length ? `The waters carry ${names.join(" and ")}. ` : "") + (hazards.barrage ? "The frigate is close and will drop charges in a barrage. " : "") + `Leg ${n} of the Long Voyage, and the Leviathan presses harder with every port.`;
    const next = places[(index + 1 + Math.floor(r() * (places.length - 1))) % places.length];
    return { id: 100 + n, leg: n, placeIndex: index, seed: ((runSeed >>> 0) + n * 7919) >>> 0, title: place.name, port: next.name, verne: place.verne, sea: place.sea, weather: place.weather, duration, brief, weights, hazards, conditions };
  }

  function nextLeg() {
    const lv = ledger.voyage;
    if (!lv.seed) { lv.seed = (Date.now() / 1000) >>> 0; lv.leg = 0; lv.score = 0; saveLedger(); }
    game.leg = legFor(lv.leg + 1, lv.seed);
    game.chartPick = "voyage";
    setState("fit");
  }

  function renderVoyageSection() {
    const box = $("chart-voyage"), lv = ledger.voyage, cv = game.campaign.voyage;
    box.hidden = !(cv && ledger.campaign.next > 1);
    if (box.hidden) return;
    $("voyage-h").textContent = cv.title;
    $("voyage-intro").textContent = cv.intro;
    const best = lv.bestLegs ? `Best run, ${lv.bestLegs} leg${lv.bestLegs === 1 ? "" : "s"} and ${lv.bestScore.toLocaleString()} points.` : "No run on record yet.";
    $("voyage-status").textContent = lv.leg ? `A run is under way. ${lv.leg} leg${lv.leg === 1 ? "" : "s"} made and ${lv.score.toLocaleString()} points so far. ${best}` : best;
    $("voyage-btn").textContent = lv.leg ? `Sail leg ${lv.leg + 1}` : "Weigh anchor";
  }

  function renderChart() {
    const camp = game.campaign, cp = ledger.campaign;
    if (game.chartPick === "voyage") game.chartPick = null;
    renderVoyageSection();
    $("chart-season").textContent = camp.season;
    const pick = game.chartPick || Math.min(cp.next, camp.chapters.length);
    game.chartPick = pick;
    const canvas = $("chart-map");
    const w = Math.max(320, canvas.clientWidth || 800), h = w / 2, dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    ART.chart(g, w, h, camp.chapters, { done: cp.done, next: cp.next, leviathan: Math.min(camp.chapters.length - 1, cp.next) });
    const list = $("chart-ports"); list.textContent = "";
    for (const ch of camp.chapters) {
      const done = !!cp.done[ch.id], open = done || ch.id === cp.next;
      const b = document.createElement("button"); b.type = "button"; b.className = "port" + (ch.id === pick ? " on" : "") + (open ? "" : " locked"); b.disabled = !open; b.setAttribute("role", "listitem");
      const n = document.createElement("span"); n.className = "n"; n.textContent = `Chapter ${ch.id}`;
      const t = document.createElement("span"); t.className = "t"; t.textContent = ch.title;
      const sub = document.createElement("span"); sub.className = "s"; sub.textContent = done ? `${ch.port} · made port · best ${cp.done[ch.id].score.toLocaleString()}` : open ? `${ch.port} · next` : "Uncharted";
      b.append(n, t, sub);
      b.addEventListener("click", () => { game.chartPick = ch.id; renderChart(); });
      list.append(b);
    }
    const ch = chapterById(pick);
    const brief = $("chart-brief"); brief.textContent = "";
    if (ch) {
      const head = document.createElement("div"); const bb = document.createElement("b"); bb.textContent = `${ch.title}, ${ch.port}. `; head.append(bb, `${ch.sea.charAt(0).toUpperCase() + ch.sea.slice(1)} sea, ${ch.weather}. From Verne, ${ch.verne.toLowerCase()}.`);
      const p = document.createElement("p"); p.textContent = ch.brief;
      brief.append(head, p);
      const waters = watersLine(ch); if (waters) brief.append(waters);
    }
    $("chart-fit").disabled = !ch || !(cp.done[ch.id] || ch.id === cp.next);
    if (cp.next > camp.chapters.length) { const p = document.createElement("p"); p.className = "tip"; p.textContent = "Season One is complete. Every port is yours to sail again, and the daily voyage continues."; brief.append(p); }
  }

  // The chapter or Long Voyage leg the chart room is fitting out for.
  function currentChapter() { return game.chartPick === "voyage" ? game.leg : chapterById(game.chartPick); }

  // A line naming the sea conditions a chapter carries, for the brief.
  function watersLine(ch) {
    const names = Object.keys((ch && ch.conditions) || {}).filter((k) => own(C.CONDITIONS, k));
    if (!names.length) return null;
    const p = document.createElement("p"); p.className = "waters";
    const b = document.createElement("b"); b.textContent = "Waters ahead. "; p.append(b);
    p.append(names.map((k) => `${C.CONDITIONS[k].label}. ${C.CONDITIONS[k].note}`).join(" "));
    return p;
  }

  function renderFit() {
    const camp = game.campaign, cp = ledger.campaign, ch = currentChapter();
    $("fit-stamp").textContent = ch ? (ch.leg ? `Chart room · the Long Voyage, leg ${ch.leg}` : `Chart room · chapter ${ch.id}, ${ch.title}`) : "Chart room";
    const brief = $("fit-brief"); brief.textContent = ch ? ch.brief : "";
    const waters = watersLine(ch); if (waters) brief.append(waters);
    $("fit-brass").textContent = `${ledger.brass.toLocaleString()} brass`;
    const grid = (el, items, kind) => {
      el.textContent = "";
      const owned = kind === "rules" ? null : cp.owned[kind];
      const current = kind === "rules" ? cp.rules : cp[kind === "systems" ? "system" : "crew"];
      if (kind !== "rules") {
        const none = fittingButton({ label: "None", detail: kind === "systems" ? "Sail without a system." : "Sail without a named crew member." }, current === null, true, "");
        none.addEventListener("click", () => { cp[kind === "systems" ? "system" : "crew"] = null; saveLedger(); renderFit(); });
        el.append(none);
      }
      for (const it of items) {
        const have = kind === "rules" || owned.includes(it.id);
        const on = current === it.id;
        const canBuy = !have && ledger.brass >= it.cost;
        const b = fittingButton(it, on, have || canBuy, have ? (on ? "Fitted" : "Owned") : `${it.cost} brass`);
        if (kind === "rules" && it.profile) { const a = document.createElement("a"); a.href = it.profile; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Read the rule book"; a.addEventListener("click", (e) => e.stopPropagation()); b.append(a); }
        b.addEventListener("click", () => {
          if (!have) { if (!canBuy) return; ledger.brass -= it.cost; owned.push(it.id); toast(`${it.label} fitted for ${it.cost} brass`); }
          if (kind === "rules") { cp.rules = it.id; if (it.id === "captain" && !cp.custom) cp.custom = limitsOf(game.profiles.standard); }
          else cp[kind === "systems" ? "system" : "crew"] = it.id;
          saveLedger(); renderFit();
        });
        el.append(b);
      }
    };
    grid($("fit-rules"), camp.fittings.rules, "rules");
    renderCustom();
    grid($("fit-systems"), camp.fittings.systems, "systems");
    grid($("fit-crew"), camp.fittings.crew, "crew");
  }

  function limitsOf(profile) {
    const out = {};
    for (const g of CUSTOM) { const sg = profile.scored_signals.find((x) => x.signal === g.signal); if (sg) out[g.signal] = { warning: sg.warning_threshold, critical: sg.critical_threshold }; }
    return out;
  }

  // The captain writes limits for each gauge. The engine checks the book,
  // and the sea judges it.
  function renderCustom() {
    const box = $("fit-custom"), cp = ledger.campaign;
    box.hidden = cp.rules !== "captain";
    box.textContent = "";
    if (box.hidden) return;
    const draft = cp.custom || limitsOf(game.profiles.standard);
    const intro = document.createElement("p"); intro.className = "muted";
    intro.textContent = "A warning limit rings Half Ahead and a critical limit rings All Stop. Hull, heat and drift are unsafe when high. Sonar is unsafe when low. The standard book is a fair start, and the three published books show where other captains drew their lines.";
    box.append(intro);
    const grid = document.createElement("div"); grid.className = "limits";
    const inputs = {};
    for (const g of CUSTOM) {
      const row = document.createElement("div"); row.className = "limit-row";
      const name = document.createElement("div"); const n = document.createElement("div"); n.className = "limit-name"; n.textContent = g.label;
      const d = document.createElement("div"); d.className = "muted small"; d.textContent = `${g.dir === "lower_is_unsafe" ? "Lower is unsafe" : "Higher is unsafe"}. From ${g.min} to ${g.max}.`;
      name.append(n, d); row.append(name);
      inputs[g.signal] = {};
      for (const k of ["warning", "critical"]) {
        const lab = document.createElement("label"); lab.append(k === "warning" ? "Warning " : "Critical ");
        const inp = document.createElement("input"); inp.type = "number"; inp.min = g.min; inp.max = g.max; inp.step = g.step; inp.value = draft[g.signal][k]; inp.dataset.sig = g.signal; inp.dataset.k = k; inp.setAttribute("aria-label", `${g.label} ${k} limit`);
        lab.append(inp); row.append(lab); inputs[g.signal][k] = inp;
      }
      grid.append(row);
    }
    box.append(grid);
    const msg = document.createElement("p"); msg.className = "fit-msg"; msg.setAttribute("aria-live", "polite"); msg.id = "fit-custom-msg";
    const row = document.createElement("div"); row.className = "row";
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn iron"; dl.textContent = "Download my rule book";
    dl.addEventListener("click", () => { const p = customProfile(cp.custom); if (p) download("nautilus-captain-trp.json", JSON.stringify(p, null, 2)); });
    row.append(dl);
    box.append(msg, row);
    const read = () => {
      const raw = {};
      for (const g of CUSTOM) raw[g.signal] = { warning: inputs[g.signal].warning.value, critical: inputs[g.signal].critical.value };
      const clean = cleanCustom(raw);
      if (!clean) { msg.textContent = "The engine rejects this book. Every limit must sit inside its range, and the warning limit must sit on the safe side of the critical one."; $("fit-sail").disabled = true; return; }
      cp.custom = clean; saveLedger();
      msg.textContent = "The engine accepts this book. The sea will judge it.";
      $("fit-sail").disabled = false;
    };
    for (const sig of Object.values(inputs)) for (const inp of Object.values(sig)) inp.addEventListener("change", read);
    read();
  }

  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function fittingButton(it, on, enabled, cost) {
    const b = document.createElement("button"); b.type = "button"; b.className = "fitting" + (on ? " on" : ""); b.disabled = !enabled; b.setAttribute("aria-pressed", String(on));
    const t = document.createElement("span"); t.className = "t"; t.textContent = it.label;
    const d = document.createElement("span"); d.className = "d"; d.textContent = it.detail;
    b.append(t, d);
    if (cost) { const c = document.createElement("span"); c.className = "c"; c.textContent = cost; b.append(c); }
    return b;
  }

  function renderPort() {
    const ch = chapterById(game.lastSummary && game.lastSummary.chapter ? game.lastSummary.chapter.id : 0);
    if (!ch) { setState("salon"); return; }
    $("port-stamp").textContent = `Chapter ${ch.id} · ${ch.port}`;
    $("port-h").textContent = ch.port;
    $("port-text").textContent = ch.scene.text;
    $("port-result").textContent = "";
    $("port-done").hidden = true;
    const box = $("port-choices"); box.textContent = "";
    ch.scene.choices.forEach((c, i) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "choice";
      const t = document.createElement("span"); t.className = "t"; t.textContent = c.label;
      const d = document.createElement("span"); d.className = "d"; d.textContent = c.detail;
      b.append(t, d);
      b.addEventListener("click", () => {
        for (const x of box.children) x.disabled = true;
        b.classList.add("on");
        const got = applyEffects(c.effects);
        ledger.campaign.done[ch.id] = { choice: i, score: game.lastSummary.score };
        ledger.campaign.next = Math.max(ledger.campaign.next, ch.id + 1);
        saveLedger();
        $("port-result").textContent = got.join(" · ");
        $("port-done").hidden = false;
      });
      box.append(b);
    });
  }

  // Effects a port can have on the ship. Each returns a line for the log.
  function applyEffects(fx) {
    const cp = ledger.campaign, camp = game.campaign, got = [];
    const label = (list, id) => { const x = list.find((i) => i.id === id); return x ? x.label : id; };
    if (fx.brass) { ledger.brass += fx.brass; got.push(`${fx.brass} brass`); }
    if (fx.rules) { cp.rules = fx.rules; got.push(`${label(camp.fittings.rules, fx.rules)} fitted`); }
    if (fx.system) { if (!cp.owned.systems.includes(fx.system)) cp.owned.systems.push(fx.system); cp.system = fx.system; got.push(`${label(camp.fittings.systems, fx.system)} fitted`); }
    if (fx.crew) { if (!cp.owned.crew.includes(fx.crew)) cp.owned.crew.push(fx.crew); cp.crew = fx.crew; got.push(`${label(camp.fittings.crew, fx.crew)} joins the crew`); }
    if (fx.pennant && own(ART.PENNANTS, fx.pennant)) { if (!ledger.pennants.includes(fx.pennant)) ledger.pennants.push(fx.pennant); ledger.pennant = fx.pennant; got.push(`${ART.PENNANTS[fx.pennant].name} pennant`); }
    if (fx.skin && own(ART.SKINS, fx.skin)) { if (!ledger.skins.includes(fx.skin)) ledger.skins.push(fx.skin); ledger.skin = fx.skin; got.push(`${ART.SKINS[fx.skin].name} hull`); }
    if (fx.pages) { let n = 0; for (let i = 0; i < fx.pages.n; i++) { const id = nextPage(fx.pages.level); if (!id) break; discover(id, true); n++; } got.push(`${n} page${n === 1 ? "" : "s"} for the library`); }
    if (fx.reveal === "all") { for (const e of CODEX.get().entries) discover(e.id, true); got.push("every page of the codex revealed"); }
    saveLedger();
    return got;
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
    return `${head}${diff}\n${timelineGlyphs(sum)}\n${sum.score.toLocaleString()} · ${medalText}${sum.caught + (sum.prevented || 0)} saved by the open rules\n${location.origin}${location.pathname}`;
  }

  function renderLog() {
    const s = game.lastSummary;
    $("log-voyage").textContent = s.tutorial ? "Shakedown cruise complete" : s.chapter && s.chapter.leg ? `The Long Voyage · leg ${s.chapter.leg} · ${s.chapter.title}` : s.chapter ? `Chapter ${s.chapter.id} · ${s.chapter.title}` : s.official ? `Voyage No. ${s.voyageNo}` : "Practice voyage";
    $("log-h").textContent = s.outcome === "harbor" ? (s.chapter ? `${s.chapter.port} Reached` : "Free Harbor Reached") : "The Nautilus Went Down";
    const leg = s.chapter && s.chapter.leg;
    $("log-port").hidden = !((s.chapter && s.outcome === "harbor" && game.madePort) || (leg && s.outcome === "harbor"));
    $("log-port").textContent = leg ? "Next leg" : "Make port";
    $("again-btn").hidden = !!leg;
    $("again-btn").textContent = s.chapter ? "Sail the chapter again" : "Sail again";
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
    for (const [k, val] of [["Leagues", s.leagues], ["Intercepted", s.intercepted], ["Saved by the rules", s.caught + (s.prevented || 0)], ["Stopped for nothing", `${s.needless_s || 0} s`], ["Hull hits", s.hits], ["Salvage", s.relics + s.chests + s.pearls], ["Brass earned", s.brass]]) {
      const d = document.createElement("div"); d.className = "stat";
      const a = document.createElement("div"); a.className = "v"; a.textContent = String(val);
      const b = document.createElement("div"); b.className = "k"; b.textContent = k;
      d.append(a, b); stats.append(d);
    }
    const r = C.rank(ledger.lifetimeLeagues);
    const rank = $("log-rank");
    rank.textContent = "";
    if (s.run) {
      const runLine = document.createElement("div"); runLine.className = "run";
      runLine.textContent = s.run.over ? `The run ends. ${s.run.leg} leg${s.run.leg === 1 ? "" : "s"} and ${s.run.score.toLocaleString()} points on the Long Voyage.` : `Leg ${s.run.leg} made. ${s.run.score.toLocaleString()} points on this run so far.`;
      rank.append(runLine);
    }
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
    if (to === "salon" || to === "explain" || to === "log" || to === "settings" || to === "yard") { setState(to); return; }
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
    g.fillText(`${s.medal ? s.medal.toUpperCase() + " · " : ""}${s.leagues} LEAGUES · ${s.caught + (s.prevented || 0)} SAVED BY THE OPEN RULES`, 70, 410);
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
      const th = game.telegraphHit, lv = game.leverHit;
      if (lv && Math.hypot(e.clientX - lv.x, e.clientY - lv.y) < lv.r) { game.voyage.setManualStop(!game.voyage.manualStop); SND.bell(); return; }
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
        if (e.key === "x") { v.setManualStop(!v.manualStop); SND.bell(); }
      }
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
        game.acc += dt * (game.state === "playing" ? game.slow : 1);
        while (game.acc >= STEP) {
          if (game.attractPolicy) game.attractPolicy(v, STEP);
          v.step(STEP);
          handle(v.drain(), v);
          game.acc -= STEP;
          if (game.state !== "playing" && !game.attractPolicy) break;
        }
      }
      if (game.attractPolicy && v.done) startAttract();
      if (game.state === "playing") {
        SND.engine(v.sub.speed);
        SND.scoreStart();
        const danger = Math.min(1, v.payloads.filter((p) => p.y > C.WATER).length * 0.2 + (v.rulesCaptured ? 0.5 : 0) + (v.hearts <= 1 ? 0.3 : 0));
        SND.score(danger, v.rulesCaptured);
      }
      game.shake = Math.max(0, game.shake - dt * 2.5);
      game.flash = Math.max(0, game.flash - dt * 1.5);
      const paused = !(game.state === "playing" || game.attractPolicy);
      game.renderer.render(v, paused ? 0 : dt * (game.state === "playing" ? game.slow : 1), { skin: ledger.skin, pennant: ledger.pennant, shake: game.shake, flash: game.flash, reduced: reducedMotion(), scene: game.state === "salon" ? "salon" : "sea" });
      drawHud(v, paused ? 0 : dt);
      if (game.state === "salon") placeSalonTags();
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ Wiring

  function bindUi() {
    $("sail-btn").addEventListener("click", () => sail());
    $("shakedown-btn").addEventListener("click", () => sail({ tutorial: true }));
    $("how-sail").addEventListener("click", () => sail());
    $("yard-sail").addEventListener("click", () => sail());
    $("again-btn").addEventListener("click", () => { const s = game.lastSummary; if (s && s.chapter) { game.chartPick = s.chapter.id; sail({ chapter: chapterById(s.chapter.id) }); } else sail(); });
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
      if (game.state === "fit") { setState("chart"); return; }
      if ((game.state === "settings" || game.state === "how" || game.state === "yard" || game.state === "chart") && game.returnTo && game.returnTo !== "title") { const to = game.returnTo; game.returnTo = null; setState(to === "playing" ? "paused" : to); return; }
      game.returnTo = null;
      if (game.voyage && !game.attractPolicy && game.state !== "settings") { setState("paused"); return; }
      startAttract(); setState("title");
    });
    $("salon-btn").addEventListener("click", () => setState("salon"));
    $("salon-sail").addEventListener("click", () => sail());
    $("log-salon").addEventListener("click", () => setState("salon"));
    $("story-btn").addEventListener("click", () => { game.returnTo = "title"; setState("prologue"); });
    $("chart-story").addEventListener("click", () => { game.returnTo = "chart"; setState("prologue"); });
    $("chart-fit").addEventListener("click", () => setState("fit"));
    $("fit-sail").addEventListener("click", () => { const ch = currentChapter(); if (ch) sail({ chapter: ch }); });
    $("log-port").addEventListener("click", () => { const s = game.lastSummary; if (s && s.chapter && s.chapter.leg) nextLeg(); else setState("port"); });
    $("voyage-btn").addEventListener("click", () => nextLeg());
    $("port-done").addEventListener("click", () => { game.returnTo = null; setState("salon"); });
    $("prologue-continue").addEventListener("click", () => { ledger.prologueSeen = true; saveLedger(); const to = game.returnTo; game.returnTo = null; setState(to === "salon" || to === "chart" ? to : "title"); });
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
      for (let s = 0; s < seconds && !v.done && game.state === "playing"; s += STEP) {
        pilot(v, STEP); v.step(STEP); handle(v.drain(), v);
        // Presentation ages with the voyage, so effects do not pile up.
        if (game.renderer.settle) game.renderer.settle(STEP);
        for (let i = game.floats.length - 1; i >= 0; i--) { game.floats[i].life -= STEP; if (game.floats[i].life <= 0) game.floats.splice(i, 1); }
        for (let i = game.captions.length - 1; i >= 0; i--) { game.captions[i].life -= STEP; if (game.captions[i].life <= 0) game.captions.splice(i, 1); }
        game.shake = Math.max(0, game.shake - STEP * 2); game.flash = Math.max(0, game.flash - STEP * 2);
      }
      return v.summary();
    },
    get state() { return game.state; },
    get order() { return game.voyage ? game.voyage.order : null; },
    get campaign() { return game.campaign; },
    sailChapter(id) { game.chartPick = id; const ch = chapterById(id); if (ch) sail({ chapter: ch }); return !!ch; },
    get ledger() { return JSON.parse(JSON.stringify(ledger)); },
  };

  async function boot() {
    try {
      const [profile, campaign] = await Promise.all([
        fetch("../../examples/nautilus/trp.json", { cache: "no-cache" }).then((r) => r.json()),
        fetch("campaign.json", { cache: "no-cache" }).then((r) => r.json()),
        CODEX.load("../codex.json"),
      ]);
      game.profileRaw = profile;
      game.campaign = campaign;
      game.profiles.standard = profile;
      for (const rb of campaign.fittings.rules) if (rb.profile && rb.id !== "standard") game.profiles[rb.id] = await fetch(rb.profile, { cache: "no-cache" }).then((r) => r.json());
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
    if (ledger.prologueSeen) setState("title"); else { game.returnTo = "title"; setState("prologue"); }
    requestAnimationFrame(frame);
  }

  // world3d.js is a module and may finish loading after this script, so wait
  // briefly for it, then fall back to 2D.
  let waited = 0;
  const wait = () => { waited += 30; if (window.NautilusWorld3D || window.NautilusWorld3DFailed || waited > 4000) boot(); else setTimeout(wait, 30); };
  wait();
})();
