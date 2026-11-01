# Connect Your Own Data To TRP Studio

TRP Studio judges any stream of evidence against any Trust Requirements Profile (TRP) with the open reference engine, in the browser. This guide covers the evidence contract, the five ways evidence reaches the Studio, the evidence bridge for telemetry systems, recipes for LeRobot, ROS 2, OpenTelemetry and MQTT, and how to add a new use case as a scenario pack.

## Evidence Contract

| Item | Specification |
|---|---|
| Unit of evidence | One JSON object per reading, mapping signal names to values |
| Value types | Number, boolean or string. Objects, arrays, null and non-finite numbers are dropped |
| Names | Must match `scored_signals[].signal` or `hard_rules[].field` in the profile. Other names are kept and reported as not in the profile |
| Missing readings | Leave the key out. The engine applies the signal's `on_missing` policy and never reads a missing value as safe |
| Timestamp | Optional `t` in seconds, either beside the evidence as `{ "t": 1.25, "evidence": { ... } }` or as a `t` key inside it |
| Size limits | 128 signals per reading, 64 KB per streamed message, 32 MB and 200,000 readings per file |
| Rejected keys | `__proto__`, `constructor` and `prototype` are refused everywhere |

```json
{"t": 0.25, "evidence": {"human_distance_m": 1.42, "balance_margin_m": 0.061, "contact_force_N": 14, "teleop_link_ok": true}}
```

In the Studio, **Connect** then **Download an evidence template** writes eight readings of the open pack in this format.

## Sources

| Source | Input | Use | Code |
|---|---|---|---|
| Synthetic | The open pack's simulator, with stochastic drift and shocks where the pack defines them | Default. Demos and pitches with no network | `studio/sim.js` |
| File | JSON lines, a JSON array, CSV with a header row of signal names and an optional `t`, `time` or `timestamp` column, or OpenTelemetry metrics as OTLP/JSON lines | Replay of recorded runs, test logs, historian exports | `studio/connect.js` |
| Stream | WebSocket (`ws:`, `wss:`) or Server-Sent Events (`http:`, `https:`), one evidence object per message. With a rosbridge topic, the Studio subscribes and parses each message's `data` string | Live systems, through the evidence bridge or a rosbridge server | `studio/connect.js` |
| Page API | `window.TRPStudio.ingest(evidence)` returns the engine result for that reading. `TRPStudio.replay(text, name)` and `TRPStudio.connect(url, opts)` do the same as the panel | Test harnesses, agents, embedding | `studio/app.js` |
| LeRobot | One episode of a public LeRobot dataset through the Hugging Face dataset viewer, mapped to arm evidence and judged against `examples/arm-motion/trp.json` | Real robot recordings. Falls back to a synthetic SO-101 episode in the same row format | `studio/lerobot.js` |

The Studio's Content Security Policy allows streams from any `https:` or `wss:` host and from `localhost` and `127.0.0.1` over `http:` and `ws:`. A page served over HTTPS cannot open a plain `http:` or `ws:` stream to another host, so put a remote bridge behind TLS.

## Evidence Bridge

`studio/bridge/evidence-bridge.js` is a single Node file with no dependencies. It accepts evidence from standard input, a file, an HTTP POST or the Studio's own generator, and serves it as Server-Sent Events.

| Command | Result |
|---|---|
| `node studio/bridge/evidence-bridge.js --demo humanoid-floor` | Streams the humanoid pack's stochastic generator with its faults injected at random. No hardware needed |
| `<producer> \| node studio/bridge/evidence-bridge.js --stdin` | Relays JSON lines or CSV from any process |
| `node studio/bridge/evidence-bridge.js --file run.jsonl --loop` | Replays a recording at its timestamps |
| `curl -X POST -H 'Content-Type: application/json' -d '{"human_distance_m": 0.8}' http://127.0.0.1:8787/evidence` | Pushes one reading, or an array of readings, from any HTTP client or webhook |

| Option | Default | Meaning |
|---|---|---|
| `--port` | 8787 | Listening port. `0` picks a free port |
| `--host` | 127.0.0.1 | Bind address. Bind wider only behind a TLS proxy |
| `--origin` | `*` | `Access-Control-Allow-Origin` header. Set it to the Studio's origin in shared environments |
| `--format` | from file name or first line | `jsonl`, `csv` or `otlp` |
| `--map` | none | `source_name=signal_name,...` renames metric names or JSON keys to profile signals |
| `--hz` | 4 | Readings a second for files without timestamps |

Endpoints are `GET /events` (Server-Sent Events), `POST /evidence` (64 KB limit) and `GET /health`. In the Studio, open **Connect**, enter `http://127.0.0.1:8787/events` under **Stream**, and press **Connect**.

## Recipes

### LeRobot

