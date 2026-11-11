"""In-process A2A agents for tests/a2a_check.py, served with the a2a-sdk Starlette routes.

Nothing listens on a socket. HostRouter hands each request to one agent's app by its Host header, and the checks
reach it through httpx.ASGITransport, so no request leaves the process. StubAgent enforces nothing and writes down
every task it receives, so each refusal is the caller's gate, and a refused delegation provably never arrived.

The receipts here are real Verifiable Trust Receipts, minted with the VTR reference library in vtr/tools/vtr.py
and keys the checks generate.
"""
from __future__ import annotations

import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, TypeAlias

from a2a.client import ClientCallContext, CredentialService
from a2a.helpers import new_raw_part, new_task, new_text_message, new_text_part
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentExtension,
    AgentInterface,
    AgentSkill,
    HTTPAuthSecurityScheme,
    SecurityRequirement,
    SecurityScheme,
    StringList,
    TaskState,
)
from a2a.utils.constants import PROTOCOL_VERSION_CURRENT, TransportProtocol
from google.protobuf.json_format import MessageToDict
from starlette.applications import Starlette
from starlette.authentication import (
    AuthCredentials,
    AuthenticationBackend,
    AuthenticationError,
    BaseUser,
    SimpleUser,
)
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.requests import HTTPConnection
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "vtr" / "tools"))
from trp_a2a import EXTENSION

import vtr

Reply: TypeAlias = str | Callable[[RequestContext], str]


class StubAgent(AgentExecutor):
    """An A2A agent with fixed answers. It records each task it receives in `seen`.

    `receipts(context)` gives the receipts to return in the task metadata, sent only when the request names
    EXTENSION in its A2A-Extensions header. With `as_message` the agent answers with one Message and no task. Each
    of `files` goes back as a raw file artifact.
    """

    def __init__(self, reply: Reply, *, receipts: Callable[[RequestContext], list[object]] | None = None,
                 issuer: str = "", state: TaskState = TaskState.TASK_STATE_COMPLETED, as_message: bool = False,
                 files: Sequence[bytes] = ()) -> None:
        self.reply, self.receipts, self.issuer, self.state, self.as_message = reply, receipts, issuer, state, as_message
        self.files = list(files)
        self.seen: list[dict[str, Any]] = []

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        user = context.call_context.user
        self.seen.append({
            "text": context.get_user_input(), "task_id": context.task_id,
            "authenticated": user.is_authenticated, "user": user.user_name,
            "extensions": sorted(context.requested_extensions),
            "metadata": MessageToDict(context.message.metadata) if context.message is not None else {},
        })
        text = self.reply(context) if callable(self.reply) else self.reply
        task_id, context_id = context.task_id or "", context.context_id or ""
        if self.as_message:
            await event_queue.enqueue_event(new_text_message(text, context_id=context_id, task_id=task_id))
            return
        if context.current_task is None:
            history = [context.message] if context.message is not None else []
            await event_queue.enqueue_event(new_task(task_id, context_id, TaskState.TASK_STATE_SUBMITTED, history=history))
        updater = TaskUpdater(event_queue, task_id, context_id)
        await updater.add_artifact([new_text_part(text)], name="answer")
        for i, data in enumerate(self.files, 1):
            await updater.add_artifact([new_raw_part(data, media_type="text/plain", filename=f"file-{i}.txt")], name=f"file-{i}")
        carried = None
        if self.receipts is not None and EXTENSION in context.requested_extensions:
            carried = {EXTENSION: {"issuer": self.issuer, "receipts": self.receipts(context)}}
        await updater.update_status(self.state, metadata=carried)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        await TaskUpdater(event_queue, context.task_id or "", context.context_id or "").cancel()


