# Integration Architecture

TRP occupies the trust requirements layer of the AI infrastructure stack. It
specifies the conditions under which an interaction is acceptable. The
protocols below handle identity, authorization, evidence, and invocation. TRP
does not replace any of them. It is the language that ties them together.

## Where TRP Sits in the Stack

```
┌─────────────────────────────────────────────────────────┐
│  Application / Orchestration Layer                      │
│  (Salesforce, ServiceNow, internal platforms)           │
├─────────────────────────────────────────────────────────┤
│  Trust Requirements Layer  ◄── TRP                      │
│  "Under what conditions is this interaction acceptable?" │
├─────────────────────────────────────────────────────────┤
│  Authorization Layer                                    │
│  (OAuth 2.1, AAuth, RBAC, ABAC)                        │
│  "What is this entity allowed to do?"                   │
├─────────────────────────────────────────────────────────┤
│  Identity Layer                                         │
│  (SPIFFE, DIDs, X.509, Login.gov)                       │
│  "Who or what is this entity?"                          │
├─────────────────────────────────────────────────────────┤
│  Transport Layer                                        │
│  (HTTPS, gRPC, MCP, A2A)                                │
│  "How do these entities communicate?"                   │
└─────────────────────────────────────────────────────────┘
```

Each layer answers a different question. TRP answers the one that none of
the others cover: given that we know who this entity is and what it is
allowed to do, does it meet the trust requirements for this interaction in
this domain?

## Working Adapters

The adapters in `adapters/` put a TRP profile in the path of a running AI agent today. Each one connects a framework's own tool interception point to one shared gate in `adapters/gate/trp_gate.py`, which judges every tool call before it runs and every tool result before the model sees it, with the reference evaluator. A refused call never runs, and the model reads the reason as the tool's result.

| System | Interception Point | Adapter | Checked With |
|---|---|---|---|
| Any MCP client and server on stdio | A proxy the client starts in place of the server | `adapters/mcp/trp_mcp_checkpoint.py` | Official MCP Python SDK 2.3.0, official filesystem server 2.1.0 and fetch server 2026.10.28, protocol revision 2026-07-28 |
| LangChain | `AgentMiddleware.wrap_tool_call` | `adapters/frameworks/langchain_trp.py` | langchain 1.4.8 with a scripted model |
| LangGraph | `ToolNode(wrap_tool_call=...)` | `adapters/frameworks/langchain_trp.py` | langgraph 1.2.19 |
| OpenAI Agents SDK | Tool input and output guardrails | `adapters/frameworks/openai_agents_trp.py` | openai-agents 0.24.0 with a scripted model |
| Google ADK (Agent Development Kit) | Before and after tool callbacks | `adapters/frameworks/google_adk_trp.py` | google-adk 2.13.0 with a scripted model |
| CrewAI | Before and after tool call hooks | `adapters/frameworks/crewai_trp.py` | crewai 1.15.34 with a scripted model |
| AG2 | Tool execution middleware | `adapters/frameworks/ag2_trp.py` | ag2 1.2.2 with a scripted model |

The reference profile `adapters/mcp/profiles/mcp-tool-checkpoint.trp.json` covers unapproved tools, paths outside the workspace, unapproved domains, credentials in outbound arguments, sensitive data leaving the session, writes that need approval, credentials in tool results and planted instructions in tool results. Four scored signals set the session's standing, and a restricted session keeps reads and pauses writes, outbound calls and commands.

Every adapter writes to the same decision log, one line of canonical JSON per decision, each line carrying the SHA-256 of the line before it. One session file can span several MCP servers and several frameworks, so content read through one cannot leave through another. `adapters/mcp/README.md` and `adapters/frameworks/README.md` give the setup for each.

## SPIFFE / SPIRE

SPIFFE assigns a cryptographic identity to every workload, a URI like
`spiffe://example.com/service/evaluator` backed by an X.509 certificate
(SVID). It answers which piece of software is actually running, a separate
question from which human logged in.

TRP consumes SPIFFE identity as evidence. A hard rule can require that the
calling workload present a valid SVID before the interaction proceeds. A
scored signal can track certificate freshness, as below.

```json
{
  "rule": "workload-identity-required",
  "field": "spiffe_id_verified",
  "condition": "is_true",
  "action": "block_startup"
}
```

```json
{
  "signal": "svid_age_seconds",
  "weight": 10,
  "direction": "higher_is_unsafe",
  "warning_threshold": 3600,
  "critical_threshold": 86400,
  "unit": "seconds",
  "reason": "Stale workload certificates indicate rotation failure."
}
```

A valid SVID proves identity. It does not prove that the workload meets
healthcare governance thresholds or manufacturing safety requirements. TRP
carries those requirements. SPIFFE provides one category of evidence.

## AAuth

Dick Hardt's AAuth protocol (the same author behind OAuth 2.0) replaces
bearer tokens with keypair-signed HTTP requests for agent authorization.
Agents propose "missions" describing what they intend to do. A person server
brokers human consent.

