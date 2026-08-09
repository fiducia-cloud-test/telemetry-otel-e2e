#!/usr/bin/env node

// Synthetic test-org checker for the integrated managed-beta probe and
// Prometheus rules. This is intentionally not the production evidence exporter:
// one GitHub Actions runner cannot prove physical failure independence or a
// completed 28-day observation window.

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_PROMETHEUS_URL = "http://127.0.0.1:19090";
const APPROVED_VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALLOWED_LABELS = new Set([
  "__name__",
  "cell",
  "operation_class",
  "probe_location",
  "result",
]);

const QUERIES = Object.freeze({
  availabilitySamples: "fiducia:sli:public_availability_samples:28d",
  freshness: "fiducia:sli:external_probe_freshness_seconds",
  lastSuccess: "fiducia:sli:external_probe_last_success_age_seconds",
  freshLocationCount: "fiducia:sli:external_probe_fresh_location_count",
  historicalLocationCount: "fiducia:sli:external_probe_location_count",
  authorityCount:
    "count by (cell, operation_class, probe_location, result) (fiducia_external_probe_total)",
  counterResets:
    "sum by (cell, operation_class, probe_location, result) (resets(fiducia_external_probe_total[28d]))",
});

function required(name, value) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function boundedList(name, value) {
  const values = required(name, value)
    .split(",")
    .map((item) => item.trim().toLowerCase());
  if (values.length === 0 || values.length > 16) {
    throw new Error(`${name} must contain 1..16 values`);
  }
  for (const item of values) {
    if (!APPROVED_VALUE.test(item)) {
      throw new Error(`${name} contains an unbounded value`);
    }
  }
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length) throw new Error(`${name} contains duplicates`);
  return unique;
}

function boundedNumber(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be within ${minimum}..${maximum}`);
  }
  return parsed;
}

async function queryVector(baseUrl, expression) {
  const url = new URL("/api/v1/query", baseUrl);
  url.searchParams.set("query", expression);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Prometheus query failed with ${response.status}`);
  const payload = await response.json();
  if (payload?.status !== "success" || payload?.data?.resultType !== "vector") {
    throw new Error("Prometheus returned a non-vector response");
  }
  if (!Array.isArray(payload.data.result) || payload.data.result.length > 256) {
    throw new Error("Prometheus returned an unsafe series count");
  }
  return payload.data.result.map((sample) => {
    for (const label of Object.keys(sample.metric ?? {})) {
      if (!ALLOWED_LABELS.has(label)) {
        throw new Error(`unexpected Prometheus label ${label}`);
      }
    }
    const labels = {};
    for (const [name, raw] of Object.entries(sample.metric ?? {})) {
      if (name === "__name__") continue;
      if (!APPROVED_VALUE.test(raw)) {
        throw new Error(`unbounded Prometheus label ${name}`);
      }
      labels[name] = raw;
    }
    const value = Number(sample.value?.[1]);
    if (!Number.isFinite(value)) throw new Error("non-finite Prometheus sample");
    return { labels, value };
  });
}

function key(labels, dimensions) {
  return dimensions.map((dimension) => `${dimension}=${labels[dimension]}`).join("|");
}

