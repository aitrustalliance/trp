#!/usr/bin/env python3
"""Checks the VTR v0.6 reference code. Both verifiers, Python and Node.js, must return the expected
result on every test vector in vtr/vectors, and they must agree with each other. Both accept VTR 0.5
receipts, and only on those the deprecated JOSE identifier EdDSA.

    pip install cryptography && python tests/vtr_check.py
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vtr" / "tools"))
import vtr  # noqa: E402

passed, failed = 0, []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
        print(f"FAIL  {name}  {detail}")


def read(rel):
    return json.loads((ROOT / rel).read_text()) if rel else None


NODE = r"""
const v = require(process.argv[1]); const fs = require("fs"); const path = require("path");
const root = process.argv[2]; const out = {};
for (const d of ["valid", "invalid"]) for (const f of fs.readdirSync(path.join(root, "vtr/vectors", d)).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(root, "vtr/vectors", d, f), "utf8"));
  const rd = (p) => (p ? JSON.parse(fs.readFileSync(path.join(root, p), "utf8")) : null);
  const opts = { profile: rd(t.profile), evidence: rd(t.evidence), allowEdDSA: t.allow_eddsa };
  const r = typeof t.receipt === "string" ? v.verify(t.receipt, rd(t.jwks), opts) : v.verifyBatched(t.receipt, rd(t.jwks), opts);
  out[d + "/" + f] = r[1];
}
console.log(JSON.stringify(out));
"""


def main():
    node = json.loads(subprocess.run(["node", "-e", NODE, str(ROOT / "vtr/tools/vtr_verify.js"), str(ROOT)],
                                     capture_output=True, text=True, check=True).stdout)
    count = {"valid": 0, "invalid": 0}
    for d in ("valid", "invalid"):
        for f in sorted((ROOT / "vtr/vectors" / d).glob("*.json")):
            t = json.loads(f.read_text())
            kw = dict(profile=read(t["profile"]), evidence=read(t["evidence"]), allow_eddsa=t["allow_eddsa"])
            jwks = read(t["jwks"])
            ok, reason = vtr.verify(t["receipt"], jwks, **kw) if isinstance(t["receipt"], str) else vtr.verify_batched(t["receipt"], jwks, **kw)
            key = f"{d}/{f.name}"
            check(f"Python verifier on {key}", reason == t["expect"] and ok == (d == "valid"), reason)
            check(f"Node.js verifier on {key}", node.get(key) == t["expect"], node.get(key))
            count[d] += 1
    check("at least 29 valid and 20 invalid vectors", count["valid"] >= 29 and count["invalid"] >= 20, count)
    valid = [vector_claims(f"valid/{f.name}") for f in (ROOT / "vtr/vectors/valid").glob("*.json")]
    check("every kind has a valid vector", {c["kind"] for c in valid} == vtr.KINDS, sorted({c["kind"] for c in valid}))
    check("every mode has a valid vector", {c["mode"] for c in valid} == vtr.MODES, sorted({c["mode"] for c in valid}))
    for name in ("unknown-kid", "missing-subject", "coverage-out-of-range", "eddsa-on-vtr-0.6", "ed25519-not-allowed", "eddsa-not-allowed"):
        check(f"the invalid vector {name} exists", (ROOT / "vtr/vectors/invalid" / f"{name}.json").exists())

    # RFC 8785 numbers: the Python canonical form must equal ECMAScript's for awkward values.
    nums = [0, 1, 1.0, 0.83, 1e-7, 1e21, 1.5e21, 123.456, 0.0001, 1e-6, 2.5e-5, 4.35, 0.1 + 0.2, -12.5, 5e-324, 1.7976931348623157e308, 1e20]
    js = json.loads(subprocess.run(["node", "-e", f"console.log(JSON.stringify({json.dumps(nums)}.map(x => JSON.stringify(x))))"],
                                   capture_output=True, text=True, check=True).stdout)
    check("canonical numbers match ECMAScript", [vtr.canonical(n) for n in nums] == js)
    awkward = {"nums": nums, "text": "a\u0000\u001f\"\\\u007f é\U0001F600", "keys": {"\U0001F600": 1, "דּ": 2, "a": 3},
               "nil": None, "flag": True, "list": [{"b": 1, "a": [2, 0.5]}]}
    node_eval = json.loads(subprocess.run(
        ["node", "-e", "const t = require(process.argv[1]); console.log(JSON.stringify(t.canonicalJson(JSON.parse(require('fs').readFileSync(0, 'utf8')))))",
         str(ROOT / "tools/evaluate.js")], input=json.dumps(awkward), capture_output=True, text=True, check=True).stdout)
    check("both evaluators write the same RFC 8785 form as the receipt library",
          vtr.trp.canonical_json(awkward) == vtr.canonical(awkward) == node_eval, (vtr.trp.canonical_json(awkward), node_eval))
    check("canonical keys sort by UTF-16 code units", vtr.canonical({"\U0001F600": 1, "דּ": 2, "a": 3}) == '{"a":3,"\U0001F600":1,"דּ":2}')

    # Every leaf of every tree size from 1 to 33 proves its way to the signed root, and only its own position does.
    key = vtr.Key.generate()
    p1 = read("examples/manufacturing-safety/trp.json")
    ev = read("vtr/vectors/evidence/healthy.json")
    base = vtr.claims_for(p1, ev, iss="https://evaluator.example.com", sub="urn:example:cell:01", iat=1793700000)
    ok_all, wrong_pos = True, True
    for n in range(1, 34):
        batch = vtr.sign_batch([dict(base, nonce=str(i)) for i in range(n)], key, base["iss"], iat=1793700000)
        for i, r in enumerate(batch):
            ok_all &= vtr.verify_batched(r, key.jwks())[0]
            if n > 1:
                moved = json.loads(json.dumps(r))
                moved["proof"]["leaf_index"] = (i + 1) % n
                wrong_pos &= not vtr.verify_batched(moved, key.jwks())[0]
    check("inclusion proofs verify for every leaf of trees of 1 to 33 receipts", ok_all)
    check("a proof moved to another position fails", wrong_pos)
    interior = vtr.sign_batch([dict(base, nonce=str(i)) for i in range(4)], key, base["iss"], iat=1793700000)
    node_as_leaf = json.loads(json.dumps(interior[0]))
    node_as_leaf["proof"]["path"] = node_as_leaf["proof"]["path"][1:]  # claim leaf 0 sits one level up, beside the right subtree
    node_as_leaf["proof"]["tree_size"] = 2
    check("a proof that presents a leaf as an interior node fails", not vtr.verify_batched(node_as_leaf, key.jwks())[0])

    # Emitter and both command line verifiers agree end to end.
    tmp = ROOT / "vtr" / ".check"
    tmp.mkdir(exist_ok=True)
    try:
        (tmp / "key.pem").write_text(key.pem())
        (tmp / "jwks.json").write_text(json.dumps(key.jwks()))
        jws = subprocess.run([sys.executable, str(ROOT / "vtr/tools/vtr_emit.py"), "--profile", str(ROOT / "examples/manufacturing-safety/trp.json"),
                              "--evidence", str(ROOT / "vtr/vectors/evidence/warning.json"), "--key", str(tmp / "key.pem"),
                              "--iss", "https://evaluator.example.com", "--sub", "urn:example:cell:09", "--nonce", "abc"],
                             capture_output=True, text=True, check=True).stdout.strip()
        (tmp / "r.jws").write_text(jws)
        args = [str(tmp / "r.jws"), "--jwks", str(tmp / "jwks.json"), "--profile", str(ROOT / "examples/manufacturing-safety/trp.json"),
                "--evidence", str(ROOT / "vtr/vectors/evidence/warning.json")]
        py = subprocess.run([sys.executable, str(ROOT / "vtr/tools/vtr_verify.py")] + args, capture_output=True, text=True)
        js = subprocess.run(["node", str(ROOT / "vtr/tools/vtr_verify.js")] + args, capture_output=True, text=True)
        check("the emitter's receipt verifies in both command line verifiers", py.stdout.strip() == "valid" == js.stdout.strip() and py.returncode == js.returncode == 0, (py.stdout, js.stdout))
        claims = json.loads(vtr.unb64u(jws.split(".")[1]))
        check("the receipt carries no score", "score" not in claims and "aria" not in json.dumps(claims).lower())
        bands = {b["band"] for b in p1["standing_bands"]}
        check("coverage and standing are separate claims, and the standing names a band of the profile",
              isinstance(claims["coverage"], (int, float)) and set(claims["standing"]) == {"result", "band", "response"}
              and claims["standing"]["band"] in bands, claims["standing"])
    finally:
        for f in tmp.iterdir():
            f.unlink()
        tmp.rmdir()

    algorithm_checks()
    standing_checks()
    result_digest_checks()
    coverage_checks()
    mistyped_signal_checks()
    rounding_checks()
    gate_receipts()
    schema_check()
    print(f"VTR: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


NODE_BATCHED = r"""
const v = require(process.argv[1]); const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(t.receipts.map((r) => v.verifyBatched(r, t.jwks, { allowEdDSA: true })[1])));
"""


def header_of(jws):
    return json.loads(vtr.unb64u(jws.split(".")[0]))


def algorithm_checks():
    """RFC 9864 names Ed25519 signatures Ed25519 and deprecates EdDSA. VTR 0.6 signs with Ed25519 and accepts EdDSA only
    on a VTR 0.5 receipt. ES256 is fully specified in JOSE already and does not change."""
    seen = []
    for f in sorted((ROOT / "vtr/vectors/valid").glob("*.json")):
        r = json.loads(f.read_text())["receipt"]
        jws = r if isinstance(r, str) else r["proof"]["batch"]
        seen.append((header_of(jws)["alg"], json.loads(vtr.unb64u(jws.split(".")[1]))["vtr_version"]))
    check("the valid vectors sign VTR 0.6 with ES256 or Ed25519 and carry EdDSA only on VTR 0.5",
          all((alg == "EdDSA") == (ver == "0.5") for alg, ver in seen) and {a for a, v in seen if v == "0.6"} == {"ES256", "Ed25519"}, seen)
    jwks = read("vtr/vectors/keys/jwks.json")
    check("the published Ed25519 key names its algorithm Ed25519, as RFC 9864 Section 5 describes",
          [k["alg"] for k in jwks["keys"] if k["kty"] == "OKP"] == ["Ed25519"], jwks)
    p1, healthy = read("examples/manufacturing-safety/trp.json"), read("vtr/vectors/evidence/healthy.json")
    ed, es = vtr.Key.generate("Ed25519"), vtr.Key.generate()
    claims = vtr.claims_for(p1, healthy, iss="https://evaluator.example.com", sub="urn:example:cell:01", iat=1793700000)
    signed = vtr.sign(claims, ed)
    check("a new receipt is VTR 0.6 and an Ed25519 key signs it as Ed25519",
          claims["vtr_version"] == "0.6" and header_of(signed)["alg"] == "Ed25519" and header_of(vtr.sign(claims, es))["alg"] == "ES256")
    check("the library refuses to sign a new VTR 0.5 receipt",
          reason(vtr.sign, dict(claims, vtr_version="0.5"), es) == "a new receipt must be VTR 0.6")
    check("a key generated under the older name EdDSA is an Ed25519 key", vtr.Key.generate("EdDSA").alg == "Ed25519")
    legacy = dict(claims, vtr_version="0.5")
    cases = [
        ("a VTR 0.5 receipt signed with EdDSA", vtr._jws(legacy, _named(ed, "EdDSA"), vtr.TYP), ed, "valid"),
        ("a VTR 0.6 receipt signed with EdDSA", vtr._jws(claims, _named(ed, "EdDSA"), vtr.TYP), ed, "EdDSA is allowed only on a VTR 0.5 receipt"),
        ("a VTR 0.5 receipt whose EdDSA header names a P-256 key", vtr._jws(legacy, _named(es, "EdDSA"), vtr.TYP), es, "alg does not match the key type"),
        ("a receipt signed under the COSE identifier ESP256", vtr._jws(claims, _named(es, "ESP256"), vtr.TYP), es, "alg ESP256 is not allowed"),
        ("a receipt that declares VTR 0.7", vtr._jws(dict(claims, vtr_version="0.7"), es, vtr.TYP), es, "vtr_version must be 0.5 or 0.6"),
    ]
    for name, jws, key, want in cases:
        py = vtr.verify(jws, key.jwks(), allow_eddsa=True)[1]
        js = node(NODE_VERIFY_ALLOWED, {"receipts": [jws], "jwks": key.jwks()})[0]
        check(f"both verifiers on {name} return: {want}", py == js == want, (py, js))
    batch = vtr.sign_batch([claims, dict(claims, nonce="1")], ed, claims["iss"], iat=1793700000)
    check("a batch signs as VTR 0.6 under Ed25519", header_of(batch[0]["proof"]["batch"])["alg"] == "Ed25519"
          and json.loads(vtr.unb64u(batch[0]["proof"]["batch"].split(".")[1]))["vtr_version"] == "0.6")
    statement = json.loads(vtr.unb64u(batch[0]["proof"]["batch"].split(".")[1]))
    old_statement = vtr._jws(dict(statement, vtr_version="0.5"), _named(ed, "EdDSA"), vtr.BATCH_TYP)
    batched = [
        ("a VTR 0.6 batch under Ed25519", batch[0], "valid"),
        ("a VTR 0.6 batch statement signed with EdDSA",
         dict(batch[0], proof=dict(batch[0]["proof"], batch=vtr._jws(statement, _named(ed, "EdDSA"), vtr.BATCH_TYP))),
         "EdDSA is allowed only on a VTR 0.5 receipt"),
        ("a VTR 0.5 batch statement signed with EdDSA over VTR 0.6 claims",
         dict(batch[0], proof=dict(batch[0]["proof"], batch=old_statement)), "the batch statement is malformed"),
    ]
    for name, r, want in batched:
        py = vtr.verify_batched(r, ed.jwks(), allow_eddsa=True)[1]
        js = node(NODE_BATCHED, {"receipts": [r], "jwks": ed.jwks()})[0]
        check(f"both verifiers on {name} return: {want}", py == js == want, (py, js))
    # Emitter and both command line verifiers agree end to end for a fresh Ed25519 key.
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        pem = subprocess.run([sys.executable, str(ROOT / "vtr/tools/vtr_emit.py"), "--new-key", "ed25519"],
                             capture_output=True, text=True, check=True).stdout
        (tmp / "key.pem").write_text(pem)
        (tmp / "jwks.json").write_text(subprocess.run([sys.executable, str(ROOT / "vtr/tools/vtr_emit.py"), "--jwks", str(tmp / "key.pem")],
                                                      capture_output=True, text=True, check=True).stdout)
        profile, evidence = str(ROOT / "examples/manufacturing-safety/trp.json"), str(ROOT / "vtr/vectors/evidence/healthy.json")
        jws = subprocess.run([sys.executable, str(ROOT / "vtr/tools/vtr_emit.py"), "--profile", profile, "--evidence", evidence,
                              "--key", str(tmp / "key.pem"), "--iss", "https://evaluator.example.com", "--sub", "urn:example:cell:10"],
                             capture_output=True, text=True, check=True).stdout.strip()
        (tmp / "r.jws").write_text(jws)
        args = [str(tmp / "r.jws"), "--jwks", str(tmp / "jwks.json"), "--profile", profile, "--evidence", evidence]
        runs = [subprocess.run(cmd + args + flag, capture_output=True, text=True)
                for flag in (["--allow-eddsa"], []) for cmd in ([sys.executable, str(ROOT / "vtr/tools/vtr_verify.py")], ["node", str(ROOT / "vtr/tools/vtr_verify.js")])]
        out = [r.stdout.strip() for r in runs]
        check("the emitter signs with a fresh Ed25519 key as Ed25519, and both command line verifiers accept it only when allowed",
              header_of(jws)["alg"] == "Ed25519" and out == ["valid", "valid"] + ["Ed25519 receipts are refused unless the verifier allows Ed25519"] * 2, out)


class _named:
    """A key that writes another identifier into the header, to build receipts an issuer must not sign."""

    def __init__(self, key, alg):
        self.key, self.alg = key, alg

    def jwk(self):
        return self.key.jwk()

    def sign(self, data):
        return self.key.sign(data)


def gate_receipts():
    """The TRP gate signs a receipt for every decision, and each one re-runs from the decision log's evidence."""
    import tempfile
    sys.path.insert(0, str(ROOT / "adapters" / "frameworks"))
    from _common import DEFAULT_PROFILE, make_gate
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        key = vtr.Key.generate()
        (tmp / "key.pem").write_text(key.pem())
        ws = tmp / "ws"
        (ws / "notes").mkdir(parents=True)
        (ws / "notes" / "plan.txt").write_text("Ship the report on Friday.\n")
        policy = {"workspace": str(ws), "approved_tools": ["read_text_file", "write_file", "fetch"],
                  "tools": {"read_text_file": {"kind": "read", "path_args": ["path"]}, "write_file": {"kind": "write", "path_args": ["path"]},
                            "fetch": {"kind": "egress", "url_args": ["url"]}},
                  "allowed_domains": ["example.com"], "halt_scope": "call"}
        gate = make_gate(policy, session=tmp / "s.json", log=tmp / "log.jsonl", source="filesystem",
                         receipts=tmp / "receipts.jws", receipt_key=tmp / "key.pem", issuer="https://gate.example.com")
        a = gate.check_call("read_text_file", {"path": "notes/plan.txt"}, call_id=1)
        gate.check_result(a, ["Ship the report on Friday."])
        gate.check_call("fetch", {"url": "https://collector.example.net/x"}, call_id=2)
        gate.check_call("write_file", {"path": "draft.txt", "content": "x"}, call_id=3)
        recs = [json.loads(x) for x in (tmp / "log.jsonl").read_text().splitlines()]
        jwss = (tmp / "receipts.jws").read_text().split()
        check("the gate signs one receipt per decision", len(jwss) == len(recs) == 4, (len(jwss), len(recs)))
        profile = json.loads(Path(DEFAULT_PROFILE).read_text())
        js_all, prev = True, None
        for rec, jws in zip(recs, jwss):
            ok, reason = vtr.verify(jws, key.jwks(), profile=profile, evidence=rec["evidence"])
            check(f"gate receipt for {rec['phase']} {rec['tool']} re-runs from the logged evidence", ok, reason)
            (tmp / "r.jws").write_text(jws)
            (tmp / "e.json").write_text(json.dumps(rec["evidence"]))
            (tmp / "p.json").write_text(json.dumps(profile))
            (tmp / "k.json").write_text(json.dumps(key.jwks()))
            js = subprocess.run(["node", str(ROOT / "vtr/tools/vtr_verify.js"), str(tmp / "r.jws"), "--jwks", str(tmp / "k.json"),
                                 "--profile", str(tmp / "p.json"), "--evidence", str(tmp / "e.json")], capture_output=True, text=True)
            js_all &= js.stdout.strip() == "valid"
            claims = json.loads(vtr.unb64u(jws.split(".")[1]))
            check(f"gate receipt for {rec['tool']} chains to the one before it", claims.get("prev") == prev)
            prev = vtr.digest(claims)
        check("the Node.js verifier accepts every gate receipt", js_all)
        verdicts = [json.loads(vtr.unb64u(j.split(".")[1]))["outcome"] for j in jwss]
        check("gate verdicts map to allow, stop and escalate", verdicts == ["allow", "allow", "stop", "escalate"], verdicts)
        check("each decision log line carries its own receipt under the log's SHA-256 chain", [r["receipt"] for r in recs] == jwss)
        shapes = [json.loads(vtr.unb64u(j.split(".")[1]))["standing"] for j in jwss]
        check("every gate receipt carries the standing as result, band and response",
              all(isinstance(s, dict) and set(s) == {"result", "band", "response"} for s in shapes), shapes)
        digests = [json.loads(vtr.unb64u(j.split(".")[1]))["result_digest"] for j in jwss]
        check("every gate receipt's result_digest is the digest of the evaluator output for its logged evidence",
              digests == [vtr.digest(vtr.evaluator_output(profile, rec["evidence"])) for rec in recs])


