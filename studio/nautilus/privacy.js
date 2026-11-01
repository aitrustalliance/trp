(function () {
  "use strict";
  const c = (window.NAUTILUS_CONFIG || {}).privacyContact;
  const el = document.getElementById("contact");
  if (c && el) { const a = document.createElement("a"); a.href = "mailto:" + c; a.textContent = c; el.replaceWith(a); }
})();
