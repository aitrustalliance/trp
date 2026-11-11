"""TRP gate for A2A (the Agent2Agent protocol), built on the official a2a-sdk Python package.

The caller side gives an agent a delegate tool. The shared TRP (Trust Requirements Profile) gate in
adapters/gate/trp_gate.py judges each delegation before the message leaves, and judges the task or message the
remote agent returns before the caller uses it. The remote side wraps any a2a-sdk AgentExecutor, so the same gate
judges each inbound task before the agent runs, with the caller's authenticated identity as evidence.

    gate = make_a2a_gate("policy.json", session="session.json", log="decisions.jsonl")
    async with Delegator(gate, agent_id="urn:example:orchestrator") as delegate:
        result = await delegate({"agent": "https://planner.example.com", "message": "Plan the release."}, call_id="c1")
        print(result.text)

    executor = TRPAgentExecutor(MyAgentExecutor(), gate)   # then serve it with DefaultRequestHandler as usual

Two behaviors are deployment choices, set in the policy.

- receipt_mode. When a remote agent's receipts fail verification, "enforce" (the default) withholds the result
  and "warn" passes it with a warning. Either way the decision log records the failure.
- anonymous_callers. When an inbound task carries no authenticated identity, "allow" (the default) runs it and
  records caller_authenticated false, and "refuse" rejects the task.

Every a2a-sdk name used here was read in the source of a2a-sdk 1.3.0, which implements A2A protocol version 1.0.
adapters/a2a/README.md lists each one and the file it was read in.
"""
from __future__ import annotations

import contextvars
import hashlib
import json
import sys
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import Any, cast
from urllib.parse import urlsplit

import httpx
from a2a.client import (
    A2ACardResolver,
    ClientCallContext,
    ClientCallInterceptor,
    ClientConfig,
    ClientFactory,
)
from a2a.client.service_parameters import ServiceParametersFactory, with_a2a_extensions
from a2a.extensions.common import find_extension_by_uri
from a2a.helpers import (
    get_data_parts,
    get_raw_parts,
    get_text_parts,
    get_url_parts,
    new_task,
    new_text_part,
)
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import (
    AgentCard,
    Message,
    Part,
    Role,
    SendMessageRequest,
    Task,
    TaskState,
)
from google.protobuf.json_format import MessageToDict
from typing_extensions import Self

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gate"))
from trp_gate import (
    Decision,
    DecisionLog,
    Gate,
    Policy,
    ReceiptIssuer,
    Session,
    canonical,
    listed,
    verify_log,
)

__all__ = [
    "DEFAULT_PROFILE",
    "DELEGATE_SPEC",
    "EXTENSION",
    "A2AGate",
    "A2APolicy",
    "CallerIdentity",
    "DelegationResult",
    "Delegator",
    "ReceiptCheck",
    "ReceiptContext",
    "ReceiptVerifier",
    "TRPAgentExecutor",
    "answer_texts",
    "caller_identity",
    "carried_receipts",
    "check_receipts",
    "make_a2a_gate",
    "origin",
    "verify_log",
]

EXTENSION = "urn:trp:a2a:extension:receipts:0.1"
"""The A2A extension URI under which the adapter reads receipts in task metadata and writes the caller in message
metadata. It matches the extension the TRP Studio agents publish."""

DEFAULT_PROFILE = Path(__file__).resolve().parent / "profiles" / "a2a-delegation.trp.json"
RECEIPT_MODES = ("enforce", "warn")
ANONYMOUS_CALLERS = ("allow", "refuse")
FAILED_STATES = frozenset({TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED,
                           TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_UNSPECIFIED})
MAX_IDENTITY = 512  # longest caller name or asserted caller the log keeps

DELEGATE_SPEC: dict[str, Any] = {"type": "function", "function": {
    "name": "delegate", "description": "Send a message to another agent over A2A and return its answer.",
    "parameters": {"type": "object", "properties": {
        "agent": {"type": "string", "description": "The address of the agent, for example https://planner.example.com"},
        "message": {"type": "string", "description": "What the agent should do"}}, "required": ["agent", "message"]}}}

_INBOUND: contextvars.ContextVar[CallerIdentity | None] = contextvars.ContextVar("trp_a2a_inbound", default=None)
_RECEIPTS: contextvars.ContextVar[ReceiptCheck | None] = contextvars.ContextVar("trp_a2a_receipts", default=None)


