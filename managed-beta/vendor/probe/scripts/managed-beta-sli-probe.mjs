#!/usr/bin/env node

// DEN-1404: failure-independent external probe producer for SLO-AVAIL-01.
//
// The probe intentionally emits only bounded, low-cardinality labels. Endpoint,
// path, organization, project, environment, key, credential, request ID, trace
// ID, response body, and error text never become metric labels or values.
//
// Prometheus counters must be cumulative across one-shot executions. A bounded
// local JSON state file is therefore mandatory. It is protected by an exclusive
// non-polling lock and replaced atomically before the textfile collector output.

import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const THIS_FILE = fileURLToPath(import.meta.url);
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(THIS_FILE);
const STATE_SCHEMA_VERSION = 1;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER - 1;

export const OPERATION_CLASSES = new Set([
  "health",
  "linearizable_read",
  "committed_write",
  "renewal",
  "secret_read",
  "watch_reconcile",
]);

const LABEL_VALUE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function required(name, value) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function parseStrictInteger(name, value, minimum, maximum) {
  const normalized = required(name, String(value));
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer within ${minimum}..${maximum}`);
  }
  return parsed;
}

export function validateBoundedLabel(name, value, allowed = null) {
  const normalized = required(name, value).toLowerCase();
  if (!LABEL_VALUE.test(normalized)) {
    throw new Error(
      `${name} must match ${LABEL_VALUE} and remain a bounded deployment label`,
    );
  }
  if (allowed && !allowed.has(normalized)) {
    throw new Error(`${name} is outside the approved bounded set`);
  }
  return normalized;
}

export function parseExpectedStatuses(value) {
  if (!value?.trim()) return new Set(Array.from({ length: 100 }, (_, i) => 200 + i));
  const statuses = new Set();
  for (const token of value.split(",")) {
    const normalized = token.trim();
    if (!/^\d{3}$/u.test(normalized)) {
      throw new Error("expected statuses must be comma-separated HTTP status integers");
    }
    const status = Number(normalized);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("expected statuses must be comma-separated HTTP status integers");
    }
    statuses.add(status);
  }
  if (statuses.size === 0) throw new Error("at least one expected status is required");
  return statuses;
}

export function normalizeExpectedStatuses(value) {
  if (!(value instanceof Set)) return parseExpectedStatuses(value);
  if (value.size === 0) throw new Error("at least one expected status is required");
  const statuses = new Set();
  for (const status of value) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("expected statuses must contain only HTTP status integers");
    }
    statuses.add(status);
  }
  return statuses;
}

function escapeLabel(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function initialState(cell, operationClass) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    cell,
    operationClass,
    successTotal: 0,
    failureTotal: 0,
    lastResult: "failure",
    lastDurationSeconds: 0,
    lastRunUnixtime: 0,
    lastSuccessUnixtime: 0,
  };
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTER;
}

export function validateState(state, cell, operationClass) {
  if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error("probe state has an unsupported schema version");
  }
  if (state.cell !== cell || state.operationClass !== operationClass) {
    throw new Error("probe state identity does not match the configured cell/operation");
  }
  if (!validCounter(state.successTotal) || !validCounter(state.failureTotal)) {
    throw new Error("probe state contains an invalid cumulative counter");
  }
  if (!["success", "failure"].includes(state.lastResult)) {
    throw new Error("probe state contains an invalid last result");
  }
  for (const field of ["lastRunUnixtime", "lastSuccessUnixtime"]) {
    if (!Number.isSafeInteger(state[field]) || state[field] < 0) {
      throw new Error(`probe state contains an invalid ${field}`);
    }
  }
  if (!Number.isFinite(state.lastDurationSeconds) || state.lastDurationSeconds < 0) {
    throw new Error("probe state contains an invalid last duration");
  }
  if (state.lastSuccessUnixtime > state.lastRunUnixtime) {
    throw new Error("probe state last success cannot be newer than last run");
  }
  return state;
}

export async function readProbeState(path, cell, operationClass) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return validateState(parsed, cell, operationClass);
  } catch (error) {
    if (error?.code === "ENOENT") return initialState(cell, operationClass);
    if (error instanceof SyntaxError) throw new Error("probe state is not valid JSON");
    throw error;
  }
}

export function recordSample(state, sample) {
  validateState(state, sample.cell, sample.operationClass);
  const next = { ...state };
  const field = sample.result === "success" ? "successTotal" : "failureTotal";
  if (next[field] >= MAX_COUNTER) {
    throw new Error("probe cumulative counter reached its safe-integer limit");
  }
  next[field] += 1;
  next.lastResult = sample.result;
  next.lastDurationSeconds = sample.durationSeconds;
  next.lastRunUnixtime = sample.timestampSeconds;
  if (sample.result === "success") next.lastSuccessUnixtime = sample.timestampSeconds;
  return validateState(next, sample.cell, sample.operationClass);
}

export function renderPrometheus(state) {
  validateState(state, state.cell, state.operationClass);
  const identity = `cell="${escapeLabel(state.cell)}",operation_class="${escapeLabel(
    state.operationClass,
  )}"`;
  const lastLabels = `${identity},result="${state.lastResult}"`;
  return [
    "# HELP fiducia_external_probe_total Cumulative managed-beta external probes by bounded result.",
    "# TYPE fiducia_external_probe_total counter",
    `fiducia_external_probe_total{${identity},result="success"} ${state.successTotal}`,
    `fiducia_external_probe_total{${identity},result="failure"} ${state.failureTotal}`,
    "# HELP fiducia_external_probe_duration_seconds Duration of the most recently completed probe without customer identifiers.",
    "# TYPE fiducia_external_probe_duration_seconds gauge",
    `fiducia_external_probe_duration_seconds{${lastLabels}} ${state.lastDurationSeconds.toFixed(6)}`,
    "# HELP fiducia_external_probe_last_run_unixtime Unix time of the most recent completed probe execution.",
    "# TYPE fiducia_external_probe_last_run_unixtime gauge",
    `fiducia_external_probe_last_run_unixtime{${identity}} ${state.lastRunUnixtime}`,
    "# HELP fiducia_external_probe_last_success_unixtime Unix time of the most recent successful probe; zero until first success.",
    "# TYPE fiducia_external_probe_last_success_unixtime gauge",
    `fiducia_external_probe_last_success_unixtime{${identity}} ${state.lastSuccessUnixtime}`,
    "",
  ].join("\n");
}

