# TRP Gate For A2A

This adapter puts the TRP (Trust Requirements Profile) gate from `adapters/gate/trp_gate.py` between AI agents that talk over A2A, the Agent2Agent protocol. A2A defines how one agent sends a task to another agent over HTTP (Hypertext Transfer Protocol) and reads back the result as a task with artifacts, or as a single message. The adapter is a thin format layer, and the shared gate makes every decision. It applies the rules the MCP (Model Context Protocol) checkpoint and the framework adapters apply, and it writes to the same session file and SHA-256 (Secure Hash Algorithm, 256 bits) chained decision log.

On the caller side the gate judges each delegation before the message leaves, and judges the returned task or message before the caller's model or code uses it. On the remote side the gate judges each inbound task before the agent runs it, with the caller's authenticated identity as evidence.

The adapter is built on the official a2a-sdk Python SDK (software development kit), version 1.3.0 from PyPI (the Python Package Index), which implements A2A protocol version 1.0. Its package metadata gives the license as Apache-2.0. Every a2a-sdk name the adapter uses was read in the installed source of that version, and the Source section lists where.

## Parts

| Part | Role |
|---|---|
| `trp_a2a.py` | The adapter. A single Python file over the shared gate and a2a-sdk |
| `profiles/a2a-delegation.trp.json` | The TRP profile it enforces by default. It has every rule of `adapters/mcp/profiles/mcp-tool-checkpoint.trp.json` and two A2A rules, and it validates against `schema/trp.schema.json` |
| `vtr_verifier.py` | `VTRVerifier`, which checks the receipts a remote agent returns with the VTR (Verifiable Trust Receipt) reference library in `vtr/tools/vtr.py` |
| `policy.example.json` | A policy for an agent that reads files, delegates to two approved agents and takes inbound tasks |
| `receipt-trust.example.json` | A trust file for `VTRVerifier`. It points at the test vector key set in `vtr/vectors/keys`, whose private keys are published beside it, so a deployment replaces it with each agent's real key set |
| `testing/stub_agent.py` | In-process a2a-sdk agents for the checks. They enforce nothing and record every task they receive |

Inside `trp_a2a.py` the pieces are these.

| Name | Side | Role |
|---|---|---|
| `A2APolicy` | Both | The shared gate's policy with the A2A keys added |
| `A2AGate` | Both | The shared gate. It judges a delegate tool's destination by the agent's address and adds the A2A evidence fields |
| `make_a2a_gate` | Both | Builds an `A2AGate` from a policy file or dict, with an optional session file and decision log |
| `Delegator` | Caller | The delegate tool. It sends through the a2a-sdk client only after the gate allows the call |
| `DelegationResult` | Caller | What one delegation produced, with `text` for the model, both decisions, the task, the receipt check and any warnings |
| `ReceiptVerifier`, `ReceiptContext`, `check_receipts` | Caller | The contract for checking the receipts a remote agent returns |
| `VTRVerifier`, `TrustedAgent` | Caller | In `vtr_verifier.py`. The receipt verifier built on the VTR reference library. It uses the keys and the profile the deployment trusts for each agent |
| `TRPAgentExecutor` | Remote | Wraps any a2a-sdk `AgentExecutor` so the gate judges each inbound task first |
| `caller_identity`, `CallerIdentity` | Remote | The caller of one inbound request, from the a2a-sdk server's authenticated user |

## Install

```bash
pip install "a2a-sdk[http-server]==1.3.0" "starlette==1.10.0" "sse-starlette==3.6.0" cryptography jsonschema
```

The remote side and the checks need Starlette, which the `http-server` extra installs. The caller side needs `a2a-sdk`, which brings `httpx`, and `cryptography` for the VTR signature checks. Run every command from the repository root.

## Policy

The policy has every key of the shared gate's policy, which `adapters/mcp/README.md` describes, and the keys below.

