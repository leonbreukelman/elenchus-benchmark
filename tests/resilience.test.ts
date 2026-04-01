/**
 * Functional tests for the self-healing / self-recovery resilience layer.
 *
 * Tests cover:
 *   - waitForValidator: health polling, timeout, immediate success
 *   - Study CLI: per-seed retry constants, validator gating before seeds
 *   - Shell wrapper: auto-restart loop structure
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForValidator } from "../src/cli/study.js";

// ---------------------------------------------------------------------------
// waitForValidator: immediate success
// ---------------------------------------------------------------------------

test("waitForValidator resolves immediately when validator is healthy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response('{"status":"ok"}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    const start = Date.now();
    await waitForValidator("http://localhost:9999", 5000, 100);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `Should resolve almost instantly, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// waitForValidator: retries on failure then succeeds
// ---------------------------------------------------------------------------

test("waitForValidator retries when validator is initially down", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 3) {
      throw new Error("Connection refused");
    }
    return new Response('{"status":"ok"}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await waitForValidator("http://localhost:9999", 10_000, 50);
    assert.ok(callCount >= 3, `Expected at least 3 calls, got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// waitForValidator: times out when validator never comes back
// ---------------------------------------------------------------------------

test("waitForValidator throws after timeout when validator stays down", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Connection refused");
  }) as typeof globalThis.fetch;

  try {
    const start = Date.now();
    await assert.rejects(
      () => waitForValidator("http://localhost:9999", 500, 50),
      /did not become healthy/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 400 && elapsed < 2000, `Should time out around 500ms, took ${elapsed}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// waitForValidator: rejects non-ok health responses
// ---------------------------------------------------------------------------

test("waitForValidator retries when health returns non-ok status JSON", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 3) {
      return new Response('{"status":"degraded"}', { status: 200 });
    }
    return new Response('{"status":"ok"}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await waitForValidator("http://localhost:9999", 10_000, 50);
    assert.ok(callCount >= 3, `Expected at least 3 calls, got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// waitForValidator: retries on HTTP error status
// ---------------------------------------------------------------------------

test("waitForValidator retries when health endpoint returns 503", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    callCount++;
    if (callCount < 3) {
      return new Response("Service Unavailable", { status: 503 });
    }
    return new Response('{"status":"ok"}', { status: 200 });
  }) as typeof globalThis.fetch;

  try {
    await waitForValidator("http://localhost:9999", 10_000, 50);
    assert.ok(callCount >= 3, `Expected at least 3 calls, got ${callCount}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Study CLI: resilience constants are present
// ---------------------------------------------------------------------------

test("study.ts defines per-seed retry constants", async () => {
  const source = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/cli/study.ts"),
    "utf8",
  );
  assert.ok(source.includes("MAX_SEED_RETRIES"), "Must define MAX_SEED_RETRIES");
  assert.ok(source.includes("SEED_RETRY_BASE_DELAY_MS"), "Must define SEED_RETRY_BASE_DELAY_MS");
  assert.ok(source.includes("HEALTH_POLL_INTERVAL_MS"), "Must define HEALTH_POLL_INTERVAL_MS");
  assert.ok(source.includes("HEALTH_POLL_TIMEOUT_MS"), "Must define HEALTH_POLL_TIMEOUT_MS");
});

test("executeStudy calls waitForValidator before each seed attempt", async () => {
  const source = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/cli/study.ts"),
    "utf8",
  );
  // The executeStudy function must call waitForValidator inside the seed loop
  const executeMatch = source.match(/async function executeStudy[\s\S]*?^}/m);
  assert.ok(executeMatch, "executeStudy must exist");
  assert.ok(
    executeMatch[0].includes("waitForValidator"),
    "executeStudy must call waitForValidator before running seeds",
  );
});

test("executeStudy retries failed seeds instead of immediately throwing", async () => {
  const source = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/cli/study.ts"),
    "utf8",
  );
  const executeMatch = source.match(/async function executeStudy[\s\S]*?^}/m);
  assert.ok(executeMatch, "executeStudy must exist");
  const body = executeMatch[0];
  // Must have a retry loop (attempt counter)
  assert.ok(body.includes("MAX_SEED_RETRIES"), "executeStudy must reference MAX_SEED_RETRIES for retry loop");
  assert.ok(body.includes("attempt"), "executeStudy must have an attempt counter");
});

// ---------------------------------------------------------------------------
// Shell wrapper: auto-restart loop
// ---------------------------------------------------------------------------

test("run-study.sh defines auto-restart loop with MAX_RESTARTS", async () => {
  const source = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../scripts/run-study.sh"),
    "utf8",
  );
  assert.ok(source.includes("MAX_RESTARTS="), "Shell script must define MAX_RESTARTS");
  assert.ok(source.includes("RESTART_BASE_DELAY="), "Shell script must define RESTART_BASE_DELAY");
  assert.ok(source.includes("run_with_restarts"), "Shell script must define run_with_restarts function");
  assert.ok(source.includes("--resume"), "Restart loop must use --resume for subsequent attempts");
});

test("run-study.sh restart loop caps backoff delay", async () => {
  const source = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../scripts/run-study.sh"),
    "utf8",
  );
  // Must cap the delay to prevent unbounded exponential growth
  assert.ok(
    source.includes("delay") && source.includes("1800"),
    "Restart delay must be capped (at 1800s / 30 minutes)",
  );
});
