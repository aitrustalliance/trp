/**
 * TRP Studio scenes. Each scene draws one kind of system on a canvas from the
 * live simulator values and the latest evaluation. A pack names its scene;
 * packs built from a bare profile use the "instrument" scene.
 *
 * Every scene receives a frame object:
 *   { ctx, w, h, dt, t, values, evidence, omitted, result, halted, restricted, pack }
 */
(function (root) {
  "use strict";

  const C = {
    hair: "rgba(214,222,238,0.10)",
    hairStrong: "rgba(214,222,238,0.22)",
    silver: "#9aa3b5",
    silverDim: "#626b80",
    white: "#f4f6fb",
    accent: "#4fa8e8",
    gold: "#e6d3a1",
    font: '-apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, "Segoe UI", Roboto, sans-serif',
    mono: '"SF Mono", ui-monospace, Menlo, Consolas, monospace',
  };

  function text(ctx, str, x, y, opts) {
    const o = opts || {};
    ctx.font = `${o.weight || 400} ${o.size || 12}px ${o.mono ? C.mono : C.font}`;
    ctx.fillStyle = o.color || C.silver;
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = o.base || "alphabetic";
    ctx.fillText(str, x, y);
  }

  function glowDot(ctx, x, y, r, color, glow) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = glow || 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function line(ctx, x1, y1, x2, y2, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  function ease(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }

  function num(values, name, fallback) {
    const v = values[name];
    return typeof v === "number" ? v : fallback;
  }

  // Motion multiplier from the evaluation: halted freezes, restricted slows.
  function pace(frame) {
    if (frame.halted) return 0;
    if (frame.restricted) return 0.45;
    return 1;
  }

  // ---------------------------------------------------------------- Robot cell
  const robotCell = {
    init(state) { state.phase = 0; state.walk = 0; state.lastD = null; },
    draw(frame, state) {
      const { ctx, w, h, values, omitted, dt } = frame;
      const s = Math.min(w / 6.4, h / 4.4);
      const cx = w * 0.4;
      const cy = h * 0.52;

      // Floor grid, fading out from the cell.
      ctx.save();
      const grad = ctx.createRadialGradient(cx, cy, s * 0.5, cx, cy, s * 3.6);
      grad.addColorStop(0, "rgba(214,222,238,0.07)");
      grad.addColorStop(1, "rgba(214,222,238,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1;
      for (let gx = cx % (s / 2); gx < w; gx += s / 2) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (let gy = cy % (s / 2); gy < h; gy += s / 2) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
      ctx.restore();

      const distance = num(values, "human_distance_m", 2.6);
      const inExclusion = distance < 0.75;
      const inWarning = distance < 1.5;

      // Safety envelope rings.
      ctx.save();
      ctx.strokeStyle = inWarning ? C.hairStrong : C.hair;
      ctx.setLineDash([3, 6]);
      ctx.beginPath(); ctx.arc(cx, cy, 1.5 * s, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = inExclusion ? "rgba(230,211,161,0.65)" : "rgba(214,222,238,0.2)";
      ctx.beginPath(); ctx.arc(cx, cy, 0.75 * s, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      text(ctx, "1.5 m warning", cx, cy - 1.5 * s - 8, { size: 11, color: C.silverDim, align: "center" });
      text(ctx, "0.75 m exclusion", cx, cy - 0.75 * s - 8, { size: 11, color: inExclusion ? C.gold : C.silverDim, align: "center" });

      // Bin and fixture.
      const bin = { x: cx - 0.95 * s, y: cy + 0.25 * s };
      const fix = { x: cx + 0.8 * s, y: cy - 0.35 * s };
      ctx.strokeStyle = C.hairStrong;
      ctx.strokeRect(bin.x - 0.16 * s, bin.y - 0.16 * s, 0.32 * s, 0.32 * s);
      ctx.strokeRect(fix.x - 0.13 * s, fix.y - 0.13 * s, 0.26 * s, 0.26 * s);
      text(ctx, "Bin", bin.x, bin.y + 0.32 * s, { size: 11, color: C.silverDim, align: "center" });
      text(ctx, "Fixture", fix.x, fix.y + 0.3 * s, { size: 11, color: C.silverDim, align: "center" });

      // Arm motion. Speed scales the cycle, the evaluation can slow or freeze it.
      const speed = num(values, "robot_speed_mm_s", 600);
      const stopped = values.estop_active === true;
      const rate = stopped ? 0 : (speed / 600) * pace(frame) / ((frame.pack.cycle_s || 4) / 2);
      state.phase = (state.phase + dt * rate) % 2;
      const leg = state.phase < 1 ? ease(state.phase) : 1 - ease(state.phase - 1);
      const tx = bin.x + (fix.x - bin.x) * leg;
      const ty = bin.y + (fix.y - bin.y) * leg - Math.sin(leg * Math.PI) * 0.35 * s;

      // Two-link arm by inverse kinematics.
      const vib = Math.max(0, num(values, "vibration_rms_g", 0.3) - 0.45);
      const shake = frame.halted ? 0 : vib * 7;
      const jx = (Math.random() - 0.5) * shake;
      const jy = (Math.random() - 0.5) * shake;
      const L1 = 0.62 * s;
      const L2 = 0.58 * s;
      let dx = tx - cx, dy = ty - cy;
      let d = Math.hypot(dx, dy);
      d = Math.min(d, L1 + L2 - 1);
      const a = Math.atan2(dy, dx);
      const cosB = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
      const b = Math.acos(Math.max(-1, Math.min(1, cosB)));
      const ex = cx + Math.cos(a - b) * L1 + jx;
      const ey = cy + Math.sin(a - b) * L1 + jy;
      const hx = cx + Math.cos(a) * d + jx;
      const hy = cy + Math.sin(a) * d + jy;

      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = frame.halted ? C.silverDim : C.white;
      ctx.lineWidth = Math.max(3, s * 0.07);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.restore();
      glowDot(ctx, ex, ey, Math.max(3, s * 0.035), C.silver, 0);
      glowDot(ctx, hx, hy, Math.max(3, s * 0.04), frame.halted ? C.silverDim : C.accent, frame.halted ? 0 : 16);

      // Base with motor temperature halo.
      const temp = num(values, "temperature_C", 52);
      const heat = Math.max(0, Math.min(1, (temp - 55) / 30));
      if (heat > 0) {
        const hg = ctx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.45);
        hg.addColorStop(0, `rgba(230,211,161,${0.35 * heat})`);
        hg.addColorStop(1, "rgba(230,211,161,0)");
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.arc(cx, cy, s * 0.45, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#0d1230";
      ctx.strokeStyle = C.hairStrong;
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      // Person, approaching along a fixed bearing.
      const shown = omitted.has("human_distance_m") ? (state.lastD == null ? 2.6 : state.lastD) : distance;
      if (!omitted.has("human_distance_m")) {
        if (state.lastD != null && Math.abs(state.lastD - distance) > 0.002) state.walk += dt * 6;
        state.lastD = distance;
      }
      const ang = 0.32;
      const px = cx + Math.cos(ang) * shown * s;
      const py = cy + Math.sin(ang) * shown * s + Math.sin(state.walk) * 1.5;
      const ghost = omitted.has("human_distance_m");
      line(ctx, cx, cy, px, py, ghost ? C.hair : (inExclusion ? "rgba(230,211,161,0.5)" : C.hair), 1, [2, 5]);
      ctx.save();
      if (ghost) ctx.setLineDash([2, 3]);
      ctx.strokeStyle = ghost ? C.silverDim : (inExclusion ? C.gold : C.white);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(px, py, s * 0.17, s * 0.1, ang + Math.PI / 2, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(px, py, s * 0.07, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      const label = ghost ? "No reading" : `${distance.toFixed(2)} m`;
      text(ctx, label, px + s * 0.24, py + 4, { size: 12, mono: true, color: ghost ? C.silverDim : (inExclusion ? C.gold : C.white) });
      text(ctx, "Person", px + s * 0.24, py - 12, { size: 11, color: C.silverDim });

      if (stopped) text(ctx, "Emergency stop pressed", cx, cy + 1.95 * s, { size: 12, color: C.gold, align: "center" });
    },
  };

  // -------------------------------------------------------------- Machine line
  const machineLine = {
    init(state) { state.parts = []; state.spawn = 0; state.jamTimer = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, dt } = frame;
      const y = h * 0.52;
      const left = w * 0.06, right = w * 0.94;
      const stations = ["Infeed", "Spindle", "Assembly", "Inspection"];
      const xs = stations.map((_, i) => left + (right - left) * (0.14 + i * 0.24));
      const sw = Math.min(110, w * 0.11), sh = Math.min(90, h * 0.2);

      line(ctx, left, y + sh / 2 + 10, right, y + sh / 2 + 10, C.hairStrong, 1);
      line(ctx, left, y + sh / 2 + 16, right, y + sh / 2 + 16, C.hair, 1);

      const speed = num(values, "line_speed_units_min", 110);
      const flow = (speed / 110) * pace(frame) * (values.stop_circuit_ok === false ? 0 : 1);
      const jam = num(values, "jam_rate_per_hour", 0.6);
      state.spawn += dt * flow * 1.1;
      if (state.spawn > 1) { state.spawn = 0; state.parts.push({ x: left, held: 0 }); }
      const jammed = jam > 2;
      const jamX = xs[2] - sw / 2 - 12;
      for (const p of state.parts) {
        let nx = p.x + dt * flow * (w * 0.09);
        if (jammed && p.x < jamX && nx >= jamX) { p.held += dt; if (p.held < 1.4) nx = jamX; }
        p.x = nx;
      }
      state.parts = state.parts.filter((p) => p.x < right);
      const stacked = {};
      for (const p of state.parts) {
        const key = Math.round(p.x / 14);
        stacked[key] = (stacked[key] || 0) + 1;
        const lift = (stacked[key] - 1) * 10;
        ctx.strokeStyle = C.silver;
        ctx.strokeRect(p.x - 5, y + sh / 2 + 1 - lift, 10, 8);
      }

      const vib = num(values, "spindle_vibration_mm_s", 2.4);
      const temp = num(values, "bearing_temperature_C", 58);
      stations.forEach((name, i) => {
        let x = xs[i] - sw / 2;
        let yy = y - sh / 2;
        if (i === 1 && !frame.halted) { const k = Math.max(0, vib - 3) * 0.9; x += (Math.random() - 0.5) * k; yy += (Math.random() - 0.5) * k; }
        if (i === 1) {
          const heat = Math.max(0, Math.min(1, (temp - 65) / 25));
          if (heat > 0) {
            const g = ctx.createRadialGradient(xs[i], y, 0, xs[i], y, sw);
            g.addColorStop(0, `rgba(230,211,161,${0.3 * heat})`);
            g.addColorStop(1, "rgba(230,211,161,0)");
            ctx.fillStyle = g; ctx.fillRect(xs[i] - sw, y - sw, sw * 2, sw * 2);
          }
        }
        ctx.strokeStyle = frame.halted ? C.hair : C.hairStrong;
        ctx.strokeRect(x, yy, sw, sh);
        text(ctx, name, xs[i], yy - 10, { size: 11, color: C.silverDim, align: "center" });
        if (i === 1) {
          const rot = (frame.t * 9 * pace(frame)) % (Math.PI * 2);
          ctx.save(); ctx.translate(xs[i], y); ctx.rotate(rot);
          ctx.strokeStyle = frame.halted ? C.silverDim : C.white;
          ctx.beginPath(); ctx.arc(0, 0, sh * 0.22, 0, Math.PI * 1.6); ctx.stroke();
          ctx.restore();
          text(ctx, `${vib.toFixed(1)} mm/s`, xs[i], yy + sh + 34, { size: 11, mono: true, color: vib >= 4.5 ? C.white : C.silverDim, align: "center" });
        }
      });

      // Guard door on the infeed station.
      const door = values.guard_door_open === true;
      const dx = xs[0] - sw / 2, dy = y - sh / 2;
      ctx.save();
      ctx.strokeStyle = door ? C.gold : C.white;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(dx, dy);
      if (door) ctx.lineTo(dx - sh * 0.6, dy - sh * 0.45); else ctx.lineTo(dx, dy + sh);
      ctx.stroke();
      ctx.restore();
      text(ctx, door ? "Guard door open" : "Guard door", dx - 6, dy + sh + 34, { size: 11, color: door ? C.gold : C.silverDim, align: "left" });

      const ok = values.stop_circuit_ok !== false;
      line(ctx, left, h * 0.86, right, h * 0.86, ok ? "rgba(79,168,232,0.45)" : C.gold, 1, ok ? null : [4, 6]);
      text(ctx, ok ? "Stop circuit" : "Stop circuit fault", left, h * 0.86 - 8, { size: 11, color: ok ? C.silverDim : C.gold });
      if (values.lockout_tagout_active === true) text(ctx, "Lockout and tagout active", right, h * 0.86 - 8, { size: 11, color: C.gold, align: "right" });
      if (jammed) text(ctx, "Jam", jamX, y + sh / 2 - 34, { size: 11, color: C.white, align: "center" });
    },
  };

  // ------------------------------------------------------------ Data flow
  const dataFlow = {
    init(state) { state.items = []; state.spawn = 0; state.n = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, omitted, dt } = frame;
      const stages = frame.pack.stages || ["Source", "Process", "Model", "Use"];
      const y = h * 0.44;
      const xs = stages.map((_, i) => w * (0.12 + i * (0.76 / (stages.length - 1))));
      line(ctx, xs[0], y, xs[xs.length - 1], y, C.hair, 1);
      stages.forEach((name, i) => {
        ctx.strokeStyle = C.hairStrong;
        ctx.fillStyle = "#0b1030";
        ctx.beginPath(); ctx.arc(xs[i], y, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        text(ctx, name, xs[i], y - 30, { size: 12, color: C.silver, align: "center" });
      });

      const sharing = values.external_sharing_without_dua === true;
      const partner = { x: xs[1] + (xs[2] - xs[1]) / 2, y: h * 0.8 };
      if (sharing) {
        line(ctx, xs[1], y, partner.x, partner.y, "rgba(230,211,161,0.55)", 1, [3, 5]);
        ctx.strokeStyle = C.gold; ctx.beginPath(); ctx.arc(partner.x, partner.y, 12, 0, Math.PI * 2); ctx.stroke();
        text(ctx, "External partner, no agreement", partner.x, partner.y + 30, { size: 12, color: C.gold, align: "center" });
      }

      const deid = num(values, "data_deidentification_confidence", 0.97);
      const consent = num(values, "consent_coverage_ratio", 0.985);
      const flow = pace(frame);
      state.spawn += dt * flow * 3.2;
      while (state.spawn > 1) {
        state.spawn -= 1;
        state.n += 1;
        const r = ((state.n * 2654435761) >>> 0) / 4294967296;
        const r2 = ((state.n * 40503 + 7) % 1000) / 1000;
        state.items.push({
          p: 0, lane: (r - 0.5) * 26,
          leak: r2 > deid, noConsent: ((state.n * 97) % 1000) / 1000 > consent,
          out: sharing && state.n % 3 === 0,
        });
      }
      const total = xs[xs.length - 1] - xs[0];
      for (const it of state.items) it.p += dt * flow * 0.16;
      state.items = state.items.filter((it) => it.p < 1);
      for (const it of state.items) {
        let x = xs[0] + total * it.p;
        let yy = y + it.lane;
        const pastDeid = x > xs[1];
        if (it.out && pastDeid) {
          const k = Math.min(1, (x - xs[1]) / (partner.x - xs[1]));
          x = xs[1] + (partner.x - xs[1]) * k;
          yy = y + it.lane * (1 - k) + (partner.y - y) * k;
          if (k >= 1) it.p = 1;
        }
        const identified = !pastDeid || it.leak;
        const color = it.out && pastDeid ? C.gold : identified ? C.white : C.accent;
        ctx.save();
        if (it.noConsent) { ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(x, yy, 2.6, 0, Math.PI * 2); ctx.stroke(); }
        else glowDot(ctx, x, yy, 2.4, color, identified && pastDeid ? 10 : 6);
        ctx.restore();
      }

      const ly = h * 0.62;
      if (!omitted.has("access_log_completeness")) {
        line(ctx, xs[0], ly, xs[xs.length - 1], ly, "rgba(79,168,232,0.35)", 1, [1, 4]);
        text(ctx, "Access log", xs[0], ly - 8, { size: 11, color: C.silverDim });
      } else {
        text(ctx, "Access log missing", xs[0], ly - 8, { size: 11, color: C.white });
      }
      const legendY = 22;
      glowDot(ctx, xs[0], legendY - 4, 2.4, C.white, 6);
      text(ctx, "Identified", xs[0] + 10, legendY, { size: 11, color: C.silverDim });
      glowDot(ctx, xs[0] + 92, legendY - 4, 2.4, C.accent, 6);
      text(ctx, "De-identified", xs[0] + 102, legendY, { size: 11, color: C.silverDim });
      ctx.strokeStyle = C.white; ctx.beginPath(); ctx.arc(xs[0] + 198, legendY - 4, 2.6, 0, Math.PI * 2); ctx.stroke();
      text(ctx, "No consent record", xs[0] + 208, legendY, { size: 11, color: C.silverDim });
      if (values.irb_status === "expired") text(ctx, "Ethics board approval expired", xs[xs.length - 1], legendY, { size: 11, color: C.gold, align: "right" });
    },
  };

  // ------------------------------------------------------------ Agent trace
  const agentTrace = {
    init(state) { state.calls = []; state.timer = 0; state.step = 0; state.k = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, dt } = frame;
      const tools = frame.pack.tools || ["search", "read_file", "run_code"];
      const ax = w * 0.2, ay = h * 0.46;
      const tx = w * 0.72;
      const ty = (i) => h * 0.16 + i * (h * 0.56 / Math.max(1, tools.length));
      const ghostY = h * 0.16 + tools.length * (h * 0.56 / Math.max(1, tools.length));
      const unapproved = values.unapproved_tool_called === true;

      const steps = num(values, "steps_per_task", 9);
      const looping = steps > 20;
      state.timer += dt * pace(frame) * (looping ? 4.5 : 1.4);
      while (state.timer > 1) {
        state.timer -= 1;
        state.k += 1;
        let target = looping ? state.k % 2 : state.k % tools.length;
        if (unapproved && state.k % 3 === 0) target = -1;
        state.calls.push({ target: target, life: 0 });
        state.step += 1;
      }
      for (const c of state.calls) c.life += dt * (frame.halted ? 0.4 : 1.2);
      state.calls = state.calls.filter((c) => c.life < 1);

      // Agent node.
      glowDot(ctx, ax, ay, 18, "#0b1030", 0);
      ctx.strokeStyle = frame.halted ? C.silverDim : C.white;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(ax, ay, 18, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
      text(ctx, "Agno", ax, ay + 44, { size: 14, color: C.white, align: "center", weight: 300 });
      text(ctx, "any model, any framework", ax, ay + 62, { size: 11, color: C.silverDim, align: "center" });

      tools.forEach((name, i) => {
        line(ctx, ax + 18, ay, tx - 10, ty(i), C.hair, 1);
        ctx.strokeStyle = C.hairStrong;
        ctx.beginPath(); ctx.arc(tx, ty(i), 6, 0, Math.PI * 2); ctx.stroke();
        let label = name;
        if (name === "read_file" && num(values, "records_beyond_need", 0) > 0.1) label = `${name}   pulling extra records`;
        if (name === "write_db" && values.write_without_approval === true) label = `${name}   no approval`;
        if (name === "send_email" && values.output_destination_approved === false) label = `${name}   unapproved destination`;
        const flagged = label !== name;
        text(ctx, label, tx + 16, ty(i) + 4, { size: 12, mono: true, color: flagged ? C.gold : C.silver });
      });
      if (unapproved) {
        line(ctx, ax + 18, ay, tx - 10, ghostY, "rgba(230,211,161,0.5)", 1, [3, 5]);
        ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = C.gold;
        ctx.beginPath(); ctx.arc(tx, ghostY, 6, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        text(ctx, "shell_exec   not approved", tx + 16, ghostY + 4, { size: 12, mono: true, color: C.gold });
      }

      for (const c of state.calls) {
        const yy = c.target === -1 ? ghostY : ty(c.target);
        const k = ease(Math.min(1, c.life));
        const x = ax + 18 + (tx - 10 - ax - 18) * k;
        const y = ay + (yy - ay) * k;
        glowDot(ctx, x, y, 2.6, c.target === -1 ? C.gold : C.accent, 10);
      }

      const by = h * 0.86;
      const shownSteps = Math.round(steps);
      text(ctx, `Step ${shownSteps}`, ax - 18, by - 12, { size: 11, color: C.silverDim, mono: true });
      for (let i = 0; i < Math.min(60, shownSteps); i++) {
        const x = ax - 18 + i * ((w * 0.7) / 60);
        line(ctx, x, by, x, by + (i >= 20 ? 10 : 6), i >= 40 ? C.gold : i >= 20 ? C.white : C.hairStrong, 1);
      }
      if (values.secret_in_output === true) text(ctx, "Output contains an access key", tx + 16, by + 8, { size: 12, color: C.gold });
      text(ctx, `$${num(values, "cost_per_task_usd", 0.12).toFixed(2)} this task`, ax - 18, by + 30, { size: 11, color: C.silverDim, mono: true });
    },
  };

  // ------------------------------------------------------------ Instrument
  const instrument = {
    init(state) { state.history = {}; },
    draw(frame, state) {
      const { ctx, w, h, values, omitted, result } = frame;
      const signals = (frame.profile && frame.profile.scoredSignals) || [];
      const cols = w > 900 ? 3 : w > 560 ? 2 : 1;
      const rows = Math.max(1, Math.ceil(signals.length / cols));
      const cw = (w - 56) / cols;
      const rh = Math.min(150, (h - 40) / rows);
      signals.forEach((s, i) => {
        const x = 28 + (i % cols) * cw;
        const y = 24 + Math.floor(i / cols) * rh;
        const hist = state.history[s.signal] || (state.history[s.signal] = []);
        const v = values[s.signal];
        if (typeof v === "number") { hist.push(v); if (hist.length > 160) hist.shift(); }
        const res = (result && result.signal_results || []).find((r) => r.signal === s.signal);
        const color = !res ? C.silverDim : res.in_critical ? C.gold : res.in_warning ? C.white : C.silver;
        text(ctx, frame.humanize(s.signal), x, y + 14, { size: 12, color: C.silver });
        text(ctx, omitted.has(s.signal) ? "No reading" : typeof v === "number" ? `${+v.toFixed(3)} ${s.unit}` : "—", x, y + 46, { size: 26, weight: 200, color: color });
        const all = hist.concat([s.warningThreshold, s.criticalThreshold]);
        const lo = Math.min(...all), hi = Math.max(...all);
        const sy = (val) => y + rh - 22 - ((val - lo) / (hi - lo || 1)) * (rh - 80);
        line(ctx, x, sy(s.warningThreshold), x + cw - 30, sy(s.warningThreshold), C.hair, 1, [2, 4]);
        line(ctx, x, sy(s.criticalThreshold), x + cw - 30, sy(s.criticalThreshold), "rgba(230,211,161,0.3)", 1, [2, 4]);
        if (hist.length > 1) {
          ctx.save(); ctx.strokeStyle = C.accent; ctx.lineWidth = 1.2; ctx.beginPath();
          hist.forEach((hv, j) => { const px = x + (j / 159) * (cw - 30); const py = sy(hv); if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
          ctx.stroke(); ctx.restore();
        }
      });
    },
  };


  // ------------------------------------------------------------- Fleet
  // A floor of robot cells, each with its own simulator, evaluated every frame.
  const fleet = {
    init(state) { state.cells = null; state.evals = []; state.total = 0; },
    draw(frame, state) {
      const { ctx, w, h, dt, pack } = frame;
      const E = root.TRPEngine, Sim = root.TRPSim;
      const cfg = pack.fleet || { rows: 8, cols: 18, fault_rate: 0.03 };
      if (!state.cells) {
        state.cells = [];
        const random = Sim.makeRandom(99);
        state.random = random;
        for (let i = 0; i < cfg.rows * cfg.cols; i++) {
          const sim = new Sim.Simulator(pack);
          sim.random = Sim.makeRandom(1000 + i);
          sim.time = random() * 4;
          state.cells.push({ sim: sim, fault: null, until: 0, result: null, phase: random() * Math.PI * 2 });
        }
      }
      const faults = [
        { human_distance_m: { to: 0.5, ramp_s: 1.5 } },
        { vibration_rms_g: { to: 1.3, ramp_s: 1.5 } },
        { robot_speed_mm_s: { to: 820, ramp_s: 1 } },
        { human_distance_m: { to: 1.2, ramp_s: 1.5 } },
      ];
      let stopped = 0, restricted = 0, evaluated = 0;
      const now = frame.t;
      for (const cell of state.cells) {
        if (frame.controlState) for (const [k, v] of Object.entries(frame.controlState)) cell.sim.controlState[k] = v;
        if (dt > 0) {
          if (!cell.fault && state.random() < cfg.fault_rate * dt) {
            cell.fault = faults[Math.floor(state.random() * faults.length)];
            cell.until = now + 2 + state.random() * 3;
            cell.sim.extraEffects = cell.fault;
          } else if (cell.fault && now > cell.until) {
            cell.fault = null; cell.sim.extraEffects = null;
          }
          cell.sim.step(dt);
          cell.result = E.evaluate(frame.profile, cell.sim.evidence(), null);
          evaluated += 1;
        }
        if (cell.result) {
          if (cell.result.response === "suspended") stopped += 1;
          else if (cell.result.response === "restricted") restricted += 1;
        }
      }
      state.total += evaluated;
      state.evals.push([now, evaluated]);
      while (state.evals.length && now - state.evals[0][0] > 1) state.evals.shift();
      const perSecond = state.evals.reduce((s, e) => s + e[1], 0);

      const top = 70, left = 28, right = w - 28, bottom = h - 30;
      const cw = (right - left) / cfg.cols, chh = (bottom - top) / cfg.rows;
      const size = Math.min(cw, chh) * 0.62;
      state.cells.forEach((cell, i) => {
        const cx = left + (i % cfg.cols + 0.5) * cw;
        const cy = top + (Math.floor(i / cfg.cols) + 0.5) * chh;
        const r = cell.result;
        const state_ = !r ? "ok" : r.response === "suspended" ? "stop" : r.response === "restricted" ? "slow" : "ok";
        ctx.strokeStyle = state_ === "stop" ? "rgba(230,211,161,0.8)" : C.hair;
        ctx.strokeRect(cx - size / 2, cy - size / 2, size, size);
        if (state_ === "stop") {
          ctx.fillStyle = "rgba(230,211,161,0.14)";
          ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
          glowDot(ctx, cx, cy, 2.5, C.gold, 10);
        } else {
          const speed = state_ === "slow" ? 0.6 : 1.8;
          cell.phase += dt * speed;
          const ax = cx + Math.cos(cell.phase) * size * 0.28;
          const ay = cy + Math.sin(cell.phase) * size * 0.28;
          line(ctx, cx, cy, ax, ay, state_ === "slow" ? C.white : "rgba(244,246,251,0.55)", 1.2);
          glowDot(ctx, ax, ay, 1.8, state_ === "slow" ? C.white : C.accent, state_ === "slow" ? 6 : 8);
        }
      });
      text(ctx, `${state.cells.length} cells`, left, 32, { size: 13, color: C.silver });
      text(ctx, `${perSecond.toLocaleString()} evaluations per second`, left, 52, { size: 22, weight: 200, color: C.white });
      text(ctx, `${stopped} stopped · ${restricted} restricted · ${state.total.toLocaleString()} evaluations so far`, right, 52, { size: 13, color: C.silver, align: "right" });
    },
  };

  // ------------------------------------------------------------- Humanoid floor
  // A humanoid seen from the side, carrying a tote down an aisle. Body lean
  // follows balance margin, the dot under its feet is the zero moment point,
  // hip and knee rings follow joint torque, the cone from its head fades with
  // perception latency, and the person ahead stands at the measured distance.
  const humanoid = {
    init(state) { state.gait = 0; state.scroll = 0; state.flash = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, omitted, dt, profile } = frame;
      const p = pace(frame);
      state.gait += dt * 5.2 * p;
      state.scroll += dt * 60 * p;
      const floorY = h * 0.78;
      const m = Math.min(w / 7.4, h / 4.1); // pixels per meter
      const rx = w * 0.3;

      // Racks behind the aisle.
      ctx.save();
      for (let i = -1; i < 8; i++) {
        const x = ((i * 190 - state.scroll) % (190 * 8) + 190 * 8) % (190 * 8) - 190;
        ctx.strokeStyle = C.hair; ctx.lineWidth = 1;
        ctx.strokeRect(x, floorY - m * 2.2, 150, m * 2.2);
        for (let k = 1; k < 4; k++) line(ctx, x, floorY - m * 2.2 * k / 4, x + 150, floorY - m * 2.2 * k / 4, C.hair, 1);
      }
      ctx.restore();
      line(ctx, 0, floorY, w, floorY, C.hairStrong, 1);

      // Distance markers from the profile.
      const dist = num(values, "human_distance_m", 2.4);
      const sig = (name) => profile && profile.scoredSignals ? profile.scoredSignals.find((x) => x.signal === name) : null;
      const dSig = sig("human_distance_m");
      const hard = profile && profile.hardRules ? profile.hardRules.find((r) => r.fieldName === "human_distance_m") : null;
      const marks = [];
      if (dSig) marks.push([dSig.warningThreshold, `${dSig.warningThreshold} m warning`], [dSig.criticalThreshold, `${dSig.criticalThreshold} m stop`]);
      if (hard && typeof hard.value === "number") marks.push([hard.value, `${hard.value} m exclusion`]);
      marks.sort((a, b) => a[0] - b[0]);
      marks.forEach(([d, label], i) => {
        const x = rx + d * m;
        line(ctx, x, floorY - m * 2.0, x, floorY + 8 + i * 15, C.hairStrong, 1, [3, 5]);
        text(ctx, label, x + 4, floorY + 20 + i * 15, { size: 11, color: C.silverDim });
      });

      // The person.
      const missing = omitted && omitted.has && omitted.has("human_distance_m");
      const px = rx + dist * m;
      const close = dSig && dist < dSig.warningThreshold;
      ctx.save();
      ctx.globalAlpha = missing ? 0.25 : 1;
      ctx.strokeStyle = close ? C.gold : C.white; ctx.lineWidth = 2; ctx.lineCap = "round";
      const pw = Math.sin(frame.t * 3) * 0.12;
      ctx.beginPath(); ctx.arc(px, floorY - m * 1.62, m * 0.11, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, floorY - m * 1.5); ctx.lineTo(px, floorY - m * 0.9);
      ctx.moveTo(px, floorY - m * 0.9); ctx.lineTo(px - m * (0.18 + pw), floorY);
      ctx.moveTo(px, floorY - m * 0.9); ctx.lineTo(px + m * (0.18 + pw), floorY);
      ctx.moveTo(px, floorY - m * 1.38); ctx.lineTo(px - m * 0.22, floorY - m * 1.05);
      ctx.moveTo(px, floorY - m * 1.38); ctx.lineTo(px + m * 0.2, floorY - m * 1.08); ctx.stroke();
      ctx.restore();
      text(ctx, missing ? "no reading" : `${dist.toFixed(2)} m`, px, floorY - m * 1.85, { size: 13, mono: true, color: missing ? C.silverDim : close ? C.gold : C.white, align: "center" });

      // Perception cone, fading with latency.
      const lat = num(values, "perception_latency_ms", 45);
      const latSig = sig("perception_latency_ms");
      const stale = Math.min(1, Math.max(0, (lat - 40) / ((latSig ? latSig.criticalThreshold : 180) - 40)));
      const headX = rx + m * 0.05, headY = floorY - m * 1.62;
      const cone = ctx.createLinearGradient(headX, headY, headX + m * 2.6, headY);
      cone.addColorStop(0, `rgba(79,168,232,${0.28 * (1 - stale) + 0.04})`); cone.addColorStop(1, "rgba(79,168,232,0)");
      ctx.fillStyle = cone;
      ctx.beginPath(); ctx.moveTo(headX, headY); ctx.lineTo(headX + m * 2.6, headY - m * 0.55); ctx.lineTo(headX + m * 2.6, headY + m * 0.9); ctx.closePath(); ctx.fill();

      // The humanoid. Lean grows as balance margin shrinks.
      const bal = num(values, "balance_margin_m", 0.075);
      const lean = Math.max(-0.05, Math.min(0.42, (0.075 - bal) / 0.075 * 0.32));
      const torque = num(values, "joint_torque_ratio", 0.56);
      const tSig = sig("joint_torque_ratio");
      const tColor = torque >= 1 ? "#f2b48a" : tSig && torque >= tSig.warningThreshold ? C.gold : C.accent;
      const g = state.gait, step = Math.sin(g) * 0.22 * (p > 0 ? 1 : 0);
      const hipX = rx, hipY = floorY - m * 0.95;
      const legs = [[step, 0], [-step, Math.PI]];
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const [sw, ph] of legs) {
        const lift = Math.max(0, Math.sin(g + ph)) * 0.08 * (p > 0 ? 1 : 0);
        const kx = hipX + m * (sw * 0.6 + 0.04), ky = hipY + m * (0.47 - lift);
        const fx = hipX + m * sw, fy = floorY - m * lift;
        ctx.strokeStyle = "rgba(244,246,251,0.85)"; ctx.lineWidth = m * 0.07;
        ctx.beginPath(); ctx.moveTo(hipX, hipY); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.strokeStyle = tColor; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(kx, ky, m * 0.055, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.translate(hipX, hipY); ctx.rotate(lean);
      ctx.strokeStyle = C.white; ctx.lineWidth = m * 0.1;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -m * 0.6); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = tColor; ctx.beginPath(); ctx.arc(0, 0, m * 0.07, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = C.white; ctx.beginPath(); ctx.arc(0, -m * 0.75, m * 0.12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#0a0e27"; ctx.fillRect(m * 0.02, -m * 0.79, m * 0.09, m * 0.04);
      // Arms and the tote, sized by payload.
      const load = num(values, "payload_kg", 8);
      const tw = m * (0.26 + load * 0.012), th = m * (0.16 + load * 0.006);
      ctx.strokeStyle = "rgba(244,246,251,0.85)"; ctx.lineWidth = m * 0.055;
      ctx.beginPath(); ctx.moveTo(0, -m * 0.52); ctx.lineTo(m * 0.2, -m * 0.32); ctx.lineTo(m * 0.32, -m * 0.38); ctx.stroke();
      ctx.fillStyle = load >= 20 ? "rgba(242,180,138,0.25)" : "rgba(230,211,161,0.14)"; ctx.strokeStyle = load >= 15 ? C.gold : C.hairStrong; ctx.lineWidth = 1.5;
      ctx.fillRect(m * 0.3, -m * 0.38 - th / 2, tw, th); ctx.strokeRect(m * 0.3, -m * 0.38 - th / 2, tw, th);
      ctx.restore();

      // Contact force flashes at the hands.
      const force = num(values, "contact_force_N", 12);
      const fSig = sig("contact_force_N");
      if (fSig && force >= fSig.warningThreshold) state.flash = 1;
      state.flash = Math.max(0, state.flash - dt * 2.5);
      if (state.flash > 0) glowDot(ctx, hipX + m * 0.45, hipY - m * 0.4, 4 + state.flash * 6, force >= (fSig ? fSig.criticalThreshold : 110) ? "#f2b48a" : C.gold, 18 * state.flash);

      // Support polygon and zero moment point under the feet.
      const half = m * 0.16;
      const zx = rx + half - Math.max(0, Math.min(1, bal / 0.1)) * half * 1.6;
      line(ctx, rx - half, floorY + 10, rx + half, floorY + 10, C.hairStrong, 3);
      const bSig = sig("balance_margin_m");
      glowDot(ctx, zx, floorY + 10, 3.5, bSig && bal <= bSig.criticalThreshold ? "#f2b48a" : bSig && bal <= bSig.warningThreshold ? C.gold : C.accent, 8);

      // Readout.
      const conf = num(values, "policy_confidence", 0.9);
      const rows = [
        ["Balance margin", `${(bal * 100).toFixed(1)} cm`],
        ["Joint torque", `${Math.round(torque * 100)}% of rated`],
        ["Payload", `${load.toFixed(1)} kg`],
        ["Policy confidence", conf.toFixed(2)],
        ["Perception latency", `${Math.round(lat)} ms`],
        ["Contact force", `${Math.round(force)} N`],
      ];
      rows.forEach(([k, v], i) => {
        text(ctx, k, 24, 34 + i * 20, { size: 12, color: C.silverDim });
        text(ctx, v, 170, 34 + i * 20, { size: 12, mono: true, color: C.white });
      });
      if (values.teleop_link_ok === false) text(ctx, "Teleoperation link down", w - 24, 34, { size: 13, color: C.gold, align: "right" });
      if (values.in_restricted_zone === true) text(ctx, "Restricted zone", w - 24, 54, { size: 13, color: C.gold, align: "right" });
    },
  };

  const HARM = "#f2b48a";
  function sigOf(profile, name) { return profile && profile.scoredSignals ? profile.scoredSignals.find((x) => x.signal === name) : null; }
  // Color for a reading against its limits: blue inside, white in warning,
  // gold in critical.
  function tone(profile, name, v) {
    const s = sigOf(profile, name);
    if (!s || typeof v !== "number") return C.accent;
    const hi = s.direction === "higher_is_unsafe";
    if (hi ? v >= s.criticalThreshold : v <= s.criticalThreshold) return C.gold;
    if (hi ? v >= s.warningThreshold : v <= s.warningThreshold) return C.white;
    return C.accent;
  }
  function readout(ctx, rows, x, y, profile, values) {
    rows.forEach(([label, name, fmt], i) => {
      const v = values[name];
      text(ctx, label, x, y + i * 20, { size: 12, color: C.silverDim });
      text(ctx, typeof v === "number" ? fmt(v) : "no reading", x + 150, y + i * 20, { size: 12, mono: true, color: typeof v === "number" ? tone(profile, name, v) : C.silverDim });
    });
  }
  function rngScene(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ------------------------------------------------------------- Agent swarm
  // An orchestrator at the center, agents on rings by delegation depth,
  // messages as sparks along the links. Drifting agents leave their orbit.
  const swarm = {
    init(state) { state.r = rngScene(7); state.sparks = []; state.angle = 0; state.agents = []; state.acc = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, dt, profile } = frame;
      const p = pace(frame);
      const cx = w * 0.56, cy = h * 0.53;
      const R = Math.min(w * 0.36, h * 0.42);
      const n = Math.max(1, Math.min(180, Math.round(num(values, "active_agents", 12))));
      const depth = Math.max(1, Math.min(12, Math.round(num(values, "delegation_depth", 2))));
      const drift = num(values, "goal_drift_score", 0.08);
      const msgs = num(values, "message_rate_per_s", 60);
      state.angle += dt * 0.12 * p;
      while (state.agents.length < n) state.agents.push({ a: state.r() * Math.PI * 2, j: state.r(), out: 0 });
      if (state.agents.length > n) state.agents.length = n;
      const ring = (k) => R * (0.22 + 0.78 * (k / depth));
      const pos = state.agents.map((ag, i) => {
        const k = 1 + (i % depth);
        const rogue = ag.j < drift * 0.9;
        ag.out += ((rogue ? 1 : 0) - ag.out) * Math.min(1, dt * 0.8);
        const r = ring(k) + ag.out * R * 0.18;
        const a = ag.a + state.angle * (1 + (k % 3) * 0.2) + ag.out * 0.6;
        return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.78, k, rogue };
      });
      // Rings and links.
      for (let k = 1; k <= depth; k++) { ctx.strokeStyle = C.hair; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(cx, cy, ring(k), ring(k) * 0.78, 0, 0, Math.PI * 2); ctx.stroke(); }
      const parent = (i) => { const k = pos[i].k; if (k === 1) return { x: cx, y: cy }; let best = null, bd = Infinity; for (let j = 0; j < pos.length; j++) if (pos[j].k === k - 1) { const d = Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y); if (d < bd) { bd = d; best = pos[j]; } } return best || { x: cx, y: cy }; };
      const parents = pos.map((_, i) => parent(i));
      ctx.lineWidth = 1;
      pos.forEach((q, i) => { ctx.strokeStyle = q.rogue ? "rgba(230,211,161,0.25)" : "rgba(214,222,238,0.08)"; ctx.beginPath(); ctx.moveTo(parents[i].x, parents[i].y); ctx.lineTo(q.x, q.y); ctx.stroke(); });
      // Messages travel along links at a rate set by the message reading.
      state.acc += dt * p * Math.min(260, msgs * 0.35);
      while (state.acc >= 1 && pos.length) { state.acc -= 1; const i = Math.floor(state.r() * pos.length); state.sparks.push({ i, t: 0, up: state.r() < 0.5 }); }
      if (state.sparks.length > 600) state.sparks.splice(0, state.sparks.length - 600);
      const hot = tone(profile, "message_rate_per_s", msgs) !== C.accent;
      for (let s = state.sparks.length - 1; s >= 0; s--) {
        const sp = state.sparks[s];
        sp.t += dt * 1.6 * Math.max(p, 0.001);
        if (sp.t >= 1 || !pos[sp.i]) { state.sparks.splice(s, 1); continue; }
        const a = sp.up ? pos[sp.i] : parents[sp.i], b = sp.up ? parents[sp.i] : pos[sp.i];
        const x = a.x + (b.x - a.x) * sp.t, y = a.y + (b.y - a.y) * sp.t;
        ctx.fillStyle = hot ? C.gold : C.accent; ctx.globalAlpha = 0.85; ctx.fillRect(x - 1, y - 1, 2, 2); ctx.globalAlpha = 1;
      }
      // Agents.
      pos.forEach((q) => { ctx.fillStyle = q.rogue ? C.gold : frame.halted ? C.silverDim : C.white; ctx.fillRect(q.x - 3, q.y - 3, 6, 6); if (q.rogue) { ctx.strokeStyle = "rgba(230,211,161,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.stroke(); } });
      glowDot(ctx, cx, cy, 7, frame.halted ? C.silverDim : C.white, 16);
      text(ctx, "Orchestrator", cx, cy + 24, { size: 11, color: C.silverDim, align: "center" });
      if (values.credential_shared === true && pos.length > 4) { line(ctx, pos[1].x, pos[1].y, pos[4].x, pos[4].y, C.gold, 2); text(ctx, "Shared credential", (pos[1].x + pos[4].x) / 2, (pos[1].y + pos[4].y) / 2 - 8, { size: 12, color: C.gold, align: "center" }); }
      if (values.agent_outside_allowlist === true) { const x = cx + R * 1.12, y = cy - R * 0.5; glowDot(ctx, x, y, 5, HARM, 14); line(ctx, x, y, cx + ring(1), cy, HARM, 1, [4, 4]); text(ctx, "Unvetted agent", x, y - 12, { size: 12, color: HARM, align: "center" }); }
      if (values.data_egress_unapproved === true) { line(ctx, cx, cy, w - 12, cy - R * 0.9, HARM, 2, [6, 4]); text(ctx, "Unapproved destination", w - 16, cy - R * 0.9 - 10, { size: 12, color: HARM, align: "right" }); }
      readout(ctx, [["Active agents", "active_agents", (v) => String(Math.round(v))], ["Spawn rate", "spawn_rate_per_min", (v) => `${v.toFixed(1)} a min`], ["Delegation depth", "delegation_depth", (v) => `${v.toFixed(1)} levels`], ["Message rate", "message_rate_per_s", (v) => `${Math.round(v)} a s`], ["Spend", "spend_usd_per_min", (v) => `$${v.toFixed(2)} a min`], ["Goal drift", "goal_drift_score", (v) => v.toFixed(2)], ["Consensus", "consensus_agreement", (v) => v.toFixed(2)]], 24, 34, profile, values);
    },
  };

  // ------------------------------------------------------------- Surgical field
  // The endoscope view. The vessel rises and falls with the patient's breath,
  // the margins come from the profile, the tip ring follows force, a ghost
  // tip shows tracking error, a ghost vessel shows registration error, and
  // video latency makes the view stutter.
  const surgical = {
    init(state) { state.shown = null; state.shownAt = -1; state.r = rngScene(11); state.spots = null; },
    draw(frame, state) {
      const { ctx, w, h, values, profile, t } = frame;
      const lat = num(values, "video_latency_ms", 60);
      // The view refreshes only as often as the video arrives.
      if (!state.shown || t - state.shownAt >= Math.max(0.033, lat / 1000)) { state.shown = Object.assign({}, values); state.shownAt = t; }
      const v = state.shown;
      const cx = w * 0.36, cy = h * 0.52, R = Math.min(w * 0.3, h * 0.44);
      const px = R / 9; // pixels per millimeter
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
      const bg = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.25, R * 0.1, cx, cy, R);
      bg.addColorStop(0, "#4a3340"); bg.addColorStop(0.7, "#2a1c26"); bg.addColorStop(1, "#0d0a12");
      ctx.fillStyle = bg; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
      if (!state.spots) { state.spots = []; for (let i = 0; i < 40; i++) state.spots.push([state.r() * 2 - 1, state.r() * 2 - 1, 4 + state.r() * 18]); }
      for (const [sx, sy, sr] of state.spots) { ctx.fillStyle = "rgba(255,220,230,0.035)"; ctx.beginPath(); ctx.arc(cx + sx * R, cy + sy * R, sr, 0, Math.PI * 2); ctx.fill(); }
      if (v.camera_feed_ok === false) { ctx.fillStyle = "#05060c"; ctx.fillRect(cx - R, cy - R, R * 2, R * 2); ctx.restore(); text(ctx, "No video", cx, cy, { size: 22, weight: 300, color: C.gold, align: "center" }); this.panel(frame); return; }
      const dist = num(v, "critical_structure_distance_mm", 6);
      const tipX = cx, tipY = cy - R * 0.08;
      const vesselY = tipY + dist * px;
      const curve = (dy, color, width, dash) => { ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(cx - R, vesselY + dy + R * 0.12); ctx.bezierCurveTo(cx - R * 0.4, vesselY + dy - R * 0.06, cx + R * 0.3, vesselY + dy + R * 0.02, cx + R, vesselY + dy - R * 0.14); ctx.stroke(); ctx.restore(); };
      // Registration error as a ghost of where the images place the vessel.
      const reg = num(v, "registration_error_mm", 0.8);
      curve(-reg * px, "rgba(244,246,251,0.07)", px * 1.6);
      // The vessel and its margins from the profile.
      curve(0, "#7d2f3a", px * 1.6); curve(-px * 0.35, "rgba(255,170,170,0.25)", px * 0.3);
      const s = sigOf(profile, "critical_structure_distance_mm");
      if (s) {
        curve(-s.warningThreshold * px, "rgba(244,246,251,0.35)", 1, [4, 6]);
        curve(-s.criticalThreshold * px, "rgba(230,211,161,0.7)", 1.2, [4, 4]);
      }
      // Instrument shaft, tip, force ring, tracking ghost.
      const trk = num(v, "tracking_error_mm", 0.3);
      line(ctx, cx + R, cy - R * 0.9, tipX + 6, tipY - 6, "rgba(200,205,215,0.85)", px * 0.9);
      ctx.strokeStyle = "rgba(244,246,251,0.35)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(tipX - trk * px, tipY - trk * px * 0.4, 5, 0, Math.PI * 2); ctx.stroke();
      const force = num(v, "tool_tip_force_N", 0.8);
      ctx.strokeStyle = tone(profile, "tool_tip_force_N", force); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(tipX, tipY, 6 + force * 4, 0, Math.PI * 2); ctx.stroke();
      glowDot(ctx, tipX, tipY, 4, C.white, 10);
      ctx.restore();
      // Rim, scale and the measured gap.
      ctx.strokeStyle = C.hairStrong; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      line(ctx, tipX + 26, tipY, tipX + 26, Math.min(vesselY, cy + R), tone(profile, "critical_structure_distance_mm", dist), 1);
      text(ctx, `${dist.toFixed(2)} mm`, tipX + 32, (tipY + Math.min(vesselY, cy + R)) / 2 + 4, { size: 13, mono: true, color: tone(profile, "critical_structure_distance_mm", dist) });
      // Margin labels sit outside the scope where each margin meets the rim.
      if (s) { text(ctx, `${s.criticalThreshold} mm stop`, cx + R + 8, vesselY - s.criticalThreshold * px - R * 0.14 + 4, { size: 11, color: C.gold }); text(ctx, `${s.warningThreshold} mm warning`, cx + R + 8, vesselY - s.warningThreshold * px - R * 0.14 + 4, { size: 11, color: C.silverDim }); }
      this.panel(frame);
    },
    panel(frame) {
      const { ctx, w, values, profile } = frame;
      const x = w * 0.36 + Math.min(w * 0.3, frame.h * 0.44) + 110;
      readout(ctx, [["Distance to vessel", "critical_structure_distance_mm", (v) => `${v.toFixed(2)} mm`], ["Tip force", "tool_tip_force_N", (v) => `${v.toFixed(2)} N`], ["Tracking error", "tracking_error_mm", (v) => `${v.toFixed(2)} mm`], ["Registration error", "registration_error_mm", (v) => `${v.toFixed(2)} mm`], ["Video latency", "video_latency_ms", (v) => `${Math.round(v)} ms`], ["Assist confidence", "autonomy_confidence", (v) => v.toFixed(2)]], Math.min(x, w - 260), 40, profile, values);
      const flags = [[values.surgeon_hands_on !== false, "Surgeon at console", "Surgeon's hands off"], [values.camera_feed_ok !== false, "Camera feed", "Camera feed lost"]];
      flags.forEach(([okv, a, b], i) => text(ctx, okv ? a : b, Math.min(x, w - 260), 190 + i * 20, { size: 12, color: okv ? C.silver : C.gold }));
    },
  };

  // ------------------------------------------------------------- Trading desk
  // Orders flow from the agent through the pre-trade risk gate to the market.
  // Each order sits at its distance from the reference price, the collar
  // comes from the profile, and the equity line is the drawdown history.
  const desk = {
    init(state) { state.r = rngScene(5); state.orders = []; state.acc = 0; state.eq = []; state.feed = 0; },
    draw(frame, state) {
      const { ctx, w, h, values, dt, profile } = frame;
      const p = pace(frame);
      const mid = h * 0.5, gateX = w * 0.58, left = 28, right = w - 28;
      const dev = num(values, "price_deviation_bps", 4);
      const rate = num(values, "order_rate_per_s", 12);
      const s = sigOf(profile, "price_deviation_bps");
      const scale = (h * 0.16) / 300; // pixels per basis point
      const span = 300 * scale + 14;
      // Reference price and the collar.
      line(ctx, left, mid, right, mid, C.hairStrong, 1);
      text(ctx, "Reference price", left, mid - 8, { size: 11, color: C.silverDim });
      if (s) for (const [lim, col, lab] of [[s.warningThreshold, "rgba(244,246,251,0.3)", "warning"], [s.criticalThreshold, "rgba(230,211,161,0.7)", "collar"]]) {
        for (const sign of [-1, 1]) line(ctx, left, mid + sign * lim * scale, right, mid + sign * lim * scale, col, 1, [4, 6]);
        text(ctx, `${lim} bps ${lab}`, right, mid - lim * scale - 6, { size: 11, color: col, align: "right" });
      }
      line(ctx, gateX, mid - span, gateX, mid + span, frame.halted ? C.gold : C.hairStrong, frame.halted ? 2 : 1);
      text(ctx, frame.halted ? "Risk gate closed" : "Risk gate", gateX, mid - span - 8, { size: 11, color: frame.halted ? C.gold : C.silverDim, align: "center" });
      text(ctx, "Market", right, mid + span + 16, { size: 11, color: C.silverDim, align: "right" });
      text(ctx, "Agent", left, mid + span + 16, { size: 11, color: C.silverDim });
      // Orders.
      state.acc += dt * Math.min(60, rate * 0.4) * (frame.halted ? 0.3 : 1);
      while (state.acc >= 1) { state.acc -= 1; const sign = state.r() < 0.5 ? -1 : 1; state.orders.push({ x: left, dev: sign * Math.max(0, dev + (state.r() - 0.5) * 6), buy: sign > 0 }); }
      if (state.orders.length > 400) state.orders.splice(0, state.orders.length - 400);
      for (let i = state.orders.length - 1; i >= 0; i--) {
        const o = state.orders[i];
        const speed = (right - left) / 2.2;
        const nx = o.x + speed * dt * (p > 0 ? 1 : 0.6);
        if (frame.halted && o.x < gateX && nx >= gateX) { state.orders.splice(i, 1); continue; }
        o.x = nx;
        if (o.x > right) { state.orders.splice(i, 1); continue; }
        const y = mid - Math.max(-span + 4, Math.min(span - 4, o.dev * scale));
        const outside = Math.abs(o.dev) >= 200;
        ctx.fillStyle = outside ? HARM : Math.abs(o.dev) >= (s ? s.warningThreshold : 100) ? C.white : C.accent;
        ctx.fillRect(o.x - 2, y - 2, 4, 4);
      }
      // Equity from drawdown history.
      const dd = num(values, "intraday_drawdown_pct", 0.3);
      state.eq.push(dd); if (state.eq.length > 600) state.eq.shift();
      const ey0 = h - 22, eh = h * 0.12;
      const dSig = sigOf(profile, "intraday_drawdown_pct");
      text(ctx, "Equity against the day's high", left, ey0 - eh - 10, { size: 11, color: C.silverDim });
      line(ctx, left, ey0 - eh, right, ey0 - eh, C.hairStrong, 1);
      if (dSig) line(ctx, left, ey0 - eh + (dSig.criticalThreshold / 4) * eh, right, ey0 - eh + (dSig.criticalThreshold / 4) * eh, "rgba(230,211,161,0.6)", 1, [4, 6]);
      ctx.strokeStyle = tone(profile, "intraday_drawdown_pct", dd); ctx.lineWidth = 1.5; ctx.beginPath();
      state.eq.forEach((d, i) => { const x = left + (i / 599) * (right - left), y = ey0 - eh + Math.min(1.2, d / 4) * eh; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      // Exposure bar.
      const ex = num(values, "gross_exposure_ratio", 0.45), eSig = sigOf(profile, "gross_exposure_ratio");
      const bx = w * 0.62, bw = right - bx, by = 40;
      ctx.fillStyle = "rgba(214,222,238,0.06)"; ctx.fillRect(bx, by, bw, 8);
      ctx.fillStyle = tone(profile, "gross_exposure_ratio", ex); ctx.fillRect(bx, by, Math.min(1.2, ex) / 1.2 * bw, 8);
      if (eSig) line(ctx, bx + eSig.criticalThreshold / 1.2 * bw, by - 4, bx + eSig.criticalThreshold / 1.2 * bw, by + 12, C.gold, 1);
      line(ctx, bx + bw / 1.2, by - 4, bx + bw / 1.2, by + 12, HARM, 1);
      text(ctx, `Gross exposure ${Math.round(ex * 100)}% of limit`, bx, by - 8, { size: 11, color: C.silverDim });
      readout(ctx, [["Order rate", "order_rate_per_s", (v) => `${Math.round(v)} a s`], ["Price deviation", "price_deviation_bps", (v) => `${Math.round(v)} bps`], ["Drawdown", "intraday_drawdown_pct", (v) => `${v.toFixed(2)}%`], ["Market data age", "market_data_age_ms", (v) => `${Math.round(v)} ms`], ["Cancel to fill", "cancel_to_fill_ratio", (v) => v.toFixed(1)], ["Model confidence", "model_confidence", (v) => v.toFixed(2)]], 24, 34, profile, values);
      if (values.restricted_list_hit === true) text(ctx, "Restricted security", right, 80, { size: 13, color: C.gold, align: "right" });
      if (values.credit_check_ok === false) text(ctx, "Credit check failed", right, 100, { size: 13, color: C.gold, align: "right" });
    },
  };

  const api = {
    "agent-swarm": swarm,
    "surgical-field": surgical,
    "trading-desk": desk,
    "humanoid-floor": humanoid,
    fleet: fleet,
    "robot-cell": robotCell,
    "machine-line": machineLine,
    "data-flow": dataFlow,
    "agent-trace": agentTrace,
    instrument: instrument,
  };
  root.TRPScenes = api;
})(typeof window !== "undefined" ? window : globalThis);