| Key | Default | Meaning |
|---|---|---|
| `approved_agents` | `[]` | Addresses of the agents the deployment approved. Each is compared by origin, the part of the address before the path |
| `delegate_tools` | `["delegate"]` | Tools that delegate over A2A. Each is kind `egress`, and its `url_args` names the argument that carries the agent's address. A delegate tool missing from `tools` is declared as `{"kind": "egress", "url_args": ["agent"]}` |
| `receipt_mode` | `"enforce"` | What happens when a remote agent's receipts fail verification. `enforce` withholds the result and `warn` passes it with a warning |
| `require_receipts` | `[]` | Agent addresses whose results must carry verified receipts even when their card lists no receipt extension |
| `inbound_tool` | `"a2a_task"` | The tool name the gate judges each inbound task as. Put it in `approved_tools`. It is declared kind `read` when missing from `tools` |
| `anonymous_callers` | `"allow"` | What happens when an inbound task carries no authenticated identity. `allow` runs it and records the absence, and `refuse` rejects the task |

Every delegate tool and the inbound tool must appear in `approved_tools`, or the `unapproved_tool_called` rule halts the session the first time the tool is used.

For a delegate tool the agent's address alone decides the `unapproved_destination` rule. The message goes to that agent and nowhere else. Web addresses written inside the message belong to the remote agent, and its own gate judges what it fetches.

## Caller

```python
import asyncio
import sys

sys.path.insert(0, "adapters/a2a")
from trp_a2a import DELEGATE_SPEC, Delegator, make_a2a_gate

gate = make_a2a_gate("adapters/a2a/policy.example.json", session="/tmp/agent-session.json",
                     log="/tmp/decisions.jsonl", source="orchestrator")


async def main() -> None:
    async with Delegator(gate, agent_id="urn:example:orchestrator") as delegate:
        result = await delegate({"agent": "https://planner.example.com", "message": "Plan the release."}, call_id="call_1")
        print(result.text)
        print(result.delivered, result.warnings)


asyncio.run(main())
```

Hand `DELEGATE_SPEC` to the model with its other tool schemas, and pass each `delegate` call's arguments and call id to the `Delegator`. Give the model `result.text`. It is the remote agent's answer, or the gate's reason when the gate refused the call or withheld the answer. A withheld answer also leaves `result.task` and `result.message` empty, so the caller's code cannot use it either.

Each call runs in this order.

1. The gate judges the call. A refused call sends nothing, and no request reaches that agent, including the request for its card.
2. The `Delegator` fetches the agent's card from `/.well-known/agent-card.json` at the agent's origin, once per `Delegator`. It sends nothing when the card lists an interface outside `approved_agents`.
3. The a2a-sdk client sends the message with a blocking, non-streaming `SendMessage` call over JSON-RPC (JavaScript Object Notation Remote Procedure Call). The message metadata names the caller under the extension key, as the Extension section shows.
4. The gate judges the returned task or message, with the receipt check as evidence. A withheld answer never reaches the model.

`Delegator` takes these keyword arguments.

| Argument | Meaning |
|---|---|
| `http` | An `httpx.AsyncClient` to send through, for TLS (Transport Layer Security) settings or for tests. Without one the `Delegator` opens its own and closes it on exit |
| `interceptors` | a2a-sdk client interceptors. An `AuthInterceptor` attaches the credentials the remote card's security schemes ask for, which is how the remote side learns who is calling |
| `verifier` | The receipt verifier, described under Receipts |
| `issuer` | Added to the caller in the message metadata |
| `tool` | The delegate tool's name, one of `delegate_tools` |
| `timeout` | Seconds to wait for the remote task, default 300 |

To send credentials, give the `Delegator` an `AuthInterceptor` with a `CredentialService` that returns the token for the scheme the card names.

```python
from a2a.client import AuthInterceptor, CredentialService

class Token(CredentialService):
    async def get_credentials(self, security_scheme_name, context):
        return "the token issued to this agent"

Delegator(gate, agent_id="urn:example:orchestrator", interceptors=[AuthInterceptor(Token())])
```