NODE_DETERMINE = r"""
const v = require(process.argv[1]); const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(cases.map((c) => v.determination(c.profile, c.evidence))));
"""

NODE_VERIFY = r"""
const v = require(process.argv[1]); const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(t.receipts.map((r) => v.verify(r, t.jwks, { profile: t.profile, evidence: t.evidence })[1])));
"""

NODE_VERIFY_ALLOWED = r"""
const v = require(process.argv[1]); const t = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(t.receipts.map((r) => v.verify(r, t.jwks, { allowEdDSA: true })[1])));
"""


def node(script, data):
    return json.loads(subprocess.run(["node", "-e", script, str(ROOT / "vtr/tools/vtr_verify.js")], input=json.dumps(data),
                                     capture_output=True, text=True, check=True).stdout)


def vector_claims(name):
    r = json.loads((ROOT / "vtr/vectors" / name).read_text())["receipt"]
    return json.loads(vtr.unb64u(r.split(".")[1])) if isinstance(r, str) else r["claims"]


def reason(fn, *args):
    try:
        fn(*args)
        return "valid"
    except vtr.VTRError as err:
        return str(err)


def standing_checks():
    """Standing is a result with the band and the response, and missing evidence gives the incomplete result."""
    p1 = read("examples/manufacturing-safety/trp.json")
    ev = {n: read(f"vtr/vectors/evidence/{n}.json") for n in ("healthy", "estop", "missing", "mistyped", "critical_missing")}
    seen = {vector_claims(f"valid/{f.name}")["standing"]["result"] for f in (ROOT / "vtr/vectors/valid").glob("*.json")}
    check("the valid vectors carry every standing result", seen == {"meets", "does_not_meet", "incomplete"}, seen)
    incomplete = {"result": "incomplete", "band": None, "response": None}
    check("a receipt whose required signal is missing carries the incomplete result",
          vector_claims("valid/es256-missing-signal-lowers-coverage.json")["standing"] == incomplete)
    check("a receipt whose hard rule field has the wrong type carries the incomplete result",
          vector_claims("valid/es256-mistyped-rule-field.json")["standing"] == incomplete)
    check("healthy evidence meets the profile in its best band",
          vector_claims("valid/es256-healthy.json")["standing"] == {"result": "meets", "band": "good", "response": "full"})
    check("a triggered hard rule does not meet the profile",
          vector_claims("valid/es256-hard-rule-violated.json")["standing"] == {"result": "does_not_meet", "band": "failing", "response": "suspended"})
    both = {k: v for k, v in ev["estop"].items() if k != "vibration_rms_g"}
    failing = {"result": "does_not_meet", "band": "failing", "response": "suspended"}
    check("a triggered hard rule gives does_not_meet even when a required signal is missing",
          vtr.determination(p1, both)["standing"] == failing)
    check("the vector with a triggered hard rule and a missing signal carries does_not_meet and coverage 0.9",
          vector_claims("valid/es256-violated-rule-and-missing-signal.json")["standing"] == failing
          and vector_claims("valid/es256-violated-rule-and-missing-signal.json")["coverage"] == 0.9)
    both_mistyped = dict(both, safety_certification_status=1)
    check("a triggered hard rule gives does_not_meet even when another hard rule is inconclusive",
          vtr.determination(p1, both_mistyped)["standing"] == failing)
    one_band = {"trp_id": "one", "version": "1", "spec_version": "0.5", "standing_bands": [{"band": "only", "severity": 0}],
                "hard_rules": [{"rule": "stop", "field": "stop", "condition": "is_true", "action": "halt"}]}
    check("a triggered hard rule gives does_not_meet even when the profile's only band is acceptable",
          vtr.determination(one_band, {"stop": True})["standing"]["result"] == "does_not_meet")
    check("the vector with a critical signal and a missing signal carries does_not_meet and coverage 0.9",
          vector_claims("valid/es256-critical-signal-and-missing-signal.json")["standing"] == failing
          and vector_claims("valid/es256-critical-signal-and-missing-signal.json")["coverage"] == 0.9)
    check("a signal in its critical range gives does_not_meet even when a required signal is missing",
          vtr.determination(p1, ev["critical_missing"])["standing"] == failing)
    critical_mistyped = dict(ev["healthy"], temperature_C=85, safety_certification_status=1)
    check("a signal in its critical range gives does_not_meet even when a hard rule is inconclusive",
          vtr.determination(p1, critical_mistyped)["standing"] == failing)
    worst_ok = json.loads(json.dumps(p1))
    worst_ok["required_standing"]["minimum_acceptable_band"] = "failing"
    critical = dict(ev["healthy"], temperature_C=85)
    check("a critical signal beside missing evidence stays incomplete when the worst band meets the profile",
          vtr.determination(worst_ok, ev["critical_missing"])["standing"] == incomplete
          and vtr.determination(worst_ok, critical)["standing"] == {"result": "meets", "band": "failing", "response": "suspended"})
    ignored = json.loads(json.dumps(p1))
    for s in ignored["scored_signals"]:
        if s["signal"] == "vibration_rms_g":
            s["on_missing"] = "ignore"
    d = vtr.determination(ignored, ev["missing"])
    check("a missing signal the profile declares ignore leaves the result complete and lowers only coverage",
          d["standing"]["result"] == "meets" and d["coverage"] == 0.9, d)
    floor = json.loads(json.dumps(p1))
    floor["required_standing"]["minimum_acceptable_band"] = "good"
    review = dict(ev["healthy"], robot_speed_mm_s=950)
    got = (vtr.determination(p1, review)["standing"], vtr.determination(floor, review)["standing"])
    check("a band at the profile's minimum acceptable band meets it and a band below it does not",
          got[0]["band"] == got[1]["band"] == "review" and got[0]["result"] == "meets" and got[1]["result"] == "does_not_meet", got)
    ff = read("tests/profiles/valid/full-featured.json")
    crit = vtr.determination(ff, {k: v for k, v in read("tests/evidence/missing-critical-signal.json").items() if not k.startswith("_")})
    acc = next(x["outcome"] for x in crit["results"] if x["clause"] == "signal:accuracy")
    check("a missing signal the profile declares critical puts the standing in the worst band and stays out of coverage",
          crit["standing"] == {"result": "does_not_meet", "band": "untrusted", "response": "suspended"} and acc == "inconclusive"
          and crit["coverage"] == 0.8889, crit)
    both_absent = {k: v for k, v in read("tests/evidence/missing-critical-signal.json").items() if not k.startswith("_") and k != "bias_score"}
    check("a missing signal declared critical gives does_not_meet even when a required signal is also missing",
          vtr.determination(ff, both_absent)["standing"] == {"result": "does_not_meet", "band": "untrusted", "response": "suspended"})
    zw = read("tests/profiles/valid/zero-weight-signal.json")
    zd = [vtr.determination(zw, {k: v for k, v in read(f"tests/evidence/{n}.json").items() if not k.startswith("_")})
          for n in ("zero-weight-critical-value", "zero-weight-missing")]
    good = {"result": "meets", "band": "good", "response": None}
    check("a signal with weight 0 never changes the standing, in its critical range or missing with on_missing critical or incomplete",
          [x["standing"] for x in zd] == [good, good], zd)
    check("a signal with weight 0 still reports its outcome and counts toward coverage",
          {x["clause"]: x["outcome"] for x in zd[0]["results"]}["signal:observed_metric"] == "violated"
          and zd[0]["coverage"] == 1.0 and zd[1]["coverage"] == 0.3333, zd)
    js = node(NODE_DETERMINE, [{"profile": p1, "evidence": both}, {"profile": ignored, "evidence": ev["missing"]},
                               {"profile": p1, "evidence": review}, {"profile": floor, "evidence": review},
                               {"profile": p1, "evidence": both_mistyped}, {"profile": one_band, "evidence": {"stop": True}},
                               {"profile": p1, "evidence": critical_mistyped}, {"profile": worst_ok, "evidence": ev["critical_missing"]},
                               {"profile": worst_ok, "evidence": critical}, {"profile": ff, "evidence": both_absent}])
    check("the Node.js verifier derives the same standings", [x["standing"] for x in js] ==
          [vtr.determination(p1, both)["standing"], d["standing"], got[0], got[1], vtr.determination(p1, both_mistyped)["standing"],
           vtr.determination(one_band, {"stop": True})["standing"], vtr.determination(p1, critical_mistyped)["standing"],
           vtr.determination(worst_ok, ev["critical_missing"])["standing"], vtr.determination(worst_ok, critical)["standing"],
           vtr.determination(ff, both_absent)["standing"]], js)
    base = vector_claims("valid/es256-healthy.json")
    shapes = [("good", "standing must carry exactly result, band and response"),
              ({"result": "pass", "band": "good", "response": "full"}, "standing result must be meets, does_not_meet or incomplete"),
              ({"result": "incomplete", "band": "failing", "response": None}, "an incomplete standing carries a null band and a null response"),
              ({"result": "meets", "band": None, "response": None}, "a standing of meets or does_not_meet names its band"),
              ({"result": "meets", "band": "good", "response": "unknown"}, "standing response must be full, restricted, suspended, revoked or null")]
    py = [reason(vtr.check_claims, dict(base, standing=s)) for s, _ in shapes]
    check("the Python verifier refuses each malformed standing", py == [m for _, m in shapes], py)
    key = vtr.Key.generate()
    receipts = [vtr._jws(dict(base, standing=s), key, vtr.TYP) for s, _ in shapes]
    js = node(NODE_VERIFY, {"receipts": receipts, "jwks": key.jwks(), "profile": None, "evidence": None})
    check("the Node.js verifier refuses each malformed standing with the same reason", js == py, js)