def origin(url: object) -> str | None:
    """scheme://host:port of an http or https address, with the default port filled in, or None for anything else."""
    if not isinstance(url, str):
        return None
    try:
        s = urlsplit(url.strip())
        port = s.port or {"http": 80, "https": 443}.get(s.scheme)
    except ValueError:
        return None
    if s.scheme not in ("http", "https") or not s.hostname or not port:
        return None
    host = s.hostname.lower()
    return f"{s.scheme}://[{host}]:{port}" if ":" in host else f"{s.scheme}://{host}:{port}"


def _short(value: object) -> str | None:
    return value[:MAX_IDENTITY] if isinstance(value, str) and value else None


# ------------------------------------------------------------ identity of an inbound caller

@dataclass(frozen=True)
class CallerIdentity:
    """Who sent an inbound task.

    `principal` is the identity the server's own authentication established, which A2A carries at the transport
    layer (A2A specification v1.0.0, Section 7). `asserted` is the caller the message metadata names, which nothing
    verified. `authenticated` is true only when the server authenticated the request and the user has a name.
    """

    authenticated: bool
    principal: str | None = None
    asserted: str | None = None

    def evidence(self, policy: A2APolicy) -> dict[str, Any]:
        return {"caller_authenticated": self.authenticated, "caller_principal": self.principal,
                "caller_asserted": self.asserted,
                "anonymous_caller_refused": not self.authenticated and policy.anonymous_callers == "refuse"}


def asserted_caller(message: Message | None) -> str | None:
    """The caller a message names under EXTENSION in its metadata, as {"on_behalf_of": {"value": ...}}."""
    if message is None:
        return None
    carried = MessageToDict(message.metadata).get(EXTENSION)
    party = carried.get("on_behalf_of") if isinstance(carried, dict) else None
    return _short(party.get("value")) if isinstance(party, dict) else None


def caller_identity(context: RequestContext) -> CallerIdentity:
    """The caller of one inbound request, from the user the a2a-sdk server put in the call context.

    The a2a-sdk Starlette routes build that user from the request's `user` scope entry, which Starlette's
    AuthenticationMiddleware sets. With no authentication configured it is an UnauthenticatedUser.
    """
    user = context.call_context.user
    name = _short(user.user_name) if user.is_authenticated else None
    return CallerIdentity(authenticated=name is not None, principal=name, asserted=asserted_caller(context.message))


# ------------------------------------------------------------ receipts a remote agent returns

@dataclass(frozen=True)
class ReceiptContext:
    """What every receipt returned with one task must match. A verifier gets this with each receipt."""

    agent: str  # the remote agent's origin, scheme://host:port
    task_id: str  # the id of the task the remote returned
    caller: str  # this agent's id, which the delegation named in on_behalf_of
    issuer: str | None  # the issuer the remote's card names in the extension parameters, or None
    card_params: Mapping[str, Any]  # every parameter the card gives the extension


ReceiptVerifier = Callable[[str, ReceiptContext], "str | None"]
"""Checks one receipt. Returns None when the receipt passes and the reason when it fails. An exception counts as a
failure. The deployment supplies the verifier with the keys it trusts for each agent. VTRVerifier in
adapters/a2a/vtr_verifier.py is one, built on the VTR reference library."""


@dataclass(frozen=True)
class ReceiptCheck:
    """The outcome of checking the receipts returned with one task."""

    expected: bool = False  # the card lists EXTENSION or the policy requires receipts from this agent
    count: int = 0
    verified: bool | None = None  # None when no receipt was expected or returned, else whether every receipt passed
    problem: str | None = None
    sha256: str | None = None  # SHA-256 of the receipts joined by newlines

    def evidence(self, receipt_mode: str) -> dict[str, Any]:
        return {"remote_receipts": self.count, "remote_receipts_expected": self.expected,
                "remote_receipts_verified": self.verified, "remote_receipt_problem": self.problem,
                "remote_receipts_sha256": self.sha256,
                "unverified_receipts_refused": self.verified is False and receipt_mode == "enforce"}