`AuthInterceptor` in a2a-sdk 1.3.0 sends the credential as `Authorization: Bearer` for every bearer-style scheme, which covers OAuth 2.0 and OpenID Connect, and as a named header for an API (application programming interface) key scheme located in a header. It sends credentials only for schemes the card lists in its security requirements.

## Remote Agent

```python
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware

from trp_a2a import TRPAgentExecutor, make_a2a_gate

gate = make_a2a_gate({"approved_tools": ["a2a_task"], "anonymous_callers": "refuse"},
                     session="/tmp/planner-session.json", log="/tmp/planner-decisions.jsonl", source="planner")
executor = TRPAgentExecutor(MyAgentExecutor(), gate)
handler = DefaultRequestHandler(agent_executor=executor, task_store=InMemoryTaskStore(), agent_card=card)
app = Starlette(routes=create_agent_card_routes(card) + create_jsonrpc_routes(handler, rpc_url="/"),
                middleware=[Middleware(AuthenticationMiddleware, backend=MyAuthenticationBackend())])
```

`MyAgentExecutor` is the agent you already serve, and `MyAuthenticationBackend` is the Starlette authentication backend that checks your credentials. `card` is your agent card. Its security schemes and requirements name what your backend enforces. `testing/stub_agent.py` has a complete small example of each, with `BearerTokens` as the backend.

Pass a function in place of the gate to give each task its own session, for example `TRPAgentExecutor(inner, lambda context: make_a2a_gate(policy, log="decisions.jsonl"))`. A refused task ends in the rejected state with the gate's reason as its status message, and the wrapped executor never runs. The wrapped agent's own tools sit behind the framework adapter it uses, from `adapters/frameworks`, with its own gate.

## Receipts

A remote agent whose own TRP gate signs a receipt for each decision can return those receipts with the task, as the TRP Studio agents do. The caller checks them before it uses the answer. This is the first design question still open, and the policy makes it configurable.

| `receipt_mode` | A Receipt Fails | Decision Log |
|---|---|---|
| `enforce`, the default | The answer is withheld by the `unverified_remote_receipts` rule, and the model reads the gate's reason | Action `withhold`, rule `unverified_remote_receipts`, the failure in the evidence |
| `warn` | The answer passes. `DelegationResult.warnings` names the failure | Action `pass`, no rule, the same failure in the evidence |

A check fails, and fails closed, in each of these cases.

- The card lists the receipt extension, or the agent is in `require_receipts`, and the task carries no receipts.
- Receipts came back and no `verifier` was given to the `Delegator`.
- A receipt is not a non-empty string.
- The verifier returns a reason, or raises.

The `Delegator` asks for receipts in the `A2A-Extensions` header only when the card lists the extension or the policy requires receipts from that agent. `require_receipts` protects against an agent whose card drops the extension to avoid returning receipts.

A verifier is a function `verify(receipt, ctx)` that returns `None` when the receipt passes and a short reason when it fails. `ctx` is a `ReceiptContext` with the agent's origin, the returned task's id, the caller's id, the issuer the card names in the extension parameters and every extension parameter. The deployment builds the verifier with the keys it trusts for each agent, so the keys come from the deployment and never from the agent that signed.

`VTRVerifier` in `vtr_verifier.py` is that verifier for Verifiable Trust Receipts, the signed records `vtr/spec.md` defines and the TRP gate issues for each decision. For each receipt it calls `vtr.verify` from `vtr/tools/vtr.py` with the agent's trusted key set and trusted profile. That call runs the checks of the Verification section of `vtr/spec.md`.

1. It parses the compact JWS (JSON Web Signature) and confirms the header carries exactly `alg`, `kid` and `typ` `vtr+jwt`.
2. It selects the key by `kid` from the trusted key set, confirms the `kid` is the RFC 7638 thumbprint of that key and verifies the signature.
3. It confirms the header and the claims are in canonical form, and checks the claims against the VTR claim rules.
4. It recomputes `trp_ref` from the trusted profile and compares it.
5. It refuses an Ed25519 receipt unless the deployment allows Ed25519 for that agent, as the specification requires.

