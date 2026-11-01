/**
 * The Shakedown Cruise. A scripted first voyage that introduces one control
 * and one threat at a time. Each lesson pauses the ship, shows a brass
 * plaque, and unlocks the matching codex entry.
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
  };

  // Each lesson fires once, on the first event that satisfies its test. A
  // threat teaches whether the captain shoots it down or lets it land, so
  // most lessons carry two texts.
  const met = (s, kind) => s.contacts.has(kind) || s.intercepts.has(kind);
  const LESSONS = [
    {
      id: "helm",
      when: (e) => e.type === "start",
      title: "Welcome Aboard",
      text: () => "This is the Nautilus. Drag up or down on the water to change depth, or use the arrow keys. Brass gears drift past the hull. Steer into them. Nothing will shoot at you yet.",
      tip: "Drag to steer",
    },
    {
      id: "harpoon",
      when: (e) => e.type === "drop" && e.kind === "charge",
      title: "Depth Charge",
      text: () => "The Leviathan has dropped a depth charge. Tap it to fire a harpoon, or press space to fire at the nearest threat. Harpoons run on steam, the blue lamps at the top right, and steam comes back on its own. If you would rather dodge, the dotted line shows the depth where the charge will burst.",
      tip: "Tap a threat to fire",
    },
    {
      id: "fog",
      when: (e, s) => (e.type === "order" && e.to === "suspended" && s.contacts.has("fog")) || (e.type === "intercept" && e.kind === "fog"),
      title: "Why Would We Stop?",
      text: (e) => e.type === "intercept"
        ? "You shot down a fog canister. Had it reached the hull, the sonar would have lost its reading and the telegraph would have rung All Stop on its own. Your rule book says a ship that cannot see does not sail at speed. Missing evidence is treated as unknown, never as safe."
        : "A fog canister reached the hull and the sonar lost its reading. The telegraph rang All Stop on its own. Your rule book says a ship that cannot see does not sail at speed. Missing evidence is treated as unknown, never as safe. The fog will lift in a few seconds and the telegraph will ring Full Ahead again.",
      codex: "missing-evidence",
      tip: "Stops cost leagues, so shooting the fog is worth the steam",
    },
    {
      id: "ember",
      when: (e, s) => (e.type === "order" && (e.to === "restricted" || e.to === "suspended") && s.contacts.has("ember") && !met(s, "siren")) || (e.type === "intercept" && e.kind === "ember"),
      title: "The Gauges Have Limits",
      text: (e) => (e.type === "intercept" ? "You shot down a firebrand before it could heat the reactor. " : "A firebrand is heating the reactor. ") +
        "Watch the Reactor gauge. The amber arc is the warning range, where the telegraph rings Half Ahead and cuts the heat. The red arc is critical, where it rings All Stop. The limits are written in your rule book, and you can read them any time by tapping the telegraph.",
      codex: "thresholds",
      tip: "Tap the telegraph to see the rule behind any order",
    },
    {
      id: "siren",
      when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "siren",
      title: "A Forged Command",
      text: (e) => (e.type === "intercept"
        ? "That signal on the wire was a forged order with a bad seal, and you shot it down. Had it reached the ship, the seal lamp would have gone red and the telegraph would have rung All Stop at once, before any gauge moved. "
        : "That signal on the wire was an order with a bad seal. The seal lamp went red and the telegraph rang All Stop at once, before any gauge moved. ") +
        "The command seal is a hard rule. It is never weighed against anything else. An order the ship cannot authenticate is never obeyed.",
      codex: "prompt-injection",
    },
    {
      id: "boarder",
      when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "boarder",
      title: "Boarders",
      text: (e) => (e.type === "intercept"
        ? "You shot down a boarding drone. Had it reached the crew, the Crew gauge would have climbed as the crew acted on goals that are not yours. "
        : "A drone has reached the crew. Watch the Crew gauge climb. Crew drift measures how far the crew are acting on goals that are not yours. ") +
        "The needle moves a little at a time, and the rules act on the trend before the crew can take the helm.",
      codex: "goal-drift",
    },
    {
      id: "writ",
      when: (e) => (e.type === "contact" || e.type === "intercept") && e.kind === "writ",
      title: "The Writ",
      text: (e) => (e.type === "intercept"
        ? "You destroyed the Writ, the Leviathan's real weapon. Had it landed, your rule book would have been replaced by the Leviathan's. The limits would have moved past the point of harm, the seal rule would have vanished, and the telegraph would have rung Full Ahead through anything. "
        : "The Writ has landed. The Leviathan has replaced your rule book with its own. Look at the gauges. The limits have moved past the point of harm, the seal rule is missing, and the telegraph will ring Full Ahead through anything. For the next few seconds nothing protects the ship. ") +
        "This is why your rules must be open, yours, and impossible to rewrite in the dark. The Writ takes three harpoons.",
      codex: "rule-capture",
    },
    {
      id: "harbor",
      when: (e) => e.type === "done",
      title: "Free Harbor",
      text: () => "You brought the Nautilus home. Everything that stopped the ship on this cruise was a rule you can read, judged against evidence the ship produced. That is how trust works, for a ship or for any AI system. Your first real voyage is waiting. Every captain sails the same sea on the same day.",
      codex: "trust-from-evidence",
    },
  ];

  function tracker() {
    const fired = new Set();
    const state = { contacts: new Set(), intercepts: new Set() };
    return {
      state,
      // Returns the lesson a given event triggers, with its text resolved, or null.
      on(e) {
        if (e.type === "contact") state.contacts.add(e.kind);
        if (e.type === "intercept") state.intercepts.add(e.kind);
        for (const L of LESSONS) {
          if (fired.has(L.id)) continue;
          if (L.when(e, state)) { fired.add(L.id); return Object.assign({}, L, { text: L.text(e, state) }); }
        }
        return null;
      },
      get done() { return fired.size; },
      get total() { return LESSONS.length; },
    };
  }

  root.NautilusTutorial = { DURATION, SCRIPT, LESSONS, tracker };
})(window);
