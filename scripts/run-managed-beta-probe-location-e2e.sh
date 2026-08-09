#!/usr/bin/env bash
set -euo pipefail

PROMETHEUS_URL="${FIDUCIA_TEST_PROMETHEUS_URL:-http://127.0.0.1:19090}"
PROBE_IMAGE="fiducia-managed-beta-probe:test-fleet"
FIXTURE_PORT=19200
PROBE_A_PORT=19201
PROBE_B_PORT=19202
PROBE_DUPLICATE_PORT=19203
ROOT="${RUNNER_TEMP:?RUNNER_TEMP is required}/probe-state"
FIXTURE="${RUNNER_TEMP}/fiducia-fixture"
PROM_DIR="${RUNNER_TEMP}/prometheus"

pids=()

cleanup() {
  docker rm --force fiducia-test-prometheus >/dev/null 2>&1 || true
  for pid in "${pids[@]:-}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

query() {
  curl --fail --silent --get \
    --data-urlencode "query=$1" \
    "${PROMETHEUS_URL}/api/v1/query"
}

dump_diagnostics() {
  echo '--- Prometheus targets ---' >&2
  curl --silent "${PROMETHEUS_URL}/api/v1/targets" | jq . >&2 || true
  echo '--- Prometheus rules ---' >&2
  curl --silent "${PROMETHEUS_URL}/api/v1/rules" | jq . >&2 || true
  echo '--- Raw external probe series ---' >&2
  query 'fiducia_external_probe_total' | jq . >&2 || true
  echo '--- Last-run series ---' >&2
  query 'fiducia_external_probe_last_run_unixtime' | jq . >&2 || true
  echo '--- Freshness recording series ---' >&2
  query 'fiducia:sli:external_probe_freshness_seconds' | jq . >&2 || true
  echo '--- Prometheus logs ---' >&2
  docker logs fiducia-test-prometheus >&2 || true
  for log in \
    "$RUNNER_TEMP/probe-a-metrics.log" \
    "$RUNNER_TEMP/probe-b-metrics.log" \
    "$RUNNER_TEMP/probe-a-duplicate.log"; do
    echo "--- ${log} ---" >&2
    cat "$log" >&2 2>/dev/null || true
  done
}

wait_for_up_targets() {
  local expected="$1"
  local count
  for _ in $(seq 1 120); do
    count="$(
      curl --silent "${PROMETHEUS_URL}/api/v1/targets" |
        jq -r '[.data.activeTargets[]? | select(.health == "up")] | length' 2>/dev/null || true
    )"
    if [[ "$count" =~ ^[0-9]+$ ]] && (( count >= expected )); then
      return 0
    fi
    sleep 0.25
  done
  echo "expected at least ${expected} healthy Prometheus targets" >&2
  dump_diagnostics
  return 1
}