function matrix(samples, dimensions) {
  return Object.fromEntries(
    samples
      .map((sample) => [key(sample.labels, dimensions), sample.value])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function main() {
  const prometheusUrl = new URL(
    process.env.FIDUCIA_TEST_PROMETHEUS_URL ?? DEFAULT_PROMETHEUS_URL,
  );
  if (
    prometheusUrl.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(prometheusUrl.hostname)
  ) {
    throw new Error("test-fleet Prometheus must be bounded localhost HTTP");
  }
  const output = resolve(required("output", process.env.FIDUCIA_TEST_EVIDENCE_OUTPUT));
  const cells = boundedList("cells", process.env.FIDUCIA_TEST_CELLS ?? "cell-a");
  const operations = boundedList(
    "operations",
    process.env.FIDUCIA_TEST_OPERATIONS ?? "health,secret_read",
  );
  const locations = boundedList(
    "locations",
    process.env.FIDUCIA_TEST_LOCATIONS ?? "probe-a,probe-b",
  );
  const expectedIntervalSeconds = boundedNumber(
    "expected interval",
    process.env.FIDUCIA_TEST_EXPECTED_INTERVAL_SECONDS ?? "60",
    10,
    3_600,
  );
  const windowDays = boundedNumber(
    "window days",
    process.env.FIDUCIA_TEST_WINDOW_DAYS ?? "28",
    28,
    35,
  );
  const minimumCoverageRatio = boundedNumber(
    "minimum coverage ratio",
    process.env.FIDUCIA_TEST_MINIMUM_COVERAGE_RATIO ?? "0.95",
    0.5,
    1,
  );
  const maxFreshnessSeconds = boundedNumber(
    "maximum freshness",
    process.env.FIDUCIA_TEST_MAX_FRESHNESS_SECONDS ?? "300",
    expectedIntervalSeconds,
    3_600,
  );
  const maxLastSuccessAgeSeconds = boundedNumber(
    "maximum last-success age",
    process.env.FIDUCIA_TEST_MAX_LAST_SUCCESS_AGE_SECONDS ?? "900",
    maxFreshnessSeconds,
    86_400,
  );

  const entries = await Promise.all(
    Object.entries(QUERIES).map(async ([id, expression]) => [
      id,
      await queryVector(prometheusUrl, expression),
    ]),
  );
  const results = Object.fromEntries(entries);

  const expectedObservationsPerCell = Math.floor(
    ((windowDays * 24 * 60 * 60) / expectedIntervalSeconds) *
      locations.length *
      operations.length,
  );
  const minimumSamplesPerCell = Math.floor(
    expectedObservationsPerCell * minimumCoverageRatio,
  );

  const sampleByCell = matrix(results.availabilitySamples, ["cell"]);
  const sampleCoverage = cells.map((cell) => ({
    cell,
    observed_samples: sampleByCell[`cell=${cell}`] ?? 0,
    minimum_required_samples: minimumSamplesPerCell,
    complete: (sampleByCell[`cell=${cell}`] ?? 0) >= minimumSamplesPerCell,
  }));

  const freshnessViolations = results.freshness.filter(
    (sample) => sample.value > maxFreshnessSeconds,
  );
  const lastSuccessViolations = results.lastSuccess.filter(
    (sample) => sample.value > maxLastSuccessAgeSeconds,
  );
  const duplicateAuthorities = results.authorityCount.filter(
    (sample) => sample.value !== 1,
  );
  const counterResets = results.counterResets.filter((sample) => sample.value !== 0);

  const expectedSourceKeys = cells.flatMap((cell) =>
    operations.flatMap((operation) =>
      locations.map(
        (location) =>
          `cell=${cell}|operation_class=${operation}|probe_location=${location}`,
      ),
    ),
  );
  const observedSourceKeys = new Set(
    results.freshness.map((sample) =>
      key(sample.labels, ["cell", "operation_class", "probe_location"]),
    ),
  );
  const missingSources = expectedSourceKeys.filter(
    (sourceKey) => !observedSourceKeys.has(sourceKey),
  );

  const freshCounts = matrix(results.freshLocationCount, ["cell", "operation_class"]);
  const historicalCounts = matrix(
    results.historicalLocationCount,
    ["cell", "operation_class"],
  );

  const measurementComplete =
    sampleCoverage.every((entry) => entry.complete) &&
    freshnessViolations.length === 0 &&
    lastSuccessViolations.length === 0 &&
    duplicateAuthorities.length === 0 &&
    counterResets.length === 0 &&
    missingSources.length === 0;

  const summary = {
    schema_version: 1,
    evidence_type: "fiducia_test_fleet_managed_beta_observability",
    test_fleet_only: true,
    production_maturity_effect: "none",
    production_exporter_reference: {
      commit: "c9e8f32aa6b55d33116d867c952fad19fcafa741",
      blob: "5c17e3fe8817c9331e594c99300abee8c286fcfb",
      loaded_by_test_fleet: false,
      reason:
        "private production repository remains inaccessible to the test-org Actions token",
    },
    policy: {
      cells,
      operation_classes: operations,
      declared_probe_locations: locations,
      expected_interval_seconds: expectedIntervalSeconds,
      window_days: windowDays,
      minimum_coverage_ratio: minimumCoverageRatio,
      expected_observations_per_cell: expectedObservationsPerCell,
      minimum_samples_per_cell: minimumSamplesPerCell,
      maximum_freshness_seconds: maxFreshnessSeconds,
      maximum_last_success_age_seconds: maxLastSuccessAgeSeconds,
    },
    observations: {
      sample_coverage: sampleCoverage,
      missing_sources: missingSources,
      freshness_violations: freshnessViolations,
      last_success_violations: lastSuccessViolations,
      duplicate_authorities: duplicateAuthorities,
      counter_resets: counterResets,
      fresh_location_count: freshCounts,
      historical_location_count: historicalCounts,
    },
    synthetic_measurement_complete: measurementComplete,
    expected_test_outcome:
      "incomplete because history is short, one operation-specific source is stale, and duplicate authority is injected",
    limitations: [
      "Both synthetic locations share one GitHub Actions host, scheduler, network, and physical failure domain.",
      "This summary is not the production exporter output and cannot promote DEN-1619 maturity.",
      "No production customer identity, endpoint credential, request ID, trace ID, or response content is included.",
    ],
  };

  if (summary.synthetic_measurement_complete) {
    throw new Error("synthetic destructive fixture unexpectedly passed measurement completeness");
  }
  if (!sampleCoverage.every((entry) => !entry.complete)) {
    throw new Error("short-history fixture did not fail observation coverage");
  }
  if (freshnessViolations.length === 0 || lastSuccessViolations.length === 0) {
    throw new Error("stale source fixture did not produce freshness violations");
  }
  if (duplicateAuthorities.length === 0) {
    throw new Error("duplicate scrape authority fixture was not detected");
  }
  if (counterResets.length !== 0) {
    throw new Error("fresh synthetic state unexpectedly reset a counter");
  }
  if (freshCounts["cell=cell-a|operation_class=health"] !== 2) {
    throw new Error("health should retain two fresh locations");
  }
  if (freshCounts["cell=cell-a|operation_class=secret_read"] !== 1) {
    throw new Error("secret_read should expose the deliberately stale location");
  }

  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`test-fleet evidence summary written to ${output}\n`);
}

main().catch((error) => {
  process.stderr.write(`managed-beta test-fleet assertion failed: ${error.message}\n`);
  process.exitCode = 1;
});
