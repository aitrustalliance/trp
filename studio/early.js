/**
 * Early access to Nautilus. Opens a card from the Studio header and sends a
 * name and an email address to the Web3Forms address in nautilus/config.js.
 * Nothing is sent until the person submits, and nothing is sent at all
 * while no key has been set.
 */
(function (root, doc) {
  "use strict";
  const ENDPOINT = "https://api.web3forms.com/submit";
  const $ = (id) => doc.getElementById(id);
  let lastFocus = null;

  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim()); }

  function open() {
    lastFocus = doc.activeElement;
    $("early").hidden = false;
    $("early-msg").textContent = "";
    $("early-email").focus();
  }
  function close() {
    $("early").hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  async function submit(ev) {
    ev.preventDefault();
    const msg = $("early-msg");
    const email = $("early-email").value.trim();
    if (!validEmail(email)) { msg.textContent = "Please give an email address we can write to."; $("early-email").focus(); return; }
    if (!$("early-consent").checked) { msg.textContent = "Please tick the box so we know you want to hear from us."; return; }
    const cfg = root.NAUTILUS_CONFIG || {};
    if (!cfg.web3formsKey) { msg.textContent = "The list is not open yet. Watch the repository for the day it is."; return; }
    const btn = $("early-btn");
    btn.disabled = true; msg.textContent = "Sending…";
    const body = {
      access_key: cfg.web3formsKey,
      subject: "Nautilus early access",
      from_name: "TRP Studio",
      name: $("early-name").value.trim().slice(0, 60),
      email: email,
      consent: "Asked to be written to when Nautilus early access opens and read the privacy note",
      source: root.location ? root.location.href.split("#")[0] : "",
      botcheck: $("early-botcheck").checked ? true : "",
    };
    try {
      const res = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (res.status === 200) { msg.textContent = "Thank you. We will write when the hatch opens."; $("early-form").reset(); }
      else { msg.textContent = json.message || `That did not go through (${res.status}). Please try again later.`; }
    } catch (err) {
      msg.textContent = "Could not reach the list. Please try again later.";
    }
    btn.disabled = false;
  }

  doc.addEventListener("DOMContentLoaded", () => {
    const btn = $("nautilus-btn");
    if (!btn || !$("early")) return;
    btn.addEventListener("click", open);
    $("early-close").addEventListener("click", close);
    $("early").addEventListener("click", (e) => { if (e.target === $("early")) close(); });
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("early").hidden) close(); });
    $("early-form").addEventListener("submit", submit);
  });

  root.StudioEarly = { validEmail };
})(window, document);