def result_digest_checks():
    """result_digest is the digest of the evaluator output, and both verifiers compute the same one."""
    import hashlib
    sys.path.insert(0, str(ROOT / "tools"))
    import evaluate as trp
    cases = []
    for f in sorted((ROOT / "tests/profiles/valid").glob("*.json")):
        prof = json.loads(f.read_text())
        if "extends" in prof:
            continue
        for e in sorted((ROOT / "tests/evidence").glob("*.json")):
            cases.append((f.name, e.name, prof, {k: v for k, v in json.loads(e.read_text()).items() if not k.startswith("_")}))
    for f in sorted((ROOT / "vtr/vectors/valid").glob("*.json")):
        t = json.loads(f.read_text())
        if t["profile"] and t["evidence"]:
            cases.append((t["profile"], t["evidence"], read(t["profile"]), read(t["evidence"])))
    py = [vtr.determination(p, e) for _, _, p, e in cases]
    js = node(NODE_DETERMINE, [{"profile": p, "evidence": e} for _, _, p, e in cases])
    differ = [f"{a} + {b}" for (a, b, _, _), x, y in zip(cases, py, js) if x != y]
    check(f"Python and Node.js verifiers derive the same determination and result_digest on {len(cases)} profile and evidence pairs", not differ, differ[:3])
    claims = vector_claims("valid/es256-healthy.json")
    p1, healthy = read("examples/manufacturing-safety/trp.json"), read("vtr/vectors/evidence/healthy.json")
    r = trp.evaluate(trp.profile_from_dict(p1), healthy)
    out = {k: v for k, v in r.items() if k != "evaluation"}
    check("result_digest is the digest of the evaluator output without its evaluation member", claims["result_digest"] == vtr.digest(out))
    check("the evaluator's result_hash is the SHA-256 of the same canonical form, so it is result_digest in hexadecimal",
          r["evaluation"]["result_hash"] == hashlib.sha256(vtr.canonical(out).encode()).hexdigest() == vtr.unb64u(claims["result_digest"]).hex())
    changed = dict(claims, coverage=0.5)
    check("result_digest does not cover the claims, so a changed coverage leaves it the same and the re-run catches the change",
          reason(vtr.check_against, changed, p1, healthy) == "coverage does not match a re-run of the evaluation")


