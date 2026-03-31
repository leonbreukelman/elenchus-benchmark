import test from "node:test";
import assert from "node:assert/strict";
import { createCheckpointFromManifest, selectPendingScenarioIds } from "../src/run/checkpoint.js";

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
