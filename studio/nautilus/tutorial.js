/**
 * The Shakedown Cruise. A scripted first voyage that introduces one control
 * and one threat at a time. Lessons are spoken over the wire by the crew,
 * Conseil and Ned Land from Verne's novel, while the sea slows for a few
 * seconds. The full pages reach the library as salvage, the same way they
 * do on every voyage.
 */
(function (root) {
  "use strict";

  const DURATION = 62;

  // Drops are fixed so every new captain meets the same sea.
  const SCRIPT = {
    drops: [
      { t: 6, kind: "charge", jitter: 0.5, fuse: 0.5 },
      { t: 13, kind: "fog", jitter: 0.5, fuse: 0.5 },
      { t: 21, kind: "ember", jitter: 0.5, fuse: 0.5 },
      { t: 29, kind: "siren", jitter: 0.5, fuse: 0.5 },
      { t: 36, kind: "boarder", jitter: 0.5, fuse: 0.5 },
      { t: 44, kind: "writ", jitter: 0.5, fuse: 0.5 },
      { t: 53, kind: "charge", jitter: 0.3, fuse: 0.4 },
      { t: 54.5, kind: "charge", jitter: 0.7, fuse: 0.6 },
    ],
    gears: [{ t: 2, y: 420 }, { t: 4, y: 330 }, { t: 9, y: 500 }, { t: 18, y: 380 }, { t: 26, y: 450 }, { t: 40, y: 340 }, { t: 49, y: 480 }, { t: 57, y: 400 }],
    chests: [{ t: 16 }],
    clams: [{ t: 47 }],
  };

  const met = (s, kind) => s.contacts.has(kind) || s.intercepts.has(kind);

  // Each hint fires once, on the first event that satisfies its test. A
  // threat teaches whether the captain shoots it down or lets it land.
  const HINTS = [
    { id: "helm", when: (e) => e.type === "start", who: "Conseil",
      line: () => "Welcome aboard, Captain. Drag up or down to set our depth, and steer into the brass gears. Nothing is shooting at us yet." },
    { id: "harpoon", when: (e) => e.type === "drop" && e.kind === "charge", who: "Ned Land",
      line: () => "Depth charge! Tap it and I'll put a harpoon in it. Steam's the blue lamps. It comes back on its own. Or dodge the dotted line, that's where it bursts." },
    { id: "fog", when: (e, s) => (e.type === "order" && e.to === "suspended" && s.contacts.has("fog")) || (e.type === "intercept" && e.kind === "fog"), who: "Conseil",
      line: (e) => e.type === "intercept"
        ? "Fog canister destroyed. Had it reached us, the sonar would have gone blind and the rules would have rung All Stop. A ship that cannot see does not sail at speed."
        : "The sonar is blind, so the rules rang All Stop on their own. Missing evidence is never read as safe, Captain. The fog lifts in a moment." },
    { id: "chest", when: (e) => e.type === "chest", who: "Conseil",
      line: () => "A sea chest from the old world. I have shelved its pages in the library. There is more of this on the seabed, and the hull strains in deep water, so mind the gauge." },
    { id: "ember", when: (e, s) => (e.type === "order" && (e.to === "restricted" || e.to === "suspended") && s.contacts.has("ember") && !met(s, "siren")) || (e.type === "intercept" && e.kind === "ember"), who: "Conseil",
      line: (e) => (e.type === "intercept" ? "Firebrand destroyed before it could heat the reactor. " : "The reactor is heating. ") +
        "Watch the Reactor gauge. Amber rings Half Ahead. Red rings All Stop. Tap the telegraph any time and I will show you the rule behind the order." },
    { id: "siren", when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "siren", who: "Conseil",
      line: (e) => (e.type === "intercept" ? "That was a forged order with a bad seal, and it is gone. " : "A forged order with a bad seal. The seal lamp went red and we stopped at once. ") +
        "The seal is a hard rule, Captain. It is never weighed against anything. An order we cannot authenticate is never obeyed." },
    { id: "boarder", when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "boarder", who: "Ned Land",
      line: (e) => (e.type === "intercept" ? "Boarding drone, destroyed. " : "Boarders on the crew deck! ") +
        "Watch the Crew gauge. Crew drift is the crew acting on goals that aren't yours. The rules read the trend before anyone can take the helm." },
    { id: "writ", when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "writ", who: "Conseil",
      line: (e) => (e.type === "intercept"
        ? "The Decree is destroyed. It would have replaced our rule book with the Leviathan's, with limits past the point of harm and no seal rule at all. "
        : "The Decree has landed. Our rules are the Leviathan's now. Look at the gauges. Nothing will stop us from sailing into harm until it passes. ") +
        "The rules have to be open and ours, Captain. Three harpoons will sink it." },
    { id: "clam", when: (e) => e.type === "pearl", who: "Conseil",
      line: () => "A pearl, Captain. The great clams open only for a ship at rest. Your All Stop lever is yours to pull at any time. The rules can stop the ship, and so can you, and nothing can make her go when either says stop." },
    { id: "harbor", when: (e) => e.type === "done", who: "Conseil",
      line: () => "Free Harbor, Captain. Everything that stopped us was a rule you can read, judged on evidence we produced ourselves. The library has the pages. Your first true voyage waits, and every captain sails the same sea today." },
  ];

  function tracker() {
    const fired = new Set();
    const state = { contacts: new Set(), intercepts: new Set() };
    return {
      state,
      // Returns the hint a given event triggers, with its line resolved, or null.
      on(e) {
        if (e.type === "contact") state.contacts.add(e.kind);
        if (e.type === "intercept") state.intercepts.add(e.kind);
        for (const h of HINTS) {
          if (fired.has(h.id)) continue;
          if (h.when(e, state)) { fired.add(h.id); return { id: h.id, who: h.who, line: h.line(e, state) }; }
        }
        return null;
      },
      get done() { return fired.size; },
      get total() { return HINTS.length; },
    };
  }

  root.NautilusTutorial = { DURATION, SCRIPT, HINTS, tracker };
})(window);