def check_receipts(receipts: Sequence[object], ctx: ReceiptContext, verifier: ReceiptVerifier | None,
                   expected: bool) -> ReceiptCheck:
    """Checks every receipt with `verifier`, failing closed. A missing expected receipt, a receipt that is not a
    string, a missing verifier and a verifier that raises each count as a failed check."""
    n = len(receipts)
    if n == 0:
        if expected:
            return ReceiptCheck(expected=True, verified=False, problem="the agent returned no receipts")
        return ReceiptCheck()
    joined = "\n".join(r if isinstance(r, str) else canonical(r) for r in receipts)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()
    problem = None
    if verifier is None:
        problem = "no receipt verifier is configured"
    else:
        for i, receipt in enumerate(receipts, 1):
            if not isinstance(receipt, str) or not receipt:
                problem = f"receipt {i} of {n} is not a non-empty string"
                break
            try:
                why = verifier(receipt, ctx)
            except Exception as err:  # noqa: BLE001  a verifier that fails counts as a failed check
                why = f"the verifier raised {type(err).__name__} {err}"
            if why:
                problem = f"receipt {i} of {n} failed verification. {why}"
                break
    return ReceiptCheck(expected=expected, count=n, verified=problem is None, problem=problem, sha256=digest)


def carried_receipts(task: Task | None) -> list[object]:
    """The receipts a task carries under EXTENSION in its metadata, as {"receipts": [...]}."""
    if task is None:
        return []
    carried = MessageToDict(task.metadata).get(EXTENSION)
    raw = carried.get("receipts") if isinstance(carried, dict) else None
    if raw is None:
        return []
    return list(raw) if isinstance(raw, list) else [raw]


# ------------------------------------------------------------ policy and gate

class A2APolicy(Policy):
    """The policy of the shared gate with the A2A keys added.

    approved_agents     addresses of the agents the deployment approved, compared by origin
    delegate_tools      tools that delegate over A2A, default ["delegate"], each kind egress
    receipt_mode        "enforce" (default) withholds a result whose receipts fail, "warn" passes it with a warning
    require_receipts    agent addresses whose results must carry verified receipts even when the card lists none
    inbound_tool        the name the gate judges each inbound task as, default "a2a_task", kind read
    anonymous_callers   "allow" (default) runs a task with no authenticated caller, "refuse" rejects it
    """

    def __init__(self, raw: Mapping[str, Any], base: Path) -> None:
        super().__init__(raw, base)  # type: ignore[no-untyped-call]
        self.tools = {k: dict(v) for k, v in self.tools.items()}
        agents = list(raw.get("approved_agents", []))
        self.agents = self._origins(agents, "approved_agents")
        self.delegate_tools = set(raw.get("delegate_tools", ["delegate"]))
        for name in self.delegate_tools:
            spec = self.tools.setdefault(name, {"kind": "egress", "url_args": ["agent"]})
            if spec.get("kind", "other") != "egress":
                raise ValueError(f"tool {name}: a delegate tool must be kind egress")
            if not spec.get("url_args"):
                raise ValueError(f"tool {name}: a delegate tool must name the argument with the agent address in url_args")
        self.receipt_mode = raw.get("receipt_mode", "enforce")
        if self.receipt_mode not in RECEIPT_MODES:
            raise ValueError(f"receipt_mode must be one of {list(RECEIPT_MODES)}")
        self.required_receipts = self._origins(list(raw.get("require_receipts", [])), "require_receipts")
        self.inbound_tool = raw.get("inbound_tool", "a2a_task")
        if not isinstance(self.inbound_tool, str) or not self.inbound_tool:
            raise ValueError("inbound_tool must be a tool name")
        self.tools.setdefault(self.inbound_tool, {"kind": "read"})
        self.anonymous_callers = raw.get("anonymous_callers", "allow")
        if self.anonymous_callers not in ANONYMOUS_CALLERS:
            raise ValueError(f"anonymous_callers must be one of {list(ANONYMOUS_CALLERS)}")

    @staticmethod
    def _origins(values: list[object], key: str) -> set[str]:
        out = set()
        for v in values:
            o = origin(v)
            if o is None:
                raise ValueError(f"{key}: {v!r} is not an http or https address")
            out.add(o)
        return out

    @classmethod
    def from_file(cls, path: str | Path) -> A2APolicy:
        p = Path(path).resolve()
        return cls(json.loads(p.read_text(encoding="utf-8")), p.parent)

    def url_args(self, tool: str) -> list[str]:
        return list(self.args(tool, "url_args"))  # type: ignore[no-untyped-call]

    def agent_ok(self, url: object) -> bool:
        o = origin(url)
        return o is not None and o in self.agents

    def receipts_required(self, url: object) -> bool:
        o = origin(url)
        return o is not None and o in self.required_receipts


