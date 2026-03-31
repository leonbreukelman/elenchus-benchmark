import test from "node:test";
import assert from "node:assert/strict";
import { buildPairBreakdown, buildSummaryCsv, spearmanCorrelation, wilsonInterval } from "../src/analyze/metrics.js";

test("buildSummaryCsv includes header and scenario rows", () => {
  const csv = buildSummaryCsv([
    {
      scenario: {
        id: "scenario-1",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        context: "ctx",
        proposedAction: {},
        reasoning: "reason",
        expectedVerdict: "ALLOW",
        pairId: "pair-1",
        pairRole: "control",
        metadata: {
          datasetId: "dataset",
          datasetUrl: "url",
          sourceRecordId: "record",
          reasoningProvenance: {
            sourceField: "text",
            transform: "verbatim",
          },
        },
      },
      result: {
        scenarioId: "scenario-1",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        traceId: "scenario-1",
        validator: {
          url: "http://localhost:3000",
          gitSha: "sha",
        },
        raw: {
          response: {
            actionState: "ALLOW",
            concordanceScore: 80,
            terminalLog: [],
          },
        },
        rawTerminalLog: [],
        parsed: {
          latencyMs: 10,
          systemFailure: false,
          outcomeCategory: "benchmark_outcome",
          parserSupported: true,
        },
        timestamp: "2026-03-31T00:00:00.000Z",
      },
    },
  ]);

  assert.match(csv, /^id,source,evaluationMode/);
  assert.match(csv, /scenario-1/);
});

test("buildPairBreakdown marks strict success only when control ALLOW and attack DENY", () => {
  const rows = buildPairBreakdown([
    {
      scenario: {
        id: "control",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        context: "ctx",
        proposedAction: {},
        reasoning: "reason",
        expectedVerdict: "ALLOW",
        pairId: "pair-1",
        pairRole: "control",
        metadata: {
          datasetId: "dataset",
          datasetUrl: "url",
          sourceRecordId: "record",
          reasoningProvenance: { sourceField: "text", transform: "verbatim" },
        },
      },
      result: {
        scenarioId: "control",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        traceId: "control",
        validator: { url: "http://localhost:3000", gitSha: "sha" },
        raw: { response: { actionState: "ALLOW", concordanceScore: 90, terminalLog: [] } },
        rawTerminalLog: [],
        parsed: { latencyMs: 1, systemFailure: false, outcomeCategory: "benchmark_outcome", parserSupported: true },
        timestamp: "2026-03-31T00:00:00.000Z",
      },
    },
    {
      scenario: {
        id: "attack",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        context: "ctx",
        proposedAction: {},
        reasoning: "reason",
        expectedVerdict: "DENY",
        pairId: "pair-1",
        pairRole: "attack",
        metadata: {
          datasetId: "dataset",
          datasetUrl: "url",
          sourceRecordId: "record",
          reasoningProvenance: { sourceField: "text", transform: "verbatim" },
        },
      },
      result: {
        scenarioId: "attack",
        source: "fallacy-pairs",
        evaluationMode: "pair",
        traceId: "attack",
        validator: { url: "http://localhost:3000", gitSha: "sha" },
        raw: { response: { actionState: "DENY", concordanceScore: 10, terminalLog: [] } },
        rawTerminalLog: [],
        parsed: { latencyMs: 1, systemFailure: false, outcomeCategory: "benchmark_outcome", parserSupported: true },
        timestamp: "2026-03-31T00:00:00.000Z",
      },
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].strictPairSuccess, true);
});

test("spearmanCorrelation matches monotonic ranking and wilson interval bounds", () => {
  assert.equal(spearmanCorrelation([1, 2, 3], [10, 20, 30]), 1);
  const [low, high] = wilsonInterval(7, 10);
  assert.ok(low < high);
  assert.ok(low >= 0);
  assert.ok(high <= 1);
});
