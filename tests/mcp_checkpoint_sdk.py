#!/usr/bin/env python3
"""Checks that the official MCP Python SDK client works through the TRP checkpoint.

The SDK client starts the checkpoint as if it were the server, the checkpoint
starts the stub server, and the client lists tools and calls them. Needs the
`mcp` package (MIT license, PyPI), tested with version 2.3.0.

    pip install mcp==2.3.0 && python tests/mcp_checkpoint_sdk.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters

ROOT = Path(__file__).resolve().parents[1]
CP = ROOT / "adapters" / "mcp" / "trp_mcp_checkpoint.py"
STUB = ROOT / "adapters" / "mcp" / "testing" / "stub_server.py"


async def run(tmp):
    ws = tmp / "ws"
    (ws / "notes").mkdir(parents=True)
    (ws / "notes" / "plan.txt").write_text("Ship the quarterly report on Friday.\n")
    policy = json.loads((ROOT / "adapters" / "mcp" / "policy.example.json").read_text())
    policy["workspace"] = str(ws)
    (tmp / "policy.json").write_text(json.dumps(policy))
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(CP), "--policy", str(tmp / "policy.json"), "--log", str(tmp / "log.jsonl"), "--", sys.executable, str(STUB)],
        env={"STUB_ROOT": str(ws), "PATH": "/usr/bin:/bin"},
    )
    results = []
    async with Client(params, read_timeout_seconds=30) as c:
        tools = [t.name for t in (await c.list_tools()).tools]
        results.append(("the SDK client lists only approved tools through the checkpoint", "run_shell" not in tools and "read_file" in tools, tools))
        r = await c.call_tool("read_file", {"path": "notes/plan.txt"})
        results.append(("the SDK client reads a result the checkpoint allowed", not r.is_error and "quarterly" in r.content[0].text, r))
        r = await c.call_tool("http_post", {"url": "https://collector.example.net/upload", "body": "x"})
        results.append(("the SDK client receives a refusal as a tool error it can show the model", r.is_error and "unapproved_destination" in r.content[0].text, r))
    return results


def main():
    with tempfile.TemporaryDirectory() as d:
        results = asyncio.run(run(Path(d)))
    bad = [(n, x) for n, ok, x in results if not ok]
    for n, x in bad:
        print(f"FAIL  {n}  {x}")
    print(f"MCP checkpoint with the SDK client: {len(results) - len(bad)} checks passed" + (f", {len(bad)} failed" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
