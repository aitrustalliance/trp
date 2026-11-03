"""Shared helpers for the framework adapters. Every adapter calls the same TRP gate in adapters/gate."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gate"))
from trp_gate import Decision, DecisionLog, Gate, Policy, ReceiptIssuer, Session, verify_log  # noqa: E402,F401

DEFAULT_PROFILE = Path(__file__).resolve().parents[1] / "mcp" / "profiles" / "mcp-tool-checkpoint.trp.json"


def make_gate(policy, session=None, log=None, profile=None, source="agent", receipts=None, receipt_key=None, issuer="urn:trp:gate"):
    """A gate from a policy file path or a policy dict, with an optional shared session file and decision log.
    With receipts and receipt_key, the gate also signs a Verifiable Trust Receipt for every decision."""
    pol = Policy.load(policy) if isinstance(policy, (str, Path)) else Policy(policy, Path.cwd())
    issuer_ = ReceiptIssuer(receipt_key, issuer, receipts) if receipts else None
    return Gate(profile or DEFAULT_PROFILE, pol, Session(session), DecisionLog(log), source=source, receipts=issuer_)


def parse_args(raw):
    """Tool arguments as a dict, from a dict or a JSON string."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            v = json.loads(raw or "{}")
            return v if isinstance(v, dict) else {"input": v}
        except json.JSONDecodeError:
            return {"input": raw}
    return {"input": raw}


def texts_of(value):
    """The text inside a tool result of any shape, for the result check."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [t for v in value for t in texts_of(v)]
    if isinstance(value, dict):
        return [t for v in value.values() for t in texts_of(v)]
    for attr in ("content", "text", "result", "parts", "output"):
        if hasattr(value, attr):
            return texts_of(getattr(value, attr))
    return [str(value)]