def coverage_checks():
    """A requirement counts as checked only when its outcome is satisfied, warning or violated."""
    p1 = read("examples/manufacturing-safety/trp.json")
    d = vtr.determination(p1, read("vtr/vectors/evidence/mistyped.json"))
    rule = next(x for x in d["results"] if x["clause"] == "rule:safety_certification_expired")
    check("a hard rule whose field is present with the wrong type is inconclusive and not counted as checked",
          rule["outcome"] == "inconclusive" and d["coverage"] == 0.9, (rule, d["coverage"]))
    check("the mistyped vector carries coverage 0.9", vector_claims("valid/es256-mistyped-rule-field.json")["coverage"] == 0.9)
    wide = {"trp_id": "wide", "version": "1", "spec_version": "0.5", "standing_bands": [{"band": "good", "severity": 0}],
            "hard_rules": [{"rule": f"r{i:02d}", "field": f"f{i:02d}", "condition": "is_true", "action": "halt"} for i in range(32)]}
    empty = {"trp_id": "empty", "version": "1", "spec_version": "0.5", "standing_bands": [{"band": "good", "severity": 0}]}
    py = [vtr.determination(wide, {"f00": False})["coverage"], vtr.determination(wide, {f"f{i:02d}": False for i in range(3)})["coverage"],
          vtr.determination(empty, {})["coverage"]]
    js = [x["coverage"] for x in node(NODE_DETERMINE, [{"profile": wide, "evidence": {"f00": False}},
                                                        {"profile": wide, "evidence": {f"f{i:02d}": False for i in range(3)}},
                                                        {"profile": empty, "evidence": {}}])]
    check("coverage rounds half to even at four places and is 1 with no requirements, in both verifiers", py == js == [0.0312, 0.0938, 1.0], (py, js))
    many = dict(wide, hard_rules=[{"rule": f"r{i:03d}", "field": f"f{i:03d}", "condition": "is_true", "action": "halt"} for i in range(160)])
    py = vtr.determination(many, {"f000": False})["coverage"]
    js = node(NODE_DETERMINE, [{"profile": many, "evidence": {"f000": False}}])[0]["coverage"]
    check("coverage of 1 in 160 rounds the exact value of the double, which lies just above 0.00625, in both verifiers", py == js == 0.0063, (py, js))


