#!/usr/bin/env python3
"""Verifies a Verifiable Trust Receipt (VTR) and prints "valid" or the first reason it fails.

    python vtr/tools/vtr_verify.py receipt.jws --jwks jwks.json [--profile trp.json --evidence evidence.json] [--allow-eddsa]
    python vtr/tools/vtr_verify.py batched.json --jwks jwks.json ...      a receipt from a signed batch

With the profile, the verifier checks trp_ref against it. With the evidence too, it re-runs the evaluation
and checks standing, results and coverage. The exit code is 0 for valid and 1 otherwise.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vtr  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("receipt")
    ap.add_argument("--jwks", required=True)
    ap.add_argument("--profile")
    ap.add_argument("--evidence")
    ap.add_argument("--allow-eddsa", action="store_true")
    a = ap.parse_args()
    read = lambda p: json.loads(Path(p).read_text()) if p else None  # noqa: E731
    text = Path(a.receipt).read_text().strip()
    kw = dict(profile=read(a.profile), evidence=read(a.evidence), allow_eddsa=a.allow_eddsa)
    ok, reason = (vtr.verify_batched(json.loads(text), read(a.jwks), **kw) if text.startswith("{")
                  else vtr.verify(text, read(a.jwks), **kw))
    print(reason)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
