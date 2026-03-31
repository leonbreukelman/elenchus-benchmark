import test from "node:test";
import assert from "node:assert/strict";
import { assertResumeCompatible, createCheckpointFromManifest, selectPendingScenarioIds } from "../src/run/checkpoint.js";
import type { RunManifest } from "../src/types.js";

test("createCheckpointFromManifest starts empty and resumable", () => {
  const checkpoint = createCheckpointFromManifest({
    schemaVersion: "1.0.0",
    runId: "run-1",
    mode: "pilot",
    startedAt: "2026-03-31T00:00:00.000Z",
    resumed: false,
    scenarioManifestPath: "/tmp/scenarios/manifest.json",
    scenarioManifestPreparedAt: "2026-03-31T00:00:00.000Z",
    scenarioIds: ["a", "b"],
    resultPaths: {},
    validator: {
      url: "http://localhost:3000",
      gitSha: "sha",
      parserSupported: true,
    },
    environment: {
      nodeVersion: "v24.0.0",
      platform: "linux",
      arch: "x64",
      benchmarkSeed: "seed",
    },
    counts: {
      total: 2,
      completed: 0,
      transportFailures: 0,
      validatorSystemFailures: 0,
      benchmarkOutcomes: 0,
    },
  });

  assert.deepEqual(checkpoint.completedScenarioIds, []);
  assert.equal(checkpoint.resultPaths.a, undefined);
  assert.equal(checkpoint.runId, "run-1");
});

test("selectPendingScenarioIds skips already completed scenarios", () => {
  assert.deepEqual(selectPendingScenarioIds(["a", "b", "c"], ["b"]), ["a", "c"]);
});

test("selectPendingScenarioIds with mixed completed list resumes idempotently", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const completed = ["s1", "s3"];
  const pending = selectPendingScenarioIds(ids, completed);
  assert.deepEqual(pending, ["s2", "s4", "s5"]);
  // Calling again with the same completed set produces the same result.
  assert.deepEqual(selectPendingScenarioIds(ids, completed), pending);
  // Simulating resume after completing s2: only s4 and s5 remain.
  assert.deepEqual(selectPendingScenarioIds(ids, [...completed, "s2"]), ["s4", "s5"]);
});

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: "1.0.0",
    runId: "run-1",
    mode: "pilot",
    startedAt: "2026-03-31T00:00:00.000Z",
    resumed: false,
    scenarioManifestPath: "/scenarios/manifest.json",
    scenarioManifestPreparedAt: "2026-03-31T00:00:00.000Z",
    scenarioIds: ["a"],
    resultPaths: {},
    validator: { url: "http://localhost:3000", gitSha: "abc123", parserSupported: true },
    environment: { nodeVersion: "v24.0.0", platform: "linux", arch: "x64", benchmarkSeed: "seed" },
    counts: { total: 1, completed: 0, transportFailures: 0, validatorSystemFailures: 0, benchmarkOutcomes: 0 },
    ...overrides,
  };
}

test("assertResumeCompatible passes when mode and sha match", () => {
  assert.doesNotThrow(() => assertResumeCompatible(makeManifest(), "pilot", "abc123"));
});

test("assertResumeCompatible throws on mode mismatch", () => {
  assert.throws(
    () => assertResumeCompatible(makeManifest({ mode: "full" }), "pilot", "abc123"),
    /Cannot resume pilot run: latest run manifest is for mode=full/,
  );
});

test("assertResumeCompatible throws on validator SHA mismatch", () => {
  assert.throws(
    () => assertResumeCompatible(makeManifest(), "pilot", "different-sha"),
    /validator git SHA mismatch/,
  );
});
