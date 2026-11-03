#!/usr/bin/env python3
"""TRP checkpoint for MCP (Model Context Protocol) servers.

Sits between any MCP client (an agent, an IDE, a chat app) and any MCP server
that speaks the stdio transport, and judges every tool call and every tool
result against a TRP (Trust Requirements Profile) before it moves on.

    python adapters/mcp/trp_mcp_checkpoint.py \\
        --profile adapters/mcp/profiles/mcp-tool-checkpoint.trp.json \\
        --policy adapters/mcp/policy.example.json \\
        --session /tmp/agent-session.json --log decisions.jsonl --server-name files \\
        -- npx -y @modelcontextprotocol/server-filesystem ./workspace

The client launches this script in place of the server. The script launches
the real server, passes every message through unchanged, and stops at two
points.

- A tools/call request. The checkpoint measures the call (which tool, what
  kind of tool, where its paths and addresses point, what its arguments
  carry), evaluates the evidence with the reference TRP evaluator and either
  forwards the call or answers the client itself with a tool error the model
  can read. A refused call never reaches the server.
- A tools/call result. The checkpoint scans what the server returned for
  secrets and for planted instructions before the model sees it, and
  withholds the result when the profile says so.

A halt stops the whole session until a person deletes the session file. A
review refuses only the call, or withholds only the result, in question. Under
the restricted response the checkpoint allows reads and refuses writes,
outbound calls and commands.

Several checkpoints can share one session file, one per MCP server an agent
uses. Content read from a sensitive path through one server is remembered as
SHA-256 fingerprints of its lines and tokens, so the same content cannot leave
through another server. The session file stores only fingerprints and counts,
never the content.

Each decision is one line of JSON in the decision log. Each line carries the
SHA-256 of the line before it, so an edit, a deletion or a reordering breaks
the chain. `--verify-log` checks a log.

MCP messages on stdio are JSON-RPC 2.0 objects, one per line, as the MCP
specification's stdio transport defines. Tool errors go back as a normal
result with isError set, so the model can read why the call was refused.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gate"))
from trp_gate import (  # noqa: E402  the shared gate every framework adapter uses
    DecisionLog, Gate, Policy, ReceiptIssuer, Session, canonical, result_texts, verify_log,
)

VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
TAGGED_FROM = "2026-07-28"  # protocol revisions from this date on require resultType on every result

__all__ = ["Checkpoint", "canonical", "verify_log"]


class Checkpoint:
    def __init__(self, profile_path, policy, session, log, server_name="server", out=None, receipts=None):
        self.gate = Gate(profile_path, policy, session, log, source=server_name, receipts=receipts)
        self.policy = policy
        self.out = out or sys.stdout.buffer
        self.out_lock = threading.Lock()
        self.pending = {}  # request id -> what the result check needs
        self.lists = set()  # request ids of tools/list
        self.to_server = None
        self.version = None  # negotiated by initialize; revisions from 2026-07-28 carry it on each request

    def request_version(self, msg):
        meta = (msg.get("params") or {}).get("_meta") or {}
        return meta.get(VERSION_KEY) or self.version

    @staticmethod
    def tool_error(text, version):
        result = {"content": [{"type": "text", "text": text}], "isError": True}
        if version is None or version >= TAGGED_FROM:
            result["resultType"] = "complete"
        return result

    def on_call(self, msg):
        """Returns the message to forward, or None after answering the client directly."""
        params = msg.get("params") or {}
        req_id = msg.get("id")
        d = self.gate.check_call(params.get("name", ""), params.get("arguments") or {}, call_id=req_id)
        if d.allowed:
            self.pending[req_id] = {"decision": d, "version": self.request_version(msg)}
            return msg
        self.reply({"jsonrpc": "2.0", "id": req_id, "result": self.tool_error(d.reason, self.request_version(msg))})
        return None

    def on_result(self, msg):
        """Returns the result message for the client, withheld when the profile says so."""
        req_id = msg.get("id")
        call = self.pending.pop(req_id, None)
        if call is None:
            return msg
        result = msg.get("result")
        failed = "error" in msg or (isinstance(result, dict) and result.get("isError") is True)
        d = self.gate.check_result(call["decision"], result_texts(result), failed=failed, protocol_error="error" in msg)
        if d.withheld:
            version = "9999" if isinstance(result, dict) and "resultType" in result else call["version"]
            return {"jsonrpc": "2.0", "id": req_id, "result": self.tool_error(d.reason, version)}
        return msg

    def on_list(self, msg):
        result = msg.get("result")
        if self.policy.hide_unapproved and isinstance(result, dict) and isinstance(result.get("tools"), list):
            result["tools"] = [t for t in result["tools"] if isinstance(t, dict) and t.get("name") in self.policy.approved]
        return msg

    # ------------------------------------------------------------ transport

    def reply(self, obj):
        data = (json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        with self.out_lock:
            self.out.write(data)
            self.out.flush()

    def from_client(self, line):
        """Handles one line from the client and returns the bytes to send to the server, if any."""
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return line
        if not isinstance(msg, dict):
            return line
        if msg.get("method") == "tools/call" and "id" in msg:
            msg = self.on_call(msg)
            if msg is None:
                return None
        elif msg.get("method") == "tools/list" and "id" in msg:
            self.lists.add(msg["id"])
        elif msg.get("method") == "initialize":
            self.version = (msg.get("params") or {}).get("protocolVersion") or self.version
        return line

    def from_server(self, line):
        """Handles one line from the server and returns the bytes to send to the client."""
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return line
        if not isinstance(msg, dict) or "method" in msg or "id" not in msg:
            return line
        if msg["id"] in self.pending:
            out = self.on_result(msg)
            return line if out is msg else (json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        if msg["id"] in self.lists:
            self.lists.discard(msg["id"])
            return (json.dumps(self.on_list(msg), separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        return line

    def run(self, command, client_in=None):
        client_in = client_in or sys.stdin.buffer
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        self.to_server = proc.stdin

        def pump_server():
            for line in iter(proc.stdout.readline, b""):
                data = self.from_server(line)
                with self.out_lock:
                    self.out.write(data if data.endswith(b"\n") else data + b"\n")
                    self.out.flush()

        t = threading.Thread(target=pump_server, daemon=True)
        t.start()
        try:
            for line in iter(client_in.readline, b""):
                if not line.strip():
                    continue
                data = self.from_client(line)
                if data is not None:
                    try:
                        proc.stdin.write(data if data.endswith(b"\n") else data + b"\n")
                        proc.stdin.flush()
                    except BrokenPipeError:
                        break
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()
            t.join(timeout=10)
            with contextlib.suppress(Exception):
                proc.wait(timeout=10)
        return proc.returncode or 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", default=str(Path(__file__).parent / "profiles" / "mcp-tool-checkpoint.trp.json"))
    ap.add_argument("--policy", help="JSON policy with approved tools, tool kinds, workspace and allowed domains")
    ap.add_argument("--session", help="session file shared by every checkpoint in one agent session")
    ap.add_argument("--log", help="decision log, JSON lines chained by SHA-256")
    ap.add_argument("--server-name", default="server")
    ap.add_argument("--verify-log", metavar="LOG", help="check a decision log's chain and exit")
    ap.add_argument("--receipts", help="also sign a Verifiable Trust Receipt for every decision, one compact JWS per line")
    ap.add_argument("--receipt-key", help="ES256 or EdDSA private key in PEM for the receipts")
    ap.add_argument("--issuer", default="urn:trp:mcp-checkpoint", help="the iss claim of the receipts")
    ap.add_argument("command", nargs=argparse.REMAINDER, help="-- then the MCP server command")
    a = ap.parse_args(argv)
    if a.verify_log:
        ok, n, problem = verify_log(a.verify_log)
        print(f"{a.verify_log}: {n} decisions, chain {'intact' if ok else 'broken at ' + problem}")
        return 0 if ok else 1
    cmd = a.command[1:] if a.command[:1] == ["--"] else a.command
    if not cmd or not a.policy:
        ap.error("give --policy and, after --, the MCP server command")
    if bool(a.receipts) != bool(a.receipt_key):
        ap.error("give --receipts and --receipt-key together")
    issuer = ReceiptIssuer(a.receipt_key, a.issuer, a.receipts) if a.receipts else None
    cp = Checkpoint(a.profile, Policy.load(a.policy), Session(a.session), DecisionLog(a.log), a.server_name, receipts=issuer)
    return cp.run(cmd)


if __name__ == "__main__":
    sys.exit(main())