wait_scalar_equals() {
  local expression="$1"
  local expected="$2"
  local value
  for _ in $(seq 1 120); do
    value="$(
      query "$expression" |
        jq -er '.data.result[0].value[1] | tonumber' 2>/dev/null || true
    )"
    if [[ "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]] &&
      python3 - "$value" "$expected" <<'PY'
import math
import sys
actual = float(sys.argv[1])
expected = float(sys.argv[2])
raise SystemExit(0 if math.isclose(actual, expected, rel_tol=0, abs_tol=1e-9) else 1)
PY
    then
      return 0
    fi
    sleep 0.25
  done
  echo "PromQL expression did not reach expected value ${expected}: ${expression}" >&2
  dump_diagnostics
  return 1
}

wait_scalar_at_least() {
  local expression="$1"
  local minimum="$2"
  local value
  for _ in $(seq 1 120); do
    value="$(
      query "$expression" |
        jq -er '.data.result[0].value[1] | tonumber' 2>/dev/null || true
    )"
    if [[ "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]] &&
      python3 - "$value" "$minimum" <<'PY'
import sys
raise SystemExit(0 if float(sys.argv[1]) >= float(sys.argv[2]) else 1)
PY
    then
      return 0
    fi
    sleep 0.25
  done
  echo "PromQL expression did not reach minimum ${minimum}: ${expression}" >&2
  dump_diagnostics
  return 1
}

wait_http() {
  local url="$1"
  for _ in $(seq 1 100); do
    curl --fail --silent "$url" >/dev/null && return 0
    sleep 0.1
  done
  echo "HTTP fixture did not become ready: ${url}" >&2
  return 1
}

verify_source_contracts() {
  test "$(git hash-object managed-beta/vendor/managed-beta-rules.yml)" = \
    "$(jq -r '.production_rules.blob' managed-beta/source-contract.json)"
  test "$(git hash-object managed-beta/vendor/probe/scripts/managed-beta-sli-probe.mjs)" = \
    "$(jq -r '.probe_source.script_blob' managed-beta/source-contract.json)"
  test "$(git hash-object managed-beta/vendor/probe/docker/managed-beta-probe.Dockerfile)" = \
    "$(jq -r '.probe_source.dockerfile_blob' managed-beta/source-contract.json)"
  test "$(jq -r '.production_rules.commit' managed-beta/source-contract.json)" = \
    'd22740b98a08dea6a30ca364c90ebd59c965b557'
  test "$(jq -r '.production_exporter.commit' managed-beta/source-contract.json)" = \
    'c9e8f32aa6b55d33116d867c952fad19fcafa741'
  test "$(jq -r '.production_exporter.blob' managed-beta/source-contract.json)" = \
    '5c17e3fe8817c9331e594c99300abee8c286fcfb'
  test "$(jq -r '.probe_source.commit' managed-beta/source-contract.json)" = \
    '596449565cd2ec466ff72a533e8190ce389b4149'
  test "$(jq -r '.probe_source.registry_access_from_test_org' managed-beta/source-contract.json)" = \
    'false'
  test "$(jq -r '.purpose' managed-beta/source-contract.json)" = \
    'Synthetic test-fleet validation only; never production evidence.'
  node --check managed-beta/vendor/probe/scripts/managed-beta-sli-probe.mjs
  node --check scripts/assert-managed-beta-test-fleet.mjs
  python3 -m py_compile scripts/serve-prometheus-textfiles.py
}

build_probe_image() {
  docker pull "$(jq -r '.prometheus_image' managed-beta/source-contract.json)"
  docker build \
    --pull \
    --file managed-beta/vendor/probe/docker/managed-beta-probe.Dockerfile \
    --tag "$PROBE_IMAGE" \
    managed-beta/vendor/probe
  test "$(docker image inspect --format '{{.Config.User}}' "$PROBE_IMAGE")" = '1000:1000'
  test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$PROBE_IMAGE")" = \
    '["node","/opt/fiducia-probe/managed-beta-sli-probe.mjs"]'
}

start_fixture() {
  mkdir -p "$FIXTURE"
  jq -r '.fixture_canary' managed-beta/source-contract.json >"$FIXTURE/index.html"
  python3 -m http.server "$FIXTURE_PORT" \
    --bind 127.0.0.1 \
    --directory "$FIXTURE" \
    >"$RUNNER_TEMP/fiducia-fixture.log" 2>&1 &
  pids+=("$!")
  wait_http "http://127.0.0.1:${FIXTURE_PORT}/"
}

run_probe() {
  local location="$1"
  local operation="$2"
  docker run --rm \
    --read-only \
    --network host \
    --tmpfs /tmp:rw,noexec,nosuid,size=8m \
    --volume "$ROOT/$location:/state" \
    --env "FIDUCIA_PROBE_ENDPOINT=http://127.0.0.1:${FIXTURE_PORT}/" \
    --env FIDUCIA_PROBE_CELL=cell-a \
    --env "FIDUCIA_PROBE_OPERATION_CLASS=$operation" \
    --env FIDUCIA_PROBE_EXPECT_STATUS=200 \
    --env "FIDUCIA_PROBE_STATE_FILE=/state/$operation.json" \
    --env "FIDUCIA_PROBE_TEXTFILE=/state/$operation.prom" \
    "$PROBE_IMAGE"
}

generate_probe_state() {
  mkdir -p "$ROOT/probe-a" "$ROOT/probe-b"
  sudo chown -R 1000:1000 "$ROOT"
  for location in probe-a probe-b; do
    for operation in health secret_read; do
      run_probe "$location" "$operation"
      run_probe "$location" "$operation"
    done
  done

  local canary
  canary="$(jq -r '.fixture_canary' managed-beta/source-contract.json)"
  if sudo grep -R -F "$canary" "$ROOT"; then
    echo 'probe state or metrics leaked the response canary' >&2
    return 1
  fi
  if sudo grep -R -F "127.0.0.1:${FIXTURE_PORT}" "$ROOT"; then
    echo 'probe state or metrics leaked the endpoint' >&2
    return 1
  fi
  if sudo grep -R -F 'probe_location' "$ROOT"; then
    echo 'probe runtime self-asserted monitoring topology identity' >&2
    return 1
  fi
}

start_metrics_servers() {
  python3 scripts/serve-prometheus-textfiles.py \
    --directory "$ROOT/probe-a" --port "$PROBE_A_PORT" \
    >"$RUNNER_TEMP/probe-a-metrics.log" 2>&1 &
  pids+=("$!")
  python3 scripts/serve-prometheus-textfiles.py \
    --directory "$ROOT/probe-b" --port "$PROBE_B_PORT" \
    >"$RUNNER_TEMP/probe-b-metrics.log" 2>&1 &
  pids+=("$!")
  python3 scripts/serve-prometheus-textfiles.py \
    --directory "$ROOT/probe-a" --port "$PROBE_DUPLICATE_PORT" \
    >"$RUNNER_TEMP/probe-a-duplicate.log" 2>&1 &
  pids+=("$!")
  for port in "$PROBE_A_PORT" "$PROBE_B_PORT" "$PROBE_DUPLICATE_PORT"; do
    wait_http "http://127.0.0.1:${port}/metrics"
  done
}

start_prometheus() {
  mkdir -p "$PROM_DIR"
  cp managed-beta/vendor/managed-beta-rules.yml "$PROM_DIR/managed-beta-rules.yml"
  sed -i '0,/interval: 30s/s//interval: 1s/' "$PROM_DIR/managed-beta-rules.yml"
  cat >"$PROM_DIR/prometheus.yml" <<YAML
global:
  scrape_interval: 1s
  evaluation_interval: 1s
rule_files:
  - /etc/prometheus/managed-beta-rules.yml
scrape_configs:
  - job_name: managed-beta-external-probes
    honor_labels: false
    static_configs:
      - targets: ["127.0.0.1:${PROBE_A_PORT}"]
        labels:
          probe_location: probe-a
      - targets: ["127.0.0.1:${PROBE_B_PORT}"]
        labels:
          probe_location: probe-b
      - targets: ["127.0.0.1:${PROBE_DUPLICATE_PORT}"]
        labels:
          probe_location: probe-a
YAML
  local image
  image="$(jq -r '.prometheus_image' managed-beta/source-contract.json)"
  docker run --rm --detach \
    --name fiducia-test-prometheus \
    --network host \
    --tmpfs /prometheus:rw,noexec,nosuid,nodev,mode=1777,size=64m \
    --volume "$PROM_DIR/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    --volume "$PROM_DIR/managed-beta-rules.yml:/etc/prometheus/managed-beta-rules.yml:ro" \
    "$image" \
    --config.file=/etc/prometheus/prometheus.yml \
    --storage.tsdb.path=/prometheus \
    --web.listen-address=127.0.0.1:19090
  wait_http "${PROMETHEUS_URL}/-/ready"
  wait_for_up_targets 3
}

prove_initial_state() {
  wait_scalar_equals \
    'fiducia:sli:external_probe_fresh_location_count{cell="cell-a",operation_class="health"}' 2
  wait_scalar_equals \
    'fiducia:sli:external_probe_fresh_location_count{cell="cell-a",operation_class="secret_read"}' 2
  wait_scalar_equals \
    'fiducia:sli:external_probe_location_count{cell="cell-a",operation_class="health"}' 2
  wait_scalar_at_least \
    'max(count by (probe_location,cell,operation_class,result) (fiducia_external_probe_total))' 2

  local raw
  raw="$(query 'fiducia_external_probe_total')"
  jq -e \
    '[.data.result[].metric.probe_location] | sort | unique == ["probe-a","probe-b"]' \
    <<<"$raw"
  jq -e \
    'all(.data.result[]; (.metric.tenant_id // "") == "" and (.metric.project_id // "") == "")' \
    <<<"$raw"
}

make_secret_read_stale() {
  local path="$ROOT/probe-b/secret_read.prom"
  local stale="$(( $(date +%s) - 1000 ))"
  sudo python3 - "$path" "$stale" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
stale = sys.argv[2]
text = path.read_text()
text = re.sub(
    r'(fiducia_external_probe_last_run_unixtime\{[^}]+\})\s+\d+',
    rf'\g<1> {stale}',
    text,
)
text = re.sub(
    r'(fiducia_external_probe_last_success_unixtime\{[^}]+\})\s+\d+',
    rf'\g<1> {stale}',
    text,
)
path.write_text(text)
PY
  wait_scalar_equals \
    'fiducia:sli:external_probe_fresh_location_count{cell="cell-a",operation_class="health"}' 2
  wait_scalar_equals \
    'fiducia:sli:external_probe_fresh_location_count{cell="cell-a",operation_class="secret_read"}' 1
}

produce_evidence_summary() {
  FIDUCIA_TEST_PROMETHEUS_URL="$PROMETHEUS_URL" \
  FIDUCIA_TEST_EVIDENCE_OUTPUT=managed-beta/test-fleet-evidence-summary.json \
  FIDUCIA_TEST_CELLS=cell-a \
  FIDUCIA_TEST_OPERATIONS=health,secret_read \
  FIDUCIA_TEST_LOCATIONS=probe-a,probe-b \
  FIDUCIA_TEST_EXPECTED_INTERVAL_SECONDS=60 \
  FIDUCIA_TEST_WINDOW_DAYS=28 \
  FIDUCIA_TEST_MINIMUM_COVERAGE_RATIO=0.95 \
  FIDUCIA_TEST_MAX_FRESHNESS_SECONDS=300 \
  FIDUCIA_TEST_MAX_LAST_SUCCESS_AGE_SECONDS=900 \
    node scripts/assert-managed-beta-test-fleet.mjs

  local summary=managed-beta/test-fleet-evidence-summary.json
  jq -e '.test_fleet_only == true' "$summary"
  jq -e '.production_maturity_effect == "none"' "$summary"
  jq -e '.synthetic_measurement_complete == false' "$summary"
  jq -e '.observations.sample_coverage[0].complete == false' "$summary"
  jq -e '.observations.freshness_violations | length >= 1' "$summary"
  jq -e '.observations.last_success_violations | length >= 1' "$summary"
  jq -e '.observations.duplicate_authorities | length >= 1' "$summary"
  jq -e '.observations.counter_resets | length == 0' "$summary"
  test "$(stat -c '%a' "$summary")" = '600'

  local canary
  canary="$(jq -r '.fixture_canary' managed-beta/source-contract.json)"
  if grep -F "$canary" "$summary"; then
    echo 'test-fleet summary leaked the fixture canary' >&2
    return 1
  fi
  if grep -F "127.0.0.1:${FIXTURE_PORT}" "$summary"; then
    echo 'test-fleet summary leaked the probe endpoint' >&2
    return 1
  fi
}

verify_source_contracts
build_probe_image
start_fixture
generate_probe_state
start_metrics_servers
start_prometheus
prove_initial_state
make_secret_read_stale
produce_evidence_summary
