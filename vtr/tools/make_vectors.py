#!/usr/bin/env python3
"""Writes the VTR v0.5 test vectors in vtr/vectors from fixed test keys.

    python vtr/tools/make_vectors.py

The keys in vtr/vectors/keys exist only to sign these vectors. Never use them for real receipts. ECDSA
signatures are randomized, so a rerun changes every ES256 signature and leaves every other byte the same.
"""
import base64
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vtr  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "vtr" / "vectors"
KEYS = OUT / "keys"
IAT = 1793700000  # 2026-11-03T08:00:00Z, fixed so vectors do not depend on the clock
ISS = "https://evaluator.example.com"
P1 = "examples/manufacturing-safety/trp.json"
P2 = "adapters/mcp/profiles/mcp-tool-checkpoint.trp.json"


def load(rel):
    return json.loads((ROOT / rel).read_text())


def keys():
    KEYS.mkdir(parents=True, exist_ok=True)
    out = {}
    for name, alg in (("issuer-es256", "ES256"), ("issuer-eddsa", "EdDSA")):
        pem = KEYS / f"{name}.pem"
        if not pem.exists():
            pem.write_text(vtr.Key.generate(alg).pem())
        out[alg] = vtr.Key.load(pem)
    (KEYS / "jwks.json").write_text(json.dumps({"keys": [out["ES256"].jwk(), out["EdDSA"].jwk()]}, indent=2) + "\n")
    return out


def resign(jws, key, change):
    """The same receipt with its claims changed by `change`, signed again so only the change is wrong."""
    payload = jws.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    change(claims)
    header = {"alg": key.alg, "kid": key.jwk()["kid"], "typ": "vtr+jwt"}
    si = vtr.b64u(vtr.canonical(header).encode()) + "." + vtr.b64u(vtr.canonical(claims).encode())
    return si + "." + vtr.b64u(key.sign(si.encode()))