def mistyped_signal_checks():
    """A scored signal whose value is not a finite number is never scored, and its on_missing governs (TRP Section 3.3)."""
    p1 = read("examples/manufacturing-safety/trp.json")
    healthy = read("vtr/vectors/evidence/healthy.json")
    ff = read("tests/profiles/valid/full-featured.json")
    base = {k: v for k, v in read("tests/evidence/all-healthy.json").items() if not k.startswith("_")}
    cases = [(p1, dict(healthy, vibration_rms_g="0.64"), "vibration_rms_g"),
             (p1, dict(healthy, vibration_rms_g=True), "vibration_rms_g"),
             (ff, dict(base, accuracy="0.97"), "accuracy"),
             (ff, dict(base, uptime_ratio="down"), "uptime_ratio")]
    py = [vtr.determination(p, e) for p, e, _ in cases]
    outcome = [next(x["outcome"] for x in d["results"] if x["clause"] == f"signal:{n}") for d, (_, _, n) in zip(py, cases)]
    check("a scored signal whose value has the wrong type is inconclusive and not counted as checked",
          outcome == ["inconclusive"] * 4 and [d["coverage"] for d in py] == [0.9, 0.9, 0.8889, 0.8889], (outcome, [d["coverage"] for d in py]))
    incomplete = {"result": "incomplete", "band": None, "response": None}
    check("a mistyped scored signal with on_missing incomplete gives the incomplete result, as text or as a boolean",
          py[0]["standing"] == incomplete and py[1]["standing"] == incomplete, (py[0]["standing"], py[1]["standing"]))
    check("a mistyped scored signal gives the same determination as the missing signal apart from the result digest",
          {k: v for k, v in py[0].items() if k != "result_digest"}
          == {k: v for k, v in vtr.determination(p1, read("vtr/vectors/evidence/missing.json")).items() if k != "result_digest"})
    check("a mistyped scored signal with on_missing critical puts the standing in the worst band",
          py[2]["standing"] == {"result": "does_not_meet", "band": "untrusted", "response": "suspended"}, py[2]["standing"])
    check("a mistyped scored signal with on_missing ignore leaves the result complete",
          py[3]["standing"] == {"result": "meets", "band": "trusted", "response": "full"}, py[3]["standing"])
    out = vtr.evaluator_output(p1, cases[0][1])
    check("the evaluator output lists a mistyped scored signal in missing_signals with the reason type_mismatch",
          out["missing_signals"] == [{"signal": "vibration_rms_g", "on_missing": "incomplete", "reason": "type_mismatch"}]
          and "vibration_rms_g" not in {x["signal"] for x in out["signal_results"]}, out["missing_signals"])
    js = node(NODE_DETERMINE, [{"profile": p, "evidence": e} for p, e, _ in cases])
    check("the Node.js verifier derives the same determination and result_digest for each mistyped scored signal", js == py, js)


