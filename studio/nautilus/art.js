/**
 * Nautilus art. Everything is drawn in code on a 1280 by 720 world.
 */
(function (root) {
  "use strict";

  const SKINS = {
    brass:     { name: "Brass", light: "#f0d9a0", mid: "#c49a55", dark: "#5e4421", band: "#3d2b14", glass: "#ffd99a" },
    copper:    { name: "Copper", light: "#f2b48a", mid: "#b8693d", dark: "#4f2814", band: "#341a0c", glass: "#ffc79a" },
    verdigris: { name: "Verdigris", light: "#a9e0d0", mid: "#4f9a8a", dark: "#1d4740", band: "#132f2a", glass: "#d9fff2" },
    silver:    { name: "Abyss Silver", light: "#eef2fa", mid: "#9aa6bd", dark: "#3a4357", band: "#232a38", glass: "#cfe2ff" },
    gilded:    { name: "Gilded", light: "#fff3c4", mid: "#e2b84f", dark: "#7a5a12", band: "#4a3507", glass: "#fff1c9" },
  };

  const PENNANTS = {
    none:  { name: "No pennant" },
    free:  { name: "Free Fleet", a: "#e6d3a1", b: "#0d1a33", cost: 30 },
    open:  { name: "Open Rules", a: "#9fd0ff", b: "#0d1a33", cost: 60 },
    crew:  { name: "Crew Roll", a: "#f4f6fb", b: "#6e522a", cost: 0, join: true },
    gear:  { name: "Jolly Gear", a: "#f0d9a0", b: "#14181f", cost: 120 },
    scholar: { name: "Scholar", a: "#5fb3a0", b: "#0d1a33", cost: 0, exam: true },
  };

  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Parallax layers are drawn once to offscreen canvases and tiled.
  function makeLayer(width, height, draw) {
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    draw(c.getContext("2d"), width, height);
    return c;
  }

  function buildLayers(W, H, WATER) {
    const r = rng(1870);
    const far = makeLayer(W * 2, H, (g, w, h) => {
      g.fillStyle = "rgba(20, 44, 78, 0.55)";
      let x = 0;
      while (x < w) {
        const bw = 40 + r() * 110, bh = 120 + r() * 260, base = h - 60;
        g.fillRect(x, base - bh, bw, bh);
        if (r() < 0.4) { g.beginPath(); g.arc(x + bw / 2, base - bh, bw / 2, Math.PI, 0); g.fill(); }
        if (r() < 0.35) g.fillRect(x + bw / 2 - 2, base - bh - 60 - r() * 60, 4, 70);
        // broken windows
        g.save(); g.globalCompositeOperation = "destination-out";
        for (let wy = base - bh + 14; wy < base - 10; wy += 22) for (let wx = x + 8; wx < x + bw - 10; wx += 16) if (r() < 0.5) g.fillRect(wx, wy, 6, 9);
        g.restore();
        x += bw + 10 + r() * 60;
      }
    });
    const near = makeLayer(W * 2, H, (g, w, h) => {
      let x = 0;
      while (x < w) {
        const kind = r();
        g.fillStyle = "rgba(9, 24, 46, 0.9)";
        if (kind < 0.35) {
          // drowned arch
          const aw = 120 + r() * 120, ah = 90 + r() * 120, base = h - 30;
          g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - ah); g.arc(x + aw / 2, base - ah, aw / 2, Math.PI, 0); g.lineTo(x + aw, base);
          g.lineTo(x + aw - 22, base); g.lineTo(x + aw - 22, base - ah); g.arc(x + aw / 2, base - ah, aw / 2 - 22, 0, Math.PI, true); g.lineTo(x + 22, base); g.closePath(); g.fill();
          x += aw + 40;
        } else if (kind < 0.6) {
          // great sunken gear
          const R = 50 + r() * 50, cx = x + R, cy = h - 40 - r() * 30;
          g.beginPath();
          for (let i = 0; i < 28; i++) {
            const a = (i / 28) * Math.PI * 2, rr = i % 2 ? R : R + 12;
            g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
          }
          g.closePath(); g.fill();
          g.save(); g.globalCompositeOperation = "destination-out"; g.beginPath(); g.arc(cx, cy, R * 0.45, 0, Math.PI * 2); g.fill(); g.restore();
          x += R * 2 + 50;
        } else {
          // server stack ruin with dead lights
          const sw = 50 + r() * 40, sh = 100 + r() * 140, base = h - 26;
          g.fillRect(x, base - sh, sw, sh);
          g.fillStyle = "rgba(120, 160, 220, 0.12)";
          for (let yy = base - sh + 10; yy < base - 8; yy += 12) g.fillRect(x + 6, yy, sw - 12, 2);
          x += sw + 50 + r() * 50;
        }
      }
    });
    const clouds = makeLayer(W * 2, WATER, (g, w, h) => {
      for (let i = 0; i < 40; i++) {
        const cx = r() * w, cy = 20 + r() * (h - 50), rx = 80 + r() * 200, ry = 10 + r() * 22;
        const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rx);
        grad.addColorStop(0, "rgba(154, 163, 181, 0.16)");
        grad.addColorStop(1, "rgba(154, 163, 181, 0)");
        g.fillStyle = grad;
        g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
      }
    });
    return { far, near, clouds };
  }

  function tile(ctx, layer, offset, y) {
    const w = layer.width;
    const x = -((offset % w) + w) % w;
    ctx.drawImage(layer, x, y || 0);
    ctx.drawImage(layer, x + w, y || 0);
  }

  function background(ctx, s) {
    const { W, H, WATER, t, dist, layers, captured, flash } = s;
    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, WATER);
    sky.addColorStop(0, captured ? "#140c24" : "#060918");
    sky.addColorStop(1, captured ? "#2a1c44" : "#1b2547");
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, WATER);
    tile(ctx, layers.clouds, dist * 0.08 + t * 6, 0);
    if (flash > 0) { ctx.fillStyle = `rgba(210, 220, 255, ${flash * 0.35})`; ctx.fillRect(0, 0, W, WATER); }
    // sea
    const sea = ctx.createLinearGradient(0, WATER, 0, H);
    sea.addColorStop(0, captured ? "#1d2050" : "#103059");
    sea.addColorStop(0.45, "#0a1f3e");
    sea.addColorStop(1, "#040b19");
    ctx.fillStyle = sea; ctx.fillRect(0, WATER, W, H - WATER);
    // light shafts
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 6; i++) {
      const x = ((i * 260 - dist * 0.15) % (W + 300) + W + 300) % (W + 300) - 150;
      const a = 0.035 + 0.02 * Math.sin(t * 0.7 + i);
      const g = ctx.createLinearGradient(0, WATER, 0, H);
      g.addColorStop(0, `rgba(170, 205, 255, ${a})`); g.addColorStop(1, "rgba(170, 205, 255, 0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x, WATER); ctx.lineTo(x + 70, WATER); ctx.lineTo(x + 260, H); ctx.lineTo(x + 120, H); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // ruins
    tile(ctx, layers.far, dist * 0.25, 0);
    tile(ctx, layers.near, dist * 0.55, 0);
    // seabed
    ctx.fillStyle = "#040a16";
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 40) ctx.lineTo(x, H - 22 - 10 * Math.sin((x + dist * 0.9) * 0.013) - 6 * Math.sin((x + dist * 0.9) * 0.041));
    ctx.lineTo(W, H); ctx.fill();
    // kelp
    ctx.strokeStyle = "rgba(60, 110, 120, 0.45)"; ctx.lineWidth = 3;
    for (let i = 0; i < 14; i++) {
      const bx = ((i * 97 - dist * 0.9) % (W + 100) + W + 100) % (W + 100) - 50;
      const hgt = 40 + (i * 37) % 60;
      ctx.beginPath(); ctx.moveTo(bx, H - 18);
      for (let k = 1; k <= 6; k++) ctx.lineTo(bx + Math.sin(t * 1.4 + i + k * 0.6) * k * 2.2, H - 18 - (hgt * k) / 6);
      ctx.stroke();
    }
    // surface
    ctx.strokeStyle = "rgba(190, 215, 255, 0.45)"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 16) ctx.lineTo(x, WATER + Math.sin(x * 0.03 + t * 2) * 3 + Math.sin(x * 0.011 - t) * 2);
    ctx.stroke();
  }

  // Sea and weather dressing for a chapter, drawn over the background and
  // under the ship. Night darkens everything outside the lantern.
  function sea(ctx, v, W, H, WATER, t) {
    const name = v.chapter ? v.chapter.sea : "open";
    const weather = v.chapter ? v.chapter.weather : "clear";
    const scroll = v.dist;
    if (name === "kelp") {
      ctx.strokeStyle = "rgba(40, 110, 90, 0.75)"; ctx.lineWidth = 6;
      for (let i = 0; i < 40; i++) {
        const bx = ((i * 41 - scroll * 0.9) % (W + 100) + W + 100) % (W + 100) - 50;
        const hgt = 260 + (i * 53) % 220;
        ctx.beginPath(); ctx.moveTo(bx, H - 18);
        for (let k = 1; k <= 8; k++) ctx.lineTo(bx + Math.sin(t * 1.1 + i + k * 0.5) * k * 3, H - 18 - (hgt * k) / 8);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(10, 40, 30, 0.25)"; ctx.fillRect(0, WATER, W, H - WATER);
    }
    if (name === "reef") {
      ctx.fillStyle = "#8a7a5a";
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 30) ctx.lineTo(x, v.depthMax + 60 - 14 * Math.sin((x + scroll * 0.9) * 0.02));
      ctx.lineTo(W, H); ctx.fill();
      const corals = ["#d66a5a", "#e8a04a", "#9a5ad6", "#5ad6c4"];
      for (let i = 0; i < 24; i++) { const cx = ((i * 97 - scroll * 0.9) % (W + 120) + W + 120) % (W + 120) - 60; ctx.fillStyle = corals[i % 4]; for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(cx + k * 12 - 12, v.depthMax + 56 - k * 10, 10 + (i + k) % 7, 0, Math.PI * 2); ctx.fill(); } }
      ctx.fillStyle = "rgba(120, 200, 255, 0.08)"; ctx.fillRect(0, WATER, W, H - WATER);
    }
    if (name === "ice") {
      const top = v.depthMin - 40;
      const g = ctx.createLinearGradient(0, WATER, 0, top); g.addColorStop(0, "#dff0ff"); g.addColorStop(1, "#9fc8e8");
      ctx.fillStyle = g; ctx.fillRect(0, WATER, W, top - WATER);
      ctx.fillStyle = "#b8d8f0";
      for (let i = 0; i < 30; i++) { const sx = ((i * 71 - scroll * 0.9) % (W + 100) + W + 100) % (W + 100) - 50; ctx.beginPath(); ctx.moveTo(sx - 16, top); ctx.lineTo(sx + 16, top); ctx.lineTo(sx, top + 30 + (i * 13) % 40); ctx.fill(); }
      ctx.fillStyle = "rgba(5, 15, 35, 0.35)"; ctx.fillRect(0, top, W, H - top);
    }
    if (name === "tunnel") {
      const top = v.depthMin - 30;
      ctx.fillStyle = "#2a2018"; ctx.fillRect(0, WATER, W, top - WATER);
      for (let i = 0; i < 40; i++) { const sx = ((i * 53 - scroll * 0.9) % (W + 100) + W + 100) % (W + 100) - 50; ctx.beginPath(); ctx.moveTo(sx - 14, top); ctx.lineTo(sx + 14, top); ctx.lineTo(sx, top + 26 + (i * 17) % 50); ctx.fill(); }
      ctx.fillStyle = "rgba(40, 30, 20, 0.35)"; ctx.fillRect(0, top, W, H - top);
    }
    if (name === "vortex") {
      ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.strokeStyle = "rgba(160, 200, 255, 0.18)"; ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) { ctx.beginPath(); const rr = 120 + i * 70; for (let a = 0; a < Math.PI * 2; a += 0.15) { const an = a + t * 0.6 + i; ctx.lineTo(1000 + Math.cos(an) * rr * 1.6, 450 + Math.sin(an) * rr * 0.5); } ctx.stroke(); }
      ctx.restore();
    }
    if (weather === "storm") {
      ctx.strokeStyle = "rgba(190, 210, 240, 0.5)"; ctx.lineWidth = 1.5;
      for (let i = 0; i < 120; i++) { const rx = ((i * 37 + t * 420) % (W + 40)) - 20, ry = ((i * 61 + t * 900) % WATER); ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 4, ry + 14); ctx.stroke(); }
      if (Math.floor(t * 7) % 23 === 0) { ctx.fillStyle = "rgba(220, 230, 255, 0.35)"; ctx.fillRect(0, 0, W, WATER); }
    }
    if (weather === "night" || weather === "dark") {
      ctx.save();
      const g = ctx.createRadialGradient(SUB_X_2D + 120, v.sub.y, 60, SUB_X_2D + 120, v.sub.y, 520);
      g.addColorStop(0, "rgba(2, 6, 16, 0)"); g.addColorStop(1, "rgba(2, 6, 16, 0.78)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  const SUB_X_2D = 360;

  function snow(ctx, flakes, W, H, WATER, dt, scroll) {
    ctx.fillStyle = "rgba(200, 220, 255, 0.35)";
    for (const f of flakes) {
      f.x -= (scroll * 0.6 + f.s * 8) * dt; f.y += f.s * 10 * dt;
      if (f.x < 0) f.x += W; if (f.y > H) f.y = WATER + 10;
      ctx.fillRect(f.x, f.y, f.r, f.r);
    }
  }

  function sub(ctx, x, y, o) {
    const sk = SKINS[o.skin] || SKINS.brass;
    ctx.save(); ctx.translate(x, y);
    ctx.rotate(o.tilt || 0);
    if (o.blink) ctx.globalAlpha = 0.45;
    // headlamp
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const lamp = ctx.createRadialGradient(118, 0, 4, 118, 0, 260);
    lamp.addColorStop(0, "rgba(255, 230, 180, 0.28)"); lamp.addColorStop(1, "rgba(255, 230, 180, 0)");
    ctx.fillStyle = lamp; ctx.beginPath(); ctx.moveTo(116, -6); ctx.lineTo(380, -90); ctx.lineTo(380, 90); ctx.lineTo(116, 6); ctx.fill();
    ctx.restore();
    // tail fins
    ctx.fillStyle = sk.dark;
    ctx.beginPath(); ctx.moveTo(-88, -10); ctx.lineTo(-126, -40); ctx.lineTo(-112, -6); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-88, 10); ctx.lineTo(-126, 40); ctx.lineTo(-112, 6); ctx.fill();
    // propeller
    ctx.save(); ctx.translate(-120, 0);
    ctx.fillStyle = sk.mid;
    for (let i = 0; i < 3; i++) {
      const a = o.prop + (i * Math.PI * 2) / 3;
      ctx.beginPath(); ctx.ellipse(0, Math.sin(a) * 14, 4, Math.abs(Math.cos(a)) * 6 + 2, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = sk.dark; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // conning tower
    const tg = ctx.createLinearGradient(0, -66, 0, -26);
    tg.addColorStop(0, sk.light); tg.addColorStop(1, sk.dark);
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.moveTo(-26, -26); ctx.lineTo(-18, -58); ctx.quadraticCurveTo(10, -66, 38, -58); ctx.lineTo(46, -26); ctx.closePath(); ctx.fill();
    ctx.fillStyle = sk.glass;
    for (const wx of [-8, 8, 24]) { ctx.beginPath(); ctx.arc(wx, -44, 3.2, 0, Math.PI * 2); ctx.fill(); }
    // periscope and pennant
    ctx.strokeStyle = sk.dark; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(-6, -60); ctx.lineTo(-6, -88); ctx.lineTo(4, -88); ctx.stroke();
    const pen = PENNANTS[o.pennant];
    if (pen && pen.a) {
      const wave = Math.sin(o.time * 6) * 4;
      ctx.fillStyle = pen.a;
      ctx.beginPath(); ctx.moveTo(-6, -86); ctx.quadraticCurveTo(-28, -84 + wave, -46, -80 + wave); ctx.lineTo(-6, -74); ctx.fill();
      ctx.fillStyle = pen.b; ctx.beginPath(); ctx.arc(-22, -80 + wave * 0.5, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    // harpoon gun
    ctx.fillStyle = sk.band; ctx.fillRect(28, -48, 22, 7);
    // hull
    const hg = ctx.createLinearGradient(0, -36, 0, 36);
    hg.addColorStop(0, sk.light); hg.addColorStop(0.35, sk.mid); hg.addColorStop(1, sk.dark);
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.moveTo(-112, 0);
    ctx.bezierCurveTo(-96, -34, 64, -38, 116, 0);
    ctx.bezierCurveTo(64, 38, -96, 34, -112, 0);
    ctx.closePath(); ctx.fill();
    ctx.save(); ctx.clip();
    // plate bands and rivets
    ctx.strokeStyle = sk.band; ctx.lineWidth = 3;
    for (const bx of [-72, -26, 20, 66]) {
      ctx.beginPath(); ctx.moveTo(bx, -40); ctx.quadraticCurveTo(bx + 8, 0, bx, 40); ctx.stroke();
      ctx.fillStyle = sk.light;
      for (let ry = -26; ry <= 26; ry += 9) { ctx.beginPath(); ctx.arc(bx + 4 + (1 - (ry * ry) / 900) * 3, ry, 1.2, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)"; ctx.fillRect(-120, -22, 240, 3);
    ctx.restore();
    // portholes
    for (const px of [-48, -4, 42, 84]) {
      ctx.fillStyle = sk.band; ctx.beginPath(); ctx.arc(px, 4, 8.5, 0, Math.PI * 2); ctx.fill();
      const pg = ctx.createRadialGradient(px - 2, 2, 1, px, 4, 7);
      pg.addColorStop(0, "#fffbe8"); pg.addColorStop(1, sk.glass);
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, 4, 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function airship(ctx, x, y, t, o) {
    ctx.save(); ctx.translate(x, y);
    // searchlight
    ctx.save(); ctx.globalCompositeOperation = "lighter";
    const ang = Math.sin(t * 0.9) * 0.35;
    ctx.rotate(ang);
    const beam = ctx.createLinearGradient(0, 40, 0, 600);
    beam.addColorStop(0, "rgba(205, 215, 255, 0.20)"); beam.addColorStop(1, "rgba(205, 215, 255, 0)");
    ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(-8, 44); ctx.lineTo(8, 44); ctx.lineTo(120, 640); ctx.lineTo(-120, 640); ctx.fill();
    ctx.restore();
    // rotor masts
    for (let i = 0; i < 6; i++) {
      const mx = -150 + i * 60;
      ctx.strokeStyle = "#1a1e2a"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(mx, -30); ctx.lineTo(mx, -62); ctx.stroke();
      const spin = Math.abs(Math.sin(t * 22 + i));
      ctx.fillStyle = "rgba(170, 180, 200, 0.55)";
      ctx.beginPath(); ctx.ellipse(mx, -63, 26 * spin + 3, 3, 0, 0, Math.PI * 2); ctx.fill();
    }
    // envelope
    const eg = ctx.createLinearGradient(0, -46, 0, 40);
    eg.addColorStop(0, "#4a5266"); eg.addColorStop(0.5, "#262b39"); eg.addColorStop(1, "#0e1018");
    ctx.fillStyle = eg;
    ctx.beginPath(); ctx.ellipse(0, 0, 190, 44, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.clip();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.35)"; ctx.lineWidth = 2;
    for (let rx = -170; rx <= 170; rx += 34) { ctx.beginPath(); ctx.ellipse(rx, 0, 8, 46, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
    // tail fins (facing left, so fins on the right)
    ctx.fillStyle = "#1b1f2b";
    ctx.beginPath(); ctx.moveTo(160, -18); ctx.lineTo(214, -54); ctx.lineTo(200, -10); ctx.fill();
    ctx.beginPath(); ctx.moveTo(160, 18); ctx.lineTo(214, 54); ctx.lineTo(200, 10); ctx.fill();
    // emblem, an unblinking eye
    ctx.strokeStyle = o.captured ? "#d8ccff" : "#b9c3e0"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(-40, -4, 22, 12, 0, 0, Math.PI * 2); ctx.stroke();
    const pulse = 0.6 + 0.4 * Math.sin(t * 3);
    ctx.fillStyle = `rgba(210, 220, 255, ${pulse})`;
    ctx.beginPath(); ctx.arc(-40, -4, 5, 0, Math.PI * 2); ctx.fill();
    // gondola
    ctx.strokeStyle = "#11141c"; ctx.lineWidth = 2;
    for (const cx of [-60, -10, 40]) { ctx.beginPath(); ctx.moveTo(cx, 36); ctx.lineTo(cx, 50); ctx.stroke(); }
    ctx.fillStyle = "#151924";
    ctx.beginPath(); ctx.moveTo(-90, 50); ctx.lineTo(70, 50); ctx.lineTo(56, 70); ctx.lineTo(-76, 70); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#cdd6ff";
    for (let wx = -78; wx < 56; wx += 16) ctx.fillRect(wx, 55, 8, 6);
    ctx.restore();
  }

  function payload(ctx, p, t) {
    ctx.save(); ctx.translate(p.x, p.y);
    const k = p.kind;
    if (k === "charge") {
      ctx.rotate(Math.sin(t * 3 + p.id) * 0.15);
      ctx.fillStyle = "#1b2030"; ctx.fillRect(-11, -15, 22, 30);
      ctx.fillStyle = "#c49a55"; ctx.fillRect(-12, -15, 24, 4); ctx.fillRect(-12, 11, 24, 4); ctx.fillRect(-12, -2, 24, 3);
      const blink = Math.sin(t * 12) > 0;
      ctx.fillStyle = blink ? "#ffd99a" : "#6e522a"; ctx.beginPath(); ctx.arc(0, -19, 3, 0, Math.PI * 2); ctx.fill();
    } else if (k === "fog") {
      ctx.fillStyle = "#3c3a58"; ctx.beginPath(); ctx.ellipse(0, 0, 10, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(160, 150, 210, 0.25)";
      for (let i = 0; i < 4; i++) { const a = t * 2 + i * 1.6; ctx.beginPath(); ctx.arc(Math.cos(a) * 12, -16 - i * 6, 8 + i * 2, 0, Math.PI * 2); ctx.fill(); }
    } else if (k === "decoy") {
      ctx.fillStyle = "#aab4cc"; ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(10, 10); ctx.lineTo(-10, 10); ctx.closePath(); ctx.fill();
      const ring = (t * 1.6 + p.id * 0.3) % 1;
      ctx.strokeStyle = `rgba(200, 215, 255, ${1 - ring})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 10 + ring * 34, 0, Math.PI * 2); ctx.stroke();
    } else if (k === "ember") {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
      g.addColorStop(0, "rgba(255, 236, 190, 0.95)"); g.addColorStop(0.4, "rgba(255, 150, 70, 0.6)"); g.addColorStop(1, "rgba(255, 110, 40, 0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 26 + Math.sin(t * 9) * 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else if (k === "boarder") {
      ctx.strokeStyle = "#8b95ab"; ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const sway = Math.sin(t * 10 + i) * 4;
        ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-18 - i * 2, 8 + i * 3 + sway); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(18 + i * 2, 8 + i * 3 - sway); ctx.stroke();
      }
      ctx.fillStyle = "#3a4357"; ctx.beginPath(); ctx.ellipse(0, 0, 13, 10, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#9fd0ff"; ctx.beginPath(); ctx.arc(0, -1, 4, 0, Math.PI * 2); ctx.fill();
    } else if (k === "siren") {
      ctx.strokeStyle = "rgba(185, 166, 255, 0.85)"; ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        for (let xx = -24; xx <= 24; xx += 3) ctx.lineTo(xx, -14 + i * 14 + Math.sin(xx * 0.3 + t * 8 + i) * 4);
        ctx.stroke();
      }
      ctx.fillStyle = "#e9e2ff"; ctx.font = "bold 16px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("§", 0, 0);
    } else if (k === "writ") {
      ctx.rotate(Math.sin(t * 1.2) * 0.08);
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 80);
      g.addColorStop(0, "rgba(200, 180, 255, 0.35)"); g.addColorStop(1, "rgba(200, 180, 255, 0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 80, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.fillStyle = "#e6d3a1"; ctx.fillRect(-34, -22, 68, 44);
      ctx.fillStyle = "#c9b27d"; ctx.fillRect(-40, -26, 8, 52); ctx.fillRect(32, -26, 8, 52);
      ctx.strokeStyle = "rgba(60, 40, 20, 0.5)"; ctx.lineWidth = 1.5;
      for (let ly = -12; ly <= 10; ly += 6) { ctx.beginPath(); ctx.moveTo(-24, ly); ctx.lineTo(20, ly); ctx.stroke(); }
      ctx.fillStyle = "#7a2433"; ctx.beginPath(); ctx.arc(14, 12, 9, 0, Math.PI * 2); ctx.fill();
      // hit points
      for (let i = 0; i < 3; i++) { ctx.fillStyle = i < p.hp ? "#d8ccff" : "rgba(216, 204, 255, 0.2)"; ctx.fillRect(-18 + i * 13, -36, 10, 4); }
    }
    ctx.restore();
  }

  function gear(ctx, g, t) {
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(t * 1.5 + g.phase);
    ctx.fillStyle = "#e6c27a";
    ctx.beginPath();
    for (let i = 0; i < 16; i++) { const a = (i / 16) * Math.PI * 2, rr = i % 2 ? 9 : 12; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#6e522a"; ctx.beginPath(); ctx.arc(0, 0, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // Salvage. A relic is what is left of a threat, a chest lies on the seabed,
  // and a clam opens only for a ship at rest.
  function relic(ctx, r, t) {
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.sin(t * 2 + r.id) * 0.3);
    ctx.globalAlpha = Math.min(1, r.life / 2);
    ctx.fillStyle = "#c49a55"; ctx.fillRect(-7, -11, 14, 22);
    ctx.fillStyle = "#3d2b14"; ctx.fillRect(-8, -12, 16, 3); ctx.fillRect(-8, 9, 16, 3);
    ctx.fillStyle = "#f0d9a0"; ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function chest(ctx, c, t) {
    ctx.save(); ctx.translate(c.x, c.y);
    ctx.fillStyle = "#4a3418"; ctx.fillRect(-22, -14, 44, 26);
    ctx.fillStyle = "#6e522a"; ctx.beginPath(); ctx.moveTo(-22, -14); ctx.quadraticCurveTo(0, -30, 22, -14); ctx.lineTo(22, -8); ctx.lineTo(-22, -8); ctx.fill();
    ctx.fillStyle = "#c49a55"; ctx.fillRect(-14, -26, 4, 38); ctx.fillRect(10, -26, 4, 38); ctx.fillRect(-4, -10, 8, 8);
    const g = (Math.sin(t * 3) + 1) * 0.5;
    ctx.strokeStyle = `rgba(240, 217, 160, ${0.25 + g * 0.5})`; ctx.lineWidth = 2; ctx.strokeRect(-23, -15, 46, 28);
    ctx.restore();
  }
  function clam(ctx, cl, t) {
    ctx.save(); ctx.translate(cl.x, cl.y);
    const open = cl.done ? 0.9 : cl.open * 0.9;
    const shell = (flip) => {
      ctx.save(); ctx.scale(1, flip ? -1 : 1);
      const grad = ctx.createLinearGradient(0, -26, 0, 0); grad.addColorStop(0, "#8fb0c8"); grad.addColorStop(1, "#3f5f78");
      ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(-36, 0);
      for (let i = 0; i <= 12; i++) { const a = Math.PI + (i / 12) * Math.PI; const rr = 36 - (i % 2) * 3; ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * 26 * (rr / 36)); }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(20, 40, 60, 0.6)"; ctx.lineWidth = 1.5;
      for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(Math.PI + (i / 6) * Math.PI) * 34, Math.sin(Math.PI + (i / 6) * Math.PI) * 24); ctx.stroke(); }
      ctx.restore();
    };
    shell(true);
    if (!cl.done) {
      ctx.save(); ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(0, -6, 2, 0, -6, 18); g.addColorStop(0, `rgba(255,255,255,${0.6 * open + 0.1})`); g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, -6, 18, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.fillStyle = "#f4f6fb"; ctx.beginPath(); ctx.arc(0, -6, 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.save(); ctx.translate(-36, 0); ctx.rotate(-open * 1.1); ctx.translate(36, 0); shell(false); ctx.restore();
    if (!cl.done && open > 0.02) { ctx.fillStyle = "#c9d0dc"; ctx.font = "600 10px sans-serif"; ctx.textAlign = "center"; ctx.fillText("HOLD STILL", 0, 44); }
    ctx.restore();
  }

  // The salon in two dimensions. Drawn over the sea, with two oval windows
  // cut from the back wall so the sea shows through. Anchors are in world
  // coordinates for the hub tags.
  const SALON_ANCHORS = { sea: [640, 250], library: [120, 300], organ: [1160, 300], chart: [560, 560], logbook: [760, 540], repeater: [940, 470], drydock: [1180, 600], articles: [250, 600] };
  function salon(ctx, W, H, t) {
    // Back wall with windows.
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H);
    for (const wx of [380, 900]) ctx.ellipse(wx, 250, 190, 125, 0, 0, Math.PI * 2, true);
    const wall = ctx.createLinearGradient(0, 0, 0, H); wall.addColorStop(0, "#1a1109"); wall.addColorStop(0.55, "#2a1a0e"); wall.addColorStop(1, "#140c06");
    ctx.fillStyle = wall; ctx.fill("evenodd");
    ctx.restore();
    // Panel lines and ribs.
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 3;
    for (let x = 60; x < W; x += 160) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 400); ctx.stroke(); }
    ctx.fillStyle = "#3b2614"; ctx.fillRect(0, 0, W, 18);
    // Window frames with rivets.
    for (const wx of [380, 900]) {
      ctx.strokeStyle = "#c49a55"; ctx.lineWidth = 10; ctx.beginPath(); ctx.ellipse(wx, 250, 196, 131, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = "#3d2b14"; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(wx, 250, 202, 137, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#f0d9a0";
      for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; ctx.beginPath(); ctx.arc(wx + Math.cos(a) * 199, 250 + Math.sin(a) * 134, 3, 0, Math.PI * 2); ctx.fill(); }
    }
    // Floor.
    const floor = ctx.createLinearGradient(0, 420, 0, H); floor.addColorStop(0, "#4a3418"); floor.addColorStop(1, "#1f1408");
    ctx.fillStyle = floor; ctx.fillRect(0, 420, W, H - 420);
    ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) { const y = 420 + i * i * 2.2; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // Library, left.
    ctx.fillStyle = "#2a1a0e"; ctx.fillRect(20, 120, 210, 330);
    const spines = ["#5a2b1a", "#2f4a3a", "#3b3a6a", "#6a4a1a", "#4a2a4a", "#2a3a5a", "#7a5a2a"];
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let shelf = 0; shelf < 4; shelf++) {
      const y = 200 + shelf * 78;
      ctx.fillStyle = "#6e522a"; ctx.fillRect(28, y, 194, 6);
      let x = 32;
      while (x < 214) { const w = 10 + rnd() * 14, h = 40 + rnd() * 26; ctx.fillStyle = spines[Math.floor(rnd() * spines.length)]; ctx.fillRect(x, y - h, w, h); ctx.fillStyle = "#c49a55"; ctx.fillRect(x + w / 2 - 1, y - h * 0.7, 2, h * 0.3); x += w + 2; }
    }
    // Chart table, center.
    ctx.fillStyle = "#3b2614"; ctx.fillRect(420, 500, 420, 18);
    ctx.fillStyle = "#2a1a0e"; for (const lx of [440, 820]) ctx.fillRect(lx, 518, 12, 120);
    ctx.fillStyle = "#d9c7a0"; ctx.fillRect(470, 470, 260, 40);
    ctx.strokeStyle = "#5a3a1a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(490, 500); ctx.bezierCurveTo(560, 470, 640, 505, 710, 478); ctx.stroke();
    ctx.fillStyle = "#4a1f1a"; ctx.fillRect(740, 478, 70, 26); ctx.fillStyle = "#c49a55"; ctx.fillRect(800, 480, 6, 22);
    // Lamp.
    ctx.fillStyle = "#2a4a3a"; ctx.beginPath(); ctx.moveTo(600, 380); ctx.lineTo(660, 380); ctx.lineTo(690, 420); ctx.lineTo(570, 420); ctx.fill();
    ctx.save(); ctx.globalCompositeOperation = "lighter"; const lg = ctx.createRadialGradient(630, 425, 5, 630, 425, 160); lg.addColorStop(0, "rgba(255,220,160,0.35)"); lg.addColorStop(1, "rgba(255,220,160,0)"); ctx.fillStyle = lg; ctx.fillRect(430, 380, 400, 260); ctx.restore();
    // Organ, right.
    ctx.fillStyle = "#2a1a0e"; ctx.fillRect(1060, 330, 200, 130);
    for (let i = 0; i < 9; i++) { const h = 120 + Math.abs(4 - i) * 22; ctx.fillStyle = "#b9c3d6"; ctx.fillRect(1075 + i * 20, 330 - h, 12, h); ctx.fillStyle = "#c49a55"; ctx.fillRect(1073 + i * 20, 330 - h - 6, 16, 6); }
    ctx.fillStyle = "#e8dfc8"; ctx.fillRect(1070, 340, 180, 10);
    // Repeater pedestal.
    ctx.fillStyle = "#3d2b14"; ctx.fillRect(925, 480, 30, 150);
    ctx.fillStyle = "#c49a55"; ctx.beginPath(); ctx.arc(940, 470, 34, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#0b1224"; ctx.beginPath(); ctx.arc(940, 470, 26, 0, Math.PI * 2); ctx.fill();
    // Dry dock chest and the pearl case.
    chest(ctx, { x: 1180, y: 610 }, t);
    ctx.fillStyle = "#3d2b14"; ctx.fillRect(235, 560, 30, 110);
    ctx.fillStyle = "rgba(200, 220, 255, 0.18)"; ctx.fillRect(228, 500, 44, 60); ctx.strokeStyle = "rgba(200,220,255,0.4)"; ctx.strokeRect(228, 500, 44, 60);
    ctx.fillStyle = "#f4f6fb"; ctx.beginPath(); ctx.arc(250, 535, 8, 0, Math.PI * 2); ctx.fill();
    void SALON_ANCHORS;
  }

  // The chart. A parchment map with the season's ports along a route.
  function chart(ctx, w, h, chapters, state) {
    const g = ctx;
    const bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, "#d9c7a0"); bg.addColorStop(1, "#c4ad83");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(90, 60, 30, 0.22)"; g.lineWidth = 1;
    for (let x = 0; x < w; x += w / 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += h / 8) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // Drowned coastlines.
    g.strokeStyle = "rgba(90, 60, 30, 0.5)"; g.lineWidth = 1.5;
    for (let i = 0; i < 5; i++) { g.beginPath(); for (let x = 0; x <= w; x += 12) g.lineTo(x, h * (0.15 + i * 0.18) + Math.sin(x * 0.02 + i * 2) * 10 + Math.sin(x * 0.07 + i) * 4); g.stroke(); }
    // Compass rose.
    g.save(); g.translate(w - 70, 70); g.strokeStyle = "#5a3a1a"; g.fillStyle = "#5a3a1a"; g.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) { g.save(); g.rotate((i * Math.PI) / 4); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, i % 2 ? -22 : -40); g.lineTo(4, -8); g.closePath(); g.fill(); g.restore(); }
    g.beginPath(); g.arc(0, 0, 44, 0, Math.PI * 2); g.stroke(); g.font = "bold 12px Georgia"; g.textAlign = "center"; g.fillText("N", 0, -50); g.restore();
    // Route.
    const pts = chapters.map((c, i) => ({ x: w * (0.08 + (i / (chapters.length - 1)) * 0.78), y: h * (0.5 + Math.sin(i * 1.7) * 0.28) }));
    g.setLineDash([6, 6]); g.strokeStyle = "#5a3a1a"; g.lineWidth = 2; g.beginPath();
    pts.forEach((p, i) => { if (i === 0) g.moveTo(p.x, p.y); else { const q = pts[i - 1]; g.bezierCurveTo(q.x + (p.x - q.x) * 0.5, q.y, p.x - (p.x - q.x) * 0.5, p.y, p.x, p.y); } });
    g.stroke(); g.setLineDash([]);
    pts.forEach((p, i) => {
      const c = chapters[i];
      const done = state.done[c.id], next = state.next === c.id, locked = !done && !next;
      g.fillStyle = done ? "#2f4a3a" : next ? "#c8643c" : "rgba(90,60,30,0.5)";
      g.beginPath(); g.arc(p.x, p.y, next ? 9 : 7, 0, Math.PI * 2); g.fill();
      if (next) { g.strokeStyle = "#c8643c"; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, 15, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = locked ? "rgba(90,60,30,0.6)" : "#3a2410"; g.font = `${next ? "bold " : ""}13px Georgia`; g.textAlign = "center";
      g.fillText(c.port, p.x, p.y + (i % 2 ? 30 : -20));
      g.font = "italic 11px Georgia"; g.fillText(`${c.id}. ${c.title}`, p.x, p.y + (i % 2 ? 44 : -34));
      if (done) { g.save(); g.translate(p.x + 22, p.y - 8); g.rotate(-0.3); g.strokeStyle = "rgba(120, 30, 30, 0.6)"; g.lineWidth = 1.5; g.strokeRect(-18, -8, 36, 16); g.fillStyle = "rgba(120, 30, 30, 0.7)"; g.font = "bold 9px Georgia"; g.fillText("MADE PORT", 0, 3); g.restore(); }
    });
    if (state.leviathan != null) { const lp = pts[Math.min(pts.length - 1, state.leviathan)]; g.fillStyle = "rgba(60, 40, 90, 0.5)"; g.beginPath(); g.ellipse(lp.x + 40, lp.y - 40, 26, 10, 0, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = "rgba(90,60,30,0.6)"; g.lineWidth = 3; g.strokeRect(6, 6, w - 12, h - 12);
    g.strokeStyle = "rgba(90,60,30,0.35)"; g.lineWidth = 1; g.strokeRect(12, 12, w - 24, h - 24);
  }

  function harpoon(ctx, h, fromX, fromY) {
    ctx.strokeStyle = "rgba(200, 180, 140, 0.55)"; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(h.x, h.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.save(); ctx.translate(h.x, h.y); ctx.rotate(h.angle || -Math.PI / 2);
    ctx.fillStyle = "#f0d9a0"; ctx.fillRect(-18, -1.5, 18, 3);
    ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-2, -5); ctx.lineTo(-2, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // A brass gauge. value and thresholds are in signal units.
  function gauge(ctx, cx, cy, r, o) {
    const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    const toA = (v) => a0 + (a1 - a0) * Math.max(0, Math.min(1, (v - o.min) / (o.max - o.min)));
    ctx.save();
    ctx.fillStyle = "#6e522a"; ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2); ctx.fill();
    const bez = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    bez.addColorStop(0, "#f0d9a0"); bez.addColorStop(1, "#7a5a2a");
    ctx.strokeStyle = bez; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#0b1224"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    // zones
    const zone = (from, to, color) => { ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, r - 5, Math.min(toA(from), toA(to)), Math.max(toA(from), toA(to))); ctx.stroke(); };
    const lowBad = o.direction === "lower_is_unsafe";
    const warnC = o.captured ? "rgba(185, 166, 255, 0.6)" : "rgba(230, 211, 161, 0.85)";
    const critC = o.captured ? "rgba(185, 166, 255, 0.9)" : "rgba(200, 100, 60, 0.95)";
    if (lowBad) { zone(o.warning, o.critical, warnC); zone(o.critical, o.min, critC); }
    else { zone(o.warning, o.critical, warnC); zone(o.critical, o.max, critC); }
    // ticks
    ctx.strokeStyle = "rgba(214, 222, 238, 0.35)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10)); ctx.lineTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14)); ctx.stroke();
    }
    // needle
    if (o.value == null) {
      ctx.fillStyle = "rgba(214, 222, 238, 0.7)"; ctx.font = "600 11px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("NO READING", cx, cy + 2);
    } else {
      const a = toA(o.value);
      ctx.strokeStyle = "#f4f6fb"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8)); ctx.stroke();
      ctx.fillStyle = "#c49a55"; ctx.beginPath(); ctx.arc(cx, cy, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#c9d0dc"; ctx.font = "600 10px -apple-system, Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText(o.label.toUpperCase(), cx, cy + r + 16);
    ctx.restore();
  }

  // Engine order telegraph. pos runs from 0 (full ahead) to 1 (all stop).
  function telegraph(ctx, cx, cy, r, pos, label) {
    ctx.save();
    ctx.fillStyle = "#6e522a"; ctx.beginPath(); ctx.arc(cx, cy, r + 6, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#0b1224"; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0); ctx.closePath(); ctx.fill();
    const labels = [["FULL", 0], ["HALF", 0.5], ["STOP", 1]];
    ctx.font = "700 11px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const [txt, p] of labels) {
      const a = Math.PI + Math.PI * (0.15 + 0.7 * p);
      ctx.fillStyle = "#e6d3a1";
      ctx.fillText(txt, cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18));
    }
    const a = Math.PI + Math.PI * (0.15 + 0.7 * pos);
    ctx.strokeStyle = "#f4f6fb"; ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34)); ctx.stroke();
    ctx.fillStyle = "#c49a55"; ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f4f6fb"; ctx.font = "600 13px Georgia, serif";
    ctx.fillText(label.toUpperCase(), cx, cy + 20);
    ctx.restore();
  }

  const api = { SKINS, PENNANTS, SALON_ANCHORS, buildLayers, background, sea, snow, sub, airship, payload, gear, relic, chest, clam, salon, chart, harpoon, gauge, telegraph };
  root.NautilusArt = api;
})(window);