`VTRVerifier` then binds the receipt to this exchange. Its `iss` must be the issuer the deployment names for the agent, or the issuer the card names when the deployment names none. Its `sub` must be `urn:trp:a2a:task:` followed by the returned task's id, so a valid receipt from another task cannot be replayed. Its `mode` must be one the deployment accepts, by default only `enforced`, since the specification treats any other mode as a decision that did not control the action. Its `on_behalf_of` must name this caller, unless the deployment sets `require_caller` to false. A receipt whose `outcome` is `stop` passes, since it is a valid record of the remote gate refusing one of its own calls.

```python
sys.path.insert(0, "adapters/a2a")
from vtr_verifier import VTRVerifier

verifier = VTRVerifier.from_file("/etc/agent/receipt-trust.json")
Delegator(gate, agent_id="urn:example:orchestrator", verifier=verifier)
```

The trust file names each agent the deployment trusts. Paths in it are relative to the file, and `jwks` and `profile` may also be the JSON objects themselves.

```json
{
  "subject_prefix": "urn:trp:a2a:task:",
  "require_caller": true,
  "agents": {
    "https://planner.example.com": {
      "jwks": "planner.jwks.json",
      "profile": "a2a-delegation.trp.json",
      "issuer": "urn:example:planner",
      "allow_eddsa": false,
      "modes": ["enforced"]
    }
  }
}
```

| Trust File Key | Meaning |
|---|---|
| `agents` | Each agent address, compared by origin, with what the deployment trusts for it |
| `jwks` | The JSON Web Key Set whose keys may sign the agent's receipts. Obtain it from the agent's operator out of band |
| `profile` | The TRP profile the agent's receipts must name in `trp_ref`, which is the profile the agent's own gate enforces |
| `issuer` | The `iss` the receipts must carry. Leave it out to accept the issuer the card names |
| `allow_eddsa` | Accept Ed25519 receipts from this agent, and the older identifier `EdDSA` on a VTR 0.5 receipt. Default false |
| `modes` | The receipt modes to accept. Default `["enforced"]` |
| `subject_prefix` | The text before the task id in `sub`. Default `urn:trp:a2a:task:`, which the TRP Studio agents use |
| `require_caller` | Require `on_behalf_of` to name the caller. Default true |

A remote agent built on this adapter can sign its own receipts. Pass `receipts`, `receipt_key`, `issuer` and `subject` to `make_a2a_gate`, as `make_gate` in `adapters/frameworks` takes them, and the gate signs a receipt for every decision and writes it into the decision log line.

| Evidence Field | Value |
|---|---|
| `remote_receipts` | Number of receipts the task carried |
| `remote_receipts_expected` | True when the card lists the extension or the policy requires receipts from this agent |
| `remote_receipts_verified` | True when every receipt passed, false when a check failed, null when none was expected or returned |
| `remote_receipt_problem` | The first reason a check failed, or null |
| `remote_receipts_sha256` | SHA-256 of the receipts joined by newlines, which a checker matches against the remote agent's own log. The log never keeps the receipts |
| `unverified_receipts_refused` | The rule field. True only when `remote_receipts_verified` is false and `receipt_mode` is `enforce` |

## Caller Identity

The second open design question is what to do when an inbound A2A call carries no caller identity. The A2A specification answers where identity comes from. Section 7 of the specification at tag `v1.0.0` of `github.com/a2aproject/a2a`, file `docs/specification.md`, says "Identity information is handled at the protocol layer", outside the A2A messages themselves. Section 7.3 has the client obtain credentials out of band for the schemes the card's `securitySchemes` names, and include them "in protocol-appropriate headers or metadata for every A2A request". Section 7.4 says the server "MUST authenticate every incoming request based on the provided credentials and its declared authentication requirements". Section 7.5 has the server authorize "based on the authenticated identity and its own policies".

