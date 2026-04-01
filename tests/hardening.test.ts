/**
 * Functional tests for the hardening fixes in issue #1.
 *
 * Each test group maps to one numbered issue:
 *   1. Validator fetch timeout
 *   2. HuggingFace fetch timeout + retry
 *   3. Study CSV escaping
 *   4. No projectRoot in environment descriptor
 *   5. Shared stats module
 *   6. No redundant initializeRunDirectories (covered by reading runner source)
 *   7. Dead variance function removed
 *   8. Shell wrapper uses openssl (covered by reading script source)
 *   9. Shell wrapper exit line removed (covered by reading script source)
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Issue 1: Validator fetch timeout — verify AbortSignal.timeout is present
// ---------------------------------------------------------------------------

test("Issue 1: invokeValidator fetch call includes AbortSignal.timeout", async () => {
  const runnerSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/run/runner.ts"),
    "utf8",
  );
  assert.ok(
    runnerSource.includes("AbortSignal.timeout("),
    "runner.ts must include AbortSignal.timeout on the validator fetch call",
  );
});

// ---------------------------------------------------------------------------
// Issue 2: HuggingFace fetch timeout + retry
// ---------------------------------------------------------------------------

test("Issue 2: huggingface.ts includes retry logic and AbortSignal.timeout", async () => {
  const hfSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/lib/huggingface.ts"),
    "utf8",
  );
  assert.ok(hfSource.includes("MAX_RETRIES"), "huggingface.ts must define MAX_RETRIES");
  assert.ok(hfSource.includes("RETRYABLE_STATUS_CODES"), "huggingface.ts must define RETRYABLE_STATUS_CODES");
  assert.ok(hfSource.includes("AbortSignal.timeout("), "huggingface.ts must include AbortSignal.timeout");
  assert.ok(hfSource.includes("INITIAL_BACKOFF_MS"), "huggingface.ts must define INITIAL_BACKOFF_MS");
});

test("Issue 2: fetchWithRetry retries on 503 then succeeds", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
    callCount++;
    if (callCount <= 2) {
      return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  try {
    // Dynamic import to pick up the patched fetch
    const { fetchDatasetMetadata } = await import("../src/lib/huggingface.js");
    // fetchDatasetMetadata calls fetchJson internally — it will hit our mock
    // We expect it to retry twice (503) and succeed on the third attempt
    // The response won't match the expected shape perfectly, but the point is
    // it doesn't throw a "Failed to fetch" error — it retried and got a 200.
    const result = await fetchDatasetMetadata("test/dataset");
    assert.ok(callCount >= 3, `Expected at least 3 fetch calls, got ${callCount}`);
    assert.ok(result, "Should have returned a result after retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Issue 2: fetchWithRetry does not retry on 404", async () => {
  let callCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
    callCount++;
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  }) as typeof globalThis.fetch;

  try {
    const { fetchDatasetMetadata } = await import("../src/lib/huggingface.js");
    await assert.rejects(
      () => fetchDatasetMetadata("test/nonexistent"),
      /Failed to fetch.*404/,
    );
    assert.equal(callCount, 1, "Should NOT retry on 404");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Issue 3: Study CSV escaping
// ---------------------------------------------------------------------------

test("Issue 3: study.ts toSummaryCsv uses csvEscape", async () => {
  const studySource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/cli/study.ts"),
    "utf8",
  );

  // The toSummaryCsv function body must use csvEscape, not raw String()
  const toSummaryCsvMatch = studySource.match(/function toSummaryCsv[\s\S]*?^}/m);
  assert.ok(toSummaryCsvMatch, "toSummaryCsv function must exist");
  const fnBody = toSummaryCsvMatch[0];
  assert.ok(fnBody.includes("csvEscape("), "toSummaryCsv must use csvEscape for field values");
  assert.ok(!fnBody.match(/\bString\(/), "toSummaryCsv must not use raw String() for field values");
});

test("Issue 3: csvEscape handles comma in seed name", async () => {
  const { csvEscape } = await import("../src/lib/io.js");
  assert.equal(csvEscape("seed,with,commas"), '"seed,with,commas"');
  assert.equal(csvEscape("clean-seed"), "clean-seed");
  assert.equal(csvEscape('has"quotes'), '"has""quotes"');
});

// ---------------------------------------------------------------------------
// Issue 4: No projectRoot in environment descriptor
// ---------------------------------------------------------------------------

test("Issue 4: describeEnvironment does not include projectRoot", async () => {
  const { describeEnvironment } = await import("../src/lib/config.js");
  const env = describeEnvironment("test-seed", "abc123");
  assert.ok(!("projectRoot" in env), "describeEnvironment must not include projectRoot");
  assert.equal(env.benchmarkSeed, "test-seed");
  assert.equal(env.benchmarkGitSha, "abc123");
  assert.equal(env.nodeVersion, process.version);
  assert.equal(env.platform, process.platform);
  assert.equal(env.arch, process.arch);
});

test("Issue 4: BenchmarkEnvironment type does not declare projectRoot", async () => {
  const typesSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/types.ts"),
    "utf8",
  );
  const envBlock = typesSource.match(/interface BenchmarkEnvironment[\s\S]*?}/);
  assert.ok(envBlock, "BenchmarkEnvironment interface must exist");
  assert.ok(!envBlock[0].includes("projectRoot"), "BenchmarkEnvironment must not declare projectRoot");
});

// ---------------------------------------------------------------------------
// Issue 5: Shared stats module
// ---------------------------------------------------------------------------

test("Issue 5: stats module exports mean and sampleStandardDeviation", async () => {
  const { mean, sampleStandardDeviation } = await import("../src/lib/stats.js");
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(mean([10]), 10);
  assert.ok(Number.isNaN(sampleStandardDeviation([5])), "stddev of single value should be NaN");
  // stddev of [2, 4, 4, 4, 5, 5, 7, 9] = 2.0
  const values = [2, 4, 4, 4, 5, 5, 7, 9];
  const sd = sampleStandardDeviation(values);
  assert.ok(Math.abs(sd - 2.1380899352993947) < 1e-10, `Expected ~2.138, got ${sd}`);
});

test("Issue 5: study.ts imports from shared stats module", async () => {
  const studySource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/cli/study.ts"),
    "utf8",
  );
  assert.ok(
    studySource.includes('from "../lib/stats.js"'),
    "study.ts must import from ../lib/stats.js",
  );
  // Must NOT have local mean/sampleStandardDeviation definitions
  assert.ok(
    !studySource.match(/^function mean\(/m),
    "study.ts must not define its own mean function",
  );
  assert.ok(
    !studySource.match(/^function sampleStandardDeviation\(/m),
    "study.ts must not define its own sampleStandardDeviation function",
  );
});

test("Issue 5: metrics.ts imports mean from shared stats module", async () => {
  const metricsSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/analyze/metrics.ts"),
    "utf8",
  );
  assert.ok(
    metricsSource.includes('from "../lib/stats.js"'),
    "metrics.ts must import from ../lib/stats.js",
  );
  assert.ok(
    !metricsSource.match(/^function mean\(/m),
    "metrics.ts must not define its own mean function",
  );
});

test("Issue 5: metrics.ts bootstrap uses createSeededRng from random module", async () => {
  const metricsSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/analyze/metrics.ts"),
    "utf8",
  );
  assert.ok(
    metricsSource.includes('from "../lib/random.js"'),
    "metrics.ts must import createSeededRng from ../lib/random.js",
  );
  // The old inline RNG used charCodeAt — that must be gone
  assert.ok(
    !metricsSource.includes("charCodeAt"),
    "metrics.ts must not contain the old inline RNG (charCodeAt)",
  );
});

// ---------------------------------------------------------------------------
// Issue 6: No redundant initializeRunDirectories on resume path
// ---------------------------------------------------------------------------

test("Issue 6: resume path does not call initializeRunDirectories before the main loop", async () => {
  const runnerSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/run/runner.ts"),
    "utf8",
  );
  // Find the resume branch: from "if (config.resume)" to "} else {"
  const resumeMatch = runnerSource.match(/if \(config\.resume\) \{([\s\S]*?)\} else \{/);
  assert.ok(resumeMatch, "Must find the resume branch in runner.ts");
  const resumeBody = resumeMatch[1];
  assert.ok(
    !resumeBody.includes("initializeRunDirectories"),
    "Resume branch must not call initializeRunDirectories (the main loop call handles it)",
  );
});

// ---------------------------------------------------------------------------
// Issue 7: Dead variance function removed
// ---------------------------------------------------------------------------

test("Issue 7: metrics.ts does not define an unused variance function", async () => {
  const metricsSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../src/analyze/metrics.ts"),
    "utf8",
  );
  assert.ok(
    !metricsSource.match(/^function variance\(/m),
    "metrics.ts must not define a standalone variance function",
  );
});

// ---------------------------------------------------------------------------
// Issue 8: Shell wrapper uses openssl instead of python3
// ---------------------------------------------------------------------------

test("Issue 8: run-study.sh uses openssl rand instead of python3 for random suffix", async () => {
  const shellSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../scripts/run-study.sh"),
    "utf8",
  );
  assert.ok(shellSource.includes("openssl rand -hex 4"), "Shell script must use openssl rand -hex 4");
  assert.ok(!shellSource.includes("python3"), "Shell script must not reference python3");
  assert.ok(!shellSource.includes("secrets.token_hex"), "Shell script must not use Python secrets module");
});

// ---------------------------------------------------------------------------
// Issue 9: Shell wrapper exit code propagation cleaned up
// ---------------------------------------------------------------------------

test("Issue 9: run-study.sh foreground path does not have unreachable PIPESTATUS exit", async () => {
  const shellSource = await fs.readFile(
    path.resolve(fileURLToPath(import.meta.url), "../../scripts/run-study.sh"),
    "utf8",
  );
  assert.ok(
    !shellSource.includes("exit ${PIPESTATUS[0]}"),
    "Shell script must not contain the unreachable exit ${PIPESTATUS[0]}",
  );
});

// ---------------------------------------------------------------------------
// Issue 5 (functional): buildAggregateStudySummary still works after refactor
// ---------------------------------------------------------------------------

test("Issue 5 (functional): buildAggregateStudySummary produces correct aggregate after stats refactor", async () => {
  const { buildAggregateStudySummary } = await import("../src/cli/study.js");

  const manifest = {
    schemaVersion: "1.0.0" as const,
    studyId: "test-study",
    mode: "full" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    resumeSupported: true as const,
    validator: { url: "http://localhost:3000", gitSha: "sha" },
    plan: { seeds: ["s1", "s2"], count: 2, seedPrefix: "s" },
    completedSeeds: ["s1", "s2"],
    seedRuns: [],
  };

  const rows = [
    {
      seed: "s1", runId: "r1", mode: "full" as const,
      validator: { url: "http://localhost:3000", gitSha: "sha", parserSupported: true },
      counts: { total: 10, completed: 10, benchmarkOutcomes: 9, transportFailures: 1, validatorSystemFailures: 0 },
      metrics: { fallacyStrictPairAccuracy: 0.8, fallacyEvaluatedPairs: 5, fallacyStrictPairSuccesses: 4, ibmSpearman: 0.5, ibmEvaluatedScenarios: 5 },
      archivedPaths: { runManifest: "/a", metrics: "/b", summaryCsv: "/c", pairBreakdownCsv: "/d", rawDir: "/e", scenariosDir: "/f" },
    },
    {
      seed: "s2", runId: "r2", mode: "full" as const,
      validator: { url: "http://localhost:3000", gitSha: "sha", parserSupported: true },
      counts: { total: 10, completed: 10, benchmarkOutcomes: 10, transportFailures: 0, validatorSystemFailures: 0 },
      metrics: { fallacyStrictPairAccuracy: 0.6, fallacyEvaluatedPairs: 5, fallacyStrictPairSuccesses: 3, ibmSpearman: 0.3, ibmEvaluatedScenarios: 5 },
      archivedPaths: { runManifest: "/a", metrics: "/b", summaryCsv: "/c", pairBreakdownCsv: "/d", rawDir: "/e", scenariosDir: "/f" },
    },
  ];

  const summary = buildAggregateStudySummary(manifest, rows);

  assert.equal(summary.aggregate.fallacyStrictPairAccuracy.mean, 0.7);
  assert.equal(summary.aggregate.ibmSpearman.mean, 0.4);
  assert.equal(summary.aggregate.totals.completed, 20);
  assert.equal(summary.aggregate.totals.transportFailures, 1);
  // Verify stddev is computed (not NaN for 2 values)
  assert.ok(Number.isFinite(summary.aggregate.fallacyStrictPairAccuracy.sampleStdDev));
});
