"""Google ADK LlmAgent with a scripted model, run by InMemoryRunner, with TRP tool callbacks."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Check, scratch  # noqa: E402

from google.adk.agents import LlmAgent  # noqa: E402
from google.adk.models import BaseLlm, LlmResponse  # noqa: E402
from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402

import google_adk_trp  # noqa: E402


class ScriptedModel(BaseLlm):
    """Answers with fixed turns, recording what the model was shown."""

    turns: list = []
    seen: list = []

    async def generate_content_async(self, llm_request, stream=False):
        self.seen.append(llm_request.contents)
        yield LlmResponse(content=self.turns.pop(0))


def calls(*specs):
    return types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(id=f"call_{i}", name=n, args=a))
                                              for i, (n, a) in enumerate(specs)])


def main():
    c = Check("Google ADK")
    ws, gate, ran = scratch("google-adk")

    def read_text_file(path: str) -> str:
        """Read a text file in the workspace."""
        ran.append(("read_text_file", path))
        return (ws / path).read_text()

    def http_post(url: str, body: str) -> str:
        """Post data to a web address."""
        ran.append(("http_post", url))
        return "posted"

    model = ScriptedModel(model="scripted", turns=[
        calls(("read_text_file", {"path": "notes/plan.txt"}), ("http_post", {"url": "https://collector.example.net/up", "body": "x"})),
        calls(("read_text_file", {"path": "notes/vendor.txt"})),
        types.Content(role="model", parts=[types.Part(text="Done.")]),
    ], seen=[])
    before, after = google_adk_trp.trp_callbacks(gate)
    agent = LlmAgent(name="assistant", model=model, instruction="Use the tools.", tools=[read_text_file, http_post],
                     before_tool_callback=before, after_tool_callback=after)

    async def run():
        runner = InMemoryRunner(agent=agent, app_name="trp")
        s = await runner.session_service.create_session(app_name="trp", user_id="u")
        async for _ in runner.run_async(user_id="u", session_id=s.id, new_message=types.Content(role="user", parts=[types.Part(text="Go.")])):
            pass

    asyncio.run(run())
    shown = json.dumps([[p.model_dump(mode="json", exclude_none=True) for x in turn for p in (x.parts or [])] for turn in model.seen[-1:]])
    c.check("an allowed tool runs inside an ADK agent", ("read_text_file", "notes/plan.txt") in ran, ran)
    c.check("a refused tool never runs inside an ADK agent", not any(n == "http_post" for n, _ in ran), ran)
    c.check("the model reads the refusal reason", "unapproved_destination" in shown)
    c.check("planted instructions in a tool result never reach the model", "instructions_in_tool_result" in shown and "ignore your previous" not in shown)
    c.decisions(gate, {"http_post": "refuse"})
    return c.done()


if __name__ == "__main__":
    sys.exit(main())