The adapter therefore takes identity from the server's own authentication and never from the message. a2a-sdk 1.3.0 builds a `User` for each request from the `user` entry of the Starlette request scope, which `AuthenticationMiddleware` sets, and puts it in `RequestContext.call_context.user`. With no authentication middleware it is an `UnauthenticatedUser`. The caller a message names in its metadata goes in the log as `caller_asserted`, kept apart from the authenticated principal.

| `anonymous_callers` | No Authenticated Identity | Decision Log |
|---|---|---|
| `allow`, the default | The task runs | `caller_authenticated` false and `caller_principal` null in the evidence |
| `refuse` | The task is rejected by the `anonymous_caller` rule and the wrapped agent never runs | Action `refuse`, rule `anonymous_caller` |

| Evidence Field | Value |
|---|---|
| `caller_authenticated` | True when the server authenticated the request and the user has a name |
| `caller_principal` | The authenticated user name, or null |
| `caller_asserted` | The unverified caller the message metadata names, or null |
| `anonymous_caller_refused` | The rule field. True only when `caller_authenticated` is false and `anonymous_callers` is `refuse` |

Section 7.4 requires a server to authenticate every request against the requirements its card declares, so an agent whose card declares security requirements should run with `anonymous_callers` set to `refuse`.

## Cases

| Case | Rule | Phase | Gate That Decides |
|---|---|---|---|
| Delegation to an approved agent | None | Call and result | Caller |
| Delegation to an agent outside `approved_agents` | `unapproved_destination` | Call, before any request reaches that agent | Caller |
| Lines of a sensitive file sent to another agent | `sensitive_data_in_egress` | Call, from the fingerprints the file tools and the delegate tool share through one session file | Caller |
| Planted instructions or a credential in an answer, an attached file, a status message or an agent turn in the task history | `instructions_in_tool_result`, `secret_in_tool_result` | Result, before the model sees the answer | Caller |
| Receipts that fail verification | `unverified_remote_receipts` under `enforce`, a warning under `warn` | Result | Caller |
| An inbound task with no authenticated caller | `anonymous_caller` under `refuse`, evidence only under `allow` | Inbound call | Remote |
| A card that lists an interface outside `approved_agents` | None. The delegation fails and nothing is sent | Result | Caller |

The two A2A rules are `require_review`, so under `enforce` and `refuse` they withhold only the answer or refuse only the task in question. Every call and result carries both rule fields, so neither rule is ever inconclusive. A task that ends in the failed, rejected, canceled or unspecified state counts toward the session's tool error rate, which restricts the session once it passes its warning threshold of 0.25 and pauses further delegations.

## Extension

The adapter carries its data in one A2A extension, `urn:trp:a2a:extension:receipts:0.1`. It is the extension the TRP Studio agents publish.

| Place | Field | Content |
|---|---|---|
| Card `capabilities.extensions` entry, `params` | `issuer` | The issuer the agent's receipts name. A Studio card also gives `agent_id` and `jwks_uri` |
| Message metadata, under the extension URI | `on_behalf_of` | The caller as `{"scheme": "uri", "value": agent_id}`, with `issuer` when the `Delegator` has one |
| Message metadata, under the extension URI | `steps` | The steps the caller's session took, counting this delegation |
| Task metadata, under the extension URI | `receipts` | The receipts the remote agent's gate signed for the task, in order |

## Checks

```bash
python tests/a2a_check.py
```

The check runs 102 checks against thirteen in-process a2a-sdk agents. Each agent is a real a2a-sdk server app with the a2a-sdk card route and JSON-RPC route over a `DefaultRequestHandler`, and each delegation goes through the real a2a-sdk client. The client reaches the agents through `httpx.ASGITransport`, an ASGI (Asynchronous Server Gateway Interface) transport, so nothing listens on a socket and nothing leaves the process. It covers allowed delegations, every blocked case in the table above, both receipt modes, both identity modes with and without a bearer token, the profile against the schema and the policy's validation. The receipts are real VTR receipts minted with `vtr/tools/vtr.py` and ES256 and EdDSA keys the check generates on each run. `VTRVerifier` is checked against a receipt from an untrusted key, a key set entry whose `kid` is not its thumbprint, claims changed after signing, a receipt that names another profile, EdDSA with and without the operator's consent, another issuer, a missing issuer, another task, a replayed receipt end to end, a shadow mode receipt, another caller, a missing `on_behalf_of`, text that is not a JWS and the example trust file. The check also verifies a receipt the A2A gate itself signs. The `a2a` job in `.github/workflows/ci.yml` runs it on every push and pull request to `main`.

