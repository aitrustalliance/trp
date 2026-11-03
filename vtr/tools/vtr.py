"""Verifiable Trust Receipt (VTR) v0.5, the reference library.

A VTR is a signed statement that one evaluation of an entity against a Trust
Requirements Profile (TRP) happened and what it found. This module builds the
claims from a profile and an evidence object with the reference evaluator,
signs them as a compact JSON Web Signature (JWS), verifies a receipt with or
without the profile and evidence, and signs batches of receipts once over an
RFC 9162 Merkle tree root. vtr/spec.md is the normative text.

    from vtr import claims_for, sign, verify, Key
    key = Key.load("issuer-es256.pem")
    jws = sign(claims_for(profile, evidence, iss="https://example.com", sub="urn:example:cell:01"), key)
    ok, reason = verify(jws, key.jwks(), profile=profile, evidence=evidence)
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import sys
import time
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import evaluate as trp  # noqa: E402  the reference evaluator in tools/evaluate.py

VTR_VERSION = "0.5"
TYP = "vtr+jwt"
BATCH_TYP = "vtr-batch+jwt"
EVALUATOR = {"implementation": "trp-reference-python", "version": "0.5.2"}
KINDS = {"evaluation", "conformance", "drill", "variance"}
MODES = {"enforced", "test", "shadow", "observed"}
OUTCOMES = {"satisfied", "warning", "violated", "inconclusive"}
RESULTS = {"meets", "does_not_meet", "incomplete"}
RESPONSES = {"full", "restricted", "suspended", "revoked"}
VERDICTS = {"allow", "stop", "escalate"}
REQUIRED = ["vtr_version", "iss", "iat", "sub", "kind", "mode", "trp_ref", "standing", "coverage", "results",
            "evidence_digest", "result_digest", "evaluator"]
OPTIONAL = ["window", "nonce", "prev", "risk", "evaluators", "build", "fallback", "principal", "on_behalf_of", "agent",
            "model", "tool", "cost", "outcome", "trp_clauses", "policy_digest", "input_digest", "escalation", "details"]


class VTRError(ValueError):
    pass


# ---------------------------------------------------------------- RFC 8785 canonical form and digests

def _number(v):
    if isinstance(v, bool):
        raise VTRError("booleans are not numbers")
    if isinstance(v, int):
        if abs(v) > 2 ** 53:
            raise VTRError("integers beyond 2^53 cannot be canonicalized exactly")
        return str(v)
    if not math.isfinite(v):
        raise VTRError("NaN and infinity have no JSON form")
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    t = Decimal(repr(abs(v))).normalize().as_tuple()  # repr gives the shortest digits that round-trip, as ECMAScript does
    digits = "".join(map(str, t.digits)).rstrip("0") or "0"
    k = len(digits)
    n = t.exponent + len("".join(map(str, t.digits)))
    if k <= n <= 21:
        s = digits + "0" * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        s = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        s = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + s


def canonical(v):
    """The RFC 8785 JSON Canonicalization Scheme form of a JSON value, as a string."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return _number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical(v[k]) for k in keys) + "}"
    raise VTRError(f"{type(v).__name__} is not a JSON value")


def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64u(text):
    if not isinstance(text, str) or "=" in text:
        raise VTRError("base64url text must not carry padding")
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def digest(v):
    """RFC 8785 canonical form, then SHA-256, then base64url without padding."""
    return b64u(hashlib.sha256(canonical(v).encode("utf-8")).digest())


# ---------------------------------------------------------------- the determination

def evaluator_output(profile_raw, evidence):
    """The reference evaluator's output with no drift history and without its `evaluation` member.

    The `evaluation` member carries the evaluation time, the evaluator's name and its `result_hash`, which differ
    from run to run and between the Python and Node.js evaluators. Every other member is the same in both.
    """
    r = trp.evaluate(trp.profile_from_dict(profile_raw), evidence)
    return {k: v for k, v in r.items() if k != "evaluation"}


