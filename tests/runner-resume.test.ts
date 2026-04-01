/**
 * Tests for resume-path manifest reconciliation in runner.ts.
 *
 * These tests exercise the divergence case where the checkpoint is ahead of the
 * run manifest (interrupt after writeCheckpoint but before writeRunManifest) and
 * verify that reconcileManifestFromCheckpoint closes the gap correctly and
 * surfaces corruption rather than silently ignoring it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { reconcileManifestFromCheckpoint } from "../src/run/runner.js";
import type { RunCheckpoint, RunManifest, RunResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TMP_ROOT = path.join(import.meta.dirname, ".tmp");

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = path.join(TEST_TMP_ROOT, crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: "1.0.0",
    runId: "run-1",
    mode: "pilot",
    startedAt: "2026-03-31T00:00:00.000Z",
    resumed: true,
    scenarioManifestPath: "/scenarios/manifest.json",
    scenarioManifestPreparedAt: "2026-03-31T00:00:00.000Z",
    scenarioIds: ["a", "b", "c"],
    resultPaths: {},
    validator: { url: "http://localhost:3000", gitSha: "abc123", parserSupported: true },
    environment: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64", benchmarkSeed: "seed" },
    counts: { total: 3, completed: 0, transportFailures: 0, validatorSystemFailures: 0, benchmarkOutcomes: 0 },
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<RunCheckpoint> = {}): RunCheckpoint {
  return {
    schemaVersion: "1.0.0",
    runId: "run-1",
    mode: "pilot",
    scenarioManifestPath: "/scenarios/manifest.json",
    scenarioManifestPreparedAt: "2026-03-31T00:00:00.000Z",
    scenarioIds: ["a", "b", "c"],
    resultPaths: {},
    completedScenarioIds: [],
    validator: { url: "http://localhost:3000", gitSha: "abc123", parserSupported: true },
    environment: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64", benchmarkSeed: "seed" },
    startedAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:01.000Z",
    ...overrides,
  };
}

function makeResult(
  scenarioId: string,
  outcomeCategory: RunResult["parsed"]["outcomeCategory"] = "benchmark_outcome",
): RunResult {
  return {
    scenarioId,
    source: "ibm-aq",
    evaluationMode: "verdict",
    traceId: scenarioId,
    validator: { url: "http://localhost:3000", gitSha: "abc123" },
    raw: { httpStatus: 200, response: { actionState: "ALLOW", concordanceScore: 0.9, terminalLog: [] } },
    rawTerminalLog: [],
    parsed: {
      latencyMs: 100,
      systemFailure: false,
      outcomeCategory,
      parserSupported: true,
    },
    timestamp: "2026-03-31T00:00:00.000Z",
  };
}

async function writeResult(dir: string, scenarioId: string, result: RunResult): Promise<string> {
  const filePath = path.join(dir, `${scenarioId}.json`);
  await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Tests: no divergence
// ---------------------------------------------------------------------------

test("reconcileManifestFromCheckpoint is a no-op when checkpoint and manifest agree", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "a", makeResult("a"));
    const manifest = makeManifest({ resultPaths: { a: resultPath }, counts: { total: 3, completed: 1, transportFailures: 0, validatorSystemFailures: 0, benchmarkOutcomes: 1 } });
    const checkpoint = makeCheckpoint({ completedScenarioIds: ["a"], resultPaths: { a: resultPath } });

    const countsBefore = { ...manifest.counts };
    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.deepEqual(manifest.counts, countsBefore);
    assert.equal(Object.keys(manifest.resultPaths).length, 1);
  });
});

test("reconcileManifestFromCheckpoint is a no-op when checkpoint is empty", async () => {
  const manifest = makeManifest();
  const checkpoint = makeCheckpoint();

  await reconcileManifestFromCheckpoint(manifest, checkpoint);

  assert.equal(manifest.counts.completed, 0);
  assert.deepEqual(manifest.resultPaths, {});
});

// ---------------------------------------------------------------------------
// Tests: divergence — checkpoint ahead of manifest
// ---------------------------------------------------------------------------

test("reconcileManifestFromCheckpoint adds missing resultPath and increments benchmark_outcome count", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "a", makeResult("a", "benchmark_outcome"));

    // Manifest is stale: scenario "a" is absent (interrupted before writeRunManifest)
    const manifest = makeManifest();
    // Checkpoint has scenario "a" persisted
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.equal(manifest.resultPaths["a"], resultPath);
    assert.equal(manifest.counts.completed, 1);
    assert.equal(manifest.counts.benchmarkOutcomes, 1);
    assert.equal(manifest.counts.transportFailures, 0);
    assert.equal(manifest.counts.validatorSystemFailures, 0);
  });
});

test("reconcileManifestFromCheckpoint handles transport_failure outcome category", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "b", makeResult("b", "transport_failure"));
    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["b"],
      resultPaths: { b: resultPath },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.equal(manifest.counts.completed, 1);
    assert.equal(manifest.counts.transportFailures, 1);
    assert.equal(manifest.counts.benchmarkOutcomes, 0);
  });
});

test("reconcileManifestFromCheckpoint handles validator_system_failure outcome category", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "c", makeResult("c", "validator_system_failure"));
    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["c"],
      resultPaths: { c: resultPath },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.equal(manifest.counts.completed, 1);
    assert.equal(manifest.counts.validatorSystemFailures, 1);
    assert.equal(manifest.counts.benchmarkOutcomes, 0);
  });
});

test("reconcileManifestFromCheckpoint reconciles multiple diverged scenarios", async () => {
  await withTempDir(async (dir) => {
    const pathA = await writeResult(dir, "a", makeResult("a", "benchmark_outcome"));
    const pathB = await writeResult(dir, "b", makeResult("b", "transport_failure"));

    // Manifest has neither; checkpoint has both
    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a", "b"],
      resultPaths: { a: pathA, b: pathB },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.equal(manifest.resultPaths["a"], pathA);
    assert.equal(manifest.resultPaths["b"], pathB);
    assert.equal(manifest.counts.completed, 2);
    assert.equal(manifest.counts.benchmarkOutcomes, 1);
    assert.equal(manifest.counts.transportFailures, 1);
  });
});

test("reconcileManifestFromCheckpoint only reconciles scenarios absent from manifest", async () => {
  await withTempDir(async (dir) => {
    const pathA = await writeResult(dir, "a", makeResult("a", "benchmark_outcome"));
    const pathB = await writeResult(dir, "b", makeResult("b", "benchmark_outcome"));

    // Manifest already has "a" persisted; only "b" is diverged
    const manifest = makeManifest({
      resultPaths: { a: pathA },
      counts: { total: 3, completed: 1, transportFailures: 0, validatorSystemFailures: 0, benchmarkOutcomes: 1 },
    });
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a", "b"],
      resultPaths: { a: pathA, b: pathB },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint);

    assert.equal(Object.keys(manifest.resultPaths).length, 2);
    assert.equal(manifest.counts.completed, 2);
    assert.equal(manifest.counts.benchmarkOutcomes, 2);
  });
});

// ---------------------------------------------------------------------------
// Tests: corruption — explicit errors rather than silent data loss
// ---------------------------------------------------------------------------

test("reconcileManifestFromCheckpoint throws when checkpoint has no resultPath entry for completed scenario", async () => {
  const manifest = makeManifest();
  // completedScenarioIds says "a" is done but resultPaths is missing the entry
  const checkpoint = makeCheckpoint({
    completedScenarioIds: ["a"],
    resultPaths: {},
  });

  await assert.rejects(
    () => reconcileManifestFromCheckpoint(manifest, checkpoint),
    /Resume corruption: checkpoint lists scenario a as completed but checkpoint\.resultPaths has no entry/,
  );
});

test("reconcileManifestFromCheckpoint throws when result file is missing from disk", async () => {
  await withTempDir(async (dir) => {
    const missingPath = path.join(dir, "a.json");
    // Intentionally do NOT write the file
    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: missingPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: checkpoint lists scenario a as completed but result file does not exist/,
    );
  });
});

test("reconcileManifestFromCheckpoint throws when result file contains invalid JSON", async () => {
  await withTempDir(async (dir) => {
    const corruptPath = path.join(dir, "a.json");
    await fs.writeFile(corruptPath, "not valid json", "utf8");

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: corruptPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: failed to read result file for scenario a/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: structural validation — parseable but structurally wrong result files
// ---------------------------------------------------------------------------

test("reconcileManifestFromCheckpoint throws when result file has mismatched scenarioId", async () => {
  await withTempDir(async (dir) => {
    // File contains a result for "b" but the checkpoint maps it to "a"
    const resultPath = path.join(dir, "a.json");
    await fs.writeFile(resultPath, JSON.stringify(makeResult("b", "benchmark_outcome")), "utf8");

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: result file for scenario a has mismatched scenarioId "b"/,
    );
  });
});

test("reconcileManifestFromCheckpoint throws when result file has missing outcomeCategory", async () => {
  await withTempDir(async (dir) => {
    const result = makeResult("a", "benchmark_outcome");
    const corrupt = { ...result, parsed: { ...result.parsed, outcomeCategory: undefined } };
    const resultPath = path.join(dir, "a.json");
    await fs.writeFile(resultPath, JSON.stringify(corrupt), "utf8");

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: result file for scenario a has invalid outcomeCategory/,
    );
  });
});

test("reconcileManifestFromCheckpoint throws when result file has unrecognised outcomeCategory", async () => {
  await withTempDir(async (dir) => {
    const result = makeResult("a", "benchmark_outcome");
    const corrupt = { ...result, parsed: { ...result.parsed, outcomeCategory: "not_a_real_category" } };
    const resultPath = path.join(dir, "a.json");
    await fs.writeFile(resultPath, JSON.stringify(corrupt), "utf8");

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: result file for scenario a has invalid outcomeCategory "not_a_real_category"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: persistence — corrected manifest written to disk when persistPath given
// ---------------------------------------------------------------------------

test("reconcileManifestFromCheckpoint writes corrected manifest to persistPath when entries are reconciled", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "a", makeResult("a", "benchmark_outcome"));
    const persistPath = path.join(dir, "run-manifest.json");

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint, persistPath);

    const persisted = JSON.parse(await fs.readFile(persistPath, "utf8")) as RunManifest;
    assert.equal(persisted.resultPaths["a"], resultPath);
    assert.equal(persisted.counts.completed, 1);
    assert.equal(persisted.counts.benchmarkOutcomes, 1);
  });
});

test("reconcileManifestFromCheckpoint does not write manifest to persistPath when no entries diverged", async () => {
  await withTempDir(async (dir) => {
    const resultPath = await writeResult(dir, "a", makeResult("a", "benchmark_outcome"));
    const persistPath = path.join(dir, "run-manifest.json");

    // Manifest already has "a" — no divergence
    const manifest = makeManifest({
      resultPaths: { a: resultPath },
      counts: { total: 3, completed: 1, transportFailures: 0, validatorSystemFailures: 0, benchmarkOutcomes: 1 },
    });
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: resultPath },
    });

    await reconcileManifestFromCheckpoint(manifest, checkpoint, persistPath);

    // File must not exist: no changes means no write
    await assert.rejects(
      () => fs.readFile(persistPath, "utf8"),
      { code: "ENOENT" },
    );
  });
});

test("reconcileManifestFromCheckpoint throws when result file scenarioId does not match checkpoint entry", async () => {
  await withTempDir(async (dir) => {
    const wrongPath = await writeResult(dir, "wrong-id", makeResult("wrong-id", "benchmark_outcome"));

    const manifest = makeManifest();
    const checkpoint = makeCheckpoint({
      completedScenarioIds: ["a"],
      resultPaths: { a: wrongPath },
    });

    await assert.rejects(
      () => reconcileManifestFromCheckpoint(manifest, checkpoint),
      /Resume corruption: result file for scenario a has mismatched scenarioId "wrong-id"/,
    );
  });
});