Type and lint checks, from the repository root.

```bash
pip install mypy types-protobuf ruff
MYPYPATH=adapters/gate:adapters/a2a:adapters/a2a/testing:vtr/tools mypy --strict --follow-imports=silent \
  --untyped-calls-exclude=trp_gate --untyped-calls-exclude=vtr \
  adapters/a2a/trp_a2a.py adapters/a2a/vtr_verifier.py adapters/a2a/testing/stub_agent.py tests/a2a_check.py
ruff check adapters/a2a tests/a2a_check.py
```

## Source

Read in the installed source of a2a-sdk 1.3.0. A later version may move any of these.

| Use | Source File | Name |
|---|---|---|
| Card fetch | `a2a/client/card_resolver.py` | `A2ACardResolver(httpx_client, base_url).get_agent_card()` at `AGENT_CARD_WELL_KNOWN_PATH` from `a2a/utils/constants.py` |
| Client | `a2a/client/client_factory.py` | `ClientFactory(config).create(card, interceptors)`, which sets the `A2A-Version` header on a shared `httpx` client |
| Client settings | `a2a/client/client.py` | `ClientConfig(streaming, httpx_client)`, `ClientCallContext(timeout, service_parameters)` |
| Send | `a2a/client/base_client.py` | `send_message(request, context=)`, which yields one `StreamResponse` holding a task or a message when streaming is off, and `close()` |
| Shared client kept open | `a2a/client/transports/jsonrpc.py` | `close()` leaves a shared `httpx` client open |
| Headers | `a2a/client/transports/http_helpers.py` | `get_http_args` sends the service parameters as HTTP headers |
| Extension header | `a2a/client/service_parameters.py`, `a2a/extensions/common.py` | `ServiceParametersFactory.create`, `with_a2a_extensions`, `HTTP_EXTENSION_HEADER`, `find_extension_by_uri` |
| Credentials | `a2a/client/auth/interceptor.py`, `a2a/client/auth/credentials.py` | `AuthInterceptor(credential_service)`, `CredentialService.get_credentials` |
| Interceptor type | `a2a/client/interceptors.py` | `ClientCallInterceptor` |
| Parts | `a2a/helpers/proto_helpers.py` | `get_text_parts`, `get_data_parts`, `get_url_parts`, `get_raw_parts`, `new_text_part`, `new_raw_part`, `new_task`, `new_text_message` |
| Executor | `a2a/server/agent_execution/agent_executor.py` | `AgentExecutor.execute(context, event_queue)`, `cancel` |
| Request context | `a2a/server/agent_execution/context.py` | `call_context`, `message`, `task_id`, `context_id`, `current_task`, `get_user_input()`, `requested_extensions` |
| Caller identity | `a2a/server/context.py`, `a2a/auth/user.py`, `a2a/server/routes/common.py` | `ServerCallContext.user`, `User.is_authenticated`, `User.user_name`, `UnauthenticatedUser`, `DefaultServerCallContextBuilder.build_user`, `StarletteUser` |
| First event of a task | `a2a/server/agent_execution/active_task.py` | A `Task` must be enqueued before a status update |
| Task updates | `a2a/server/tasks/task_updater.py` | `TaskUpdater(event_queue, task_id, context_id)`, `add_artifact`, `update_status(state, metadata=)`, `reject`, `cancel`, `new_agent_message` |
| Task metadata | `a2a/server/tasks/task_manager.py` | A status update's `metadata` merges into `Task.metadata` |
| Event queue | `a2a/server/events/event_queue.py` | `EventQueue.enqueue_event` |
| Server routes | `a2a/server/routes/agent_card_routes.py`, `a2a/server/routes/jsonrpc_routes.py` | `create_agent_card_routes(agent_card)`, `create_jsonrpc_routes(request_handler, rpc_url)` |
| Request handler | `a2a/server/request_handlers/__init__.py`, `default_request_handler_v2.py` | `DefaultRequestHandler(agent_executor, task_store, agent_card)`, an alias of `DefaultRequestHandlerV2` |
| Task store | `a2a/server/tasks/inmemory_task_store.py` | `InMemoryTaskStore()` |
| Types | `a2a/types/a2a_pb2.pyi` | `AgentCard`, `AgentCapabilities`, `AgentExtension`, `AgentInterface`, `AgentSkill`, `SecurityScheme`, `HTTPAuthSecurityScheme`, `SecurityRequirement`, `StringList`, `Message`, `Part`, `Role`, `SendMessageRequest`, `Task`, `Artifact`, `TaskState` |
| Protocol constants | `a2a/utils/constants.py` | `PROTOCOL_VERSION_CURRENT` is `1.0`, `TransportProtocol.JSONRPC` |

