# NVIDIA OpenShell

NVIDIA OpenShell runs AI agents in sandboxes the Linux kernel enforces, under a sandbox policy that lists every destination each program in the sandbox may reach. `trp_openshell.py` puts a TRP (Trust Requirements Profile) on both sides of that sandbox. It writes the sandbox policy from a profile and a deployment file, and it turns the OCSF (Open Cybersecurity Schema Framework) records that OpenShell's sandbox supervisor writes for every allowed or denied request into TRP evidence, which the reference evaluator then judges against the same profile. The adapter needs only the Python standard library and `tools/evaluate.py`.

## Use

```bash
python adapters/openshell/trp_openshell.py policy --profile adapters/openshell/profiles/openshell-egress.trp.json \
  --deployment adapters/openshell/deployment.example.json --policy-out policy.yaml --coverage-out coverage.json
openshell sandbox create --name trp-egress --policy policy.yaml --no-auto-providers
openshell settings set trp-egress --key ocsf_json_enabled --value true
docker logs <supervisor container> 2>&1 | grep OCSF-JSON > supervisor-stderr.log
python adapters/openshell/trp_openshell.py evidence supervisor-stderr.log --out evidence.jsonl
python adapters/openshell/trp_openshell.py evaluate evidence.jsonl --profile adapters/openshell/profiles/openshell-egress.trp.json --out results.jsonl
```

`policy` exits 2 and names the field when the deployment cannot become a valid policy. `evidence` reads OCSF JSON lines or the supervisor's stderr lines, which carry the `OCSF-JSON` marker after a UTC (Coordinated Universal Time) timestamp, and passes over the shorthand copy of each event. `evaluate` prints a summary and writes one result per decision.

## Policy

A deployment names each destination the agent needs and the programs that may reach it, by their real executable paths, since OpenShell matches the executable and an empty list allows nothing. The adapter reads the profile's hard rules by field and condition.

| TRP Requirement | What The Policy Carries | What Stays With The TRP Gate |
|---|---|---|
| `output_destination_approved` is false | One `network_policies` entry per endpoint, with its `binaries`. OpenShell denies every connection no entry allows | Addresses inside tool arguments that a tool fetches from outside the sandbox |
| `write_without_approval` is true | `protocol: rest` with the `read-only` preset, which allows GET, HEAD and OPTIONS, or `read-write` where the deployment sets `writes_approved`, which also allows POST, PUT and PATCH | The review the profile asks for, since OpenShell blocks or logs a request and never pauses one for a person, and writes to endpoints without request inspection or in `audit` |
| Any other hard rule and every scored signal | Nothing | The whole requirement |

An endpoint without `protocol` gets a connection check only. An endpoint with `protocol: rest` takes the deployment's `enforcement`, which defaults to `enforce` here, while OpenShell's own default is `audit`. The coverage report lists every requirement in the profile with `carried_by` set to `openshell`, `openshell_in_part` or `trp_gate`. Read it before applying a policy.

For the example deployment the network rule comes out the same, member for member, as the `github_api` rule in NVIDIA's sandbox policy quickstart, and `tests/openshell_check.py` checks that on every push.

## Evidence

| OCSF Record | Evidence |
|---|---|
| Network Activity (`class_uid` 4001), `action` Allowed | `output_destination_approved` true and `write_without_approval` false, since opening a connection writes nothing |
| Network Activity, `action` Denied | `output_destination_approved` false and `write_without_approval` false |
| HTTP Activity (`class_uid` 4002), `action` Allowed | `output_destination_approved` true and `write_without_approval` false |
| HTTP Activity, `action` Denied | `output_destination_approved` true, and `write_without_approval` true when `http_request.http_method` is POST, PUT, PATCH or DELETE. With no method in the record the field stays out, and the evaluator reports the rule as inconclusive |
| Anything else, including `action` Other under `audit` | No evidence |

Each evidence line keeps the record's `metadata.uid`, time, action, disposition, rule name, destination, program and sandbox name beside the evidence. A record read twice, from stderr and from a file, counts once by its `metadata.uid`. Each result says whether the profile and OpenShell agreed. A request OpenShell allowed should meet every hard rule, and a request it denied should trigger at least one.

## Recording

`record.sh` installs a pinned OpenShell release on a Linux machine with Docker Engine 28.0 or later, starts the gateway, creates a sandbox under the policy written from `openshell-egress`, turns on OCSF JSON export and runs a scripted agent for three rounds. Each round makes two requests to the approved GitHub API endpoint, a read and a write, and one read from a destination the policy does not list. No model and no credential is involved. `.github/workflows/record-openshell.yml` runs it on GitHub's ubuntu-24.04 runners and keeps the policy, the coverage report, the supervisor's OCSF lines, the evidence, the results and their SHA-256 digests as the `openshell-recording` artifact.

## Limits

- Collection is best effort. OpenShell's own documentation says so, and the supervisor drops lines when its console queue of 1,024 lines is full.
- The fixtures in `fixtures/nvidia-docs` are NVIDIA's documentation examples. They test the reader and the mapping, and only a live recording counts as evidence that a sandbox behaved this way.
- This version writes `rest` and connection-only endpoints. OpenShell's `mcp`, `graphql`, `websocket` and `json-rpc` inspection, its filesystem and process rules beyond the deployment's settings, and its policy advisor are not used.
- The HTTP method field is read from the OCSF standard's `http_request` object. NVIDIA's pages show no HTTP Activity example, so a live recording settles it.

## Sources

Read on 15 November 2026 from the NVIDIA OpenShell repository at commit 2e5589b and its published documentation.

- Sandbox policy quickstart, https://github.com/NVIDIA/OpenShell/tree/main/examples/sandbox-policy-quickstart
- Policy schema, https://docs.nvidia.com/openshell/latest/how-it-works/policies/schema
- OCSF JSON export, https://docs.nvidia.com/openshell/latest/observability/ocsf-json-export
- Installation, https://docs.nvidia.com/openshell/latest/about/installation
- Support matrix, https://docs.nvidia.com/openshell/latest/about/support-matrix