NODE_ROUND = r"""
const r = require(process.argv[1]).roundHalfEven; const v = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(v.map((x) => r(x, 4))));
"""


def rounding_checks():
    """The Node.js evaluator rounds every value to four places exactly as Python's round does."""
    vals = [(k + 0.5) / 100000 for k in range(20000)] + [k / 2 ** 15 for k in range(4000)]
    vals += [2.675, 1.00005, 0.00015, 0.00625, -0.03125, 5e-324, 1e15 + 0.03125, 123456789.00005, 546.875 / 1500]
    js = json.loads(subprocess.run(["node", "-e", NODE_ROUND, str(ROOT / "tools/evaluate.js")], input=json.dumps(vals),
                                   capture_output=True, text=True, check=True).stdout)
    bad = [(v, j, round(v, 4)) for v, j in zip(vals, js) if j != round(v, 4)]
    check(f"the Node.js evaluator rounds {len(vals)} ties and near ties as Python does", not bad, bad[:3])


def schema_check():
    try:
        import jsonschema
    except ImportError:
        return
    schema = json.loads((ROOT / "vtr/schema/vtr.schema.json").read_text())
    jsonschema.Draft202012Validator.check_schema(schema)
    v = jsonschema.Draft202012Validator(schema)
    bad = []
    for f in sorted((ROOT / "vtr/vectors/valid").glob("*.json")):
        bad += [f"{f.name}: {e.message}" for e in v.iter_errors(vector_claims(f"valid/{f.name}"))]
    check("every valid vector's claims pass the JSON Schema", not bad, bad[:3])
    # The schema states the claim rules, so it must reject exactly the invalid vectors whose claims break one.
    # The others fail on the signature, a digest, a re-run or a batch proof, which no schema can see.
    disagree, rejected = [], []
    for f in sorted((ROOT / "vtr/vectors/invalid").glob("*.json")):
        c = vector_claims(f"invalid/{f.name}")
        by_rule = reason(vtr.check_claims, c) != "valid"
        by_schema = not v.is_valid(c)
        if by_rule != by_schema:
            disagree.append(f.name)
        if by_schema:
            rejected.append(f.stem)
    check("the JSON Schema rejects every invalid vector whose claims break a claim rule, and only those", not disagree, disagree)
    check("the JSON Schema rejects the missing subject and the coverage out of range",
          {"missing-subject", "coverage-out-of-range"} <= set(rejected), rejected)
    base = vector_claims("valid/es256-healthy.json")
    check("the JSON Schema rejects a standing given as a band name", not v.is_valid(dict(base, standing="good")))
    check("the JSON Schema rejects an incomplete standing that names a band",
          not v.is_valid(dict(base, standing={"result": "incomplete", "band": "failing", "response": None})))


if __name__ == "__main__":
    sys.exit(main())
