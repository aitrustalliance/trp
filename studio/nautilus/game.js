/**
 * Nautilus game controller.
 *
 * Owns the voyage from core.js, input, sound, the heads-up display, the
 * screens, the captain's ledger, sharing and the crew sign-up. The world is
 * drawn by a renderer: World3D (world3d.js, WebGL) when it loads, otherwise
 * World2D below, which uses art.js.
 */
(function () {
  "use strict";

  const C = window.TRPNautilusCore;
  const E = window.TRPEngine;
  const ART = window.NautilusArt;
  const SND = window.NautilusAudio;
  const CREW = window.NautilusCrew;
  const CFG = window.NAUTILUS_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const W = C.W, H = C.H;
  const STEP = 1 / 60;

  const GAUGES = [
    { signal: "hull_stress", label: "Hull", min: 0, max: 1.2 },
    { signal: "reactor_temp_c", label: "Reactor", min: 40, max: 160 },
    { signal: "sonar_confidence", label: "Sonar", min: 0, max: 1 },
    { signal: "crew_goal_drift", label: "Crew", min: 0, max: 1 },
  ];
  const UNLOCKS = { bronze: "copper", silver: "verdigris", gold: "gilded" };
  const MEDAL_BRASS = { gold: 30, silver: 20, bronze: 10 };

  const game = {
    state: "loading",       // loading, title, playing, paused, log, yard, how
    profileRaw: null,
    voyage: null,
    official: false,
    renderer: null,
    hud: null,
    hudCtx: null,
    captions: [],
    floats: [],
    shake: 0,
    flash: 0,
    telegraph: 0,
    acc: 0,
    last: 0,
    parScore: null,
    lastSummary: null,
  };

  // ------------------------------------------------------------ Ledger

  const LKEY = "nautilus.v1";
  function freshLedger() {
    return {
      brass: 0, lifetimeLeagues: 0, bestEver: 0, best: {}, streak: { last: 0, count: 0 },
      medals: { gold: 0, silver: 0, bronze: 0 }, skins: ["brass"], skin: "brass",
      pennants: ["none"], pennant: "none", captain: "", joined: false, sound: true, played: {},
    };
  }
  // Storage is shared with other pages on the same site, so every field is
  // checked and anything unexpected falls back to the default.
  function loadLedger() {
    const L = freshLedger();
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(LKEY) || "null"); } catch (err) { raw = null; }
    if (!raw || typeof raw !== "object") return L;
    const num = (v, d) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
    L.brass = num(raw.brass, 0);
    L.lifetimeLeagues = num(raw.lifetimeLeagues, 0);
    L.bestEver = num(raw.bestEver, 0);
    if (raw.streak) L.streak = { last: num(raw.streak.last, 0), count: num(raw.streak.count, 0) };
    if (raw.medals) for (const k of ["gold", "silver", "bronze"]) L.medals[k] = num(raw.medals[k], 0);
    if (Array.isArray(raw.skins)) L.skins = raw.skins.filter((s) => s in ART.SKINS);
    if (!L.skins.includes("brass")) L.skins.unshift("brass");
    if (raw.skin in ART.SKINS && L.skins.includes(raw.skin)) L.skin = raw.skin;
    if (Array.isArray(raw.pennants)) L.pennants = raw.pennants.filter((p) => p in ART.PENNANTS);
    if (!L.pennants.includes("none")) L.pennants.unshift("none");
    if (raw.pennant in ART.PENNANTS && L.pennants.includes(raw.pennant)) L.pennant = raw.pennant;
    if (typeof raw.captain === "string") L.captain = raw.captain.slice(0, 40);
    L.joined = raw.joined === true;
    L.sound = raw.sound !== false;
    if (raw.best && typeof raw.best === "object") for (const [k, v] of Object.entries(raw.best)) if (/^\d{8}$/.test(k)) L.best[k] = num(v, 0);
    if (raw.played && typeof raw.played === "object") for (const k of Object.keys(raw.played)) if (/^\d{8}$/.test(k)) L.played[k] = true;
    return L;
  }
  let ledger = loadLedger();
  function saveLedger() { try { localStorage.setItem(LKEY, JSON.stringify(ledger)); } catch (err) { /* private mode */ } }

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
      event(e, v) { burst2d(parts, e, v); },
      render(v, dt, view) {
        const g = ctx;
        // Letterbox bands continue the sky and sea.
        const band = g.createLinearGradient(0, 0, 0, ch);
        band.addColorStop(0, "#060918"); band.addColorStop(Math.max(0.01, Math.min(0.99, (oy + C.WATER * s) / ch)), "#103059"); band.addColorStop(1, "#040b19");
        g.fillStyle = band; g.fillRect(0, 0, cw, ch);
        g.save();
        g.translate(ox + (Math.random() - 0.5) * view.shake * 12, oy + (Math.random() - 0.5) * view.shake * 12);
        g.scale(s, s);
        const scroll = 140 * v.sub.speed;
        ART.background(g, { W, H, WATER: C.WATER, t: v.t, dist: v.dist, layers, captured: v.rulesCaptured, flash: view.flash });
        ART.snow(g, flakes, W, H, C.WATER, dt, scroll);
        ART.airship(g, C.airshipX(v.t), 92, v.t, { captured: v.rulesCaptured });
        for (const p of v.payloads) {
          if (p.kind === "charge") { g.strokeStyle = "rgba(230, 211, 161, 0.25)"; g.setLineDash([6, 6]); g.beginPath(); g.moveTo(p.x - 40, p.fuseY); g.lineTo(p.x + 40, p.fuseY); g.stroke(); g.setLineDash([]); }
          ART.payload(g, p, v.t);
        }
        for (const gr of v.gears) ART.gear(g, gr, v.t);
        for (const h of v.harpoons) ART.harpoon(g, h, C.SUB_X + 30, v.sub.y - 40);
        if (v.sub.speed > 0.05 && Math.random() < v.sub.speed * 0.8) parts.push({ x: C.SUB_X - 125, y: v.sub.y + (Math.random() - 0.5) * 10, vx: -40 - Math.random() * 40, vy: -20 - Math.random() * 20, life: 1.2, max: 1.2, r: 2 + Math.random() * 3, kind: "bubble" });
        ART.sub(g, C.SUB_X, v.sub.y, { skin: view.skin, pennant: view.pennant, prop: v.t * (4 + 16 * v.sub.speed), time: v.t, tilt: (v.sub.targetY - v.sub.y) * 0.0012, blink: v.invuln > 0 && Math.floor(v.t * 12) % 2 === 0 });
        drawParts2d(g, parts, dt);
        g.restore();
      },
    };
  }

  function burst2d(parts, e) {
    const add = (n, f) => { for (let i = 0; i < n; i++) parts.push(f(i)); };
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
    const playing = game.state === "playing" || game.state === "paused";
    // Floating text and captions show in every state that has a voyage.
    for (let i = game.floats.length - 1; i >= 0; i--) {
      const f = game.floats[i];
      f.life -= dt; f.y -= 40 * dt;
      if (f.life <= 0) { game.floats.splice(i, 1); continue; }
      const p = game.renderer.project(f.x, f.y);
      g.globalAlpha = Math.min(1, f.life * 2);
      g.font = `600 ${f.size || 16}px Georgia, serif`; g.textAlign = "center";
      g.fillStyle = f.color || "#f0d9a0"; g.fillText(f.text, p.x, p.y);
      g.globalAlpha = 1;
    }
    if (!playing) return;
    const k = Math.max(0.62, Math.min(1.15, Math.min(w / 1150, h / 680)));
    g.save();
    // Score
    g.textAlign = "left"; g.textBaseline = "alphabetic";
    g.fillStyle = "#f4f6fb"; g.font = `400 ${Math.round(38 * k)}px Georgia, serif`;
    g.fillText(v.score.toLocaleString(), 20 * k, 92 * k);
    g.fillStyle = "#aab3c5"; g.font = `600 ${Math.round(12 * k)}px -apple-system, Segoe UI, sans-serif`;
    const mult = Math.min(3, 1 + Math.floor(v.combo / 5));
    g.fillText(`${v.leagues} LEAGUES${v.combo > 1 ? `  ·  COMBO ${v.combo}${mult > 1 ? `  ×${mult}` : ""}` : ""}`, 22 * k, 112 * k);
    // Voyage clock
    const left = Math.max(0, C.DURATION - v.t);
    g.fillText(`FREE HARBOR IN ${Math.ceil(left)}s`, 22 * k, 130 * k);
    // Hearts and steam
    g.textAlign = "right";
    for (let i = 0; i < 3; i++) {
      const x = w - (24 + i * 34) * k, y = 78 * k;
      g.fillStyle = i < v.hearts ? "#e6c27a" : "rgba(230, 194, 122, 0.18)";
      g.beginPath(); g.ellipse(x - 12 * k, y, 14 * k, 6 * k, 0, 0, Math.PI * 2); g.fill();
    }
    for (let i = 0; i < v.steamMax; i++) {
      const x = w - (24 + i * 18) * k - 4 * k, y = 100 * k;
      g.fillStyle = i < Math.floor(v.steam) ? "#cfe2ff" : "rgba(207, 226, 255, 0.15)";
      g.beginPath(); g.arc(x - 8 * k, y, 5 * k, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = "#aab3c5"; g.font = `600 ${Math.round(10 * k)}px -apple-system, Segoe UI, sans-serif`;
    g.fillText("HULL", w - 128 * k, 82 * k); g.fillText("STEAM", w - 104 * k, 104 * k);
    // Telegraph and gauges
    const target = v.response === "full" ? 0 : v.response === "restricted" ? 0.5 : 1;
    game.telegraph += (target - game.telegraph) * (1 - Math.exp(-dt / 0.15));
    const by = h - 30 * k;
    g.save(); g.translate(0, 0);
    g.scale(k, k);
    ART.telegraph(g, 86, by / k - 30, 62, game.telegraph, v.order);
    const prof = v.rulesCaptured ? v.captured : v.profile;
    GAUGES.forEach((gs, i) => {
      const sig = prof.scoredSignals.find((x) => x.signal === gs.signal);
      const val = v.evidence[gs.signal];
      ART.gauge(g, 200 + i * 86, by / k - 52, 32, { min: gs.min, max: gs.max, value: val === undefined ? null : val, warning: sig.warningThreshold, critical: sig.criticalThreshold, direction: sig.direction, label: gs.label, captured: v.rulesCaptured });
    });
    // Command seal lamp
    const sealOk = v.evidence.command_seal_valid !== false;
    const lx = 200 + 4 * 86 - 10, ly = by / k - 52;
    g.fillStyle = "#6e522a"; g.beginPath(); g.arc(lx, ly, 15, 0, Math.PI * 2); g.fill();
    g.fillStyle = sealOk ? "#9fd0ff" : "#c8643c"; g.beginPath(); g.arc(lx, ly, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#c9d0dc"; g.font = "600 10px -apple-system, Segoe UI, sans-serif"; g.textAlign = "center";
    g.fillText("SEAL", lx, ly + 31);
    g.restore();
    game.telegraphHit = { x: 86 * k, y: by - 30 * k, r: 70 * k };
    // Rules overwritten banner
    if (v.rulesCaptured) {
      g.textAlign = "center"; g.fillStyle = "rgba(185, 166, 255, 0.95)";
      g.font = `700 ${Math.round(14 * k)}px -apple-system, Segoe UI, sans-serif`;
      g.fillText(`RULES OVERWRITTEN BY THE LEVIATHAN · ${Math.ceil(v.timers.captured)}s`, w / 2, h - 120 * k);
    }
    g.restore();
    // Captions
    const cap = game.captions[0];
    if (cap) {
      cap.life -= dt;
      if (cap.life <= 0) game.captions.shift();
      const a = Math.min(1, cap.life * 3, (cap.max - cap.life) * 6);
      g.globalAlpha = a; g.textAlign = "center";
      g.fillStyle = cap.color || "#f4f6fb"; g.font = `400 ${Math.round(24 * k)}px Georgia, serif`;
      g.fillText(cap.text, w / 2, 150 * k);
      if (cap.sub) { g.fillStyle = "#aab3c5"; g.font = `600 ${Math.round(12 * k)}px -apple-system, Segoe UI, sans-serif`; g.fillText(cap.sub.toUpperCase(), w / 2, 172 * k); }
      g.globalAlpha = 1;
    }
  }

  function caption(text, sub, color, life) {
    if (game.captions.length > 3) game.captions.splice(1, game.captions.length - 2);
    game.captions.push({ text, sub, color, life: life || 2.2, max: life || 2.2 });
  }
  function float(x, y, text, color, size) { game.floats.push({ x, y, text, color, size, life: 1.1 }); }

  // ------------------------------------------------------------ Events

  function handle(events, v) {
    for (const e of events) {
      if (e.type === "caught") e.subY = v.sub.y;
      game.renderer.event(e, v);
      if (game.state !== "playing") continue;
      switch (e.type) {
        case "fire": SND.fire(); break;
        case "intercept":
          SND.intercept(e.combo);
          float(e.x, e.y - 20, `+${e.points}`, "#f0d9a0", e.mult > 1 ? 20 : 16);
          if (e.kind === "writ") caption("The Writ is destroyed", "Your rules stay your own", "#e6d3a1", 2.6);
          break;
        case "dent": SND.fire(); float(e.x, e.y - 30, `${e.hp} more`, "#d8ccff"); break;
        case "blast": SND.blast(e.near); if (e.near) game.shake = Math.max(game.shake, 0.5); break;
        case "hit": SND.hit(); game.shake = 1; caption(e.reason, `${e.hearts} hull plate${e.hearts === 1 ? "" : "s"} left`, "#f2b48a"); break;
        case "contact":
          if (e.kind === "writ") { SND.alarm(); game.flash = 1; caption("Your rules were overwritten", "The Leviathan decides what is safe now", "#d8ccff", 3); }
          else caption(e.message, "", "#c9d0dc", 1.8);
          break;
        case "caught": SND.caught(); float(C.SUB_X, v.sub.y - 70, "Saved by the rules +60", "#e6d3a1", 18); break;
        case "order":
          SND.bell();
          if (e.to === "suspended") caption("All stop", e.reason, "#f4f6fb", 1.8);
          else if (e.to === "restricted") caption("Half ahead", e.reason, "#e6d3a1", 1.4);
          else caption("Full ahead", "", "#cfe2ff", 1);
          break;
        case "gear": SND.gear(); float(e.x, e.y - 16, "+1 brass", "#e6c27a", 14); break;
        case "done": finishVoyage(v); break;
        default: break;
      }
    }
  }

  // ------------------------------------------------------------ Flow

  function newVoyage(seed) {
    return new C.Voyage({ engine: E, profileRaw: game.profileRaw, seed });
  }

  function startAttract() {
    game.voyage = newVoyage((Math.random() * 1e9) >>> 0);
    game.attractPolicy = C.referencePolicy(game.voyage.seed);
    game.captions = []; game.floats = [];
  }

  function setState(s) {
    game.state = s;
    for (const id of ["title-screen", "how-screen", "log-screen", "yard-screen", "pause-screen", "explain-screen"]) { const el = $(id); if (el) el.hidden = true; }
    const show = { title: "title-screen", how: "how-screen", log: "log-screen", yard: "yard-screen", paused: "pause-screen", explain: "explain-screen" }[s];
    if (show) $(show).hidden = false;
    $("pause-btn").hidden = !(s === "playing" || s === "paused" || s === "explain");
    $("pause-btn").textContent = s === "paused" ? "Resume" : "Pause";
    if (s !== "playing") SND.silence();
    if (s === "title") renderTitle();
    if (s === "yard") renderYard();
  }

  function sail() {
    SND.init();
    SND.setMuted(!ledger.sound);
    const seed = C.daySeed();
    game.official = !ledger.played[seed];
    game.voyage = newVoyage(seed);
    game.attractPolicy = null;
    game.captions = []; game.floats = []; game.telegraph = 0;
    setState("playing");
    caption(game.official ? `Voyage No. ${C.voyageNumber()}` : "Practice voyage", "Reach Free Harbor", "#e6d3a1", 2.6);
    SND.ping();
  }

  function finishVoyage(v) {
    const sum = v.summary();
    const seed = v.seed;
    const parScore = game.parScore || C.par({ engine: E, profileRaw: game.profileRaw, seed });
    const medal = C.medal(sum.score, parScore);
    const rewards = [];
    const before = C.rank(ledger.lifetimeLeagues).title;
    ledger.lifetimeLeagues += sum.leagues;
    let brass = sum.gears + (sum.outcome === "harbor" ? 10 : 0) + (medal ? MEDAL_BRASS[medal] : 0);
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
    ledger.best[seed] = Math.max(ledger.best[seed] || 0, sum.score);
    ledger.bestEver = Math.max(ledger.bestEver, sum.score);
    saveLedger();
    game.lastSummary = Object.assign({ medal, par: parScore, brass, rewards, voyageNo: C.voyageNumber(), official: game.official }, sum);
    if (sum.outcome === "harbor") SND.harbor();
    setTimeout(() => { renderLog(); setState("log"); }, sum.outcome === "harbor" ? 900 : 1600);
  }

  // ------------------------------------------------------------ Screens

  function renderTitle() {
    $("voyage-label").textContent = `Voyage No. ${C.voyageNumber()} · ${ledger.played[C.daySeed()] ? "Practice" : "Today's voyage"}`;
    const r = C.rank(ledger.lifetimeLeagues);
    const row = $("captain-row");
    row.textContent = "";
    const item = (label, value) => { const s = document.createElement("span"); s.append(label + " "); const b = document.createElement("b"); b.textContent = value; s.append(b); row.append(s); };
    item("Rank", r.title);
    item("Leagues", ledger.lifetimeLeagues.toLocaleString());
    item("Brass", ledger.brass.toLocaleString());
    item("Streak", `${ledger.streak.count} day${ledger.streak.count === 1 ? "" : "s"}`);
  }

  function timelineGlyphs(sum) {
    return sum.timeline.map((x) => (x === 2 ? "💥" : x === 1 ? "⚓" : "🌊")).join("") + (sum.outcome === "harbor" ? "🏝" : "🌑");
  }

  function shareText(sum) {
    const medalText = sum.medal ? sum.medal.charAt(0).toUpperCase() + sum.medal.slice(1) + " · " : "";
    const head = sum.official ? `Nautilus · Voyage No. ${sum.voyageNo}` : "Nautilus · Practice voyage";
    return `${head}\n${timelineGlyphs(sum)}\n${sum.score.toLocaleString()} · ${medalText}${sum.caught} saved by the open rules\n${location.origin}${location.pathname}`;
  }

  function renderLog() {
    const s = game.lastSummary;
    $("log-voyage").textContent = s.official ? `Voyage No. ${s.voyageNo}` : "Practice voyage";
    $("log-h").textContent = s.outcome === "harbor" ? "Free Harbor Reached" : "The Nautilus Went Down";
    const medal = $("log-medal");
    medal.className = "medal " + (s.medal || "none");
    medal.textContent = s.medal ? s.medal : "No medal";
    $("log-score").textContent = s.score.toLocaleString();
    $("log-par").textContent = `Par ${s.par.toLocaleString()}, set by a steady reference captain on the same voyage`;
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
    const text = shareText(s);
    $("x-btn").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(text);
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
      const label = owned ? (ledger.pennant === id ? "Flying" : "Owned") : p.join ? "Join the crew" : `${p.cost} brass`;
      const canBuy = !owned && !p.join && ledger.brass >= p.cost;
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
    const add = (title, detail) => { const d = document.createElement("div"); d.className = "ex-row"; const a = document.createElement("b"); a.textContent = title; const b = document.createElement("span"); b.textContent = detail; d.append(a, b); box.append(d); };
    add("Engine order", `${v.order}. Standing ${r.standing}, response ${r.response}.`);
    for (const t of r.hard_rules_triggered || []) add(C.LABELS[t.rule] || t.rule, `Hard rule met: ${t.field} ${t.condition.replace(/_/g, " ")}. Action ${t.action}.`);
    for (const m of r.missing_signals || []) add(C.LABELS[m.signal] || m.signal, `No reading. The rules treat missing evidence as ${m.on_missing}, so the ship will not sail blind.`);
    const prof = v.rulesCaptured ? v.captured : v.profile;
    for (const s of r.signal_results || []) {
      if (!s.in_warning) continue;
      const def = prof.scoredSignals.find((x) => x.signal === s.signal);
      add(C.LABELS[s.signal] || s.signal, `${s.value} ${s.unit || ""}. Warning at ${def.warningThreshold}, critical at ${def.criticalThreshold}. ${s.in_critical ? "Critical" : "Warning"}.`);
    }
    if (box.children.length === 1) add("All clear", "Every reading is inside its limits and no hard rule is met.");
    if (v.rulesCaptured) add("Captured rules", "The Leviathan's version of your rules is in force. Its limits sit past the point of harm, so nothing stops the ship.");
    $("explain-rules").href = "../../examples/nautilus/trp.json";
  }

  // ------------------------------------------------------------ Share card

  function shareCard(s) {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 630;
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, 630); bg.addColorStop(0, "#0a1636"); bg.addColorStop(1, "#040b19");
    g.fillStyle = bg; g.fillRect(0, 0, 1200, 630);
    g.save(); g.translate(880, 330); g.scale(1.6, 1.6); ART.sub(g, 0, 0, { skin: ledger.skin, pennant: ledger.pennant, prop: 0.5, time: 0, tilt: -0.04 }); g.restore();
    g.fillStyle = "#e6c27a"; g.font = "600 22px -apple-system, Segoe UI, sans-serif"; g.fillText(s.official ? `VOYAGE NO. ${s.voyageNo}` : "PRACTICE VOYAGE", 70, 110);
    g.fillStyle = "#f0d9a0"; g.font = "400 96px Georgia, serif"; g.fillText("Nautilus", 64, 210);
    g.fillStyle = "#f4f6fb"; g.font = "400 120px Georgia, serif"; g.fillText(s.score.toLocaleString(), 64, 360);
    g.fillStyle = "#aab3c5"; g.font = "600 26px -apple-system, Segoe UI, sans-serif";
    g.fillText(`${s.medal ? s.medal.toUpperCase() + " · " : ""}${s.leagues} LEAGUES · ${s.caught} SAVED BY THE OPEN RULES`, 70, 410);
    s.timeline.forEach((x, i) => { g.fillStyle = x === 2 ? "#c8643c" : x === 1 ? "#e6c27a" : "rgba(170,179,197,0.4)"; g.fillRect(70 + i * 52, 450, 44, 14); });
    g.fillStyle = s.outcome === "harbor" ? "#cfe2ff" : "#c8643c"; g.fillRect(70 + 10 * 52, 450, 44, 14);
    g.fillStyle = "#aab3c5"; g.font = "500 22px -apple-system, Segoe UI, sans-serif";
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
      const running = game.state === "playing" || game.state === "title" || game.state === "how" || game.state === "yard" || game.state === "loading";
      if (running && !v.done) {
        game.acc += dt;
        while (game.acc >= STEP) {
          if (game.attractPolicy) game.attractPolicy(v, STEP);
          v.step(STEP);
          handle(v.drain(), v);
          game.acc -= STEP;
        }
      }
      if (game.attractPolicy && v.done) startAttract();
      if (game.state === "playing") SND.engine(v.sub.speed);
      game.shake = Math.max(0, game.shake - dt * 2.5);
      game.flash = Math.max(0, game.flash - dt * 1.5);
      const paused = game.state === "paused" || game.state === "explain";
      game.renderer.render(v, paused ? 0 : dt, { skin: ledger.skin, pennant: ledger.pennant, shake: game.shake, flash: game.flash });
      drawHud(v, paused ? 0 : dt);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------ Wiring

  function bindUi() {
    $("sail-btn").addEventListener("click", sail);
    $("how-sail").addEventListener("click", sail);
    $("yard-sail").addEventListener("click", sail);
    $("again-btn").addEventListener("click", sail);
    $("how-btn").addEventListener("click", () => setState("how"));
    $("yard-btn").addEventListener("click", () => setState("yard"));
    $("log-yard").addEventListener("click", () => setState("yard"));
    for (const b of document.querySelectorAll("[data-back]")) b.addEventListener("click", () => { if (game.voyage && !game.attractPolicy) startAttract(); setState("title"); });
    $("pause-btn").addEventListener("click", togglePause);
    $("resume-btn").addEventListener("click", togglePause);
    $("explain-close").addEventListener("click", togglePause);
    $("quit-btn").addEventListener("click", () => { startAttract(); setState("title"); });
    $("share-btn").addEventListener("click", share);
    $("copy-btn").addEventListener("click", () => copy(shareText(game.lastSummary)));
    const sound = $("sound-btn");
    const paint = () => { sound.textContent = ledger.sound ? "Sound on" : "Sound off"; sound.setAttribute("aria-pressed", String(ledger.sound)); };
    paint();
    sound.addEventListener("click", () => { ledger.sound = !ledger.sound; saveLedger(); SND.init(); SND.setMuted(!ledger.sound); paint(); });
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
    if (CFG.repo) for (const id of ["star-btn"]) $(id).href = CFG.repo;
  }

  // For agents, tests and the curious.
  window.TRPNautilus = {
    version: "1",
    rules: () => JSON.parse(JSON.stringify(game.profileRaw)),
    play(opts) {
      const o = opts || {};
      return C.run({ engine: E, profileRaw: game.profileRaw, seed: o.seed || C.daySeed() }, o.policy);
    },
    par(seed) { return C.par({ engine: E, profileRaw: game.profileRaw, seed: seed || C.daySeed() }); },
    get state() { return game.state; },
  };

  async function boot() {
    try {
      const res = await fetch("../../examples/nautilus/trp.json", { cache: "no-cache" });
      game.profileRaw = await res.json();
    } catch (err) {
      $("title-h").textContent = "Nautilus";
      toast("The vessel rules could not be loaded.");
      return;
    }
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
    setTimeout(() => { game.parScore = C.par({ engine: E, profileRaw: game.profileRaw, seed: C.daySeed() }); }, 50);
    setState("title");
    requestAnimationFrame(frame);
  }

  // world3d.js is a module and may finish loading after this script, so wait
  // briefly for it, then fall back to 2D.
  let waited = 0;
  const wait = () => { waited += 30; if (window.NautilusWorld3D || window.NautilusWorld3DFailed || waited > 4000) boot(); else setTimeout(wait, 30); };
  wait();
})();
