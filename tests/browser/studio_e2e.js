#!/usr/bin/env node
/**
 * Browser tests for TRP Studio. Serves the repository on a local port, opens
 * the Studio in headless Chromium with Playwright, and checks every pack and
 * mode, hostile imports, bad links, phone layout and basic accessibility.
 *
 * Run from the repository root:
 *   npm install --no-save playwright && npx playwright install chromium
 *   node tests/browser/studio_e2e.js
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".txt": "text/plain", ".md": "text/markdown" };

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
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && detail ? `  (${detail})` : ""}`);
}

async function newPage(browser, base, opts) {
  const page = await browser.newPage(opts || { viewport: { width: 1440, height: 900 } });
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errors.push("console: " + m.text()); });
  await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"stargazers_count":7}' }));
  await page.addInitScript(() => { window.alert = () => { window.__pwned = "alert"; }; });
  page.base = base;
  return page;
}

async function pwned(page) { return page.evaluate(() => window.__pwned || null); }

// The Content Security Policy blocks inline script on its own, which could
// hide an escaping bug. Hostile-input checks therefore run twice, once as
// shipped and once with the policy removed, so escaping is tested by itself.
async function withoutCsp(page) {
  await page.route(/\/studio\/(index\.html)?(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
    route.fulfill({ response: res, body });
  });
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const packs = JSON.parse(fs.readFileSync(path.join(ROOT, "studio/packs/index.json"), "utf-8")).packs.map((p) => p.id);

  try {
    // Every pack in every mode.
    for (const id of packs) {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?pack=${id}&story=0`);
      await page.waitForTimeout(1200);
      const standing = await page.textContent("#standing-word");
      check(`${id} live mode evaluates`, standing && standing.trim() !== "—", standing);
      for (const mode of ["arena", "stress", "learn"]) {
        const tab = page.locator(`.mode[data-mode=${mode}]`);
        if (await tab.isDisabled()) continue;
        await tab.click();
        await page.waitForTimeout(300);
        check(`${id} ${mode} panel opens`, await page.isVisible(`#${mode}-panel`));
      }
      check(`${id} has no page errors`, page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Arena and stress through the agent interface.
    {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(1000);
      const r = await page.evaluate(() => window.TRPGames.play({ event: "robot-cell", guards: ["second-sensor", "speed-limit"] }));
      check("agent play returns a medal against par", r && r.score === r.par && r.medal === "gold", JSON.stringify(r));
      const st = await page.evaluate(() => window.TRPGames.stress({ event: "robot-cell", episodes: 100 }));
      check("agent stress runs 100 episodes", st && st.episodes === 100, JSON.stringify(st && st.overall));
      const bad = await page.evaluate(() => { try { window.TRPGames.play({ event: "nope" }); return "no error"; } catch (e) { return e.message; } });
      check("agent play rejects an unknown event", bad !== "no error", bad);
      check("agent interface raises no page errors", page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Positive control. The payload must fire when the policy is removed and
    // the text is written as raw HTML, or the hostile checks prove nothing.
    {
      const page = await newPage(browser, base);
      await withoutCsp(page);
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(500);
      await page.evaluate(() => { const d = document.createElement("div"); d.innerHTML = '<img src=x onerror="window.__pwned=1">'; document.body.appendChild(d); });
      await page.waitForTimeout(300);
      check("positive control, raw HTML without the policy runs the payload", await pwned(page));
      await page.close();
    }
    for (const csp of [true, false]) {
      const tag = csp ? "" : " (policy removed)";
      // A Learn challenge, failed with the shipped limits and passed with better ones.
    {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?pack=fleet&story=0`);
      await page.waitForTimeout(800);
      await page.click(".mode[data-mode=learn]");
      await page.waitForTimeout(300);
      check("Learn lists four challenges", (await page.locator(".challenge").count()) === 4);
      await page.waitForSelector("#learn-codex .codex-item", { timeout: 5000 });
      check("Learn carries the glossary with every term open", (await page.locator("#learn-codex .codex-item").count()) === 24 && (await page.locator("#learn-codex .codex-item.locked").count()) === 0);
      await page.click("#learn-codex .codex-item[data-codex=operating-limits]");
      await page.waitForTimeout(200);
      check("a glossary entry opens at full depth with its case, the standard and a self-check", (await page.locator("#learn-codex .codex-section.trp").count()) === 1 && (await page.locator("#learn-codex .codex-basis").count()) === 1 && (await page.locator("#learn-codex .codex-option").count()) === 4);
      await page.click("#learn-codex .codex-option >> nth=0");
      check("the self-check grades", /^(Right|Not quite)\./.test(await page.textContent("#learn-codex .codex-result")));
      await page.click("#learn-codex .codex-back");
      await page.waitForTimeout(200);
      check("the glossary returns to its list", (await page.locator("#learn-codex .codex-item").count()) === 24);
      await page.click(".challenge[data-id=rush-job]");
      await page.waitForTimeout(500);
      check("opening a challenge switches to its pack", (await page.textContent("#pack-title")) === "Robot Cell");
      await page.click("#learn-test");
      await page.waitForTimeout(2500);
      check("shipped limits do not pass the challenge", /Not yet/.test(await page.textContent("#learn-out")));
      for (const [k, v] of [["critical", "1.75"], ["warning", "2.2"]]) {
        const sel = `input[data-sig=human_distance_m][data-k=${k}]`;
        await page.fill(sel, v);
        await page.dispatchEvent(sel, "change");
      }
      await page.click("#learn-test");
      await page.waitForTimeout(2500);
      check("better limits pass the challenge", /Challenge complete/.test(await page.textContent("#learn-out")));
      await page.fill("input[data-sig=human_distance_m][data-k=warning]", "0.5");
      await page.dispatchEvent("input[data-sig=human_distance_m][data-k=warning]", "change");
      await page.click("#learn-test");
      await page.waitForTimeout(500);
      check("limits in the wrong order are explained, not run", /safe side/.test(await page.textContent("#learn-out")));
      check("Learn raises no page errors", page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Hostile profile by link, served from the same site.
      {
        const page = await newPage(browser, base);
        if (!csp) await withoutCsp(page);
        await page.goto(`${base}/studio/?profile=${encodeURIComponent("../tests/fixtures/hostile-profile.json")}&story=0`);
        await page.waitForTimeout(1500);
        const title = await page.textContent("#pack-title");
        check(`hostile profile loads as text${tag}`, title.includes("<img"), title);
        for (const ev of await page.$$("#events li")) { await ev.click().catch(() => {}); }
        await page.waitForTimeout(300);
        check(`hostile profile runs no script${tag}`, !(await pwned(page)));
        await page.close();
      }

      // Hostile pack imported through the file picker, then played in every mode.
      {
        const page = await newPage(browser, base);
        if (!csp) await withoutCsp(page);
        await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
        await page.waitForTimeout(800);
        await page.setInputFiles("#file-input", path.join(ROOT, "tests/fixtures/hostile-pack.json"));
        await page.waitForTimeout(800);
        check(`hostile pack imports${tag}`, (await page.textContent("#pack-title")).includes("<img"));
        await page.click(".mode[data-mode=arena]");
        await page.waitForTimeout(300);
        const guard = page.locator("#arena-panel .guard").first();
        if (await guard.count()) await guard.click();
        const start = page.locator("#arena-start");
        if (await start.count()) { await start.click(); await page.waitForTimeout(1500); }
        await page.click(".mode[data-mode=stress]");
        await page.waitForTimeout(200);
        const run = page.locator("#stress-run");
        if (await run.count()) { await run.click(); await page.waitForTimeout(1500); }
        check(`hostile pack runs no script in any mode${tag}`, !(await pwned(page)));
        await page.close();
      }
    }

    // A full Arena match, fast-forwarded, for a shipped pack and for the
    // hostile pack with the policy removed, so the results panel is covered.
    for (const [label, setup] of [["robot-cell", null], ["hostile pack", "hostile"]]) {
      const page = await newPage(browser, base);
      if (setup) await withoutCsp(page);
      await page.clock.install();
      const query = setup ? `profile=${encodeURIComponent("../tests/fixtures/hostile-pack.json")}` : "pack=robot-cell";
      await page.goto(`${base}/studio/?${query}&story=0`);
      for (let i = 0; i < 40 && (await page.textContent("#pack-title")) === "Loading"; i++) { await page.waitForTimeout(100); await page.clock.runFor(100); }
      await page.click(".mode[data-mode=arena]");
      for (let i = 0; i < 40 && !(await page.locator("#arena-panel .guard").count()); i++) { await page.waitForTimeout(100); await page.clock.runFor(100); }
      await page.locator("#arena-panel .guard").first().click();
      await page.click("#arena-start");
      for (let i = 0; i < 70; i++) await page.clock.runFor(1000);
      const txt = await page.textContent("#arena-panel");
      check(`${label} Arena match reaches the results panel`, /Match over/.test(txt), txt.slice(0, 80));
      check(`${label} Arena match runs no script and raises no errors`, !(await pwned(page)) && page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Stored scores from other pages on the same site are not trusted.
    {
      const page = await newPage(browser, base);
      await withoutCsp(page);
      await page.addInitScript(() => { try { localStorage.setItem("trp-studio-best-robot-cell", JSON.stringify({ score: '<img src=x onerror="window.__pwned=1">' })); } catch (e) {} });
      await page.goto(`${base}/studio/?pack=robot-cell&story=0&mode=arena`);
      await page.waitForTimeout(1000);
      check("poisoned stored score runs no script", !(await pwned(page)) && page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Rejected inputs.
    {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(800);
      await page.setInputFiles("#file-input", path.join(ROOT, "tests/fixtures/hostile-threshold.json"));
      await page.waitForTimeout(400);
      const toast = await page.textContent(".toast").catch(() => "");
      check("profile with a text threshold is rejected", /must be a number/.test(toast || ""), toast);
      await page.close();
    }
    {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?profile=${encodeURIComponent("http://example.com/p.json")}&story=0`);
      await page.waitForTimeout(800);
      const toast = await page.textContent(".toast").catch(() => "");
      check("plain http profile link is refused", /https/.test(toast || ""), toast);
      check("refused link still opens a pack", (await page.textContent("#pack-title")) !== "Loading");
      await page.close();
    }
    for (const hash of ["#r=!!!!", "#r=" + "A".repeat(70000), "#r=" + Buffer.from(JSON.stringify({ p: "robot-cell", s: [[0.5, "speed", "<img src=x onerror=window.__pwned=1>"], [1, "speed", 1e308]] })).toString("base64")]) {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/${hash}`);
      await page.waitForTimeout(1200);
      check(`bad replay link handled (${hash.slice(0, 12)}…)`, page.errors.length === 0 && !(await pwned(page)), page.errors.join(" | "));
      await page.close();
    }

    // Share produces a replay link that plays back.
    {
      const page = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }).then((c) => c.newPage());
      page.errors = [];
      page.on("pageerror", (e) => page.errors.push(e.message));
      await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(800);
      const slider = page.locator("#controls input[type=range]").first();
      await slider.fill(String(await slider.getAttribute("max")));
      await slider.dispatchEvent("input");
      await page.waitForTimeout(400);
      await page.click("#share-btn");
      await page.waitForTimeout(300);
      const link = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
      check("share copies a replay link", /#r=/.test(link), link.slice(0, 80));
      if (/#r=/.test(link)) {
        await page.goto(link);
        await page.waitForTimeout(1500);
        check("replay link plays back without errors", page.errors.length === 0, page.errors.join(" | "));
      }
      await page.close();
    }

    // Phone layout.
    {
      const page = await newPage(browser, base, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(1000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone layout has no sideways scroll", overflow <= 1, `${overflow}px wider than the screen`);
      await page.close();
    }

    // Basic accessibility.
    {
      const page = await newPage(browser, base);
      await page.goto(`${base}/studio/?pack=robot-cell&story=0`);
      await page.waitForTimeout(800);
      const unnamed = await page.evaluate(() => [...document.querySelectorAll("button, a, input, select")]
        .filter((el) => el.offsetParent !== null && el.type !== "hidden")
        .filter((el) => !(el.getAttribute("aria-label") || el.textContent.trim() || el.title || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label")))
        .map((el) => el.outerHTML.slice(0, 80)));
      check("every visible control has a name", unnamed.length === 0, unnamed.join(" | "));
      const lang = await page.getAttribute("html", "lang");
      check("page declares a language", !!lang);
      await page.close();
    }

    // Automated accessibility audit with axe-core, when it is installed.
    let axeSource = null;
    try { axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8"); } catch (err) { console.log("SKIP  accessibility audit (npm install --no-save axe-core to run it)"); }
    if (axeSource) {
      for (const [url, learn] of [["/studio/?pack=robot-cell&story=0", false], ["/studio/?pack=robot-cell&story=0&mode=arena", false], ["/studio/?pack=robot-cell&story=0", true], ["/studio/lab.html", false]]) {
        const ctx = await browser.newContext({ bypassCSP: true });
        const page = await ctx.newPage();
        await page.route("https://api.github.com/**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
        await page.goto(base + url);
        await page.waitForTimeout(1000);
        if (learn) { await page.click(".mode[data-mode=learn]"); await page.click(".challenge[data-id=rush-job]"); await page.waitForTimeout(300); }
        await page.addScriptTag({ content: axeSource });
        const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id} (${x.nodes.length})`));
        check(`no serious accessibility issues on ${url}${learn ? " in Learn" : ""}`, v.length === 0, v.join(", "));
        await ctx.close();
      }
    }

    // Lab page with the dataset API stubbed.
    {
      const page = await newPage(browser, base);
      await page.route("https://datasets-server.huggingface.co/**", (r) => {
        const rows = [];
        for (let i = 0; i < 60; i++) rows.push({ row: { episode_index: 0, frame_index: i, timestamp: i / 30, "observation.state": [0, i, 0, 0, 0, 0], action: [0, i, 0, 0, 0, 0] } });
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ features: [], num_rows_total: 60, rows }) });
      });
      await page.goto(`${base}/studio/lab.html`);
      await page.waitForTimeout(600);
      await page.click("#lr-load");
      await page.waitForTimeout(1500);
      check("lab replays a stubbed episode", /60 frames/.test(await page.textContent("#lr-status")));
      check("lab has no page errors", page.errors.length === 0, page.errors.join(" | "));
      await page.close();
    }

    // Load and speed.
    {
      const page = await newPage(browser, base);
      const t0 = Date.now();
      await page.goto(`${base}/studio/?pack=fleet&story=0`, { waitUntil: "load" });
      const loadMs = Date.now() - t0;
      await page.waitForTimeout(2500);
      const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const s = performance.now(); (function f() { n++; if (performance.now() - s < 1000) requestAnimationFrame(f); else res(n); })(); }));
      check(`Studio loads in under 3 seconds (${loadMs} ms)`, loadMs < 3000);
      check(`Fleet keeps at least 30 frames a second headless (${fps})`, fps >= 30);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nStudio browser tests: ${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