def standing_of(profile_raw, out):
    """The standing `{result, band, response}` that follows from one evaluator output."""
    if any(m["on_missing"] == "incomplete" for m in out["missing_signals"]) or out["hard_rules_inconclusive"]:
        return {"result": "incomplete", "band": None, "response": None}
    severity = {b["band"]: b["severity"] for b in profile_raw.get("standing_bands", [])}
    band = out["standing"] if out["standing"] in severity else None
    response = out["response"] if out["response"] in RESPONSES else None
    floor = (profile_raw.get("required_standing") or {}).get("minimum_acceptable_band")
    limit = severity[floor] if floor in severity else min(severity.values(), default=None)
    meets = band is not None and limit is not None and severity[band] <= limit
    return {"result": "meets" if meets else "does_not_meet", "band": band, "response": response}


def determination(profile_raw, evidence):
    """Standing, coverage, one result per declared requirement and the result digest, from the reference evaluator."""
    out = evaluator_output(profile_raw, evidence)
    results = []
    by_signal = {s["signal"]: s for s in out["signal_results"]}
    for s in profile_raw.get("scored_signals", []):
        name = s["signal"]
        if name not in by_signal:
            outcome = "inconclusive"
        else:
            x = by_signal[name]
            outcome = "violated" if x["in_critical"] else "warning" if x["in_warning"] else "satisfied"
        results.append({"clause": f"signal:{name}", "outcome": outcome})
    triggered = {x["rule"] for x in out["hard_rules_triggered"]}
    inconclusive = {x["rule"] for x in out["hard_rules_inconclusive"]}
    for h in profile_raw.get("hard_rules", []):
        name = h["rule"]
        outcome = "inconclusive" if name in inconclusive else "violated" if name in triggered else "satisfied"
        results.append({"clause": f"rule:{name}", "outcome": outcome})
    results.sort(key=lambda x: x["clause"])
    checked = sum(1 for x in results if x["outcome"] != "inconclusive")  # a check is made only when it has an outcome
    total = len(results)
    coverage = 1.0 if total == 0 else float(Decimal(checked / total).quantize(Decimal("0.0001"), rounding=ROUND_HALF_EVEN))
    return {"standing": standing_of(profile_raw, out), "coverage": coverage, "results": results, "result_digest": digest(out)}


def trp_ref(profile_raw):
    return {"id": profile_raw["trp_id"], "version": profile_raw["version"], "digest": digest(profile_raw)}


def result_digest(profile_raw, evidence):
    """The digest of the evaluator output, which any verifier with the profile and evidence recomputes by re-running it."""
    return digest(evaluator_output(profile_raw, evidence))


def claims_for(profile_raw, evidence, iss, sub, kind="evaluation", mode="enforced", iat=None, **optional):
    """VTR claims for one evaluation of `evidence` against `profile_raw`."""
    d = determination(profile_raw, evidence)
    claims = {
        "vtr_version": VTR_VERSION, "iss": iss, "iat": int(iat if iat is not None else time.time()), "sub": sub,
        "kind": kind, "mode": mode, "trp_ref": trp_ref(profile_raw), "standing": d["standing"],
        "coverage": d["coverage"], "results": d["results"], "evidence_digest": digest(evidence),
        "result_digest": d["result_digest"], "evaluator": dict(EVALUATOR, spec_version=profile_raw.get("spec_version", "0.5")),
    }
    for k, v in optional.items():
        if k not in OPTIONAL:
            raise VTRError(f"{k} is not a VTR v0.5 claim")
        claims[k] = v
    check_claims(claims)
    return claims


# ---------------------------------------------------------------- claim rules

