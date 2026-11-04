#!/usr/bin/env node
// Verifiable Trust Receipt (VTR) v0.5 verifier for Node.js, written apart from the Python reference so the two
// can be checked against each other on every test vector. Needs Node.js 18 or later and nothing else.
//
//   node vtr/tools/vtr_verify.js receipt.jws --jwks jwks.json [--profile trp.json --evidence evidence.json] [--allow-eddsa]
//   node vtr/tools/vtr_verify.js batched.json --jwks jwks.json ...      a receipt from a signed batch
//
// Prints "valid" or the first reason the receipt fails, and exits 0 or 1.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const trp = require(path.join(__dirname, "..", "..", "tools", "evaluate.js"));

const VTR_VERSION = "0.5";
const KINDS = new Set(["evaluation", "conformance", "drill", "variance"]);
const MODES = new Set(["enforced", "test", "shadow", "observed"]);
const OUTCOMES = new Set(["satisfied", "warning", "violated", "inconclusive"]);
const RESULTS = new Set(["meets", "does_not_meet", "incomplete"]);
const RESPONSES = new Set(["full", "restricted", "suspended", "revoked"]);
const VERDICTS = new Set(["allow", "stop", "escalate"]);
const REQUIRED = ["vtr_version", "iss", "iat", "sub", "kind", "mode", "trp_ref", "standing", "coverage", "results",
  "evidence_digest", "result_digest", "evaluator"];
const OPTIONAL = ["window", "nonce", "prev", "risk", "evaluators", "build", "fallback", "principal", "on_behalf_of", "agent",
  "model", "tool", "cost", "outcome", "trp_clauses", "policy_digest", "input_digest", "escalation", "details"];

class VTRError extends Error {}
const fail = (m) => { throw new VTRError(m); };

// RFC 8785: JSON.stringify gives ECMAScript number and string forms, and keys sort by UTF-16 code units.
function canonical(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") { if (!Number.isFinite(v)) fail("NaN and infinity have no JSON form"); return JSON.stringify(v); }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  fail(`${typeof v} is not a JSON value`);
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function unb64u(text) {
  if (typeof text !== "string" || text.includes("=") || !/^[A-Za-z0-9_-]*$/.test(text)) fail("base64url text must not carry padding");
  return Buffer.from(text, "base64url");
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest();
const digest = (v) => b64u(sha(Buffer.from(canonical(v), "utf8")));

function thumbprint(jwk) {
  const req = jwk.kty === "EC" ? ["crv", "kty", "x", "y"] : ["crv", "kty", "x"];
  return b64u(sha(Buffer.from(JSON.stringify(Object.fromEntries(req.map((k) => [k, jwk[k]]))), "utf8")));
}

const round4 = (x) => trp.roundHalfEven(x, 4);  // half to even at four places on the exact value, as Python rounds

// The Node.js evaluator's output with no drift history and without its `evaluation` member, which carries the
// evaluation time and the evaluator's name. Every other member matches the Python evaluator's.
function evaluatorOutput(profileRaw, evidence) {
  const { evaluation, ...out } = trp.evaluate(trp.profileFromObject(profileRaw), evidence);
  return out;
}

// A triggered hard rule is a known violation and gives does_not_meet even when other evidence is missing.
// A critical condition, a scored signal in its critical range or one missing with on_missing critical, sets the worst
// band whatever else is missing, so it gives does_not_meet even when other evidence is missing whenever that band does
// not meet the profile. Otherwise missing required evidence or an inconclusive hard rule gives incomplete, and then the
// band decides. A signal with weight 0 is informational under TRP Section 3.3 and never changes the standing.
function standingOf(profileRaw, out) {
  const severity = new Map((profileRaw.standing_bands || []).map((b) => [b.band, b.severity]));
  const band = severity.has(out.standing) ? out.standing : null;
  const response = RESPONSES.has(out.response) ? out.response : null;
  if (out.hard_rules_triggered.length > 0) return { result: "does_not_meet", band, response };
  const informational = new Set((profileRaw.scored_signals || []).filter((s) => s.weight === 0).map((s) => s.signal));
  const present = out.signal_results.filter((s) => !informational.has(s.signal));
  const missing = out.missing_signals.filter((m) => !informational.has(m.signal));
  const critical = present.some((s) => s.in_critical) || missing.some((m) => m.on_missing === "critical");
  const incomplete = missing.some((m) => m.on_missing === "incomplete") || (out.hard_rules_inconclusive || []).length > 0;
  const floor = (profileRaw.required_standing || {}).minimum_acceptable_band;
  const limit = severity.has(floor) ? severity.get(floor) : severity.size ? Math.min(...severity.values()) : null;
  const meets = band !== null && limit !== null && severity.get(band) <= limit;
  if (incomplete && (meets || !critical)) return { result: "incomplete", band: null, response: null };
  return { result: meets ? "meets" : "does_not_meet", band, response };
}

function determination(profileRaw, evidence) {
  const out = evaluatorOutput(profileRaw, evidence);
  const results = [];
  const bySignal = Object.fromEntries(out.signal_results.map((s) => [s.signal, s]));
  for (const s of profileRaw.scored_signals || []) {
    let outcome = "inconclusive";
    if (bySignal[s.signal]) { const x = bySignal[s.signal]; outcome = x.in_critical ? "violated" : x.in_warning ? "warning" : "satisfied"; }
    results.push({ clause: `signal:${s.signal}`, outcome });
  }
  const triggered = new Set(out.hard_rules_triggered.map((x) => x.rule));
  const inconclusive = new Set((out.hard_rules_inconclusive || []).map((x) => x.rule));
  for (const h of profileRaw.hard_rules || []) {
    results.push({ clause: `rule:${h.rule}`, outcome: inconclusive.has(h.rule) ? "inconclusive" : triggered.has(h.rule) ? "violated" : "satisfied" });
  }
  results.sort((a, b) => (a.clause < b.clause ? -1 : a.clause > b.clause ? 1 : 0));
  const checked = results.filter((x) => x.outcome !== "inconclusive").length;  // a check is made only when it has an outcome
  const total = results.length;
  return { standing: standingOf(profileRaw, out), coverage: total === 0 ? 1 : round4(checked / total), results, result_digest: digest(out) };
}

const trpRef = (p) => ({ id: p.trp_id, version: p.version, digest: digest(p) });

function checkStanding(s) {
  if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).sort().join() !== "band,response,result") fail("standing must carry exactly result, band and response");
  if (!RESULTS.has(s.result)) fail("standing result must be meets, does_not_meet or incomplete");
  if (s.band !== null && (typeof s.band !== "string" || !s.band)) fail("standing band must be a band name or null");
  if (s.response !== null && !RESPONSES.has(s.response)) fail("standing response must be full, restricted, suspended, revoked or null");
  if (s.result === "incomplete" && (s.band !== null || s.response !== null)) fail("an incomplete standing carries a null band and a null response");
  if (s.result !== "incomplete" && s.band === null) fail("a standing of meets or does_not_meet names its band");
}