def stub_card(name: str, url: str, *, receipts_issuer: str | None = None, bearer: bool = False,
              extra_interfaces: Sequence[str] = ()) -> AgentCard:
    """A card for an agent served at `url` over JSON-RPC (JavaScript Object Notation Remote Procedure Call).

    `receipts_issuer` lists EXTENSION with that issuer. `bearer` declares an HTTP bearer scheme and requires it,
    as Section 7.3 of the A2A specification describes. `extra_interfaces` adds more interface addresses.
    """
    base = url.rstrip("/")
    extensions = []
    if receipts_issuer is not None:
        extensions.append(AgentExtension(uri=EXTENSION, required=False, params={"issuer": receipts_issuer},
                                         description="Returns the receipts the agent's TRP gate signed for the task"))
    card = AgentCard(
        name=name, description=f"{name} for the A2A adapter checks", version="1.0.0",
        supported_interfaces=[AgentInterface(url=u, protocol_binding=TransportProtocol.JSONRPC.value,
                                             protocol_version=PROTOCOL_VERSION_CURRENT)
                              for u in [base + "/", *extra_interfaces]],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False, extensions=extensions),
        default_input_modes=["text/plain"], default_output_modes=["text/plain"],
        skills=[AgentSkill(id="answer", name="Answer", description="Answers one message", tags=["answer"])])
    if bearer:
        card.security_schemes["bearer"].CopyFrom(SecurityScheme(http_auth_security_scheme=HTTPAuthSecurityScheme(scheme="Bearer")))
        card.security_requirements.append(SecurityRequirement(schemes={"bearer": StringList(list=[])}))
    return card


class BearerTokens(AuthenticationBackend):
    """Starlette authentication from a fixed map of bearer token to user name. No token means no user."""

    def __init__(self, tokens: Mapping[str, str]) -> None:
        self.tokens = dict(tokens)

    async def authenticate(self, conn: HTTPConnection) -> tuple[AuthCredentials, BaseUser] | None:
        scheme, _, token = conn.headers.get("authorization", "").partition(" ")
        if scheme.lower() != "bearer" or not token:
            return None
        name = self.tokens.get(token)
        if name is None:
            raise AuthenticationError("unknown bearer token")
        return AuthCredentials(["a2a"]), SimpleUser(name)


def stub_app(card: AgentCard, executor: AgentExecutor, tokens: Mapping[str, str] | None = None) -> Starlette:
    """The a2a-sdk card route and JSON-RPC route for one agent, behind bearer authentication when `tokens` is given."""
    handler = DefaultRequestHandler(agent_executor=executor, task_store=InMemoryTaskStore(), agent_card=card)
    routes = create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/")
    middleware = [Middleware(AuthenticationMiddleware, backend=BearerTokens(tokens))] if tokens is not None else []
    return Starlette(routes=routes, middleware=middleware)


class HostRouter:
    """One ASGI (Asynchronous Server Gateway Interface) app that hands each request to the app for its Host header.
    It records every request, so a check can show a host was never contacted."""

    def __init__(self, apps: Mapping[str, ASGIApp]) -> None:
        self.apps = {h.lower(): a for h, a in apps.items()}
        self.requests: list[tuple[str, str, str]] = []

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            return
        host = dict(scope["headers"]).get(b"host", b"").decode("latin-1").lower()
        self.requests.append((host, scope["method"], scope["path"]))
        app = self.apps.get(host)
        if app is None:
            await PlainTextResponse("no agent at this host", status_code=404)(scope, receive, send)
            return
        await app(scope, receive, send)

    def hits(self, host: str) -> int:
        return sum(1 for h, _, _ in self.requests if h == host.lower())


class StaticToken(CredentialService):
    """Gives one token for every security scheme, for the a2a-sdk AuthInterceptor."""

    def __init__(self, token: str) -> None:
        self.token = token

    async def get_credentials(self, security_scheme_name: str, context: ClientCallContext | None) -> str | None:
        return self.token


def mint_receipt(key: Any, profile: Mapping[str, Any], evidence: Mapping[str, Any], *, issuer: str, subject: str,
                 caller: str | None, mode: str = "enforced", outcome: str = "allow") -> str:
    """A Verifiable Trust Receipt signed with `key`, a vtr.Key, through the VTR reference library."""
    extra: dict[str, Any] = {"outcome": outcome, "agent": {"id": issuer, "version": "1.0.0"}}
    if caller is not None:
        extra["on_behalf_of"] = {"scheme": "uri", "value": caller}
    claims = vtr.claims_for(dict(profile), dict(evidence), iss=issuer, sub=subject, mode=mode, **extra)
    return str(vtr.sign(claims, key))


def sign_with_kid(key: Any, claims: Mapping[str, Any], kid: str) -> str:
    """A receipt in the VTR envelope whose header names `kid` in place of the key's own thumbprint, for the check
    that a verifier refuses a key set entry whose kid is not the thumbprint of its key."""
    header = {"alg": key.alg, "kid": kid, "typ": vtr.TYP}
    signing_input = vtr.b64u(vtr.canonical(header).encode()) + "." + vtr.b64u(vtr.canonical(dict(claims)).encode())
    return str(signing_input + "." + vtr.b64u(key.sign(signing_input.encode("ascii"))))