def check_claims(c):
    """Raises VTRError naming the first rule a claims object breaks."""
    if not isinstance(c, dict):
        raise VTRError("claims must be a JSON object")
    for k in REQUIRED:
        if k not in c:
            raise VTRError(f"missing required claim {k}")
    for k in c:
        if k not in REQUIRED and k not in OPTIONAL:
            raise VTRError(f"unknown claim {k}")
    if c["vtr_version"] != VTR_VERSION:
        raise VTRError(f"vtr_version must be {VTR_VERSION}")
    if not isinstance(c["iat"], int) or isinstance(c["iat"], bool):
        raise VTRError("iat must be integer Unix seconds")
    for k in ("iss", "sub", "evidence_digest", "result_digest"):
        if not isinstance(c[k], str) or not c[k]:
            raise VTRError(f"{k} must be a non-empty string")
    if c["kind"] not in KINDS:
        raise VTRError(f"unknown kind {c['kind']}")
    if c["mode"] not in MODES:
        raise VTRError(f"unknown mode {c['mode']}")
    ref = c["trp_ref"]
    if not isinstance(ref, dict) or set(ref) != {"id", "version", "digest"}:
        raise VTRError("trp_ref must carry exactly id, version and digest")
    check_standing(c["standing"])
    cov = c["coverage"]
    if isinstance(cov, bool) or not isinstance(cov, (int, float)) or not 0 <= cov <= 1:
        raise VTRError("coverage must be a number from 0 to 1")
    res = c["results"]
    if not isinstance(res, list) or any(not isinstance(x, dict) or set(x) != {"clause", "outcome"} for x in res):
        raise VTRError("each result must carry exactly clause and outcome")
    if any(x["outcome"] not in OUTCOMES for x in res):
        raise VTRError("result outcome must be satisfied, warning, violated or inconclusive")
    if [x["clause"] for x in res] != sorted(x["clause"] for x in res):
        raise VTRError("results must be sorted by clause")
    ev = c["evaluator"]
    if not isinstance(ev, dict) or not {"implementation", "version", "spec_version"} <= set(ev):
        raise VTRError("evaluator must carry implementation, version and spec_version")
    if "outcome" in c and c["outcome"] is not None and c["outcome"] not in VERDICTS:
        raise VTRError("outcome must be allow, stop or escalate")
    if "risk" in c and c["risk"] not in ({}, None):
        raise VTRError("risk must be empty in VTR v0.5")
    if c["kind"] != "evaluation" and not isinstance(c.get("details"), dict):
        raise VTRError(f"kind {c['kind']} requires a details object")


def check_standing(s):
    if not isinstance(s, dict) or set(s) != {"result", "band", "response"}:
        raise VTRError("standing must carry exactly result, band and response")
    if not isinstance(s["result"], str) or s["result"] not in RESULTS:
        raise VTRError("standing result must be meets, does_not_meet or incomplete")
    if s["band"] is not None and (not isinstance(s["band"], str) or not s["band"]):
        raise VTRError("standing band must be a band name or null")
    if s["response"] is not None and (not isinstance(s["response"], str) or s["response"] not in RESPONSES):
        raise VTRError("standing response must be full, restricted, suspended, revoked or null")
    if s["result"] == "incomplete" and (s["band"] is not None or s["response"] is not None):
        raise VTRError("an incomplete standing carries a null band and a null response")
    if s["result"] != "incomplete" and s["band"] is None:
        raise VTRError("a standing of meets or does_not_meet names its band")


# ---------------------------------------------------------------- keys and signatures

class Key:
    """An ES256 (P-256) or EdDSA (Ed25519) signing key, or a public key from a JWK."""

    def __init__(self, private=None, public=None):
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519
        self.private = private
        self.public = public or private.public_key()
        if isinstance(self.public, ec.EllipticCurvePublicKey):
            if self.public.curve.name != "secp256r1":
                raise VTRError("only the P-256 curve is allowed")
            self.alg = "ES256"
        elif isinstance(self.public, ed25519.Ed25519PublicKey):
            self.alg = "EdDSA"
        else:
            raise VTRError("only P-256 and Ed25519 keys are allowed")

    @classmethod
    def load(cls, path):
        from cryptography.hazmat.primitives import serialization
        return cls(private=serialization.load_pem_private_key(Path(path).read_bytes(), password=None))

    @classmethod
    def generate(cls, alg="ES256"):
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519
        return cls(private=ec.generate_private_key(ec.SECP256R1()) if alg == "ES256" else ed25519.Ed25519PrivateKey.generate())

    @classmethod
    def from_jwk(cls, jwk):
        from cryptography.hazmat.primitives.asymmetric import ec, ed25519
        if jwk.get("kty") == "EC" and jwk.get("crv") == "P-256":
            x, y = (int.from_bytes(unb64u(jwk[k]), "big") for k in ("x", "y"))
            return cls(public=ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key())
        if jwk.get("kty") == "OKP" and jwk.get("crv") == "Ed25519":
            return cls(public=ed25519.Ed25519PublicKey.from_public_bytes(unb64u(jwk["x"])))
        raise VTRError("the key set holds a key type VTR does not allow")

    def jwk(self):
        from cryptography.hazmat.primitives import serialization
        if self.alg == "ES256":
            n = self.public.public_numbers()
            j = {"crv": "P-256", "kty": "EC", "x": b64u(n.x.to_bytes(32, "big")), "y": b64u(n.y.to_bytes(32, "big"))}
        else:
            raw = self.public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            j = {"crv": "Ed25519", "kty": "OKP", "x": b64u(raw)}
        return dict(j, kid=thumbprint(j), alg=self.alg, use="sig")

    def jwks(self):
        return {"keys": [self.jwk()]}

    def pem(self):
        from cryptography.hazmat.primitives import serialization
        return self.private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()).decode()

    def sign(self, data):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
        if self.alg == "ES256":
            r, s = decode_dss_signature(self.private.sign(data, ec.ECDSA(hashes.SHA256())))
            return r.to_bytes(32, "big") + s.to_bytes(32, "big")  # RFC 7518 section 3.4, R then S
        return self.private.sign(data)

    def check(self, data, sig):
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        try:
            if self.alg == "ES256":
                if len(sig) != 64:
                    return False
                der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
                self.public.verify(der, data, ec.ECDSA(hashes.SHA256()))
            else:
                self.public.verify(sig, data)
            return True
        except InvalidSignature:
            return False


