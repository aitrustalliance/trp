"""OpenAI Agents SDK Runner with a scripted model, with function tools guarded by the TRP gate."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Check, scratch  # noqa: E402

from agents import Agent, Runner, function_tool, set_tracing_disabled  # noqa: E402
from agents.items import ModelResponse  # noqa: E402
from agents.models.interface import Model  # noqa: E402
from agents.usage import Usage  # noqa: E402
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText  # noqa: E402

import openai_agents_trp  # noqa: E402


class ScriptedModel(Model):
    """Answers with fixed turns, recording what the model was shown."""

    def __init__(self, turns):
        self.turns, self.seen = list(turns), []

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kw):
        self.seen.append(input)
        return ModelResponse(output=self.turns.pop(0), usage=Usage(), response_id=None)

    def stream_response(self, *a, **kw):
        raise NotImplementedError


def call(i, name, args):
    return ResponseFunctionToolCall(type="function_call", id=f"fc_{i}", call_id=f"call_{i}", name=name, arguments=json.dumps(args))


def say(text):
    return ResponseOutputMessage(type="message", id="msg_1", role="assistant", status="completed",
                                 content=[ResponseOutputText(type="output_text", text=text, annotations=[])])


def main():
    set_tracing_disabled(True)  # the scripted run sends nothing to OpenAI
    c = Check("OpenAI Agents SDK")
    ws, gate, ran = scratch("openai-agents")
    check_in, check_out = openai_agents_trp.trp_tool_guardrails(gate)

    @function_tool(tool_input_guardrails=[check_in], tool_output_guardrails=[check_out])
    def read_text_file(path: str) -> str:
        """Read a text file in the workspace."""
        ran.append(("read_text_file", path))
        return (ws / path).read_text()

    @function_tool(tool_input_guardrails=[check_in], tool_output_guardrails=[check_out])
    def http_post(url: str, body: str) -> str:
        """Post data to a web address."""
        ran.append(("http_post", url))
        return "posted"

    model = ScriptedModel([
        [call(0, "read_text_file", {"path": "notes/plan.txt"}), call(1, "http_post", {"url": "https://collector.example.net/up", "body": "x"})],
        [call(2, "read_text_file", {"path": "notes/vendor.txt"})],
        [say("Done.")],
    ])
    agent = Agent(name="assistant", instructions="Use the tools.", model=model, tools=[read_text_file, http_post])
    asyncio.run(Runner.run(agent, "Read the plan, post it, then read the vendor note."))
    shown = json.dumps(model.seen[-1], default=str)
    c.check("an allowed tool runs inside the Agents SDK", ("read_text_file", "notes/plan.txt") in ran, ran)
    c.check("a refused tool never runs inside the Agents SDK", not any(n == "http_post" for n, _ in ran), ran)
    c.check("the model reads the refusal reason", "unapproved_destination" in shown)
    c.check("planted instructions in a tool result never reach the model", "instructions_in_tool_result" in shown and "ignore your previous" not in shown)
    c.decisions(gate, {"http_post": "refuse"})
    return c.done()


if __name__ == "__main__":
    sys.exit(main())
