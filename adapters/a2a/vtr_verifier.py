"""A receipt verifier for the A2A adapter, built on the VTR reference library in vtr/tools/vtr.py.

A remote agent whose TRP gate signs a Verifiable Trust Receipt (VTR, vtr/spec.md) for each decision can return
those receipts with the task. VTRVerifier checks each one for the Delegator, with the keys and the profile the
deployment trusts for that agent and never with keys the agent hands over.

    verifier = VTRVerifier.from_file("adapters/a2a/receipt-trust.example.json")
    async with Delegator(gate, agent_id="urn:example:orchestrator", verifier=verifier) as delegate:
        ...

For each receipt vtr.verify runs the checks of the Verification section of vtr/spec.md. It parses the compact JWS
(JSON Web Signature), selects the key by kid from the trusted key set, confirms the kid is the RFC 7638 thumbprint
of that key, verifies the signature, checks the claims and confirms trp_ref against the trusted profile. It
refuses an Ed25519 receipt unless the deployment allows Ed25519 for that agent. The verifier then binds the receipt to
the exchange. Its iss must be the issuer the deployment names for the agent, or the one the card names when the
deployment names none. Its sub must be the subject prefix followed by the returned task's id, so a receipt from
another task cannot be replayed. Its mode must be one the deployment accepts, by default only enforced. Its
on_behalf_of must name this caller.
"""
from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "vtr" / "tools"))
from trp_a2a import ReceiptContext, origin

import vtr

__all__ = ["SUBJECT_PREFIX", "TrustFileError", "TrustedAgent", "VTRVerifier"]

SUBJECT_PREFIX = "urn:trp:a2a:task:"
"""The subject a remote agent's receipts carry, followed by the A2A task id. The TRP Studio agents use it."""


class TrustFileError(ValueError):
    """A trust file that does not have the shape VTRVerifier.from_file reads."""


@dataclass(frozen=True)
class TrustedAgent:
    """What the deployment trusts for one remote agent."""

    jwks: Mapping[str, Any]  # the JSON Web Key Set whose keys may sign this agent's receipts
    profile: Mapping[str, Any]  # the TRP profile this agent's receipts must name in trp_ref
    issuer: str | None = None  # the iss its receipts must carry, or None for the issuer its card names
    allow_eddsa: bool = False  # vtr/spec.md requires refusing Ed25519 receipts unless the operator allows them
    modes: frozenset[str] = field(default_factory=lambda: frozenset({"enforced"}))


class VTRVerifier:
    """A ReceiptVerifier for the Delegator. Returns None when a receipt passes and the reason when it fails.

    `agents` maps each agent address to what the deployment trusts for it. Addresses are compared by origin, as
    approved_agents is. With `require_caller` false a receipt may leave out on_behalf_of.
    """

    def __init__(self, agents: Mapping[str, TrustedAgent], subject_prefix: str = SUBJECT_PREFIX,
                 require_caller: bool = True) -> None:
        self.agents: dict[str, TrustedAgent] = {}
        for address, trusted in agents.items():
            o = origin(address)
            if o is None:
                raise ValueError(f"{address!r} is not an http or https address")
            self.agents[o] = trusted
        self.subject_prefix, self.require_caller = subject_prefix, require_caller

    @classmethod
    def from_file(cls, path: str | Path) -> VTRVerifier:
        """A verifier from a JSON trust file. Paths in it are relative to the file.

        {"subject_prefix": "urn:trp:a2a:task:", "require_caller": true,
         "agents": {"https://planner.example.com": {"jwks": "planner.jwks.json", "profile": "a2a-delegation.trp.json",
                                                    "issuer": "urn:example:planner", "allow_eddsa": false,
                                                    "modes": ["enforced"]}}}

        `jwks` and `profile` are each a file path or the JSON object itself.
        """
        p = Path(path).resolve()
        raw = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or not isinstance(raw.get("agents"), dict):
            raise TrustFileError(f"{p}: a trust file needs an agents object")

        def load(value: object, what: str, address: str) -> dict[str, Any]:
            if isinstance(value, str):
                value = json.loads((p.parent / value).read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise TrustFileError(f"{p}: {address} needs {what} as a file path or a JSON object")
            return value

        agents = {}
        for address, spec in raw["agents"].items():
            if not isinstance(spec, dict):
                raise TrustFileError(f"{p}: {address} must be a JSON object")
            modes = spec.get("modes", ["enforced"])
            if not isinstance(modes, list) or not all(isinstance(m, str) for m in modes):
                raise TrustFileError(f"{p}: {address} modes must be a list of mode names")
            issuer = spec.get("issuer")
            if issuer is not None and (not isinstance(issuer, str) or not issuer):
                raise TrustFileError(f"{p}: {address} issuer must be a non-empty string")
            agents[address] = TrustedAgent(jwks=load(spec.get("jwks"), "jwks", address), profile=load(spec.get("profile"), "profile", address),
                                           issuer=issuer, allow_eddsa=bool(spec.get("allow_eddsa", False)), modes=frozenset(modes))
        return cls(agents, subject_prefix=str(raw.get("subject_prefix", SUBJECT_PREFIX)),
                   require_caller=bool(raw.get("require_caller", True)))

    def __call__(self, receipt: str, ctx: ReceiptContext) -> str | None:
        trusted = self.agents.get(ctx.agent)
        if trusted is None:
            return f"no receipt keys are trusted for {ctx.agent}"
        ok, why = vtr.verify(receipt, dict(trusted.jwks), profile=dict(trusted.profile), allow_eddsa=trusted.allow_eddsa)
        if not ok:
            return str(why)
        claims = json.loads(vtr.unb64u(receipt.split(".")[1]))
        issuer = trusted.issuer or ctx.issuer
        if issuer is None:
            return "neither the deployment nor the agent's card names the issuer"
        if claims["iss"] != issuer:
            return f"the receipt names the issuer {claims['iss']}, and {issuer} was expected"
        if claims["sub"] != self.subject_prefix + ctx.task_id:
            return f"the receipt is about {claims['sub']}, which is not the returned task"
        if claims["mode"] not in trusted.modes:
            return f"the receipt has mode {claims['mode']}, which the deployment does not accept"
        if self.require_caller:
            party = claims.get("on_behalf_of")
            served = party.get("value") if isinstance(party, dict) else None
            if served != ctx.caller:
                return f"the receipt serves {served}, and this caller is {ctx.caller}"
        return None
