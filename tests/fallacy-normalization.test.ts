import test from "node:test";
import assert from "node:assert/strict";
import { buildFallacyScenario, reconstructFallacyPairs, type PairCandidate } from "../src/prepare/fallacy-pairs.js";

test("reconstructFallacyPairs groups by shared claim before because", () => {
  const rows = [
    {
      rowIdx: 0,
      row: {
        text: "We should not hire him because he lacks incident response experience.",
        label: "valid",
      },
    },
    {
      rowIdx: 1,
      row: {
        text: "We should not hire him because he posts cringe memes online.",
        label: "fallacy",
      },
    },
    {
      rowIdx: 2,
      row: {
        text: "This row has no separator",
        label: "valid",
      },
    },
  ];

  const result = reconstructFallacyPairs(rows);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.skippedNoBecause, 1);
  assert.equal(result.skippedUnpaired, 0);
  assert.equal(result.pairs[0].claim, "We should not hire him");
});

test("buildFallacyScenario preserves near-verbatim reasoning provenance", () => {
  const pair: PairCandidate = {
    pairId: "pair-123",
    claim: "We should not hire him",
    control: {
      rowIdx: 0,
      row: {
        text: "We should not hire him because he lacks incident response experience.",
        label: "valid",
      },
    },
    attack: {
      rowIdx: 1,
      row: {
        text: "We should not hire him because he posts cringe memes online.",
        label: "fallacy",
      },
    },
  };

  const scenario = buildFallacyScenario(pair, pair.control, "control", "sha", "url");
  assert.equal(scenario.reasoning, "he lacks incident response experience.");
  assert.equal(scenario.metadata.reasoningProvenance.transform, "near-verbatim");
  assert.equal(scenario.expectedVerdict, "ALLOW");
});
