/**
 * Crew sign-up. Optional and opt-in. Sends a captain name, email and role to
 * the Web3Forms address set in config.js, with the player's progress so
 * future rewards can honor it. Nothing is sent until the player submits.
 */
(function (root) {
  "use strict";
  const ENDPOINT = "https://api.web3forms.com/submit";

  async function join(fields, ledger) {
    const cfg = root.NAUTILUS_CONFIG || {};
    if (!cfg.web3formsKey) {
      return { ok: false, offline: true, message: "The crew roll is not open yet. Your progress is saved on this device." };
    }
    const body = {
      access_key: cfg.web3formsKey,
      subject: "New Nautilus crew member",
      from_name: "TRP Studio Nautilus",
      captain_name: fields.captain,
      email: fields.email,
      role: fields.role,
      consent: "Agreed to receive game and TRP updates and to the privacy note",
      lifetime_leagues: ledger.lifetimeLeagues,
      brass: ledger.brass,
      best_score: ledger.bestEver,
      streak: ledger.streak.count,
      source: root.location ? root.location.href.split("#")[0] : "",
      botcheck: fields.botcheck ? true : "",
    };
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 200) return { ok: true, message: json.message || "Welcome aboard." };
      return { ok: false, message: json.message || `Sign-up failed (${res.status}). Please try again later.` };
    } catch (err) {
      return { ok: false, message: "Could not reach the crew roll. Please try again later." };
    }
  }

  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim()); }

  root.NautilusCrew = { join, validEmail };
})(window);
