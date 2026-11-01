/**
 * Nautilus sound. Every sound is synthesized in the browser, no files.
 */
(function (root) {
  "use strict";
  let ctx = null, master = null, hum = null, humGain = null, muted = false;

  function init() {
    if (ctx) return;
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ctx.destination);
    hum = ctx.createOscillator(); hum.type = "sawtooth"; hum.frequency.value = 42;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 180;
    humGain = ctx.createGain(); humGain.gain.value = 0;
    hum.connect(lp); lp.connect(humGain); humGain.connect(master); hum.start();
  }

  function tone(freq, dur, type, vol, slide) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = type || "sine"; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol || 0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, cutoff) {
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = cutoff || 900;
    const g = ctx.createGain(); g.gain.value = vol || 0.4;
    s.connect(f); f.connect(g); g.connect(master); s.start();
  }

  // A procedural score. A slow pad in a minor mode, a pulse that quickens
  // with danger, and an arpeggio that climbs as the sea gets rough. The
  // Decree detunes everything while it is in force.
  const SCALE = [0, 2, 3, 5, 7, 10, 12, 14, 15];
  const BASE = 55; // A1
  let score = null;
  function startScore() {
    if (!ctx) return;
    if (score) { score.bus.gain.setTargetAtTime(1, ctx.currentTime, 1); score.next = Math.max(score.next, ctx.currentTime + 0.2); return; }
    const bus = ctx.createGain(); bus.gain.value = 0.0; bus.connect(master);
    const padGain = ctx.createGain(); padGain.gain.value = 0.11; padGain.connect(bus);
    const padFilter = ctx.createBiquadFilter(); padFilter.type = "lowpass"; padFilter.frequency.value = 500; padFilter.Q.value = 0.7; padFilter.connect(padGain);
    const pads = [0, 7, 12].map((semi, i) => { const o = ctx.createOscillator(); o.type = i === 1 ? "triangle" : "sawtooth"; o.frequency.value = BASE * Math.pow(2, semi / 12); o.detune.value = (i - 1) * 6; o.connect(padFilter); o.start(); return o; });
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; const lfoGain = ctx.createGain(); lfoGain.gain.value = 180; lfo.connect(lfoGain); lfoGain.connect(padFilter.frequency); lfo.start();
    score = { bus, padFilter, pads, next: ctx.currentTime + 0.5, step: 0, level: 0, captured: false };
    bus.gain.setTargetAtTime(1, ctx.currentTime, 2);
  }
  function note(freq, at, dur, type, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(vol, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(score.bus); o.start(at); o.stop(at + dur + 0.05);
  }
  function scoreTick(level, captured) {
    if (!ctx || !score || muted) return;
    score.level += (level - score.level) * 0.05;
    score.captured = captured;
    const l = score.level;
    score.padFilter.frequency.setTargetAtTime(380 + l * 900, ctx.currentTime, 0.5);
    for (const [i, o] of score.pads.entries()) o.detune.setTargetAtTime(captured ? (i - 1) * 35 + 20 : (i - 1) * 6, ctx.currentTime, 0.3);
    const beat = 0.5 - l * 0.26;
    while (score.next < ctx.currentTime + 0.3) {
      const at = score.next;
      const s = score.step;
      if (s % 2 === 0) note(BASE, at, 0.25, "sine", 0.12 + l * 0.12);
      if (l > 0.15 && s % 4 === 2) note(BASE * 1.5, at, 0.18, "triangle", 0.05 + l * 0.08);
      if (l > 0.35 || s % 8 === 0) {
        const deg = SCALE[(s * 2 + Math.floor(l * 5)) % SCALE.length] + (captured ? 1 : 0);
        note(BASE * 4 * Math.pow(2, deg / 12), at, 0.22, "square", 0.025 + l * 0.04);
      }
      score.next += beat;
      score.step++;
    }
  }
  function stopScore() { if (score) { score.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.6); } }

  const api = {
    init,
    score: scoreTick,
    scoreStart: startScore,
    scoreStop: stopScore,
    setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.5; },
    get muted() { return muted; },
    fire() { tone(220, 0.12, "triangle", 0.18, 90); noise(0.05, 0.15, 3000); },
    intercept(combo) { const f = 440 * Math.pow(2, Math.min(12, combo) / 12); tone(f, 0.18, "square", 0.08); tone(f * 1.5, 0.22, "sine", 0.1); noise(0.15, 0.25, 2200); },
    blast(near) { noise(near ? 0.9 : 0.5, near ? 0.8 : 0.35, near ? 500 : 300); tone(60, 0.6, "sine", near ? 0.5 : 0.2, 30); },
    hit() { noise(0.6, 0.7, 1200); tone(90, 0.5, "sawtooth", 0.25, 40); },
    caught() { tone(660, 0.12, "sine", 0.15); setTimeout(() => tone(990, 0.25, "sine", 0.15), 110); },
    bell() { tone(1318, 0.9, "sine", 0.12); tone(1975, 0.6, "sine", 0.05); },
    ping() { tone(1400, 0.5, "sine", 0.12, 1200); },
    gear() { tone(1760, 0.07, "triangle", 0.1); tone(2637, 0.09, "triangle", 0.06); },
    alarm() { tone(300, 0.4, "sawtooth", 0.15, 220); setTimeout(() => tone(300, 0.4, "sawtooth", 0.15, 220), 450); },
    harbor() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.5, "triangle", 0.12), i * 140)); },
    engine(speed) { if (humGain) humGain.gain.setTargetAtTime(0.05 + speed * 0.07, ctx.currentTime, 0.2); if (hum) hum.frequency.setTargetAtTime(36 + speed * 18, ctx.currentTime, 0.3); },
    silence() { if (humGain) humGain.gain.setTargetAtTime(0, ctx.currentTime, 0.2); stopScore(); },
  };
  root.NautilusAudio = api;
})(window);