| Step | Detail |
|---|---|
| Fetch | `GET https://datasets-server.huggingface.co/rows?dataset=<id>&config=default&split=train&offset=<n>&length=100`, paged until the episode ends |
| Fields read | `observation.state`, `action`, `timestamp`, `frame_index`, `episode_index` |
| Evidence | `peak_joint_speed` from the change in state per second, `tracking_error` from the largest gap between action and state, `action_jump` from the change in action per frame, `frame_gap` when timestamps skip more than three frame periods |
| Profile | `examples/arm-motion/trp.json`. Its thresholds are placeholders until set from a real episode's measured joint speeds and units |
| Offline | `TRPLeRobot.synthEpisode({ seed, faults })` generates a six-joint pick-and-place episode with tracking lag, sensor noise and optional `rush`, `collision`, `glitch` and `dropout` faults, in the same row format. `TRPLeRobot.rowsPage(frames)` writes it as a `/rows` page for a local file. The Studio and the Lab label it as synthetic |
| Local recordings | For a dataset on disk, export frames to JSON lines with the fields above and replay through **File**, or convert with `TRPLeRobot.toEvidence` in Node and stream through the bridge |

### ROS 2

| Path | Detail |
|---|---|
| rosbridge | Run a rosbridge WebSocket server. Publish evidence as a `std_msgs/msg/String` message whose `data` is the evidence JSON. In the Studio, enter the rosbridge address under **Stream** and the topic, for example `/trp/evidence`. The Studio sends `{"op": "subscribe", "topic": "/trp/evidence", "type": "std_msgs/msg/String"}` and parses `msg.data` of each `publish` message |
| Bridge | A node that subscribes to robot topics, computes evidence and posts it to `http://127.0.0.1:8787/evidence`. Suits signals derived from several topics, such as minimum human distance from a perception topic and balance margin from the controller |
| Mapping | Evidence names follow the profile. Typical sources are joint state for torque and speed, the balance controller for zero moment point margin, the safety controller for emergency stop, and perception for human distance and latency |

### OpenTelemetry

| Step | Detail |
|---|---|
| Collector | Configure a file exporter that writes OTLP/JSON metrics, one `MetricsData` object per line |
| Points read | `gauge` and `sum` data points with `asDouble` or `asInt`, grouped by `timeUnixNano`. Readings carry forward so a slower metric stays present |
| Names | Metric names become signal names. Use `--map` or the profile's own names to match |
| Command | `node studio/bridge/evidence-bridge.js --file metrics.jsonl --format otlp --map robot.balance.margin=balance_margin_m --loop`, or tail the exporter's file into `--stdin --format otlp` |

### MQTT

| Step | Detail |
|---|---|
| Subscribe | Any MQTT client that prints one payload per line, for example `mosquitto_sub -t 'plant/+/evidence'` |
| Relay | Pipe it into `node studio/bridge/evidence-bridge.js --stdin` |
| Payload | Each payload is one evidence object. Use `--map` to rename vendor keys |

### CSV And Historians

Export a time range with one column per signal and a `timestamp` column in seconds, then load it through **File**, or relay it through the bridge with `--file export.csv --format csv`.

## Adding A Use Case

A use case is a scenario pack, a JSON file in `studio/packs/<id>/pack.json` registered in `studio/packs/index.json`, beside a profile in `examples/<id>/trp.json`. Importing a bare profile builds a pack automatically with one control per requirement.

| Field | Purpose |
|---|---|
| `signals.<name>.base`, `min`, `max`, `decimals`, `jitter`, `label` | Starting value, bounds, display precision, small noise |
| `signals.<name>.process` | `{ "type": "ou", "theta": <1/s>, "sigma": <units/√s> }`. Ornstein-Uhlenbeck drift around the level, the standard model for a reading that wanders and reverts |
| `signals.<name>.shocks` | `{ "rate": <per s>, "size": <units>, "spread": <units>, "decay_s": <s> }`. Poisson arrivals of sudden deviations that decay, such as a slip, a bump or a person stepping out |
| `signals.<name>.wave` | `{ "amplitude": <units>, "period_s": <s>, "phase": <radians> }`. A periodic swing on top of the level, such as a patient's breathing moving tissue toward an instrument |
| `signals.<name>.derive` | `{ "from": <signal>, "scale": <k>, "offset": <c> }`. The level follows another signal, such as joint torque from payload or spend from message rate |
| `controls` | Sliders that set a signal and toggles with effects (`set`, `to`, `ramp_s`, `omit`, `shock_rate`) |
| `story` | Timed captions and control changes for the guided demo |
| `arena.harm` | Conditions on true values that define harm, with optional `near` conditions for near misses. This is what the stress test and the Command floor score against |
| `arena.moves` | Faults, each a set of effects. Used by the Arena, the stress test and the Command floor |
| `arena.guards` | Purchasable mitigations for the Arena |
| `command` | `group`, `unit`, `count`, `fault_rate`, and `benign` excursions with `benign_rate`. Puts the pack on the Command floor |

