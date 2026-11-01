/**
 * The Captain's Codex renderer, shared by TRP Studio and Nautilus.
 *
 * Loads studio/codex.json and draws entries at three depths. Deckhand shows
 * the short definition and the game tie-in. Navigator adds the real-world
 * explanation and example. Captain adds the specification mapping and the
 * frameworks. Every element is built with DOM calls, never with HTML
 * strings, so the renderer is safe to use with any content file.
 */
(function (root) {
  "use strict";

  const DEPTHS = ["deckhand", "navigator", "captain"];
  let codex = null;
  let loading = null;
  let termIndex = null;

  function load(url) {
    if (codex) return Promise.resolve(codex);
    if (!loading) {
      loading = fetch(url, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`Could not load the codex (${r.status}).`);
        return r.json();
      }).then((data) => { codex = data; termIndex = buildTerms(data); return data; });
    }
    return loading;
  }

  function get() { return codex; }
  function entry(id) { return codex ? codex.entries.find((e) => e.id === id) || null : null; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // Alias and term lookup, longest first, so "hard rule" wins over "rule".
  function buildTerms(data) {
    const list = [];
    for (const e of data.entries) {
      for (const a of [e.term].concat(e.aliases || [])) list.push({ text: a.toLowerCase(), id: e.id });
    }
    list.sort((a, b) => b.text.length - a.text.length);
    return list;
  }

  function findTerm(text) {
    if (!termIndex) return null;
    const t = String(text).toLowerCase();
    return termIndex.find((x) => x.text === t) || null;
  }

  // Wrap the first occurrence of each known term inside an element's text
  // nodes with a button that opens the entry.
  function markTerms(container, onOpen, opts) {
    if (!termIndex) return 0;
    const o = opts || {};
    const max = o.max || 6;
    const seen = new Set();
    let count = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (count >= max) break;
      if (node.parentNode && node.parentNode.closest && node.parentNode.closest("button, a, .term, code")) continue;
      let text = node.nodeValue;
      for (const t of termIndex) {
        if (count >= max) break;
        if (seen.has(t.id) || t.text.length < 4) continue;
        const re = new RegExp(`\\b(${t.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\b`, "i");
        const m = re.exec(text);
        if (!m) continue;
        const before = text.slice(0, m.index), word = m[1], after = text.slice(m.index + word.length);
        const btn = el("button", "term", word);
        btn.type = "button";
        btn.dataset.codex = t.id;
        btn.setAttribute("aria-label", `${word}, open codex entry`);
        btn.addEventListener("click", () => onOpen(t.id));
        const frag = document.createDocumentFragment();
        frag.append(before, btn);
        const rest = document.createTextNode(after);
        frag.append(rest);
        node.parentNode.replaceChild(frag, node);
        seen.add(t.id);
        count++;
        // Continue scanning the remainder of this text node.
        text = after;
        nodes.push(rest);
        break;
      }
    }
    return count;
  }

  function renderList(container, opts) {
    const o = opts || {};
    container.textContent = "";
    const discovered = o.discovered || null;
    for (const depth of DEPTHS) {
      const group = codex.entries.filter((e) => e.level === depth);
      if (!group.length) continue;
      const head = el("div", "codex-group");
      head.append(el("h3", "codex-group-title", codex.levels[depth]));
      head.append(el("p", "codex-group-sub", o.subtitles ? o.subtitles[depth] || "" : ""));
      const ul = el("div", "codex-list");
      for (const e of group) {
        const b = el("button", "codex-item");
        b.type = "button";
        b.dataset.codex = e.id;
        const found = !discovered || discovered.has(e.id);
        if (!found) b.classList.add("locked");
        b.append(el("span", "codex-item-term", e.term));
        b.append(el("span", "codex-item-short", found ? e.short : (o.lockedText || "Discover this on a voyage.")));
        if (o.done && o.done.has(e.id)) b.append(el("span", "codex-item-done", "Checked"));
        b.addEventListener("click", () => o.onOpen && o.onOpen(e.id));
        ul.append(b);
      }
      head.append(ul);
      container.append(head);
    }
  }

  function renderEntry(container, e, opts) {
    const o = opts || {};
    const depth = DEPTHS.indexOf(o.depth || "captain");
    container.textContent = "";
    const head = el("div", "codex-head");
    head.append(el("div", "codex-eyebrow", `${codex.levels[e.level]} entry`));
    head.append(el("h2", "codex-term", e.term));
    head.append(el("p", "codex-short", e.short));
    container.append(head);

    const section = (title, text, cls) => {
      const s = el("section", "codex-section " + (cls || ""));
      s.append(el("h4", "codex-section-title", title));
      const p = el("p", "codex-text", text);
      s.append(p);
      return s;
    };
    container.append(section(o.gameLabel || "On the voyage", e.game, "game"));
    if (depth >= 1) {
      container.append(section("In the world", e.world, "world"));
      const ex = section("A case", e.example.text, "example");
      ex.append(el("p", "codex-basis", "Based on " + e.example.basis));
      container.append(ex);
    }
    if (depth >= 2) {
      const trp = section("In the standard", e.trp.text, "trp");
      const link = el("a", "codex-spec", `Trust Requirements Profile specification, section ${e.trp.spec}`);
      link.href = (o.specBase || "https://github.com/aitrustalliance/trp/blob/main/spec/trp-spec.md");
      link.target = "_blank"; link.rel = "noopener";
      trp.append(link);
      container.append(trp);
      if (e.frameworks && e.frameworks.length) {
        const f = el("section", "codex-section frameworks");
        f.append(el("h4", "codex-section-title", "On the wider map"));
        const ul = el("ul", "codex-frameworks");
        for (const x of e.frameworks) ul.append(el("li", null, x));
        f.append(ul);
        container.append(f);
      }
    }
    if (depth < 2) {
      const more = el("button", "codex-more", depth === 0 ? "Go deeper, Navigator" : "Go deeper, Captain");
      more.type = "button";
      more.addEventListener("click", () => renderEntry(container, e, Object.assign({}, o, { depth: DEPTHS[depth + 1] })));
      container.append(more);
    }
    if (o.learnMore && o.learnMore.url) {
      const a = el("a", "codex-learn", o.learnMore.label || "Courses on this topic");
      a.href = o.learnMore.url; a.target = "_blank"; a.rel = "noopener";
      container.append(a);
    }
    if (o.check !== false) container.append(renderCheck(e, o));
    if (e.related && e.related.length && o.onOpen) {
      const rel = el("section", "codex-section related");
      rel.append(el("h4", "codex-section-title", "See also"));
      const row = el("div", "codex-related");
      for (const id of e.related) {
        const r = entry(id);
        if (!r) continue;
        const b = el("button", "codex-chip", r.term);
        b.type = "button";
        b.addEventListener("click", () => o.onOpen(id));
        row.append(b);
      }
      rel.append(row);
      container.append(rel);
    }
  }

  function renderCheck(e, o) {
    const q = e.check;
    const box = el("section", "codex-section check");
    box.append(el("h4", "codex-section-title", "Check yourself"));
    box.append(el("p", "codex-question", q.question));
    const list = el("div", "codex-options");
    const result = el("p", "codex-result");
    result.setAttribute("aria-live", "polite");
    q.options.forEach((text, i) => {
      const b = el("button", "codex-option", text);
      b.type = "button";
      b.addEventListener("click", () => {
        for (const x of list.children) x.disabled = true;
        const right = i === q.answer;
        b.classList.add(right ? "right" : "wrong");
        if (!right) list.children[q.answer].classList.add("right");
        result.textContent = (right ? "Right. " : "Not quite. ") + q.why;
        if (o.onCheck) o.onCheck(e.id, right);
      });
      list.append(b);
    });
    box.append(list, result);
    return box;
  }

  // Pick n questions, preferring entries the player has discovered.
  function examination(n, discovered, rng) {
    const pool = codex.entries.filter((e) => !discovered || discovered.has(e.id));
    const source = pool.length >= n ? pool : codex.entries;
    const r = rng || Math.random;
    const copy = source.slice();
    for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
    return copy.slice(0, n);
  }

  const api = { load, get, entry, findTerm, markTerms, renderList, renderEntry, renderCheck, examination, DEPTHS };
  root.TRPCodex = api;
})(window);
