#!/usr/bin/env node
/**
 * Browser tests for the Nautilus game. Serves the repository locally and
 * plays the game in headless Chromium, in 2D and in 3D (software WebGL).
 *
 *   npm install --no-save playwright axe-core && npx playwright install chromium
 *   node tests/browser/nautilus_e2e.js
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".txt": "text/plain" };
const GL_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
}

async function open(browser, url, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 }, permissions: ["clipboard-read", "clipboard-write"] }, opts || {}));
  const page = await ctx.newPage();
  page.errors = [];
  page.requests = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push(m.text()); });
  page.on("request", (r) => page.requests.push(r.url()));
  await page.addInitScript(() => { window.alert = () => { window.__pwned = 1; }; });
  if (opts && opts.init) await page.addInitScript(opts.init);
  await page.goto(url);
  await page.waitForFunction(() => window.TRPNautilus && window.TRPNautilus.state === "title", null, { timeout: 20000 });
  page.ctx = ctx;
  return page;
}

async function playToLog(page) {
  await page.click("#sail-btn");
  await page.waitForTimeout(300);
  await page.evaluate(() => window.TRPNautilus.advance(90));
  await page.waitForFunction(() => window.TRPNautilus.state === "log", null, { timeout: 15000 });
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/studio/nautilus/`;
  const browser = await chromium.launch({ args: GL_ARGS });
  try {
    for (const mode of ["2d", "3d"]) {
      const page = await open(browser, base + (mode === "2d" ? "?renderer=2d" : ""));
      check(`${mode}: renderer is ${mode}`, (await page.evaluate(() => document.body.dataset.renderer)) === mode);
      await playToLog(page);
      const log = await page.textContent("#log-screen");
      check(`${mode}: a full voyage ends at the captain's log`, /Free Harbor Reached|Went Down/.test(log));
      check(`${mode}: the log shows par`, /Par [\d,]+/.test(log));
      await page.click("#copy-btn");
      await page.waitForTimeout(200);
      const text = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      check(`${mode}: share text names the voyage and carries the timeline`, /Nautilus · Voyage No\. \d+/.test(text) && /[🌊⚓💥]/u.test(text), text.slice(0, 60));
      const others = page.requests.filter((u) => !u.startsWith(`http://127.0.0.1`) && !u.startsWith("data:") && !u.startsWith("blob:"));
      check(`${mode}: no requests leave the site while playing`, others.length === 0, others.join(", "));
      check(`${mode}: no page errors`, page.errors.length === 0, page.errors.join(" | "));
      await page.ctx.close();
    }

    // Explain screen from the telegraph, and pause.
    {
      const page = await open(browser, base + "?renderer=2d");
      await page.click("#sail-btn");
      await page.waitForTimeout(500);
      await page.keyboard.press("e");
      await page.waitForTimeout(200);
      check("E opens the explanation of the engine order", (await page.evaluate(() => window.TRPNautilus.state)) === "explain" && /Engine order/.test(await page.textContent("#explain-body")));
      await page.click("#explain-close");
      await page.keyboard.press("p");
      check("P pauses", (await page.evaluate(() => window.TRPNautilus.state)) === "paused");
      await page.ctx.close();
    }

    // Shipyard purchases with brass.
    {
      const page = await open(browser, base + "?renderer=2d", { init: () => localStorage.setItem("nautilus.v1", JSON.stringify({ brass: 100 })) });
      await page.click("#yard-btn");
      await page.locator("#yard-pennants .yard-item", { hasText: "Free Fleet" }).click();
      const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem("nautilus.v1")));
      check("buying a pennant spends brass and flies it", ledger.brass === 70 && ledger.pennant === "free");
      const locked = await page.locator("#yard-hulls .yard-item", { hasText: "Gilded" }).isDisabled();
      check("hulls stay locked until earned", locked);
      await page.ctx.close();
    }

    // Hostile stored ledger.
    {
      const page = await open(browser, base + "?renderer=2d", { init: () => localStorage.setItem("nautilus.v1", JSON.stringify({ brass: "<img src=x onerror=window.__pwned=1>", captain: "<img src=x onerror=window.__pwned=1>", skins: ["__proto__", "gilded"], skin: "gilded", pennants: ["nope"], streak: { count: "lots" }, best: { "<b>": 9 } })) });
      await playToLog(page);
      await page.click("#log-yard");
      await page.waitForTimeout(200);
      const pwned = await page.evaluate(() => window.__pwned || null);
      const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem("nautilus.v1")));
      check("a poisoned ledger runs no script and is cleaned", !pwned && typeof ledger.brass === "number" && !("<b>" in ledger.best) && ledger.skins.every((s) => s !== "__proto__"), JSON.stringify(ledger).slice(0, 120));
      check("a poisoned ledger raises no errors", page.errors.length === 0, page.errors.join(" | "));
      await page.ctx.close();
    }

    // Crew sign-up with no key configured.
    {
      const page = await open(browser, base + "?renderer=2d");
      await playToLog(page);
      await page.fill("#join-captain", "Nemo");
      await page.fill("#join-email", "nemo@example.org");
      await page.click("#join-btn");
      check("sign-up requires consent", /tick the box/.test(await page.textContent("#join-msg")));
      await page.check("#join-consent");
      await page.click("#join-btn");
      await page.waitForTimeout(300);
      check("sign-up without a key sends nothing and says so", /not open yet/.test(await page.textContent("#join-msg")) && !page.requests.some((u) => u.includes("web3forms")));
      await page.ctx.close();
    }

    // Crew sign-up with a key, against a stand-in for the form service.
    {
      let body = null;
      const page = await open(browser, base + "?renderer=2d", {});
      await page.ctx.route("**/studio/nautilus/config.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: 'window.NAUTILUS_CONFIG = { web3formsKey: "test-key", privacyContact: "", repo: "https://github.com/aitrustalliance/trp" };' }));
      await page.ctx.route("https://api.web3forms.com/**", (r) => { body = JSON.parse(r.request().postData() || "{}"); r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"success":true,"message":"Welcome aboard."}' }); });
      await page.reload();
      await page.waitForFunction(() => window.TRPNautilus && window.TRPNautilus.state === "title");
      await playToLog(page);
      await page.fill("#join-captain", "Nemo");
      await page.fill("#join-email", "nemo@example.org");
      await page.check("#join-consent");
      await page.click("#join-btn");
      await page.waitForTimeout(600);
      check("sign-up posts the form with consent, progress and the key", body && body.access_key === "test-key" && body.email === "nemo@example.org" && body.consent && typeof body.lifetime_leagues === "number" && body.botcheck === "", JSON.stringify(body));
      const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem("nautilus.v1")));
      check("joining unlocks the Crew Roll pennant", ledger.joined === true && ledger.pennants.includes("crew"));
      await page.ctx.close();
    }

    // Agents can play headless.
    {
      const page = await open(browser, base + "?renderer=2d");
      const s = await page.evaluate(() => window.TRPNautilus.play({ seed: 20261101 }));
      const par = await page.evaluate(() => window.TRPNautilus.par(20261101));
      check("TRPNautilus.play matches par for the reference captain", s.score === par, `${s.score} vs ${par}`);
      await page.ctx.close();
    }

    // Phone layout.
    {
      const page = await open(browser, base + "?renderer=2d", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone title screen has no sideways scroll", overflow <= 1, `${overflow}px`);
      await page.ctx.close();
    }

    // Accessibility audit, when axe-core is installed.
    let axe = null;
    try { axe = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8"); } catch (err) { console.log("SKIP  accessibility audit (npm install --no-save axe-core)"); }
    if (axe) {
      for (const [label, url, play] of [["title", base + "?renderer=2d", false], ["captain's log", base + "?renderer=2d", true], ["privacy note", base + "privacy.html", false]]) {
        const ctx = await browser.newContext({ bypassCSP: true });
        const page = await ctx.newPage();
        await page.goto(url);
        if (label !== "privacy note") await page.waitForFunction(() => window.TRPNautilus && window.TRPNautilus.state === "title");
        if (play) await playToLog(page);
        await page.addScriptTag({ content: axe });
        const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id} (${x.nodes.length}): ${x.nodes[0].target.join(" ")}`));
        check(`no serious accessibility issues on the ${label}`, v.length === 0, v.join(" | "));
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nNautilus browser tests: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
