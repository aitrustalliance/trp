"""TRP gate for the OpenAI Agents SDK.

Function tools take tool_input_guardrails and tool_output_guardrails, built
with the tool_input_guardrail and tool_output_guardrail decorators. A guardrail
returns ToolGuardrailFunctionOutput.allow() or .reject_content(message), and a
rejected call or output reaches the model as that message (verified in
openai-agents 0.24.0, agents/tool_guardrails.py and agents/tool.py).

    from agents import function_tool
    gate = make_gate("policy.json", session="session.json", log="decisions.jsonl", source="openai-agents")
    check_in, check_out = trp_tool_guardrails(gate)

    @function_tool(tool_input_guardrails=[check_in], tool_output_guardrails=[check_out])
    def read_text_file(path: str) -> str: ...
"""
from __future__ import annotations

from _common import make_gate, parse_args, texts_of  # noqa: F401


def trp_tool_guardrails(gate):
    from agents import ToolGuardrailFunctionOutput, tool_input_guardrail, tool_output_guardrail

    allowed = {}  # tool_call_id -> the allowed decision, for the output check

    @tool_input_guardrail
    def trp_check_call(data):
        ctx = data.context
        d = gate.check_call(ctx.tool_name, parse_args(ctx.tool_arguments), call_id=ctx.tool_call_id)
        if not d.allowed:
            return ToolGuardrailFunctionOutput.reject_content(d.reason, output_info=d.record)
        allowed[ctx.tool_call_id] = d
        return ToolGuardrailFunctionOutput.allow(output_info=d.record)

    @tool_output_guardrail
    def trp_check_result(data):
        d = allowed.pop(data.context.tool_call_id, None)
        if d is None:
            return ToolGuardrailFunctionOutput.allow()
        r = gate.check_result(d, texts_of(data.output))
        if r.withheld:
            return ToolGuardrailFunctionOutput.reject_content(r.reason, output_info=r.record)
        return ToolGuardrailFunctionOutput.allow(output_info=r.record)

    return trp_check_call, trp_check_result
