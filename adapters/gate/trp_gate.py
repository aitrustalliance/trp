#!/usr/bin/env python3
"""TRP gate for AI agent tool calls, shared by every agent framework adapter.

One gate judges each tool call before it runs and each tool result before the
model sees it, against a TRP (Trust Requirements Profile) with the reference
evaluator in tools/evaluate.py. The MCP checkpoint, the LangChain middleware,
the OpenAI Agents SDK guardrails, the CrewAI hooks, the Google ADK callbacks
and the AG2 middleware all call the same two methods, so a rule means the same
thing in every framework.

    gate = Gate(profile_path, Policy.load("policy.json"), Session("session.json"), DecisionLog("decisions.jsonl"), source="langgraph")
    d = gate.check_call("read_text_file", {"path": "notes/plan.txt"}, call_id="call_1")
    if d.allowed:
        output = run_the_tool()
        r = gate.check_result(d, [output], failed=False)
        if r.withheld:
            output = r.reason

A halt stops the whole session until a person deletes the session file. A
review refuses only the call, or withholds only the result, in question. Under
the restricted response the gate allows reads and refuses writes, outbound
calls and commands.

Several gates can share one session file. Content read from a sensitive path
is remembered as SHA-256 fingerprints of its lines and tokens, so the same
content cannot leave through another tool or another framework in the same
session. The session file stores only fingerprints and counts, never content.

Each decision is one line of canonical JSON in the decision log. Each line
carries the SHA-256 of the line before it, so an edit, a deletion or a
reordering breaks the chain. verify_log checks a log.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import unquote_plus, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import evaluate as trp  # noqa: E402  the reference evaluator in tools/evaluate.py

try:
    import fcntl  # POSIX file locks for a session file shared by several checkpoints
except ImportError:  # Windows: one checkpoint per session file
    fcntl = None

DECISION = "trp.mcp.decision"
LOG_VERSION = 1

# Published token formats. Each is the documented prefix and length of a real credential type.
SECRET_PATTERNS = [
    ("aws_access_key_id", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("github_fine_grained_token", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b")),
    ("openai_style_key", re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}\b")),
    ("nvidia_api_key", re.compile(r"\bnvapi-[A-Za-z0-9_\-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b")),
    ("stripe_secret_key", re.compile(r"\b[rs]k_live_[A-Za-z0-9]{20,}\b")),
    ("private_key_block", re.compile(r"-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
    ("assigned_secret", re.compile(r"(?i)\b(?:api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*['\"]?[A-Za-z0-9/+_\-]{16,}")),
]

# Phrases that tell a model to drop its instructions or act for someone else. Content from a tool is data,
# so text in a tool result that addresses the model this way is a planted instruction.
INSTRUCTION_PATTERNS = [
    re.compile(r"(?i)\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|guidelines|directions)\b"),
    re.compile(r"(?i)\b(?:new|updated|real|actual)\s+(?:system\s+)?instructions?\s*[:\-]"),
    re.compile(r"(?i)\byou\s+(?:are\s+now|must\s+now|will\s+now|should\s+now)\b"),
    re.compile(r"(?i)\b(?:assistant|ai|agent|model)\s*[,:]\s*(?:please\s+)?(?:send|upload|post|email|forward|exfiltrate|run|execute|delete)\b"),
    re.compile(r"(?i)\bdo\s+not\s+(?:tell|inform|mention\s+(?:this\s+)?to)\s+the\s+user\b"),
    re.compile(r"<\|?(?:im_start|im_end|system|endoftext)\|?>"),
]

KINDS = {"read", "write", "egress", "exec", "other"}
NARROWED = {"write", "egress", "exec", "other"}  # refused while the session is restricted


def now_iso():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def strings(obj):
    """Every string inside a JSON value."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from strings(v)