function checkClaims(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) fail("claims must be a JSON object");
  for (const k of REQUIRED) if (!(k in c)) fail(`missing required claim ${k}`);
  for (const k of Object.keys(c)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) fail(`unknown claim ${k}`);
  if (c.vtr_version !== VTR_VERSION) fail(`vtr_version must be ${VTR_VERSION}`);
  if (!Number.isInteger(c.iat)) fail("iat must be integer Unix seconds");
  for (const k of ["iss", "sub", "evidence_digest", "result_digest"]) if (typeof c[k] !== "string" || !c[k]) fail(`${k} must be a non-empty string`);
  if (!KINDS.has(c.kind)) fail(`unknown kind ${c.kind}`);
  if (!MODES.has(c.mode)) fail(`unknown mode ${c.mode}`);
  const ref = c.trp_ref;
  if (!ref || typeof ref !== "object" || Object.keys(ref).sort().join() !== "digest,id,version") fail("trp_ref must carry exactly id, version and digest");
  checkStanding(c.standing);
  if (typeof c.coverage !== "number" || c.coverage < 0 || c.coverage > 1) fail("coverage must be a number from 0 to 1");
  if (!Array.isArray(c.results) || c.results.some((x) => !x || typeof x !== "object" || Object.keys(x).sort().join() !== "clause,outcome")) fail("each result must carry exactly clause and outcome");
  if (c.results.some((x) => !OUTCOMES.has(x.outcome))) fail("result outcome must be satisfied, warning, violated or inconclusive");
  const clauses = c.results.map((x) => x.clause);
  if (clauses.join("\u0000") !== [...clauses].sort().join("\u0000")) fail("results must be sorted by clause");
  const ev = c.evaluator;
  if (!ev || typeof ev !== "object" || !["implementation", "version", "spec_version"].every((k) => k in ev)) fail("evaluator must carry implementation, version and spec_version");
  if ("outcome" in c && c.outcome !== null && !VERDICTS.has(c.outcome)) fail("outcome must be allow, stop or escalate");
  if ("risk" in c && c.risk !== null && !(typeof c.risk === "object" && Object.keys(c.risk).length === 0)) fail("risk must be empty in VTR v0.5");
  if (c.kind !== "evaluation" && !(c.details && typeof c.details === "object" && !Array.isArray(c.details))) fail(`kind ${c.kind} requires a details object`);
}

function publicKey(jwk) {
  if (jwk.kty === "EC" && jwk.crv === "P-256") return { alg: "ES256", key: crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" }) };
  if (jwk.kty === "OKP" && jwk.crv === "Ed25519") return { alg: "EdDSA", key: crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }) };
  fail("the key set holds a key type VTR does not allow");
}