The Starlette names the remote side and the checks use, `AuthenticationMiddleware`, `AuthenticationBackend`, `AuthCredentials`, `SimpleUser`, `Middleware` and `Starlette(routes, middleware)`, were read in Starlette 1.10.0. `AuthenticationMiddleware` sets the request scope's `user` and `auth` entries, and sets an unauthenticated user when the backend returns nothing.

## Packages

| Package | Version Checked | License | Needed For |
|---|---|---|---|
| a2a-sdk | 1.3.0 | Apache-2.0 | Both sides |
| httpx | 0.28.1 | BSD-3-Clause | Both sides, through a2a-sdk |
| protobuf | 7.36.2 | BSD-3-Clause | Both sides, through a2a-sdk |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause | `VTRVerifier` and receipt signing, through `vtr/tools/vtr.py` |
| starlette | 1.10.0 | BSD-3-Clause | Remote side and checks, through the `http-server` extra |
| sse-starlette | 3.6.0 | BSD-3-Clause | Remote side and checks, through the `http-server` extra |
| typing_extensions | 4.16.0 | PSF-2.0 | Both sides, through a2a-sdk |
| culsans | 0.11.0 | ISC | Both sides on Python before 3.13, through a2a-sdk |
| jsonschema | 4.25.1 and 4.26.0 | MIT | The profile check |
| mypy | 2.3.1 | MIT | Type check only |
| types-protobuf | 7.35.1.20260906 | Apache-2.0 | Type check only |
| ruff | 0.16.8 | MIT | Lint only |

The check passes on Python 3.10, 3.11, 3.12 and 3.13.

## Limits

- Secret and instruction detection are the shared gate's pattern matches. Encoded or paraphrased content can pass them.
- The gate scans text parts, data parts, file address parts, raw file parts that decode as UTF-8 (the Unicode text encoding) and agent turns in the task history. It does not scan binary files, or any metadata apart from the receipts.
- An approved agent is an origin. Two agents on one origin under different paths share one approval.
- The `Delegator` uses the non-streaming JSON-RPC binding only. A task that stops to wait for input or for authorization comes back with its status message, and the `Delegator` does not continue it.
- `TRPAgentExecutor` judges the inbound task. What the wrapped agent returns to its caller is judged by the caller's own gate.
- `VTRVerifier` accepts single compact receipts. It does not accept the batched receipts of the Batches section of `vtr/spec.md`.
- `VTRVerifier` checks what a receipt says against the trusted profile and the exchange. It does not re-run the remote agent's evaluation, because the caller never sees the remote agent's evidence.
- `TRPAgentExecutor` signs receipts into the remote agent's own log when its gate has a receipt key, and it does not return them to the caller in the task metadata.
