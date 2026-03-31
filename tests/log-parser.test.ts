import test from "node:test";
import assert from "node:assert/strict";
import { parseTerminalLog } from "../src/run/log-parser.js";

const SUPPORTED_SHA = "5f7d500b5e5cb9287cf1b2ca57071b6cb98cdcea";

test("parseTerminalLog extracts rounds and termination reason for supported sha", () => {
  const parsed = parseTerminalLog(SUPPORTED_SHA, [
    "[RECEIVE] traceId=abc | action=test | timestamp=2026-03-31T00:00:00.000Z",
    "[SABOTEUR R1] Alternative: {}. Reasoning: alt. Plausibility: 60/100.",
    "[JUDGE R1] Verdict: ALLOW. Concordance: 72. Strong reasoning.",
    "[VERDICT] ALLOW | concordance=72 | rounds=1 | elapsed=1.2s",
  ]);

  assert.equal(parsed.parserSupported, true);
  assert.equal(parsed.rounds, 1);
  assert.equal(parsed.terminationReason, "judge_allow_concordance_threshold");
  assert.equal(parsed.systemFailure, false);
});

test("parseTerminalLog detects validator fail-closed system failures", () => {
  const parsed = parseTerminalLog(SUPPORTED_SHA, [
    "[ERROR] No API key configured (GEMINI_API_KEY or API_KEY)",
  ]);

  assert.equal(parsed.systemFailure, true);
  assert.equal(parsed.failureClass, "missing_api_key");
  assert.equal(parsed.terminationReason, "missing_api_key");
});

test("parseTerminalLog leaves parser fields unset for unsupported sha", () => {
  const parsed = parseTerminalLog("other-sha", [
    "[VERDICT] DENY | concordance=0 | rounds=1 | elapsed=0.1s",
  ]);

  assert.equal(parsed.parserSupported, false);
  assert.equal(parsed.rounds, undefined);
  assert.equal(parsed.terminationReason, undefined);
});
