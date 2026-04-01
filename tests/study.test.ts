import test from "node:test";
import assert from "node:assert/strict";
import { buildAggregateStudySummary, buildSeedList, parseStudyArgs } from "../src/cli/study.js";

test("parseStudyArgs defaults to a full 10-seed study", () => {
  const parsed = parseStudyArgs([]);
  assert.equal(parsed.mode, "full");
  assert.equal(parsed.resume, false);
  assert.equal(parsed.count, 10);
  assert.equal(parsed.seedPrefix, "study-seed");
  assert.deepEqual(buildSeedList(parsed).slice(0, 3), ["study-seed-001", "study-seed-002", "study-seed-003"]);
});

test("parseStudyArgs accepts explicit seeds and pilot mode", () => {
  const parsed = parseStudyArgs(["--pilot", "--seeds", "alpha,beta,gamma"]);
  assert.equal(parsed.mode, "pilot");
  assert.deepEqual(buildSeedList(parsed), ["alpha", "beta", "gamma"]);
  assert.equal(parsed.count, 3);
});

test("parseStudyArgs rejects unknown flags", () => {
  assert.throws(() => parseStudyArgs(["--wat"]), /Unknown argument/);
});

test("buildAggregateStudySummary computes mean and totals across runs", () => {
  const summary = buildAggregateStudySummary(
    {
      schemaVersion: "1.0.0",
      studyId: "study-full-test",
      mode: "full",
      createdAt: "2026-03-31T00:00:00.000Z",
      updatedAt: "2026-03-31T00:00:00.000Z",
      resumeSupported: true,
      validator: {
        url: "http://localhost:3000",
        gitSha: "sha",
      },
      plan: {
        seeds: ["seed-001", "seed-002"],
        count: 2,
        seedPrefix: "seed",
      },
      completedSeeds: ["seed-001", "seed-002"],
      seedRuns: [],
    },
    [
      {
        seed: "seed-001",
        runId: "run-1",
        mode: "full",
        validator: { url: "http://localhost:3000", gitSha: "sha", parserSupported: true },
        counts: {
          total: 110,
          completed: 110,
          benchmarkOutcomes: 109,
          transportFailures: 1,
          validatorSystemFailures: 0,
        },
        metrics: {
          fallacyStrictPairAccuracy: 0.7,
          fallacyEvaluatedPairs: 30,
          fallacyStrictPairSuccesses: 21,
          ibmSpearman: 0.41,
          ibmEvaluatedScenarios: 50,
        },
        archivedPaths: {
          runManifest: "/tmp/run-1.json",
          metrics: "/tmp/metrics-1.json",
          summaryCsv: "/tmp/summary-1.csv",
          pairBreakdownCsv: "/tmp/pairs-1.csv",
          rawDir: "/tmp/raw-1",
          scenariosDir: "/tmp/scenarios-1",
        },
      },
      {
        seed: "seed-002",
        runId: "run-2",
        mode: "full",
        validator: { url: "http://localhost:3000", gitSha: "sha", parserSupported: true },
        counts: {
          total: 110,
          completed: 110,
          benchmarkOutcomes: 108,
          transportFailures: 0,
          validatorSystemFailures: 2,
        },
        metrics: {
          fallacyStrictPairAccuracy: 0.5,
          fallacyEvaluatedPairs: 30,
          fallacyStrictPairSuccesses: 15,
          ibmSpearman: 0.21,
          ibmEvaluatedScenarios: 50,
        },
        archivedPaths: {
          runManifest: "/tmp/run-2.json",
          metrics: "/tmp/metrics-2.json",
          summaryCsv: "/tmp/summary-2.csv",
          pairBreakdownCsv: "/tmp/pairs-2.csv",
          rawDir: "/tmp/raw-2",
          scenariosDir: "/tmp/scenarios-2",
        },
      },
    ],
  );

  assert.equal(summary.seedsCompleted, 2);
  assert.equal(summary.aggregate.totals.completed, 220);
  assert.equal(summary.aggregate.totals.transportFailures, 1);
  assert.equal(summary.aggregate.totals.validatorSystemFailures, 2);
  assert.equal(summary.aggregate.fallacyStrictPairAccuracy.mean, 0.6);
  assert.equal(summary.aggregate.ibmSpearman.mean, 0.31);
});

test("parseStudyArgs keeps resume off by default for new studies", () => {
  const parsed = parseStudyArgs(["--study-id", "study-full-test"]);
  assert.equal(parsed.resume, false);
  assert.equal(parsed.studyId, "study-full-test");
});
