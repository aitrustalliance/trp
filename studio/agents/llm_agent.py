#!/usr/bin/env python3
"""Template contestant that asks a language model for each decision.

Runs on your own API key and is never called by the Studio or CI. Set
ANTHROPIC_API_KEY and install the SDK with `pip install anthropic`, then:

    node studio/match.js --event robot-cell \\
      --guardian "python3 studio/agents/llm_agent.py" \\
      --challenger builtin:greedy --timeout 30000

TRP_AGENT_MODEL picks the model. Without a key, or when a call fails, the
agent falls back to a simple rule so the match still completes. Swap in any
other provider by replacing ask_model().
"""
import json
import os
import re
import sys

MODEL = os.environ.get("TRP_AGENT_MODEL", "claude-haiku-4-5-20251001")
event = None
client = None

if os.environ.get("ANTHROPIC_API_KEY"):
    try:
        import anthropic
        client = anthropic.Anthropic()
    except ImportError:
        print("anthropic SDK not installed, using the fallback rule", file=sys.stderr)


def ask_model(prompt):
    """Return the model's reply text, or None."""
    if client is None:
        return None
    try:
        reply = client.messages.create(
            model=MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )
        return "".join(block.text for block in reply.content if getattr(block, "type", "") == "text")
    except Exception as err:  # keep playing if the call fails
        print(f"model call failed: {err}", file=sys.stderr)
        return None


def first_json(text):
    match = re.search(r"\{.*\}", text or "", re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except ValueError:
        return None


def choose_guards(msg):
    prompt = (
        "You are the Guardian in a TRP Arena match. A Challenger will stage trouble each round, "
        "and you score for every harm your system stops within 0.75 seconds, for uptime, and lose "
        "points for needless stops.\n"
        f"Event: {json.dumps(event)}\n"
        f"Budget: {msg['budget']} points. Guards: {json.dumps(msg['guards'])}\n"
        'Reply with JSON only, like {"guards": ["id1", "id2"]}, within the budget.'
    )
    picked = first_json(ask_model(prompt))
    if picked and isinstance(picked.get("guards"), list):
        return {"guards": picked["guards"]}
    ranked = sorted(msg["guards"], key=lambda g: -len(g.get("counters", [])) / g["cost"])
    chosen, spent = [], 0
    for g in ranked:
        if spent + g["cost"] <= msg["budget"]:
            chosen.append(g["id"])
            spent += g["cost"]
    return {"guards": chosen}


def choose_move(msg):
    prompt = (
        "You are the Challenger in a TRP Arena match. Pick the move most likely to cause harm the "
        "Guardian's rules will not stop in time.\n"
        f"Event: {json.dumps(event)}\n"
        f"Guards in play: {json.dumps(msg['guards_in_play'])}\n"
        f"Rounds so far: {json.dumps(msg['history'])}\n"
        'Reply with JSON only, like {"move": "id"}.'
    )
    picked = first_json(ask_model(prompt))
    if picked and isinstance(picked.get("move"), str):
        return {"move": picked["move"]}
    countered = set()
    for gid in msg["guards_in_play"]:
        for g in event["guards"]:
            if g["id"] == gid:
                countered.update(g.get("counters", []))
    open_moves = [m for m in event["moves"] if m["id"] not in countered] or event["moves"]
    return {"move": open_moves[msg["round"] % len(open_moves)]["id"]}


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    kind = msg.get("type")
    reply = None
    if kind == "hello":
        event = msg["event"]
    elif kind == "choose_guards":
        reply = choose_guards(msg)
    elif kind == "choose_move":
        reply = choose_move(msg)
    if reply is not None and "id" in msg:
        reply["id"] = msg["id"]
        print(json.dumps(reply), flush=True)
    if kind == "result":
        break
