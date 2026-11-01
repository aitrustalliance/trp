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

  const api = {
    init,
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
    silence() { if (humGain) humGain.gain.setTargetAtTime(0, ctx.currentTime, 0.2); },
  };
  root.NautilusAudio = api;
})(window);
