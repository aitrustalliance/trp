"""TRP gate for Google's Agent Development Kit (ADK).

LlmAgent takes before_tool_callback(tool, args, tool_context) and
after_tool_callback(tool, args, tool_context, tool_response). A dict returned
from the before callback skips the tool and becomes its response, and a dict
returned from the after callback replaces the response (verified in
google-adk 2.13.0, google/adk/agents/llm_agent.py).

    from google.adk.agents import LlmAgent
    gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="google-adk")
    before, after = trp_callbacks(gate)
    agent = LlmAgent(name="assistant", model=model, tools=tools, before_tool_callback=before, after_tool_callback=after)
"""
from __future__ import annotations

from _common import make_gate, texts_of  # noqa: F401


def trp_callbacks(gate):
    allowed = {}  # function call id -> the allowed decision, for the after callback

    def call_id(tool_context):
        return getattr(tool_context, "function_call_id", None)

    def before(tool, args, tool_context):
        d = gate.check_call(tool.name, args or {}, call_id=call_id(tool_context))
        if not d.allowed:
            return {"error": d.reason, "trp": {"action": d.action, "rules": d.rules}}
        allowed[call_id(tool_context) or id(args)] = d
        return None

    def after(tool, args, tool_context, tool_response):
        d = allowed.pop(call_id(tool_context) or id(args), None)
        if d is None:
            return None
        r = gate.check_result(d, texts_of(tool_response))
        if r.withheld:
            return {"error": r.reason, "trp": {"action": r.action, "rules": r.rules}}
        return None

    return before, after