def thumbprint(jwk):
    """RFC 7638 thumbprint: the required members in lexicographic order with no whitespace, SHA-256, base64url."""
    req = ("crv", "kty", "x", "y") if jwk["kty"] == "EC" else ("crv", "kty", "x")
    return b64u(hashlib.sha256(json.dumps({k: jwk[k] for k in req}, separators=(",", ":"), sort_keys=True).encode()).digest())


def _jws(payload, key, typ):
    header = {"alg": key.alg, "kid": key.jwk()["kid"], "typ": typ}
    signing_input = b64u(canonical(header).encode()) + "." + b64u(canonical(payload).encode())
    return signing_input + "." + b64u(key.sign(signing_input.encode("ascii")))


def sign(claims, key):
    """A compact JWS of the claims, signed with key."""
    check_claims(claims)
    return _jws(claims, key, TYP)


def _open(jws, jwks, typ, allow_eddsa):
    parts = jws.split(".") if isinstance(jws, str) else []
    if len(parts) != 3:
        raise VTRError("not a compact JWS")
    try:
        header = json.loads(unb64u(parts[0]))
        payload = json.loads(unb64u(parts[1]))
        sig = unb64u(parts[2])
    except (ValueError, TypeError) as err:
        raise VTRError(f"malformed JWS ({err})") from None
    if not isinstance(header, dict) or set(header) != {"alg", "kid", "typ"}:
        raise VTRError("the protected header must carry exactly alg, kid and typ")
    if header["typ"] != typ:
        raise VTRError(f"typ must be {typ}")
    if header["alg"] == "EdDSA" and not allow_eddsa:
        raise VTRError("EdDSA receipts are refused unless the verifier allows EdDSA")
    if header["alg"] not in ("ES256", "EdDSA"):
        raise VTRError(f"alg {header['alg']} is not allowed")
    jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == header["kid"]), None)
    if jwk is None:
        raise VTRError("no key in the key set has this kid")
    if thumbprint(jwk) != header["kid"]:
        raise VTRError("kid is not the RFC 7638 thumbprint of its key")
    key = Key.from_jwk(jwk)
    if key.alg != header["alg"]:
        raise VTRError("alg does not match the key type")
    if not key.check((parts[0] + "." + parts[1]).encode("ascii"), sig):
        raise VTRError("bad signature")
    if parts[0] != b64u(canonical(header).encode()) or parts[1] != b64u(canonical(payload).encode()):
        raise VTRError("header or payload is not in RFC 8785 canonical form")
    return header, payload


def check_against(claims, profile_raw=None, evidence=None):
    """Re-derives what a verifier can from the profile and evidence it was given."""
    if profile_raw is not None and claims["trp_ref"] != trp_ref(profile_raw):
        raise VTRError("trp_ref does not match the supplied profile")
    if evidence is not None and claims["evidence_digest"] != digest(evidence):
        raise VTRError("evidence_digest does not match the supplied evidence")
    if profile_raw is not None and evidence is not None:
        d = determination(profile_raw, evidence)
        if claims["result_digest"] != d["result_digest"]:
            raise VTRError("result_digest does not match a re-run of the evaluation")
        if claims["standing"] != d["standing"]:
            raise VTRError("standing does not match a re-run of the evaluation")
        if claims["results"] != d["results"]:
            raise VTRError("results do not match a re-run of the evaluation")
        if claims["coverage"] != d["coverage"]:
            raise VTRError("coverage does not match a re-run of the evaluation")


