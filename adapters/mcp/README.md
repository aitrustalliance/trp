# TRP Checkpoint For MCP

The checkpoint puts a TRP (Trust Requirements Profile) between an AI agent and the MCP (Model Context Protocol) servers it uses. MCP is the open protocol agents use to reach tools such as files, the web, code runners and business systems. The checkpoint judges every tool call before the server sees it and every tool result before the model sees it, using the reference TRP evaluator in `tools/evaluate.py`.

It works with any MCP client and any MCP server on the stdio transport, which is how desktop agents, coding agents and IDEs start local servers. Nothing in the client, the server or the model changes.

## What It Stops

| Rule | Phase | Action | Example |
|---|---|---|---|
| `unapproved_tool_called` | Call | Halt | The agent calls `run_shell` when the policy approves only file and web tools |
| `secret_in_arguments` | Call | Halt | An outbound post carries a GitHub token |
| `unapproved_destination` | Call | Halt | A fetch goes to a domain outside the allowed list |
| `path_outside_workspace` | Call | Halt | A read of `/etc/passwd` or `../../.ssh/id_rsa` |
| `sensitive_data_in_egress` | Call | Halt | Lines read from `secrets/customers.csv` through the filesystem server appear in a fetch address through the fetch server, even inside an escaped query string |
| `write_without_approval` | Call | Review | A write to a path the policy has not pre-approved |
| `secret_in_tool_result` | Result | Review | A file read returns an API key, which never reaches the model |
| `instructions_in_tool_result` | Result | Review | A fetched page or file tells the model to ignore its instructions, which never reaches the model |

Four scored signals set the session's standing. They are tool calls so far, the tool error rate, calls per minute and kilobytes sent out. In the warning range the session is restricted, and the checkpoint allows reads and refuses writes, outbound calls and commands. In the critical range every call is refused.

A halt stops the whole session until a person deletes the session file. Set `"halt_scope": "call"` in the policy to refuse only the call. A review refuses only the call or withholds only the result.

Refusals go back to the client as a normal tool result with `isError` set, so the model reads why and can tell the user. A refused call never reaches the server.

## Files

| File | Purpose |
|---|---|
| `trp_mcp_checkpoint.py` | The checkpoint, a single Python file with no dependencies beyond the standard library and `tools/evaluate.py` |
| `profiles/mcp-tool-checkpoint.trp.json` | The TRP profile it enforces by default. It validates against `schema/trp.schema.json` |
| `policy.example.json` | A policy for the stub server used in tests |
| `policies/filesystem.json` | A policy for the official filesystem server, npm `@modelcontextprotocol/server-filesystem` |
| `policies/fetch.json` | A policy for the official fetch server, PyPI `mcp-server-fetch` |
| `testing/stub_server.py` | A small MCP server that enforces nothing and writes down every call it receives |

## Run It

Give the client the checkpoint command in place of the server command, and put the server command after `--`.

```bash
python adapters/mcp/trp_mcp_checkpoint.py \
  --policy adapters/mcp/policies/filesystem.json \
  --session /tmp/agent-session.json \
  --log /tmp/decisions.jsonl \
  --server-name filesystem \
  -- npx -y @modelcontextprotocol/server-filesystem@2.1.0 /path/to/workspace
```

In a client configuration file that lists MCP servers, the entry becomes the following.

```json
{
  "command": "python",
  "args": ["/path/to/trp-studio/adapters/mcp/trp_mcp_checkpoint.py",
           "--policy", "/path/to/policy.json", "--session", "/tmp/agent-session.json", "--log", "/tmp/decisions.jsonl",
           "--server-name", "filesystem", "--",
           "npx", "-y", "@modelcontextprotocol/server-filesystem@2.1.0", "/path/to/workspace"]
}
```

Start one checkpoint per server and give them all the same `--session` and `--log`. The shared session file is how content read through one server is stopped from leaving through another. It stores counts and SHA-256 fingerprints of lines and tokens, never the content.

## Policy

| Key | Meaning |
|---|---|
| `workspace` | The folder the agent may touch, relative to the policy file or absolute |
| `approved_tools` | Tool names the agent may call. Others are refused and hidden from `tools/list` |
| `tools` | Each tool's `kind` (`read`, `write`, `egress`, `exec` or `other`) and which arguments hold paths (`path_args`) or addresses (`url_args`) |
| `allowed_domains` | Domains an `egress` tool may reach, subdomains included |
| `approved_writes` | Tool names, or path patterns inside the workspace, that may be written without review |
| `sensitive_paths` | Path patterns whose content is fingerprinted when read and may not leave the session |
| `hide_unapproved_tools` | Remove unapproved tools from `tools/list`, so the model never sees them. Default true |
| `halt_scope` | `session` (default) or `call` |

## Decision Log

Every call and every result adds one line of canonical JSON to the log. A line records the tool, its kind, the SHA-256 of its arguments, the evidence, the standing and response from the evaluator, the rules met, the action and the reason. It also names the profile ID and version and gives the evaluator's result hash. Each line carries the SHA-256 of the line before it, so an edited, deleted or reordered decision breaks the chain. The log never keeps raw arguments or file content.

```bash
python adapters/mcp/trp_mcp_checkpoint.py --verify-log /tmp/decisions.jsonl
```

## Protocol Versions

The checkpoint passes every message through unchanged except the `tools/call` requests and results it judges and the `tools/list` results it narrows. It works with sessions that open with `initialize` and with the stateless 2026-07-28 revision, where the client opens with `server/discover` and each request carries its protocol version in `_meta`. On 2026-07-28 sessions the results the checkpoint writes itself carry `resultType`, which that revision requires.

## Tests

```bash
python tests/mcp_checkpoint_check.py                              # 28 checks over real stdio pipes against the stub server
pip install "mcp==2.3.0" && python tests/mcp_checkpoint_sdk.py    # the official MCP Python SDK client through the checkpoint
```

## Limits

- Secret detection matches published token formats and assignments such as `api_key=`. Instruction detection matches phrase patterns. Both are pattern matches, not classifiers, and encoded or paraphrased content can pass them.
- Data-flow tracking matches exact lines of 12 characters or more and tokens of 16 or more. Content that is rewritten, summarized or encoded before it leaves is not matched.
- Only the stdio transport is covered. Streamable HTTP servers need the same checks in an HTTP proxy.
