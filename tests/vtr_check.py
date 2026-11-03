#!/usr/bin/env python3
"""Checks the VTR v0.5 reference code. Both verifiers, Python and Node.js, must return the expected
result on every test vector in vtr/vectors, and they must agree with each other.

    pip install cryptography && python tests/vtr_check.py
"""
import json
import subprocess
import sys
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
    check("at least 20 valid and 10 invalid vectors", count["valid"] >= 20 and count["invalid"] >= 10, count)

    # RFC 8785 numbers: the Python canonical form must equal ECMAScript's for awkward values.
    nums = [0, 1, 1.0, 0.83, 1e-7, 1e21, 1.5e21, 123.456, 0.0001, 1e-6, 2.5e-5, 4.35, 0.1 + 0.2, -12.5, 5e-324, 1.7976931348623157e308, 1e20]
    js = json.loads(subprocess.run(["node", "-e", f"console.log(JSON.stringify({json.dumps(nums)}.map(x => JSON.stringify(x))))"],
                                   capture_output=True, text=True, check=True).stdout)
    check("canonical numbers match ECMAScript", [vtr.canonical(n) for n in nums] == js)
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
        check("coverage and standing are separate claims, and standing is a band of the profile", isinstance(claims["coverage"], (int, float)) and claims["standing"] in bands, claims["standing"])
    finally:
        for f in tmp.iterdir():
            f.unlink()
        tmp.rmdir()

    gate_receipts()
    schema_check()
    print(f"VTR: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


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
        r = json.loads(f.read_text())["receipt"]
        claims = json.loads(vtr.unb64u(r.split(".")[1])) if isinstance(r, str) else r["claims"]
        bad += [f"{f.name}: {e.message}" for e in v.iter_errors(claims)]
    check("every valid vector's claims pass the JSON Schema", not bad, bad[:3])


if __name__ == "__main__":
    sys.exit(main())
