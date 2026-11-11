#!/usr/bin/env python3
"""Evaluates evidence against a TRP profile and prints the Verifiable Trust Receipt (VTR) as a compact JWS.

    python vtr/tools/vtr_emit.py --profile trp.json --evidence evidence.json --key issuer.pem \\
        --iss https://evaluator.example.com --sub urn:example:cell:01 [--mode enforced] [--nonce N] [--prev DIGEST] \\
        [--window 2026-11-03T10:00:00Z,2026-11-03T10:05:00Z]
    python vtr/tools/vtr_emit.py --new-key es256 > issuer.pem      a fresh signing key for testing
    python vtr/tools/vtr_emit.py --jwks issuer.pem                 the key set to publish at /.well-known/jwks.json
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vtr  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile")
    ap.add_argument("--evidence")
    ap.add_argument("--key")
    ap.add_argument("--iss")
    ap.add_argument("--sub")
    ap.add_argument("--kind", default="evaluation")
    ap.add_argument("--mode", default="enforced")
    ap.add_argument("--nonce")
    ap.add_argument("--prev")
    ap.add_argument("--window", help="start,end in RFC 3339")
    ap.add_argument("--new-key", choices=["es256", "ed25519", "eddsa"], help="eddsa is the older name for ed25519")
    ap.add_argument("--jwks", metavar="PEM")
    a = ap.parse_args()
    if a.new_key:
        print(vtr.Key.generate("ES256" if a.new_key == "es256" else "Ed25519").pem(), end="")
        return 0
    if a.jwks:
        print(json.dumps(vtr.Key.load(a.jwks).jwks(), indent=2))
        return 0
    if not all([a.profile, a.evidence, a.key, a.iss, a.sub]):
        ap.error("give --profile, --evidence, --key, --iss and --sub")
    opt = {k: v for k, v in (("nonce", a.nonce), ("prev", a.prev)) if v}
    if a.window:
        start, end = a.window.split(",")
        opt["window"] = {"start": start, "end": end}
    claims = vtr.claims_for(json.loads(Path(a.profile).read_text()), json.loads(Path(a.evidence).read_text()),
                            iss=a.iss, sub=a.sub, kind=a.kind, mode=a.mode, **opt)
    print(vtr.sign(claims, vtr.Key.load(a.key)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