function open(jws, jwks, typ, allowEdDSA) {
  const parts = typeof jws === "string" ? jws.split(".") : [];
  if (parts.length !== 3) fail("not a compact JWS");
  let header, payload, sig;
  try { header = JSON.parse(unb64u(parts[0]).toString("utf8")); payload = JSON.parse(unb64u(parts[1]).toString("utf8")); sig = unb64u(parts[2]); }
  catch (err) { if (err instanceof VTRError) throw err; fail(`malformed JWS (${err.message})`); }
  if (!header || typeof header !== "object" || Object.keys(header).sort().join() !== "alg,kid,typ") fail("the protected header must carry exactly alg, kid and typ");
  if (header.typ !== typ) fail(`typ must be ${typ}`);
  if (header.alg === "EdDSA" && !allowEdDSA) fail("EdDSA receipts are refused unless the verifier allows EdDSA");
  if (header.alg !== "ES256" && header.alg !== "EdDSA") fail(`alg ${header.alg} is not allowed`);
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) fail("no key in the key set has this kid");
  if (thumbprint(jwk) !== header.kid) fail("kid is not the RFC 7638 thumbprint of its key");
  const pk = publicKey(jwk);
  if (pk.alg !== header.alg) fail("alg does not match the key type");
  const data = Buffer.from(parts[0] + "." + parts[1], "ascii");
  const ok = pk.alg === "ES256"
    ? sig.length === 64 && crypto.verify("sha256", data, { key: pk.key, dsaEncoding: "ieee-p1363" }, sig)
    : crypto.verify(null, data, pk.key, sig);
  if (!ok) fail("bad signature");
  if (parts[0] !== b64u(Buffer.from(canonical(header))) || parts[1] !== b64u(Buffer.from(canonical(payload)))) fail("header or payload is not in RFC 8785 canonical form");
  return payload;
}

function checkAgainst(c, profile, evidence) {
  if (profile && canonical(c.trp_ref) !== canonical(trpRef(profile))) fail("trp_ref does not match the supplied profile");
  if (evidence && c.evidence_digest !== digest(evidence)) fail("evidence_digest does not match the supplied evidence");
  if (profile && evidence) {
    const d = determination(profile, evidence);
    if (c.result_digest !== d.result_digest) fail("result_digest does not match a re-run of the evaluation");
    if (canonical(c.standing) !== canonical(d.standing)) fail("standing does not match a re-run of the evaluation");
    if (canonical(c.results) !== canonical(d.results)) fail("results do not match a re-run of the evaluation");
    if (c.coverage !== d.coverage) fail("coverage does not match a re-run of the evaluation");
  }
}

const leaf = (d) => sha(Buffer.concat([Buffer.from([0]), d]));
const node = (l, r) => sha(Buffer.concat([Buffer.from([1]), l, r]));

function rootFromPath(index, size, leafHash, pathHashes) {  // RFC 9162 section 2.1.3.2
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return null;
  let fn = index, sn = size - 1, r = leafHash;
  for (const p of pathHashes) {
    if (sn === 0) return null;
    if (fn % 2 === 1 || fn === sn) {
      r = node(p, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else r = node(r, p);
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 ? r : null;
}

function verify(jws, jwks, opts = {}) {
  try { const c = open(jws, jwks, "vtr+jwt", opts.allowEdDSA); checkClaims(c); checkAgainst(c, opts.profile, opts.evidence); return [true, "valid"]; }
  catch (err) { if (err instanceof VTRError) return [false, err.message]; throw err; }
}

function verifyBatched(receipt, jwks, opts = {}) {
  try {
    if (!receipt || typeof receipt !== "object" || Object.keys(receipt).sort().join() !== "claims,proof") fail("a batched receipt carries exactly claims and proof");
    const { claims, proof } = receipt;
    checkClaims(claims);
    const batch = open(proof.batch, jwks, "vtr-batch+jwt", opts.allowEdDSA);
    if (Object.keys(batch).sort().join() !== "iat,iss,root,tree_size,vtr_version" || batch.vtr_version !== VTR_VERSION) fail("the batch statement is malformed");
    if (batch.iss !== claims.iss) fail("the batch was signed by another issuer");
    if (proof.tree_size !== batch.tree_size) fail("tree_size does not match the signed batch");
    const root = rootFromPath(proof.leaf_index, proof.tree_size, leaf(unb64u(digest(claims))), (proof.path || []).map(unb64u));
    if (!root || b64u(root) !== batch.root) fail("the inclusion proof does not lead to the signed root");
    checkAgainst(claims, opts.profile, opts.evidence);
    return [true, "valid"];
  } catch (err) { if (err instanceof VTRError) return [false, err.message]; if (err instanceof TypeError) return [false, `malformed batched receipt (${err.message})`]; throw err; }
}

module.exports = { canonical, digest, thumbprint, verify, verifyBatched, determination, evaluatorOutput };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
  const read = (f) => (f ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
  const target = a[0];
  if (!target || !opt("--jwks")) { console.error("usage: vtr_verify.js RECEIPT --jwks JWKS [--profile P --evidence E] [--allow-eddsa]"); process.exit(2); }
  const text = fs.readFileSync(target, "utf8").trim();
  const opts = { profile: read(opt("--profile")), evidence: read(opt("--evidence")), allowEdDSA: a.includes("--allow-eddsa") };
  const [ok, reason] = text.startsWith("{") ? verifyBatched(JSON.parse(text), read(opt("--jwks")), opts) : verify(text, read(opt("--jwks")), opts);
  console.log(reason);
  process.exit(ok ? 0 : 1);
}