The protocol explicitly notes that "missions are not a policy language"
(Appendix B.3.5). Missions are natural-language descriptions evaluated by
humans or AI. TRP provides the machine-readable, deterministic policy
language that AAuth chose not to build.

The composition is direct. A person server receives an agent's mission,
fetches the applicable TRP profile, evaluates the agent's evidence against
it, and approves or denies the mission based on standing. The two protocols
are complementary by design.

## auth.md

WorkOS publishes auth.md as an open protocol for agent authentication
discovery. A service places a markdown file at its domain root describing
how agents should authenticate, with OAuth 2.1 flows, ID-JAG token exchange
and dynamic client registration.

`auth.md` answers how to authenticate. `trust.json` answers what trust
requirements apply after authentication. Side by side on the same domain,
they give agents a complete discovery surface.

```
1. Agent encounters a service
2. Fetches auth.md -> authenticates
3. Fetches trust.json -> discovers trust requirements
4. Evaluates its evidence against the applicable TRP profile
5. If authenticated AND trusted: proceed
```

A valid OAuth token proves identity. It says nothing about whether the agent
meets compliance, bias, or safety requirements for the interaction it
requests. `trust.json` carries those requirements.

See `spec/trust-json-discovery.md` for the full specification.

## Model Context Protocol (MCP)

MCP is an open protocol for AI models to invoke tools, access resources,
and receive structured context from external services. An MCP server can
publish a TRP profile describing what it requires of callers, such as the
following.

```json
{
  "trp_id": "mcp-tool-invocation",
  "scope": {
    "intended_use": "Trust requirements for agents invoking tools on this MCP server."
  },
  "hard_rules": [
    {
      "rule": "agent-identity-required",
      "field": "agent_identity_verified",
      "condition": "is_false",
      "action": "halt"
    }
  ],
  "scored_signals": [
    {
      "signal": "invocation_rate_per_minute",
      "weight": 20,
      "direction": "higher_is_unsafe",
      "warning_threshold": 60,
      "critical_threshold": 300,
      "reason": "Excessive invocation rate indicates runaway agent behavior."
    },
    {
      "signal": "data_classification_level",
      "weight": 30,
      "direction": "higher_is_unsafe",
      "warning_threshold": 2,
      "critical_threshold": 4,
      "reason": "Tools accessing highly classified data require elevated trust."
    }
  ]
}
```

MCP defines how tools are invoked. TRP defines the conditions under which
invocation is acceptable. An MCP server evaluates the client's evidence
before granting tool access.

The MCP checkpoint in `adapters/mcp` enforces a TRP profile from the other
side, in front of any server, with no change to the client or the server. See
Working Adapters above.

## W3C Verifiable Credentials and DIDs

Verifiable Credentials are cryptographically signed claims about a subject,
issued by a trusted authority. A VC attesting to a compliance certification
or a model evaluation result is a natural evidence artifact for TRP.

The evaluator does not need to understand VC internals. It consumes a value
extracted from the credential, like the number of days since a HIPAA
certification was issued, as below.

```json
{
  "signal": "hipaa_certification_age_days",
  "weight": 25,
  "direction": "higher_is_unsafe",
  "warning_threshold": 180,
  "critical_threshold": 365,
  "unit": "days",
  "reason": "HIPAA compliance certification must be current."
}
```

VCs carry claims. TRP specifies which claims matter, what thresholds they
must meet, and what happens when they fall short.

## Google A2A

A2A handles communication, delegation, and coordination between AI agents
across organizational boundaries. When Agent A delegates to Agent B, both
agents can evaluate each other against published TRP profiles before
delegation proceeds.

TRP handles the trust contract, meaning the conditions under which Agent A
will delegate to Agent B and the conditions under which Agent B will accept.
The profile runs both ways, enabling bilateral trust without manual
negotiation by either operator.

## Composing Multiple Evidence Sources

TRP's value shows up when multiple evidence sources feed a single evaluation.
A profile for an AI agent accessing healthcare data might require the
following evidence.

- Workload identity via SPIFFE (is this the production instance?)
- Authorization via AAuth (has the person approved this mission?)
- Compliance via Verifiable Credential (is the HIPAA certification current?)
- Bias evaluation via model card (is demographic parity within threshold?)
- Operational metrics via monitoring (is latency acceptable?)

Each comes from a different protocol and a different system. TRP composes
them into a single, deterministic trust decision.

## Building an Integration

To connect a new evidence source to TRP, follow these steps.

1. Identify the evidence artifact your protocol produces (a certificate, a
   token, a signed claim, a metric).
2. Define TRP signals or hard rules that consume values extracted from that
   artifact.
3. Build an evidence adapter that extracts values from the protocol's native
   format and passes them to the evaluator.
4. Write every field your rules inspect on every run, even when the value is false or zero. Section 3.4 treats a missing hard rule field as inconclusive, which marks the assessment incomplete.
5. Validate using the conformance test suite.

Contributions of evidence adapters are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md).
