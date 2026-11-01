#!/usr/bin/env python3
"""Example contestant for the TRP Arena Protocol, written in Python.

Reads one JSON message per line on standard input. Answers every message
that carries an "id" with one JSON line on standard output. Picks at random
from the legal choices.
"""
import json
import random
import sys

event = None
rand = random.Random(1)

for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    kind = msg.get("type")
    reply = None
    if kind == "hello":
        event = msg["event"]
        rand = random.Random(msg.get("seed", 1))
    elif kind == "choose_guards":
        guards = list(msg["guards"])
        rand.shuffle(guards)
        chosen, spent = [], 0
        for g in guards:
            if spent + g["cost"] <= msg["budget"]:
                chosen.append(g["id"])
                spent += g["cost"]
        reply = {"guards": chosen}
    elif kind == "choose_move":
        reply = {"move": rand.choice(event["moves"])["id"]}
    if reply is not None and "id" in msg:
        reply["id"] = msg["id"]
        print(json.dumps(reply), flush=True)
    if kind == "result":
        break