def main():
    k = keys()
    es, ed = k["ES256"], k["EdDSA"]
    p1, p2 = load(P1), load(P2)
    healthy = {"human_distance_m": 1.8, "robot_speed_mm_s": 600, "vibration_rms_g": 0.64, "temperature_C": 56,
               "model_confidence": 0.94, "data_quality": 0.97, "estop_active": False, "safety_certification_status": "valid"}
    ev = {
        "healthy": healthy,
        "estop": dict(healthy, estop_active=True),
        "missing": {x: y for x, y in healthy.items() if x != "vibration_rms_g"},
        "warning": dict(healthy, robot_speed_mm_s=1100),
        "mistyped": dict(healthy, safety_certification_status=1),  # a number where the rule compares a string
        "estop_missing": {x: y for x, y in dict(healthy, estop_active=True).items() if x != "vibration_rms_g"},
    }
    gate = {"steps_per_task": 3, "tool_error_rate": 0.0, "calls_per_minute": 3, "egress_kb_session": 0.0,
            "unapproved_tool_called": False, "secret_in_arguments": False, "output_destination_approved": True,
            "path_outside_workspace": False, "sensitive_data_in_egress": False, "write_without_approval": False,
            "secret_in_tool_result": False, "instructions_in_tool_result": False}
    ev["tool_allow"] = gate
    ev["tool_stop"] = dict(gate, output_destination_approved=False, steps_per_task=4)
    ev["tool_review"] = dict(gate, write_without_approval=True, steps_per_task=5)
    evdir = OUT / "evidence"
    evdir.mkdir(parents=True, exist_ok=True)
    for name, e in ev.items():
        (evdir / f"{name}.json").write_text(json.dumps(e, indent=2) + "\n")

    def c(profile, e, **kw):
        return vtr.claims_for(profile, ev[e], iss=ISS, sub=kw.pop("sub", "urn:example:cell:01"), iat=IAT, **kw)

    first = c(p1, "healthy")
    tool = lambda name, verdict, e, **kw: c(p2, e, sub="urn:example:agent:assistant-7", tool={"name": name, "target": "filesystem"},  # noqa: E731
                                           outcome=verdict, input_digest=vtr.digest({"tool": name, "arguments": {"path": "notes/plan.txt"}}),
                                           agent={"id": "assistant-7", "version": "1.4.0"}, **kw)
    window = {"start": "2026-11-03T07:55:00Z", "end": "2026-11-03T08:00:00Z"}
    valid = [
        ("es256-healthy", vtr.sign(first, es), P1, "healthy", False),
        ("es256-hard-rule-violated", vtr.sign(c(p1, "estop"), es), P1, "estop", False),
        ("es256-missing-signal-lowers-coverage", vtr.sign(c(p1, "missing"), es), P1, "missing", False),
        ("es256-mistyped-rule-field", vtr.sign(c(p1, "mistyped"), es), P1, "mistyped", False),
        ("es256-violated-rule-and-missing-signal", vtr.sign(c(p1, "estop_missing"), es), P1, "estop_missing", False),
        ("es256-warning", vtr.sign(c(p1, "warning"), es), P1, "warning", False),
        ("es256-window", vtr.sign(c(p1, "healthy", window=window), es), P1, "healthy", False),
        ("es256-nonce", vtr.sign(c(p1, "healthy", nonce="b3J2WkFWb3ZqZWhR"), es), P1, "healthy", False),
        ("es256-prev", vtr.sign(c(p1, "warning", prev=vtr.digest(first)), es), P1, "warning", False),
        ("es256-window-nonce-prev", vtr.sign(c(p1, "estop", window=window, nonce="Zm9vYmFy", prev=vtr.digest(first)), es), P1, "estop", False),
        ("eddsa-healthy", vtr.sign(c(p1, "healthy"), ed), P1, "healthy", True),
        ("eddsa-window-nonce", vtr.sign(c(p1, "missing", window=window, nonce="cXV4"), ed), P1, "missing", True),
        ("es256-signature-only", vtr.sign(c(p1, "estop"), es), None, None, False),
        ("agent-tool-allow", vtr.sign(tool("read_text_file", "allow", "tool_allow"), es), P2, "tool_allow", False),
        ("agent-tool-stop", vtr.sign(tool("fetch", "stop", "tool_stop", trp_clauses=["rule:unapproved_destination"]), es), P2, "tool_stop", False),
        ("agent-tool-escalate", vtr.sign(tool("write_file", "escalate", "tool_review", trp_clauses=["rule:write_without_approval"]), es), P2, "tool_review", False),
        ("mode-shadow", vtr.sign(c(p1, "estop", mode="shadow"), es), P1, "estop", False),
        ("kind-drill", vtr.sign(c(p1, "estop", kind="drill", details={"app": "robot-cell", "forced_failure": "estop_active", "from": "full", "to": "suspended", "result": "stopped"}), es), P1, "estop", False),
        ("kind-conformance", vtr.sign(c(p1, "healthy", kind="conformance", details={
            "suite": {"id": "robot-cell-suite", "version": "3", "digest": vtr.digest({"suite": "robot-cell-suite", "version": "3"})},
            "outgoing": {"id": "cell-controller", "version": "2.1.0"}, "incoming": {"id": "cell-controller", "version": "2.2.0"},
            "result": "pass"}), es), P1, "healthy", False),
        ("kind-variance", vtr.sign(c(p1, "warning", kind="variance", details={"runs": 5, "distinct_standings": 1, "distinct_result_digests": 1}), es), P1, "warning", False),
        ("mode-test", vtr.sign(c(p1, "healthy", mode="test"), es), P1, "healthy", False),
        ("mode-observed", vtr.sign(c(p1, "missing", mode="observed"), es), P1, "missing", False),
    ]
    batch = vtr.sign_batch([c(p1, e, sub=f"urn:example:cell:0{i}") for i, e in enumerate(["healthy", "estop", "missing", "warning", "healthy"], 1)], es, ISS, iat=IAT)
    single = vtr.sign_batch([c(p1, "healthy")], es, ISS, iat=IAT)
    valid += [("batch-of-5-leaf-0", batch[0], P1, "healthy", False), ("batch-of-5-leaf-2", batch[2], P1, "missing", False),
              ("batch-of-5-leaf-4", batch[4], None, None, False), ("batch-of-1", single[0], P1, "healthy", False)]

    by_name = {v[0]: v[1] for v in valid}
    healthy_jws = by_name["es256-healthy"]
    bad_sig = healthy_jws[:-4] + ("AAAA" if healthy_jws[-4:] != "AAAA" else "BBBB")
    wrong_typ = healthy_jws.split(".")
    hdr = {"alg": "ES256", "kid": es.jwk()["kid"], "typ": "JWT"}
    si = vtr.b64u(vtr.canonical(hdr).encode()) + "." + wrong_typ[1]
    wrong_typ = si + "." + vtr.b64u(es.sign(si.encode()))
    swapped = copy.deepcopy(batch[1])
    swapped["proof"]["path"] = batch[3]["proof"]["path"]
    lied_size = copy.deepcopy(batch[2])
    lied_size["proof"]["tree_size"] = 4
    hdr = {"alg": "ES256", "kid": vtr.digest({"kid": "not in the key set"}), "typ": "vtr+jwt"}
    si = vtr.b64u(vtr.canonical(hdr).encode()) + "." + healthy_jws.split(".")[1]
    unknown_kid = si + "." + vtr.b64u(es.sign(si.encode()))
    missing_jws = by_name["es256-missing-signal-lowers-coverage"]
    failing = {"result": "does_not_meet", "band": "failing", "response": "suspended"}
    meets = {"result": "meets", "band": "good", "response": "full"}
    incomplete = {"result": "incomplete", "band": None, "response": None}
    invalid = [
        ("bad-signature", bad_sig, P1, "healthy", False, "bad signature"),
        ("wrong-typ", wrong_typ, P1, "healthy", False, "typ must be vtr+jwt"),
        ("trp-ref-digest-mismatch", resign(healthy_jws, es, lambda x: x["trp_ref"].update(digest=vtr.digest({"altered": True}))), P1, "healthy", False, "trp_ref does not match the supplied profile"),
        ("evidence-digest-mismatch", healthy_jws, P1, "estop", False, "evidence_digest does not match the supplied evidence"),
        ("missing-required-claim", resign(healthy_jws, es, lambda x: x.pop("coverage")), P1, "healthy", False, "missing required claim coverage"),
        ("unknown-kind", resign(healthy_jws, es, lambda x: x.update(kind="audit")), P1, "healthy", False, "unknown kind audit"),
        ("altered-standing", resign(healthy_jws, es, lambda x: x.update(standing=failing)), P1, "healthy", False, "standing does not match a re-run of the evaluation"),
        ("incomplete-altered-to-meets", resign(missing_jws, es, lambda x: x.update(standing=meets)), P1, "missing", False, "standing does not match a re-run of the evaluation"),
        ("violation-reported-as-incomplete", resign(by_name["es256-violated-rule-and-missing-signal"], es, lambda x: x.update(standing=incomplete)), P1, "estop_missing", False, "standing does not match a re-run of the evaluation"),
        ("unknown-claim", resign(healthy_jws, es, lambda x: x.update(score=812)), P1, "healthy", False, "unknown claim score"),
        ("eddsa-not-allowed", by_name["eddsa-healthy"], P1, "healthy", False, "EdDSA receipts are refused unless the verifier allows EdDSA"),
        ("result-digest-mismatch", resign(healthy_jws, es, lambda x: x.update(result_digest=vtr.digest("other"))), P1, "healthy", False, "result_digest does not match a re-run of the evaluation"),
        ("unknown-kid", unknown_kid, P1, "healthy", False, "no key in the key set has this kid"),
        ("missing-subject", resign(healthy_jws, es, lambda x: x.pop("sub")), P1, "healthy", False, "missing required claim sub"),
        ("coverage-out-of-range", resign(healthy_jws, es, lambda x: x.update(coverage=1.25)), P1, "healthy", False, "coverage must be a number from 0 to 1"),
        ("batch-proof-for-another-leaf", swapped, P1, "estop", False, "the inclusion proof does not lead to the signed root"),
        ("batch-tree-size-mismatch", lied_size, P1, "missing", False, "tree_size does not match the signed batch"),
    ]
    for d in ("valid", "invalid"):
        (OUT / d).mkdir(parents=True, exist_ok=True)
        for old in (OUT / d).glob("*.json"):
            old.unlink()
    for name, receipt, prof, e, eddsa in valid:
        write("valid", name, receipt, prof, e, eddsa, "valid")
    for name, receipt, prof, e, eddsa, reason in invalid:
        write("invalid", name, receipt, prof, e, eddsa, reason)
    print(f"{len(valid)} valid and {len(invalid)} invalid vectors in {OUT.relative_to(ROOT)}")


def write(kind, name, receipt, prof, e, eddsa, expect):
    (OUT / kind / f"{name}.json").write_text(json.dumps({
        "receipt": receipt, "jwks": "vtr/vectors/keys/jwks.json", "profile": prof,
        "evidence": f"vtr/vectors/evidence/{e}.json" if e else None, "allow_eddsa": eddsa, "expect": expect,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
