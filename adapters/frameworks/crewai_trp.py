"""TRP gate for CrewAI.

CrewAI calls every registered before-tool-call hook with a ToolCallHookContext
(tool_name, tool_input) and blocks the tool when a hook returns False. Each
after-tool-call hook may return a string that replaces the tool result
(verified in crewai 1.15.34, crewai/hooks/tool_hooks.py). CrewAI tells the
agent "Tool execution blocked by hook" on a block, and the decision log keeps
the TRP reason.

    gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="crewai")
    register_trp_hooks(gate)
"""
from __future__ import annotations

from _common import make_gate, parse_args  # noqa: F401


def trp_hooks(gate):
    allowed = {}  # id of the hook context -> the allowed decision, for the after hook

    def before(ctx):
        d = gate.check_call(ctx.tool_name, parse_args(ctx.tool_input))
        if not d.allowed:
            return False
        allowed[id(ctx.tool_input)] = d
        return None

    def after(ctx):
        d = allowed.pop(id(ctx.tool_input), None)
        if d is None:
            return None
        r = gate.check_result(d, [ctx.tool_result] if isinstance(ctx.tool_result, str) else [])
        return r.reason if r.withheld else None

    return before, after


def register_trp_hooks(gate):
    from crewai.hooks import register_after_tool_call_hook, register_before_tool_call_hook

    before, after = trp_hooks(gate)
    register_before_tool_call_hook(before)
    register_after_tool_call_hook(after)
    return before, after
