"""TRP gate for LangChain 1.x agents and LangGraph ToolNode.

LangChain's create_agent takes middleware, and AgentMiddleware.wrap_tool_call
wraps every tool execution (verified in langchain 1.4.8,
langchain/agents/middleware/types.py). LangGraph's ToolNode takes the same kind
of function as its wrap_tool_call argument (langgraph-prebuilt 1.1.1,
langgraph/prebuilt/tool_node.py).

    from langchain.agents import create_agent
    gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="langchain")
    agent = create_agent(model, tools, middleware=[trp_middleware(gate)])

    from langgraph.prebuilt import ToolNode
    node = ToolNode(tools, wrap_tool_call=trp_wrap_tool_call(gate))

A refused call returns a ToolMessage with status "error" and the reason, so
the model reads why. A withheld result replaces the tool's content the same
way. The tool never runs on a refused call.
"""
from __future__ import annotations

from _common import make_gate, texts_of  # noqa: F401  make_gate is part of this module's interface


def trp_wrap_tool_call(gate):
    from langchain_core.messages import ToolMessage

    def refuse(call, reason):
        return ToolMessage(content=reason, tool_call_id=call.get("id") or "", name=call.get("name"), status="error")

    def wrap(request, handler):
        call = request.tool_call
        d = gate.check_call(call.get("name", ""), call.get("args") or {}, call_id=call.get("id"))
        if not d.allowed:
            return refuse(call, d.reason)
        out = handler(request)
        if isinstance(out, ToolMessage):
            r = gate.check_result(d, texts_of(out.content), failed=out.status == "error")
            if r.withheld:
                return refuse(call, r.reason)
        return out

    return wrap


def trp_middleware(gate):
    from langchain.agents.middleware import AgentMiddleware

    wrap = trp_wrap_tool_call(gate)

    class TRPToolMiddleware(AgentMiddleware):
        """Judges every tool call and result against the TRP profile."""

        def wrap_tool_call(self, request, handler):
            return wrap(request, handler)

    return TRPToolMiddleware()
