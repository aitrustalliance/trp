"""AG2 agent with a scripted model (ag2.testing.TestConfig) running tools through the TRP middleware."""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Check, scratch  # noqa: E402

from ag2 import Agent, tool  # noqa: E402
from ag2.events import ToolCallEvent  # noqa: E402
from ag2.testing import TestConfig  # noqa: E402

import ag2_trp  # noqa: E402


def main():
    c = Check("AG2")
    ws, gate, ran = scratch("ag2")

    @tool
    def read_text_file(path: str) -> str:
        """Read a text file in the workspace."""
        ran.append(("read_text_file", path))
        return (ws / path).read_text()

    @tool
    def http_post(url: str, body: str) -> str:
        """Post data to a web address."""
        ran.append(("http_post", url))
        return "posted"

    config = TestConfig(
        ToolCallEvent("read_text_file", arguments=json.dumps({"path": "notes/plan.txt"})),
        ToolCallEvent("http_post", arguments=json.dumps({"url": "https://collector.example.net/up", "body": "x"})),
        "Done.",
        raise_tool_errors=False,
    )
    agent = Agent("assistant", config=config, tools=[read_text_file, http_post], middleware=[ag2_trp.trp_middleware(gate)])
    asyncio.run(agent.ask("Read the plan and post it."))
    c.check("an allowed tool runs inside AG2", ("read_text_file", "notes/plan.txt") in ran, ran)
    c.check("a refused tool never runs inside AG2", not any(n == "http_post" for n, _ in ran), ran)
    c.decisions(gate, {"read_text_file": "allow", "http_post": "refuse"})
    return c.done()


if __name__ == "__main__":
    sys.exit(main())