class A2AGate(Gate):
    """The shared gate with A2A added.

    For a delegate tool the agent's address alone decides the unapproved_destination rule, by its origin, because
    the message goes only to that agent. Addresses written inside the message are the remote agent's business, and
    its own gate judges what it fetches. Every call and result carries the two A2A rule fields of the
    a2a-delegation profile, so neither rule is ever inconclusive.
    """

    policy: A2APolicy

    def __init__(self, profile_path: str | Path, policy: A2APolicy, session: Session, log: DecisionLog,
                 source: str = "a2a", receipts: ReceiptIssuer | None = None) -> None:
        super().__init__(profile_path, policy, session, log, source=source, receipts=receipts)  # type: ignore[no-untyped-call]

    def call_evidence(self, tool: str, args: dict[str, Any], state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        ev, facts = super().call_evidence(tool, args, state)  # type: ignore[no-untyped-call]
        if tool in self.policy.delegate_tools:
            dest = [v for k in self.policy.url_args(tool) for v in listed(args.get(k))]
            ev["output_destination_approved"] = bool(dest) and all(self.policy.agent_ok(u) for u in dest)
            facts["urls"] = [origin(u) or u for u in dest]
        identity = _INBOUND.get()
        ev.update(identity.evidence(self.policy) if identity else {"anonymous_caller_refused": False})
        ev["unverified_receipts_refused"] = False
        return ev, facts

    def result_evidence(self, call_ev: dict[str, Any], texts: list[str], state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        ev, facts = super().result_evidence(call_ev, texts, state)  # type: ignore[no-untyped-call]
        check = _RECEIPTS.get()
        if check is not None:
            ev.update(check.evidence(self.policy.receipt_mode))
        else:
            ev["unverified_receipts_refused"] = False
        ev["anonymous_caller_refused"] = False
        return ev, facts

    def check_delegation(self, args: dict[str, Any], call_id: str | None = None, tool: str = "delegate") -> Decision:
        """Judges one delegation before the message leaves. The message is sent only when the decision is allowed."""
        return cast(Decision, self.check_call(tool, args, call_id=call_id))  # type: ignore[no-untyped-call]

    def check_inbound(self, text: str, identity: CallerIdentity, call_id: str | None = None) -> Decision:
        """Judges one inbound task before the agent runs it. The task runs only when the decision is allowed."""
        token = _INBOUND.set(identity)
        try:
            args = {"message": text, "caller": identity.principal or identity.asserted}
            return cast(Decision, self.check_call(self.policy.inbound_tool, args, call_id=call_id))  # type: ignore[no-untyped-call]
        finally:
            _INBOUND.reset(token)

    def check_answer(self, call: Decision, texts: list[str], failed: bool, receipts: ReceiptCheck) -> Decision:
        """Judges a remote agent's answer to an allowed delegation, with the receipt check as evidence."""
        token = _RECEIPTS.set(receipts)
        try:
            return cast(Decision, self.check_result(call, texts, failed=failed))  # type: ignore[no-untyped-call]
        finally:
            _RECEIPTS.reset(token)


def make_a2a_gate(policy: str | Path | Mapping[str, Any], session: str | Path | None = None, log: str | Path | None = None,
                  profile: str | Path | None = None, source: str = "a2a", receipts: str | Path | None = None,
                  receipt_key: str | Path | None = None, issuer: str = "urn:trp:gate", subject: str | None = None) -> A2AGate:
    """An A2AGate from a policy file path or a policy dict, with an optional shared session file and decision log.
    The default profile is adapters/a2a/profiles/a2a-delegation.trp.json. With receipts and receipt_key the gate also
    signs a Verifiable Trust Receipt for every decision, with `issuer` as iss and `subject` as sub when given."""
    pol = A2APolicy.from_file(policy) if isinstance(policy, (str, Path)) else A2APolicy(policy, Path.cwd())
    signer = ReceiptIssuer(receipt_key, issuer, receipts, subject=subject) if receipts else None
    return A2AGate(profile or DEFAULT_PROFILE, pol, Session(session), DecisionLog(log), source=source, receipts=signer)


# ------------------------------------------------------------ the caller side

def _part_texts(parts: Sequence[Part]) -> list[str]:
    return get_text_parts(parts) + [canonical(x) for x in get_data_parts(parts)] + get_url_parts(parts)


def answer_texts(task: Task | None, reply: Message | None) -> tuple[list[str], list[str]]:
    """(the text the model sees, every text the gate scans) of a returned task or message.

    The model sees the text parts, the data parts as canonical JSON and the file addresses of the task's artifacts
    and status message, or of the reply message. The gate also scans each raw file part that decodes as UTF-8 and
    every agent message in the task's history, since the caller can read those too.
    """
    parts: list[Part] = []
    extra: list[Part] = []
    if task is not None:
        for artifact in task.artifacts:
            parts.extend(artifact.parts)
        if task.status.HasField("message"):
            parts.extend(task.status.message.parts)
        for past in task.history:
            if past.role == Role.ROLE_AGENT:
                extra.extend(past.parts)
    elif reply is not None:
        parts.extend(reply.parts)
    visible = _part_texts(parts)
    scanned = visible + _part_texts(extra)
    for raw in get_raw_parts([*parts, *extra]):
        try:
            scanned.append(raw.decode("utf-8"))
        except UnicodeDecodeError:
            continue
    return visible, scanned


@dataclass
class DelegationResult:
    """What one delegation produced. `text` is what the model should see. It is the remote's answer, or the gate's
    reason when the gate refused the call or withheld the result. A withheld result carries no task and no message,
    so the caller's code cannot use what the gate withheld."""

    text: str
    call: Decision
    result: Decision | None = None
    task: Task | None = None
    message: Message | None = None
    receipts: ReceiptCheck = field(default_factory=ReceiptCheck)
    warnings: list[str] = field(default_factory=list)

    @property
    def delivered(self) -> bool:
        """True when the gate allowed the delegation and passed the answer, even when the remote task failed.
        task.status.state gives the task's own outcome."""
        return bool(self.call.allowed) and self.result is not None and not self.result.withheld


class Delegator:
    """The delegate tool. The gate judges each call first, and the message leaves only when the gate allows it.

    Use it as an async context manager, then call it with the tool's arguments, {"agent": address, "message": text}.
    `http` is an httpx.AsyncClient to send through, for TLS (Transport Layer Security) settings or tests. Without one
    the Delegator opens its own and closes it on exit. `interceptors` go to the a2a-sdk client, for example an
    AuthInterceptor that attaches the credentials the remote's card asks for. `verifier` checks returned receipts.
    """

    def __init__(self, gate: A2AGate, agent_id: str, *, issuer: str | None = None, tool: str = "delegate",
                 verifier: ReceiptVerifier | None = None, http: httpx.AsyncClient | None = None,
                 interceptors: Sequence[ClientCallInterceptor] = (), timeout: float = 300.0) -> None:
        if tool not in gate.policy.delegate_tools:
            raise ValueError(f"{tool} is not one of the policy's delegate_tools")
        self.gate, self.agent_id, self.issuer, self.tool = gate, agent_id, issuer, tool
        self.verifier, self.timeout = verifier, timeout
        self.interceptors = list(interceptors)
        self._http, self._owns_http = http, http is None
        self._cards: dict[str, AgentCard] = {}

    async def __aenter__(self) -> Self:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=30.0)
        return self

    async def __aexit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                        tb: TracebackType | None) -> None:
        if self._owns_http and self._http is not None:
            await self._http.aclose()
            self._http = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("use the Delegator inside async with")
        return self._http

    async def card(self, address: str) -> AgentCard:
        """The agent's card, fetched once from its well-known address, after the gate approved that agent."""
        o = origin(address)
        if o is None:
            raise ValueError(f"{address} is not an http or https address")
        if o not in self._cards:
            card = await A2ACardResolver(self.http, o).get_agent_card()
            outside = [i.url for i in card.supported_interfaces if not self.gate.policy.agent_ok(i.url)]
            if outside:
                raise PermissionError(f"the card of {o} lists an interface at {outside[0]} outside the approved agents, so nothing was sent")
            self._cards[o] = card
        return self._cards[o]

    def _outgoing(self, text: str, steps: int) -> Message:
        caller: dict[str, Any] = {"scheme": "uri", "value": self.agent_id}
        if self.issuer:
            caller["issuer"] = self.issuer
        return Message(role=Role.ROLE_USER, message_id=str(uuid.uuid4()), parts=[Part(text=text)],
                       metadata={EXTENSION: {"on_behalf_of": caller, "steps": steps}})

    async def __call__(self, args: Mapping[str, Any] | object, call_id: str | None = None) -> DelegationResult:
        args = dict(args) if isinstance(args, Mapping) else {"input": args}
        d = self.gate.check_delegation(args, call_id=call_id, tool=self.tool)
        if not d.allowed:
            return DelegationResult(text=d.reason, call=d)
        url_arg = self.gate.policy.url_args(self.tool)[0]
        address, text = args.get(url_arg), args.get("message")
        params: dict[str, Any] = {}
        expected = False
        task: Task | None = None
        reply: Message | None = None
        try:
            if not isinstance(address, str) or not isinstance(text, str) or not text.strip():
                raise ValueError(f"{self.tool} needs an agent address in {url_arg} and a message")
            card = await self.card(address)
            ext = find_extension_by_uri(card, EXTENSION)
            params = MessageToDict(ext.params) if ext is not None else {}
            expected = ext is not None or self.gate.policy.receipts_required(address)
            service = ServiceParametersFactory.create([with_a2a_extensions([EXTENSION])]) if expected else {}
            client = ClientFactory(ClientConfig(streaming=False, httpx_client=self.http)).create(card, interceptors=self.interceptors)
            try:
                request = SendMessageRequest(message=self._outgoing(text, int(d.record["evidence"]["steps_per_task"])))
                context = ClientCallContext(timeout=self.timeout, service_parameters=service)
                async for event in client.send_message(request, context=context):
                    if event.HasField("task"):
                        task = event.task
                    elif event.HasField("message"):
                        reply = event.message
            finally:
                await client.close()
        except Exception as err:  # noqa: BLE001  the model reads why the delegation failed
            out = f"Delegation failed. {type(err).__name__} {err}"
            r = self.gate.check_answer(d, [out], failed=True, receipts=ReceiptCheck(expected=expected))
            return DelegationResult(text=r.reason if r.withheld else out, call=d, result=r, receipts=ReceiptCheck(expected=expected))

        visible, scanned = answer_texts(task, reply)
        failed = (task is None and reply is None) or (task is not None and task.status.state in FAILED_STATES)
        o = origin(address) or address
        task_id = task.id if task is not None else (reply.task_id if reply is not None else "")
        rctx = ReceiptContext(agent=o, task_id=task_id, caller=self.agent_id,
                              issuer=params.get("issuer") if isinstance(params.get("issuer"), str) else None, card_params=params)
        check = check_receipts(carried_receipts(task), rctx, self.verifier, expected)
        r = self.gate.check_answer(d, scanned, failed=failed, receipts=check)
        warnings = []
        if check.verified is False and self.gate.policy.receipt_mode == "warn":
            warnings.append(f"The receipts from {o} were not verified, and receipt_mode warn passed the answer. {check.problem}")
        if r.withheld:
            return DelegationResult(text=r.reason, call=d, result=r, receipts=check, warnings=warnings)
        return DelegationResult(text="\n".join(visible) or "The agent returned no text.", call=d, result=r, task=task,
                                message=reply, receipts=check, warnings=warnings)


