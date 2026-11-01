# TRP Arena Protocol

Version `trp-arena/1`. The protocol lets any program play the TRP Arena against any other, in any language. One side is the Guardian, which buys guards before the match. The other is the Challenger, which picks one move each round. The open TRP engine judges every tick, so neither side can argue with the result.

## Running A Match

Everything runs on your own machine. There is no server.

```bash
# One leg, your agent as Guardian against the Studio's own Challenger
node studio/match.js --event robot-cell --guardian "python3 my_agent.py" --challenger builtin:scripted

# Two legs with sides swapped. Each side's mark is its score as Guardian.
node studio/match.js --event agno --versus "node studio/agents/greedy.js" "python3 studio/agents/random_agent.py" --out match.json

# Re-run a saved match from its recorded choices and confirm the result
node studio/match.js --verify match.json
```

| Option | Meaning |
|---|---|
| `--event <id>` | Arena event, one of the scenario packs with an `arena` section |
| `--guardian <who>`, `--challenger <who>` | Contestants for a single leg |
| `--versus <a> <b>` | Two legs, `a` defends first, then the sides swap |
| `--seed <n>` | Match seed, default today's UTC date |
| `--timeout <ms>` | Time allowed for each reply, default 5000, maximum 120000 |
| `--names a,b` | Names for the two sides of a versus match |
| `--out <file>` | Save the match record |
| `--verify <file>` | Re-run a saved record and exit 1 if any result differs |

A contestant is one of these.

| Value | Contestant |
|---|---|
| `builtin:greedy` | Guardian buys the guards that counter the most moves per point. Challenger aims at moves no guard counters |
| `builtin:random` | Random legal choices |
| `builtin:scripted` | The Studio's own Challenger, so results match the browser Arena |
| `builtin:guards=a,b` | A Guardian that always buys guards `a` and `b` |
| Any other text | A command to run, which must speak the protocol below |

## Messages

The runner writes one JSON object per line to the contestant's standard input. The contestant answers only messages that carry an `id`, with one JSON line on standard output that repeats the `id`. Anything else the contestant prints is ignored, and messages without an `id` need no answer.

| Message | Sent | Reply |
|---|---|---|
| `hello` | Once, first | None |
| `choose_guards` | Once, to the Guardian | `{"id": n, "guards": ["id", ...]}` |
| `choose_move` | Each round, to the Challenger | `{"id": n, "move": "id"}` |
| `round_result` | After each round, to both | None |
| `result` | Once, last | None. Exit after this |

`hello` describes the event.

```json
{"type": "hello", "protocol": "trp-arena/1", "role": "guardian", "seed": 20261101,
 "event": {"id": "robot-cell", "title": "Cell Defense", "rounds": 8, "round_s": 6, "budget": 7,
   "guards": [{"id": "second-sensor", "label": "Second sensor", "detail": "...", "cost": 3, "counters": ["blind"]}],
   "moves": [{"id": "blind", "label": "Blind the sensor"}],
   "harm": [{"id": "contact", "label": "Person struck"}],
   "scoring": "100 x (0.65 x share of harm stopped within 0.75 s + 0.35 x uptime) - 2 x false stops"}}
```

`choose_move` tells the Challenger which guards are in play and what happened so far.

```json
{"type": "choose_move", "id": 4, "round": 2, "rounds": 8, "guards_in_play": ["second-sensor"],
 "history": [{"round": 0, "move": "blind", "caught": 1, "missed": 0, "false_stops": 0}]}
```

`result` carries the guards, the moves, the summary from the Arena scorer and the round history.

## Rules The Runner Enforces

- A reply that is late, malformed or names something that does not exist is recorded as a fault. The Guardian then plays with the guards that were valid, and the Challenger gets a random legal move from the match seed.
- Guards are kept in the order asked for, while they fit the budget. Unknown and repeated guards are dropped.
- A line over 64 KB ends that contestant's part in the match.
- A whole match is stopped after 10 minutes.
- Every contestant program runs in its own process group and is stopped when the match ends.
- Contestant commands run with your permissions and are not sandboxed. Run programs you did not write inside a container.

## Match Records

`--out` saves the event, seed, guards, moves, per-round history, summary and faults for each leg. The simulation is deterministic, so `--verify` re-runs the recorded choices and confirms every score. Any public leaderboard should accept only records that verify.

## Writing A Contestant

`studio/agents/greedy.js` (JavaScript) and `studio/agents/random_agent.py` (Python) are complete contestants in about 30 lines each. `studio/agents/llm_agent.py` asks a language model for each decision using your own `ANTHROPIC_API_KEY`, and falls back to a simple rule without one. Model calls are slow, so pass `--timeout 30000` when using it.
