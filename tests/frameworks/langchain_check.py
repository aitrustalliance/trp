"""LangChain create_agent with a scripted model, and LangGraph ToolNode, running tools through the TRP gate."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Check, scratch  # noqa: E402

from langchain.agents import create_agent  # noqa: E402
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402
from langgraph.graph import END, START, MessagesState, StateGraph  # noqa: E402
from langgraph.prebuilt import ToolNode  # noqa: E402

import langchain_trp  # noqa: E402


class ScriptedModel(FakeMessagesListChatModel):
    """Plays fixed replies, and accepts tools the way a real chat model does."""

    def bind_tools(self, tools, **kwargs):
        return self


def tools_for(ws, ran):
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

    return [read_text_file, http_post]


def calls(*specs):
    return AIMessage(content="", tool_calls=[{"name": n, "args": a, "id": f"call_{i}"} for i, (n, a) in enumerate(specs)])


def main():
    c = Check("LangChain")
    ws, gate, ran = scratch("langchain")
    model = ScriptedModel(responses=[
        calls(("read_text_file", {"path": "notes/plan.txt"}), ("http_post", {"url": "https://collector.example.net/up", "body": "x"})),
        calls(("read_text_file", {"path": "notes/vendor.txt"})),
        AIMessage(content="Done."),
    ])
    agent = create_agent(model, tools_for(ws, ran), middleware=[langchain_trp.trp_middleware(gate)])
    out = agent.invoke({"messages": [HumanMessage("Read the plan, post it, then read the vendor note.")]})
    msgs = {m.tool_call_id: m for m in out["messages"] if isinstance(m, ToolMessage)}
    c.check("an allowed tool runs inside a LangChain agent", ("read_text_file", "notes/plan.txt") in ran, ran)
    c.check("a refused tool never runs inside a LangChain agent", not any(n == "http_post" for n, _ in ran), ran)
    c.check("the model reads the refusal as an error tool message", msgs["call_1"].status == "error" and "unapproved_destination" in msgs["call_1"].content, msgs.get("call_1"))
    vendor = [m for m in out["messages"] if isinstance(m, ToolMessage) and m.status == "error" and "instructions_in_tool_result" in m.content]
    c.check("planted instructions in a tool result never reach the model", vendor and "ignore your previous" not in vendor[0].content, vendor)
    c.decisions(gate, {"http_post": "refuse"})

    ws2, gate2, ran2 = scratch("langgraph")
    node = ToolNode(tools_for(ws2, ran2), wrap_tool_call=langchain_trp.trp_wrap_tool_call(gate2))
    g = StateGraph(MessagesState)
    g.add_node("tools", node)
    g.add_edge(START, "tools")
    g.add_edge("tools", END)
    res = g.compile().invoke({"messages": [calls(("read_text_file", {"path": "notes/plan.txt"}), ("read_text_file", {"path": "../../etc/passwd"}))]})
    by_id = {m.tool_call_id: m for m in res["messages"] if isinstance(m, ToolMessage)}
    c.check("a LangGraph ToolNode runs an allowed call", by_id["call_0"].status == "success" and "quarterly" in by_id["call_0"].content, by_id)
    c.check("a LangGraph ToolNode refuses a path outside the workspace", by_id["call_1"].status == "error" and "path_outside_workspace" in by_id["call_1"].content, by_id)
    return c.done()


if __name__ == "__main__":
    sys.exit(main())