A Learn challenge in `studio/challenges.json` with a `solution` gives the pack a tuned rule book on the Command floor. `tests/learn_challenges.js` checks the published profile fails the challenge and the solution passes it.

`examples/humanoid-workforce/trp.json` and `studio/packs/humanoid-floor/pack.json` are the reference for a stochastic use case. Humanoid robots on learned policies carry totes in an aisle shared with people. Human distance, balance margin, contact force, joint torque, policy confidence and perception latency drift and take shocks. Joint torque follows payload. Measured over 300 runs, the published limits stop every harm and stop for nothing 36 times. The tuned limits in the Noisy Floor challenge stop every harm and stop for nothing twice.

Three more reference use cases sit in regulated settings. Each has a profile, a pack, a scene, an Arena event, a Command group and a Learn challenge whose tuned limits were set by measurement. The published profiles ship with a gap that the challenge closes.

| Use case | Profile and pack | Stochastic behavior | Published, 300 runs | Tuned, 300 runs |
|---|---|---|---|---|
| Surgical assist. An autonomous suturing assist near a major vessel under a surgeon's supervision | `examples/robotic-surgery-assist/`, `studio/packs/surgical-assist/` | Breathing moves the vessel margin periodically, force and tracking drift, the patient can shift | 94% of harm stopped, 13 false stops | All harm stopped, 18 false stops (Breathing Room) |
| Agent swarm. AI agents doing back-office work that spawn helpers and delegate | `examples/agent-swarm-operations/`, `studio/packs/agent-swarm/` | Agent count follows spawn rate, spend follows message rate, drift and depth take shocks | 88% of harm stopped, 6 false stops | All harm stopped, 10 false stops (Quiet Takeover) |
| Trading agent. An AI agent trading equities through a broker's market access | `examples/algorithmic-trading-agent/`, `studio/packs/trading-desk/` | Price deviation, drawdown, order rate and data age drift and take shocks | 85% of harm stopped, 31 false stops | All harm stopped, 10 false stops (Price Collar) |

## Verification

| Item | Status | Basis |
|---|---|---|
| Parsers for JSON lines, CSV and OTLP/JSON, replay timing, hostile key handling | Verified | `tests/studio_connect.js` |
| Evidence bridge over HTTP POST, standard input in JSON lines and CSV, and demo mode | Verified | `tests/studio_connect.js` starts the bridge and reads its event stream |
| Studio Connect panel with a live stream, file replay, page API and the LeRobot fallback | Verified in headless Chromium | `tests/browser/studio_e2e.js` |
| Stochastic simulator determinism, drift, shocks and coupling, with existing packs unchanged | Verified | `tests/studio_connect.js`, `tests/learn_challenges.js` |
| Hugging Face `/rows` endpoint, parameters, 100-row limit and response fields | Verified against documentation | Hugging Face dataset viewer quick start, 2026-11-01 |
| Hugging Face access from a browser (CORS) and rate limits | Not verified | Not covered in the documentation, and the build environment cannot reach the API |
| rosbridge `subscribe` and `publish` message fields | Verified against documentation | rosbridge protocol document. Not tested against a running ROS 2 system |
| OTLP file exporter format | Verified against documentation | OpenTelemetry file exporter specification, status Development. `gauge` and `asDouble` follow the OTLP JSON encoding and do not appear in that page's examples |
| MQTT through `mosquitto_sub` | Not verified | Relies on one payload per line on standard output |
| Arm motion thresholds | Placeholders | Set from a real LeRobot episode before any claim about arm safety |
| Humanoid profile thresholds | Illustrative | Reference values for a demo, not certified limits |
| Surgical, agent swarm and trading profile thresholds | Illustrative | Reference values for a demo, not clinical, regulatory or risk limits. The standards and rules named in each profile's notes are for orientation and need checking against the primary text |

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Browser access to Hugging Face blocked by CORS or rate limits | LeRobot source shows the synthetic episode | Fallback is automatic and labeled. For a pitch, save one real episode with `rowsPage` and replay it through **File** |
| A remote stream over plain `http:` from an HTTPS page | Browser blocks it | Serve the bridge over TLS or run the Studio locally |
| Evidence names that do not match the profile | Signals judged as missing, standing goes to failing | The Connect panel lists missing and unmatched names. Use `--map` or rename at the source |
| Synthetic data presented as real | Loss of credibility in diligence | Every synthetic source is labeled in the Connect panel, in the notice shown on load and on the Lab page |
| Thresholds read as certified | Liability | Every reference profile states its values are illustrative. Real deployments set limits from measured data |