def listed(value):
    """A string argument, or the strings in a list argument, as a list."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [v for v in value if isinstance(v, str)]
    return []


def fingerprints(text):
    """SHA-256 prefixes of each trimmed line of 12 characters or more and each token of 16 or more."""
    out = set()
    for line in text.splitlines():
        line = line.strip()
        if len(line) >= 12:
            out.add(sha256(line)[:24])
        for tok in re.split(r"[\s,;\"'()\[\]{}<>]+", line):
            if len(tok) >= 16:
                out.add(sha256(tok)[:24])
    return out


def outbound_fingerprints(text):
    """Fingerprints of text leaving the session, also read with URL escapes undone and split at URL marks,
    so content packed into a query string still matches what was read."""
    out = fingerprints(text)
    plain = unquote_plus(text)
    out |= fingerprints(plain)
    out |= fingerprints(re.sub(r"[?&=/:#+|]+", " ", plain))
    return out


def secrets_in(texts):
    found = []
    for t in texts:
        for name, pat in SECRET_PATTERNS:
            if pat.search(t) and name not in found:
                found.append(name)
    return found


def instructions_in(texts):
    for t in texts:
        for pat in INSTRUCTION_PATTERNS:
            m = pat.search(t)
            if m:
                return m.group(0)[:80]
    return None


def result_texts(result):
    """The text an MCP tool result would put in front of the model."""
    if not isinstance(result, dict):
        return []
    texts = []
    for item in result.get("content") or []:
        if isinstance(item, dict):
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                texts.append(item["text"])
            res = item.get("resource")
            if isinstance(res, dict) and isinstance(res.get("text"), str):
                texts.append(res["text"])
    if "structuredContent" in result:
        texts.extend(strings(result["structuredContent"]))
    return texts


class Policy:
    """What the deployment allows: tools, their kinds, the workspace and the outside addresses."""

    def __init__(self, raw, base):
        self.workspace = (base / raw.get("workspace", ".")).resolve()
        self.approved = set(raw.get("approved_tools", []))
        self.tools = raw.get("tools", {})
        for name, t in self.tools.items():
            if t.get("kind", "other") not in KINDS:
                raise ValueError(f"tool {name}: kind must be one of {sorted(KINDS)}")
        self.allowed_domains = [d.lower() for d in raw.get("allowed_domains", [])]
        self.approved_writes = raw.get("approved_writes", [])
        self.sensitive = raw.get("sensitive_paths", [])
        self.hide_unapproved = raw.get("hide_unapproved_tools", True)
        self.halt_scope = raw.get("halt_scope", "session")
        if self.halt_scope not in ("session", "call"):
            raise ValueError("halt_scope must be session or call")

    @classmethod
    def load(cls, path):
        p = Path(path).resolve()
        return cls(json.loads(p.read_text()), p.parent)

    def kind(self, tool):
        return self.tools.get(tool, {}).get("kind", "other")

    def args(self, tool, key):
        return self.tools.get(tool, {}).get(key, [])

    def outside(self, value):
        p = Path(value)
        p = (p if p.is_absolute() else self.workspace / p).resolve()
        return p != self.workspace and self.workspace not in p.parents

    def relpath(self, value):
        p = Path(value)
        p = (p if p.is_absolute() else self.workspace / p).resolve()
        try:
            return p.relative_to(self.workspace).as_posix()
        except ValueError:
            return p.as_posix()

    def is_sensitive(self, value):
        rel = self.relpath(value)
        return any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch("/" + rel, g) for g in self.sensitive)

    def domain_ok(self, url):
        host = (urlsplit(url).hostname or "").lower()
        if not host:
            return False
        return any(host == d or host.endswith("." + d) for d in self.allowed_domains)

    def write_ok(self, tool, paths):
        for rule in self.approved_writes:
            if rule == tool:
                return True
            if paths and all(fnmatch.fnmatch(self.relpath(p), rule) for p in paths):
                return True
        return False


class Session:
    """Counts and fingerprints for one agent session, optionally shared by several checkpoints."""

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.mem = self.blank()
        self.lock = threading.Lock()

    @staticmethod
    def blank():
        return {"id": str(uuid.uuid4()), "started": now_iso(), "calls": 0, "errors": 0, "results": 0,
                "egress_bytes": 0, "call_times": [], "halted": None, "fingerprints": []}

    @contextlib.contextmanager
    def edit(self):
        """Yields the session state for reading and changing, under a lock, and saves it after."""
        with self.lock:
            if not self.path:
                yield self.mem
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a+", encoding="utf-8") as f:
                if fcntl:
                    fcntl.flock(f, fcntl.LOCK_EX)
                try:
                    f.seek(0)
                    text = f.read()
                    state = json.loads(text) if text.strip() else self.blank()
                    yield state
                    f.seek(0)
                    f.truncate()
                    f.write(json.dumps(state))
                    f.flush()
                    os.fsync(f.fileno())
                finally:
                    if fcntl:
                        fcntl.flock(f, fcntl.LOCK_UN)


class DecisionLog:
    """Append-only JSON lines, each carrying the SHA-256 of the line before it."""

    def __init__(self, path):
        self.path = Path(path) if path else None
        self.lock = threading.Lock()

    def append(self, record):
        if not self.path:
            return record
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a+b") as f:
                if fcntl:
                    fcntl.flock(f, fcntl.LOCK_EX)
                try:
                    last = self.last_line(f)
                    record["seq"] = json.loads(last)["seq"] + 1 if last else 0
                    record["prev"] = sha256(last) if last else None
                    f.seek(0, os.SEEK_END)
                    f.write((canonical(record) + "\n").encode("utf-8"))
                    f.flush()
                finally:
                    if fcntl:
                        fcntl.flock(f, fcntl.LOCK_UN)
        return record

    @staticmethod
    def last_line(f):
        """The last non-empty line, read from the end so a long log costs the same as a short one."""
        f.seek(0, os.SEEK_END)
        end = f.tell()
        chunk = 4096
        while True:
            start = max(0, end - chunk)
            f.seek(start)
            lines = [ln for ln in f.read(end - start).split(b"\n") if ln.strip()]
            if len(lines) >= 2 or start == 0:
                return lines[-1].decode("utf-8") if lines else None
            chunk *= 2


def verify_log(path):
    """Checks the chain. Returns (ok, records checked, first problem or None)."""
    lines = [ln for ln in Path(path).read_text(encoding="utf-8").splitlines() if ln.strip()]
    prev = None
    for i, ln in enumerate(lines):
        try:
            rec = json.loads(ln)
        except json.JSONDecodeError:
            return False, i, f"line {i + 1} is not JSON"
        if canonical(rec) != ln:
            return False, i, f"line {i + 1} is not in canonical form"
        if rec.get("seq") != i:
            return False, i, f"line {i + 1} has seq {rec.get('seq')}"
        if rec.get("prev") != prev:
            return False, i, f"line {i + 1} does not chain to the line before it"
        prev = sha256(ln)
    return True, len(lines), None


class Decision:
    """What the gate decided about one call or one result."""

    def __init__(self, action, reason, record, token=None):
        self.action = action  # allow or refuse for a call, pass or withhold for a result
        self.reason = reason
        self.record = record
        self.token = token  # what check_result needs, set on an allowed call

    @property
    def allowed(self):
        return self.action == "allow"

    @property
    def withheld(self):
        return self.action == "withhold"

    @property
    def rules(self):
        return self.record["rules"]


class Gate:
    def __init__(self, profile_path, policy, session, log, source="agent"):
        self.profile = trp.load_profile(Path(profile_path))
        self.policy = policy
        self.session = session
        self.log = log
        self.source = source

    # ------------------------------------------------------------ evidence

    def call_evidence(self, tool, args, state):
        kind = self.policy.kind(tool)
        texts = list(strings(args))
        paths = [v for k in self.policy.args(tool, "path_args") for v in listed(args.get(k))]
        urls = [v for k in self.policy.args(tool, "url_args") for v in listed(args.get(k))]
        if kind == "egress":
            urls += [u for u in re.findall(r"https?://[^\s\"'<>]+", " ".join(texts)) if u not in urls]
        out_bytes = len(canonical(args).encode()) if kind in ("egress", "write") else 0
        known = set(state["fingerprints"])
        leaked = bool(known) and kind in ("egress", "write", "exec", "other") and any(fp in known for t in texts for fp in outbound_fingerprints(t))
        recent = [t for t in state["call_times"] if t > time.time() - 60]
        ev = {
            "steps_per_task": state["calls"] + 1,
            "tool_error_rate": round(state["errors"] / state["results"], 4) if state["results"] else 0.0,
            "calls_per_minute": len(recent) + 1,
            "egress_kb_session": round((state["egress_bytes"] + (out_bytes if kind == "egress" else 0)) / 1024, 3),
            "unapproved_tool_called": tool not in self.policy.approved,
            "secret_in_arguments": bool(secrets_in(texts)) and kind in ("egress", "write", "exec", "other"),
            "output_destination_approved": all(self.policy.domain_ok(u) for u in urls) if kind == "egress" else True,
            "path_outside_workspace": any(self.policy.outside(p) for p in paths),
            "sensitive_data_in_egress": leaked,
            "write_without_approval": kind == "write" and not self.policy.write_ok(tool, paths),
            "secret_in_tool_result": False,
            "instructions_in_tool_result": False,
        }
        facts = {"kind": kind, "paths": [self.policy.relpath(p) for p in paths], "urls": [urlsplit(u).hostname for u in urls],
                 "secrets": secrets_in(texts), "out_bytes": out_bytes,
                 "sensitive_read": kind == "read" and any(self.policy.is_sensitive(p) for p in paths)}
        return ev, facts

    def result_evidence(self, call_ev, texts, state):
        ev = dict(call_ev)
        ev.update({"unapproved_tool_called": False, "secret_in_arguments": False, "output_destination_approved": True,
                   "path_outside_workspace": False, "sensitive_data_in_egress": False, "write_without_approval": False,
                   "tool_error_rate": round(state["errors"] / state["results"], 4) if state["results"] else 0.0})
        found = secrets_in(texts)
        planted = instructions_in(texts)
        ev["secret_in_tool_result"] = bool(found)
        ev["instructions_in_tool_result"] = bool(planted)
        return ev, {"secrets": found, "instruction": planted}

    # ------------------------------------------------------------ decisions

    def judge(self, ev):
        r = trp.evaluate(self.profile, ev)
        return r, {x["action"] for x in r["hard_rules_triggered"]}

    def record(self, phase, call_id, tool, args, ev, r, action, reason, facts, state):
        rec = {
            "v": LOG_VERSION, "type": DECISION, "time": now_iso(), "session": state["id"], "server": self.source,
            "phase": phase, "request_id": call_id, "tool": tool, "kind": facts.get("kind") or self.policy.kind(tool),
            "arguments_sha256": sha256(canonical(args)), "evidence": ev,
            "standing": r["standing"], "response": r["response"],
            "rules": [x["rule"] for x in r["hard_rules_triggered"]],
            "action": action, "reason": reason,
            "profile": {"trp_id": r["evaluation"]["profile_id"], "version": r["evaluation"]["profile_version"],
                        "spec_version": r["evaluation"]["spec_version"]},
            "evaluator": r["evaluation"]["evaluator"], "result_hash": r["evaluation"]["result_hash"],
            "facts": {k: v for k, v in facts.items() if k in ("paths", "urls", "secrets", "out_bytes", "sensitive_read", "instruction")},
        }
        return self.log.append(rec)

    def check_call(self, tool, args, call_id=None):
        """Judges one tool call before it runs. The tool runs only when the decision is allowed."""
        args = args if isinstance(args, dict) else {"input": args}
        with self.session.edit() as state:
            ev, facts = self.call_evidence(tool, args, state)
            r, actions = self.judge(ev)
            if state["halted"]:
                action, reason = "refuse", f"The session was halted earlier by the rule {state['halted']}. A person must reset it."
            elif "halt" in actions:
                rule = next(x["rule"] for x in r["hard_rules_triggered"] if x["action"] == "halt")
                action, reason = "refuse", f"Refused by the trust profile. Rule {rule} stops this session."
                if self.policy.halt_scope == "session":
                    state["halted"] = rule
            elif "require_review" in actions:
                rule = next(x["rule"] for x in r["hard_rules_triggered"] if x["action"] == "require_review")
                action, reason = "refuse", f"Held for a person to approve. Rule {rule} requires review before this call runs."
            elif r["response"] == "suspended":
                action, reason = "refuse", "Refused by the trust profile. The session's standing is untrusted, so every tool call is suspended."
            elif r["response"] == "restricted" and facts["kind"] in NARROWED:
                action, reason = "refuse", f"Refused by the trust profile. The session is restricted, so {facts['kind']} tools are paused and reads continue."
            else:
                action, reason = "allow", "Conforms to the trust profile."
            state["calls"] += 1
            state["call_times"] = [t for t in state["call_times"] if t > time.time() - 60] + [time.time()]
            if action == "allow" and facts["kind"] == "egress":
                state["egress_bytes"] += facts["out_bytes"]
            rec = self.record("call", call_id, tool, args, ev, r, action, reason, facts, state)
        token = {"tool": tool, "args": args, "ev": ev, "facts": facts, "call_id": call_id} if action == "allow" else None
        return Decision(action, reason, rec, token)

    def check_result(self, call, texts, failed=False, protocol_error=False):
        """Judges a tool's result before the model sees it. `call` is the allowed Decision from check_call."""
        token = call.token if isinstance(call, Decision) else call
        texts = [t for t in texts if isinstance(t, str)]
        with self.session.edit() as state:
            state["results"] += 1
            state["errors"] += 1 if failed else 0
            ev, facts = self.result_evidence(token["ev"], texts, state)
            facts["kind"] = token["facts"]["kind"]
            r, actions = self.judge(ev)
            # Content read from a sensitive path, and any secret seen, is remembered as fingerprints.
            if not failed and (token["facts"].get("sensitive_read") or facts["secrets"]):
                known = set(state["fingerprints"])
                for t in texts:
                    known |= fingerprints(t)
                state["fingerprints"] = sorted(known)
            if protocol_error:
                action, reason = "pass", "The tool returned a protocol error."
            elif "require_review" in actions or "halt" in actions:
                rule = r["hard_rules_triggered"][0]["rule"]
                action = "withhold"
                reason = f"Result withheld by the trust profile. Rule {rule} requires a person to review it before the model sees it."
            else:
                action, reason = "pass", "Conforms to the trust profile."
            rec = self.record("result", token["call_id"], token["tool"], token["args"], ev, r, action, reason, facts, state)
        return Decision(action, reason, rec)

    def visible_tools(self, names):
        """The tool names the model may see."""
        return [n for n in names if not self.policy.hide_unapproved or n in self.policy.approved]