async function readBearerToken(path) {
  if (!path) return null;
  const value = (await readFile(path, "utf8")).trim();
  if (!value || value.length > 8192 || /[\r\n\0]/u.test(value)) {
    throw new Error("bearer token file must contain one bounded non-empty line");
  }
  return value;
}

async function consumeBoundedBody(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let seen = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) return;
      seen += value.byteLength;
      if (seen > MAX_RESPONSE_BYTES) {
        await reader.cancel("bounded external probe response limit exceeded");
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runProbe(options) {
  const endpoint = new URL(required("endpoint", options.endpoint));
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("endpoint must use HTTP or HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("endpoint must not contain userinfo or a fragment");
  }

  const cell = validateBoundedLabel("cell", options.cell);
  const operationClass = validateBoundedLabel(
    "operationClass",
    options.operationClass,
    OPERATION_CLASSES,
  );
  const method = required("method", options.method ?? "GET").toUpperCase();
  if (!METHODS.has(method)) throw new Error("method is outside the approved set");
  const timeoutMs = parseStrictInteger(
    "timeoutMs",
    options.timeoutMs ?? 5_000,
    100,
    MAX_TIMEOUT_MS,
  );
  const expectedStatuses = normalizeExpectedStatuses(options.expectedStatuses);
  const bearer = await readBearerToken(options.bearerFile);

  const headers = new Headers(options.headers ?? {});
  headers.set("accept", "application/json");
  headers.set("user-agent", "fiducia-managed-beta-sli-probe/1");
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);

  const started = performance.now();
  let result = "failure";
  let status = null;
  try {
    const response = await fetch(endpoint, {
      method,
      headers,
      body: options.body ?? undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    await consumeBoundedBody(response);
    result = expectedStatuses.has(status) ? "success" : "failure";
  } catch {
    // Transport errors are deliberately reduced to a bounded result. Error
    // strings can contain endpoints, certificates, credentials, and paths.
    result = "failure";
  }

  return {
    cell,
    operationClass,
    result,
    status,
    durationSeconds: Math.max(0, performance.now() - started) / 1000,
    timestampSeconds: Math.floor(Date.now() / 1000),
  };
}

export async function atomicWrite(path, content) {
  const target = resolve(path);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}

export async function withExclusiveLock(path, fn) {
  const lockPath = resolve(path);
  let handle;
  try {
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("probe state lock is already held; overlapping runs fail closed");
      }
      throw error;
    }
    await handle.writeFile(`${process.pid}\n${Math.floor(Date.now() / 1000)}\n`);
    return await fn();
  } finally {
    if (handle) {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
}

export async function runAndPersist(options) {
  const stateFile = resolve(required("stateFile", options.stateFile));
  return withExclusiveLock(`${stateFile}.lock`, async () => {
    const cell = validateBoundedLabel("cell", options.cell);
    const operationClass = validateBoundedLabel(
      "operationClass",
      options.operationClass,
      OPERATION_CLASSES,
    );
    // Validate cumulative authority before issuing any external operation. A
    // corrupt or mismatched state must not permit an unrecorded read, renewal,
    // or mutation and then fail only after the request has completed.
    const prior = await readProbeState(stateFile, cell, operationClass);
    const sample = await runProbe({ ...options, cell, operationClass });
    const state = recordSample(prior, sample);
    // Persist the cumulative authority first. If the process crashes before the
    // textfile rename, the next run re-renders the complete cumulative state.
    await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    const metrics = renderPrometheus(state);
    if (options.textfile) await atomicWrite(options.textfile, metrics);
    return { sample, state, metrics };
  });
}

async function main() {
  const result = await runAndPersist({
    endpoint: process.env.FIDUCIA_PROBE_ENDPOINT,
    cell: process.env.FIDUCIA_PROBE_CELL,
    operationClass: process.env.FIDUCIA_PROBE_OPERATION_CLASS ?? "health",
    method: process.env.FIDUCIA_PROBE_METHOD ?? "GET",
    timeoutMs: process.env.FIDUCIA_PROBE_TIMEOUT_MS ?? "5000",
    expectedStatuses: process.env.FIDUCIA_PROBE_EXPECT_STATUS,
    bearerFile: process.env.FIDUCIA_PROBE_BEARER_FILE,
    stateFile: process.env.FIDUCIA_PROBE_STATE_FILE,
    textfile: process.env.FIDUCIA_PROBE_TEXTFILE,
  });
  if (!result.metrics || !process.env.FIDUCIA_PROBE_TEXTFILE) {
    process.stdout.write(result.metrics);
  }
  process.exitCode = result.sample.result === "success" ? 0 : 1;
}

if (IS_CLI) {
  main().catch((error) => {
    // Configuration/state errors contain only field policy, never HTTP response
    // content. State and lock paths are intentionally not repeated here.
    process.stderr.write(`managed-beta SLI probe failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