# ------------------------------------------------------------ the remote side

GateFor = Callable[[RequestContext], A2AGate]


class TRPAgentExecutor(AgentExecutor):
    """Wraps an a2a-sdk AgentExecutor so the gate judges each inbound task before the agent runs it.

    The gate sees the caller's identity as evidence. A refused task ends in the rejected state with the gate's
    reason as its status message, and the wrapped executor never runs. `gate` is one A2AGate for every task, or a
    function that returns the gate for one request, for a session per task or per caller.
    """

    def __init__(self, inner: AgentExecutor, gate: A2AGate | GateFor) -> None:
        self.inner = inner
        self._gate = gate
        self.decisions: list[Decision] = []

    def gate_for(self, context: RequestContext) -> A2AGate:
        return self._gate if isinstance(self._gate, A2AGate) else self._gate(context)

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        d = self.gate_for(context).check_inbound(context.get_user_input(), caller_identity(context), call_id=context.task_id)
        self.decisions.append(d)
        if d.allowed:
            await self.inner.execute(context, event_queue)
            return
        task_id, context_id = context.task_id or "", context.context_id or ""
        if context.current_task is None:
            history = [context.message] if context.message is not None else []
            await event_queue.enqueue_event(new_task(task_id, context_id, TaskState.TASK_STATE_SUBMITTED, history=history))
        updater = TaskUpdater(event_queue, task_id, context_id)
        await updater.reject(updater.new_agent_message([new_text_part(d.reason)]))

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        await self.inner.cancel(context, event_queue)
