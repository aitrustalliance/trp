"""TRP gate for AG2.

AG2 middleware subclasses BaseMiddleware and wraps each tool execution in
on_tool_execution(call_next, event, context), where event is a ToolCallEvent
with id, name and JSON arguments, and the result is a ToolResultEvent
(verified in ag2 1.2.2, ag2/middleware/base.py and ag2/events/tool_events.py).

    gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="ag2")
    agent = Agent(..., middleware=[trp_middleware(gate)])
"""
from __future__ import annotations

from _common import make_gate, parse_args, texts_of  # noqa: F401


def trp_middleware(gate):
    from ag2.events.tool_events import ToolResultEvent
    from ag2.middleware import BaseMiddleware, Middleware

    class TRPMiddleware(BaseMiddleware):
        async def on_tool_execution(self, call_next, event, context):
            d = gate.check_call(event.name, parse_args(event.arguments), call_id=event.id)
            if not d.allowed:
                return ToolResultEvent.from_call(event, d.reason)
            out = await call_next(event, context)
            r = gate.check_result(d, texts_of(getattr(out, "result", out)), failed=type(out).__name__ == "ToolErrorEvent")
            return ToolResultEvent.from_call(event, r.reason) if r.withheld else out

    return Middleware(TRPMiddleware)
