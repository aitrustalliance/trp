#!/usr/bin/env bash
# Records one live run of an NVIDIA OpenShell sandbox under a sandbox policy
# written from the openshell-egress TRP profile, on a Linux machine with
# Docker Engine 28.0 or later. GitHub Actions runs it on ubuntu-24.04 through
# .github/workflows/record-openshell.yml.
#
#   bash adapters/openshell/record.sh [output-folder]
#
# A scripted agent inside the sandbox, an image built from agent-image with
# curl added, runs three rounds. Each round makes two requests to the approved
# GitHub API endpoint, a read and a write, and one read from a destination the
# policy does not list. No model and no
# credential is involved. OpenShell's sandbox supervisor records each decision
# in OCSF (Open Cybersecurity Schema Framework) JSON on its stderr, and the
# adapter turns those records into TRP evidence and judges them.
#
# Every OpenShell command and setting here comes from NVIDIA's documentation
# and the sandbox policy quickstart in the OpenShell repository.

set -euo pipefail

VERSION="${OPENSHELL_VERSION:-v0.1.8}"
OUT="${1:-openshell-recording}"
NAME="trp-egress"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$HERE/profiles/openshell-egress.trp.json"
TOOL="$HERE/trp_openshell.py"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
LOG="$OUT/record.log"
exec > >(tee -a "$LOG") 2>&1

collect() {
  set +e
  echo "== collecting"
  docker ps -a --format '{{.ID}} {{.Image}} {{.Names}} {{.Status}}' > "$OUT/containers.txt" 2>&1
  for c in $(docker ps -aq); do docker logs "$c" 2>&1 | grep 'OCSF-JSON'; done > "$OUT/supervisor-stderr.log"
  openshell logs "$NAME" --since 30m --source sandbox -n 1000 > "$OUT/shorthand.log" 2>&1
  journalctl --user -u openshell-gateway -n 200 --no-pager > "$OUT/gateway-journal.log" 2>&1
  openshell sandbox delete "$NAME" > /dev/null 2>&1
  (cd "$OUT" && sha256sum -- *.* > SHA256SUMS)
}
trap collect EXIT

echo "== writing the sandbox policy from the TRP profile"
python3 "$TOOL" policy --profile "$PROFILE" --deployment "$HERE/deployment.example.json" \
  --policy-out "$OUT/policy.yaml" --coverage-out "$OUT/coverage.json"

echo "== installing OpenShell $VERSION"
# The Linux package runs the gateway as a systemd user service. A CI runner
# has no login session, so lingering starts the user manager for it.
sudo loginctl enable-linger "$USER"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for _ in $(seq 1 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done
mkdir -p "$HOME/.config/openshell"
echo "OPENSHELL_TELEMETRY_ENABLED=false" >> "$HOME/.config/openshell/gateway.env"
docker version --format 'Docker Engine {{.Server.Version}}' | tee "$OUT/docker-version.txt"
uname -r | tee "$OUT/kernel.txt"
curl -LsSf "https://raw.githubusercontent.com/NVIDIA/OpenShell/${VERSION}/install.sh" | OPENSHELL_VERSION="$VERSION" sh

if ! openshell status > /dev/null 2>&1; then
  echo "== the user service did not answer, starting the gateway the way its unit file does"
  export OPENSHELL_LOCAL_TLS_DIR="$HOME/.local/state/openshell/tls"
  openshell-gateway config preflight
  openshell-gateway generate-certs --output-dir "$OPENSHELL_LOCAL_TLS_DIR" --server-san host.openshell.internal
  nohup openshell-gateway > "$OUT/gateway.log" 2>&1 &
  sleep 5
  openshell gateway add https://127.0.0.1:17670 --local --name openshell || true
  for _ in $(seq 1 30); do openshell status > /dev/null 2>&1 && break; sleep 2; done
fi
openshell --version | tee "$OUT/openshell-version.txt"
openshell status | tee "$OUT/status.txt"

echo "== building the scripted agent's image"
# The default sandbox image has no curl. A Docker gateway runs local images
# named with --from, as NVIDIA's bring-your-own-container example shows.
docker build -q -t trp-egress-agent:local "$HERE/agent-image" | tee "$OUT/agent-image.txt"

echo "== creating the sandbox under the policy"
openshell sandbox create --name "$NAME" --from trp-egress-agent:local --policy "$OUT/policy.yaml" \
  --no-auto-providers --no-tty -- echo ready
openshell settings set "$NAME" --key ocsf_json_enabled --value true
# The setting takes effect on the next poll, every 10 seconds by default.
sleep 15

echo "== reaching into the sandbox"
# sandbox exec is the documented one-shot command. NVIDIA's policy quickstart
# script reaches the sandbox over SSH through sandbox ssh-config, so that is
# the fallback when exec does not answer.
SSH_CONFIG="$OUT/ssh-config"
in_sandbox() {
  if [ "${MODE:-exec}" = exec ]; then
    openshell sandbox exec -n "$NAME" --no-tty --no-login-shell --timeout 30 -- "$@" < /dev/null
  else
    ssh -F "$SSH_CONFIG" -o BatchMode=yes "$SSH_HOST" "$@" < /dev/null
  fi
}
MODE=exec
if in_sandbox echo probe > "$OUT/probe.txt" 2> "$OUT/probe-error.txt" && grep -q probe "$OUT/probe.txt"; then
  echo "sandbox exec answers"
else
  echo "sandbox exec did not answer, trying SSH"
  cat "$OUT/probe-error.txt"
  openshell sandbox ssh-config "$NAME" > "$SSH_CONFIG"
  SSH_HOST="$(awk '/^Host / { print $2; exit }' "$SSH_CONFIG")"
  MODE=ssh
  for _ in $(seq 1 15); do in_sandbox true > /dev/null 2>&1 && break; sleep 2; done
  in_sandbox echo probe > "$OUT/probe.txt" 2> "$OUT/probe-error.txt" || true
fi
echo "mode $MODE" | tee -a "$OUT/workload.txt"

echo "== running the scripted agent"
request() {
  local label="$1"; shift
  local code
  code="$(in_sandbox curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>> "$OUT/workload-errors.txt" || true)"
  printf '%s %s\n' "$label" "${code:-no response}" | tee -a "$OUT/workload.txt"
}
for round in 1 2 3; do
  request "round $round read approved endpoint" https://api.github.com/zen
  request "round $round write approved endpoint" -X POST -H 'Content-Type: application/json' \
    -d '{"title":"trp"}' https://api.github.com/repos/octocat/hello-world/issues
  request "round $round read unlisted destination" https://example.com/
  sleep 2
done
sleep 5

trap - EXIT
collect

echo "== judging the decisions against the profile"
python3 "$TOOL" evidence "$OUT/supervisor-stderr.log" --format stderr --out "$OUT/evidence.jsonl"
python3 "$TOOL" evaluate "$OUT/evidence.jsonl" --profile "$PROFILE" --out "$OUT/results.jsonl" | tee "$OUT/summary.json"
(cd "$OUT" && sha256sum -- *.* > SHA256SUMS)
