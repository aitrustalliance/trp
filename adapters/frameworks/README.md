# TRP Gate For Agent Frameworks

Each adapter connects one agent framework's own tool interception point to the shared TRP gate in `adapters/gate/trp_gate.py`. The MCP checkpoint in `adapters/mcp` uses the same gate. A rule means the same thing in every framework, every decision lands in the same SHA-256 chained log, and one session file can be shared across frameworks and MCP servers, so content read through one cannot leave through another.

| Framework | Version Verified | Interception Point | Adapter |
|---|---|---|---|
| LangChain | langchain 1.4.8 | `AgentMiddleware.wrap_tool_call` in `create_agent(middleware=...)` | `trp_middleware(gate)` |
| LangGraph | langgraph 1.2.19 | `ToolNode(wrap_tool_call=...)` | `trp_wrap_tool_call(gate)` |
| OpenAI Agents SDK | openai-agents 0.24.0 | `function_tool(tool_input_guardrails=..., tool_output_guardrails=...)` | `trp_tool_guardrails(gate)` |
| Google ADK (Agent Development Kit) | google-adk 2.13.0 | `LlmAgent(before_tool_callback=..., after_tool_callback=...)` | `trp_callbacks(gate)` |
| CrewAI | crewai 1.15.34 | `register_before_tool_call_hook`, `register_after_tool_call_hook` | `register_trp_hooks(gate)` |
| AG2 | ag2 1.2.2 | `BaseMiddleware.on_tool_execution` in `Agent(middleware=...)` | `trp_middleware(gate)` |
| Any MCP client | MCP 2026-07-28 and earlier | stdio proxy in front of the server | `adapters/mcp/trp_mcp_checkpoint.py` |

Each interception point was read in the framework's published source for the version listed. A later version may move it.

## Use

```python
import sys
sys.path.insert(0, "adapters/frameworks")
from _common import make_gate

gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="langchain")
```

The policy file has the same keys as the MCP checkpoint's policy, described in `adapters/mcp/README.md`. The default profile is `adapters/mcp/profiles/mcp-tool-checkpoint.trp.json`. Pass `profile=` to use another.

Then hand the gate to the adapter for the framework, as the table shows. A refused call never runs. The model receives the reason as the tool's result, in the form the framework uses for a tool error. A withheld result reaches the model as the reason in place of the content.

CrewAI tells the agent "Tool execution blocked by hook" on a refusal, since its hook interface has no way to pass a message. The decision log keeps the TRP reason.

## Checks

Each check runs the real framework, with its own runner, and replaces the model with fixed turns, so it needs no API key and no network.

```bash
pip install "langchain==1.4.8" "langgraph==1.2.19" && PYTHONPATH=adapters/frameworks python tests/frameworks/langchain_check.py
pip install "openai-agents==0.24.0" && OPENAI_API_KEY=unused PYTHONPATH=adapters/frameworks python tests/frameworks/openai_agents_check.py
pip install "google-adk==2.13.0" && PYTHONPATH=adapters/frameworks python tests/frameworks/google_adk_check.py
pip install "crewai==1.15.34" && OTEL_SDK_DISABLED=true PYTHONPATH=adapters/frameworks python tests/frameworks/crewai_check.py
pip install "ag2==1.2.2" && PYTHONPATH=adapters/frameworks python tests/frameworks/ag2_check.py
```

The `agent-frameworks` job in `.github/workflows/ci.yml` runs all five on every push.