def verify(jws, jwks, profile=None, evidence=None, allow_eddsa=False):
    """(True, "valid") or (False, the first reason the receipt fails)."""
    try:
        _, claims = _open(jws, jwks, TYP, allow_eddsa)
        check_claims(claims)
        check_against(claims, profile, evidence)
        return True, "valid"
    except VTRError as err:
        return False, str(err)


# ---------------------------------------------------------------- batches under one signature (RFC 9162 Merkle tree)

def _leaf(d):
    return hashlib.sha256(b"\x00" + d).digest()


def _node(left, right):
    return hashlib.sha256(b"\x01" + left + right).digest()


def _split(n):
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def _root(leaves):
    if len(leaves) == 1:
        return leaves[0]
    k = _split(len(leaves))
    return _node(_root(leaves[:k]), _root(leaves[k:]))


def _path(index, leaves):
    if len(leaves) == 1:
        return []
    k = _split(len(leaves))
    if index < k:
        return _path(index, leaves[:k]) + [_root(leaves[k:])]
    return _path(index - k, leaves[k:]) + [_root(leaves[:k])]


def sign_batch(claims_list, key, iss, iat=None):
    """Signs a batch once over the Merkle root of its receipts' digests. Returns one batched receipt per claims object."""
    for c in claims_list:
        check_claims(c)
    digests = [unb64u(digest(c)) for c in claims_list]
    leaves = [_leaf(d) for d in digests]
    root = _root(leaves)
    batch = _jws({"vtr_version": VTR_VERSION, "iss": iss, "iat": int(iat if iat is not None else time.time()),
                  "tree_size": len(leaves), "root": b64u(root)}, key, BATCH_TYP)
    return [{"claims": c, "proof": {"leaf_index": i, "tree_size": len(leaves), "path": [b64u(h) for h in _path(i, leaves)],
                                    "batch": batch}} for i, c in enumerate(claims_list)]


def _root_from_path(index, size, leaf_hash, path):
    """RFC 9162 section 2.1.3.2: recomputes the root from an inclusion proof, or None when the proof is malformed."""
    if index >= size:
        return None
    fn, sn, r = index, size - 1, leaf_hash
    for p in path:
        if sn == 0:
            return None
        if fn % 2 == 1 or fn == sn:
            r = _node(p, r)
            if fn % 2 == 0:
                while fn % 2 == 0 and fn != 0:
                    fn >>= 1
                    sn >>= 1
        else:
            r = _node(r, p)
        fn >>= 1
        sn >>= 1
    return r if sn == 0 else None


def verify_batched(receipt, jwks, profile=None, evidence=None, allow_eddsa=False):
    """(True, "valid") or (False, reason) for one receipt from a signed batch."""
    try:
        if not isinstance(receipt, dict) or set(receipt) != {"claims", "proof"}:
            raise VTRError("a batched receipt carries exactly claims and proof")
        claims, proof = receipt["claims"], receipt["proof"]
        check_claims(claims)
        _, batch = _open(proof.get("batch"), jwks, BATCH_TYP, allow_eddsa)
        if set(batch) != {"vtr_version", "iss", "iat", "tree_size", "root"} or batch["vtr_version"] != VTR_VERSION:
            raise VTRError("the batch statement is malformed")
        if batch["iss"] != claims["iss"]:
            raise VTRError("the batch was signed by another issuer")
        if proof.get("tree_size") != batch["tree_size"]:
            raise VTRError("tree_size does not match the signed batch")
        root = _root_from_path(proof["leaf_index"], proof["tree_size"], _leaf(unb64u(digest(claims))),
                               [unb64u(h) for h in proof["path"]])
        if root is None or b64u(root) != batch["root"]:
            raise VTRError("the inclusion proof does not lead to the signed root")
        check_against(claims, profile, evidence)
        return True, "valid"
    except VTRError as err:
        return False, str(err)
    except (KeyError, TypeError) as err:
        return False, f"malformed batched receipt ({err})"
