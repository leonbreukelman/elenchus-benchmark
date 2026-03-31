/**
 * Tests for dataset normalization logic using inline fixtures.
 * Uses Node built-in test runner (node:test).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// --- Fixtures ---

const NAVY_ROWS_FIXTURE = [
  {
    row_idx: 0,
    row: {
      text: "We should not promote her to project manager because she has missed three major deadlines on comparable projects.",
      label: "valid",
    },
  },
  {
    row_idx: 1,
    row: {
      text: "We should not promote her to project manager because she dresses unprofessionally and annoys people at lunch.",
      label: "fallacy",
    },
  },
  {
    row_idx: 2,
    row: {
      text: "He should not be assigned as lead surgeon because his complication rate is significantly higher than the department average.",
      label: "valid",
    },
  },
  {
    row_idx: 3,
    row: {
      text: "He should not be assigned as lead surgeon because he is rude to waiters.",
      label: "fallacy",
    },
  },
  // Row with no "because" — should be skipped.
  {
    row_idx: 4,
    row: {
      text: "This is an argument without the delimiter.",
      label: "valid",
    },
  },
];

// --- Inline normalization logic (mirrors fallacy-pairs.ts, testable without imports) ---

function extractBecausePrefix(text: string): string | null {
  const match = text.match(/^(.+?)\s+because\s+/i);
  if (!match) return null;
  return match[1].trim().toLowerCase();
}

function extractReasoning(text: string): string | null {
  const idx = text.search(/\s+because\s+/i);
  if (idx === -1) return null;
  const afterBecause = text.slice(idx).replace(/^\s+because\s+/i, "").trim();
  return afterBecause || null;
}

type RawRow = { text: string; label: string };

function reconstructPairs(
  rows: Array<{ row_idx: number; row: Record<string, unknown> }>
): Array<{ prefix: string; valid: RawRow; fallacy: RawRow }> {
  const groups = new Map<
    string,
    { valid?: RawRow; fallacy?: RawRow }
  >();

  for (const { row } of rows) {
    const text = String(row["text"] ?? "").trim();
    const label = String(row["label"] ?? "").trim().toLowerCase();
    if (!text || (label !== "valid" && label !== "fallacy")) continue;

    const prefix = extractBecausePrefix(text);
    if (!prefix) continue;

    const entry = groups.get(prefix) ?? {};
    if (label === "valid") entry.valid = row as unknown as RawRow;
    else if (label === "fallacy") entry.fallacy = row as unknown as RawRow;
    groups.set(prefix, entry);
  }

  const complete: Array<{ prefix: string; valid: RawRow; fallacy: RawRow }> = [];
  for (const [prefix, entry] of groups.entries()) {
    if (entry.valid && entry.fallacy) {
      complete.push({ prefix, valid: entry.valid, fallacy: entry.fallacy });
    }
  }
  return complete;
}

// --- Tests ---

test("extractBecausePrefix handles standard 'because' split", () => {
  const text =
    "We should not promote her to project manager because she has missed three major deadlines.";
  const prefix = extractBecausePrefix(text);
  assert.equal(
    prefix,
    "we should not promote her to project manager"
  );
});

test("extractBecausePrefix returns null when no 'because' present", () => {
  const text = "This argument has no delimiter at all.";
  assert.equal(extractBecausePrefix(text), null);
});

test("extractReasoning returns the because-clause verbatim", () => {
  const text =
    "We should not promote her to project manager because she has missed three major deadlines.";
  const r = extractReasoning(text);
  assert.equal(r, "she has missed three major deadlines.");
});

test("extractReasoning returns null for text without 'because'", () => {
  assert.equal(extractReasoning("this text has no such keyword"), null);
});

test("reconstructPairs groups rows into complete pairs", () => {
  const pairs = reconstructPairs(NAVY_ROWS_FIXTURE);
  assert.equal(pairs.length, 2, "expected 2 complete pairs");
});

test("reconstructPairs skips rows without 'because'", () => {
  const pairs = reconstructPairs(NAVY_ROWS_FIXTURE);
  // Row with text "This is an argument without the delimiter." should be excluded.
  const hasNoDelimiter = pairs.some(
    (p) =>
      p.valid.text.includes("without the delimiter") ||
      (p.fallacy?.text ?? "").includes("without the delimiter")
  );
  assert.equal(hasNoDelimiter, false);
});

test("reconstructPairs assigns valid and fallacy roles correctly", () => {
  const pairs = reconstructPairs(NAVY_ROWS_FIXTURE);
  for (const pair of pairs) {
    assert.equal(pair.valid.label, "valid");
    assert.equal(pair.fallacy.label, "fallacy");
  }
});

test("pair prefix normalisation produces consistent keys across case variations", () => {
  const p1 = extractBecausePrefix(
    "We should NOT promote her because she failed."
  );
  const p2 = extractBecausePrefix(
    "We should NOT promote her because she dresses badly."
  );
  // Both should normalise to the same lowercase prefix.
  assert.equal(p1, p2);
});

test("IBM AQ row with valid WA score is accepted", () => {
  // Inline row validator logic.
  function isValidIbmRow(row: Record<string, unknown>): boolean {
    const argument = String(row["argument"] ?? "").trim();
    const topic = String(row["topic"] ?? "").trim();
    const wa = Number(row["WA"]);
    return !!argument && !!topic && !isNaN(wa) && wa >= 0 && wa <= 1;
  }

  assert.equal(
    isValidIbmRow({
      argument: "Marriage is outdated.",
      topic: "We should abandon marriage",
      WA: 0.846,
    }),
    true
  );
});

test("IBM AQ row missing argument is rejected", () => {
  function isValidIbmRow(row: Record<string, unknown>): boolean {
    const argument = String(row["argument"] ?? "").trim();
    const topic = String(row["topic"] ?? "").trim();
    const wa = Number(row["WA"]);
    return !!argument && !!topic && !isNaN(wa) && wa >= 0 && wa <= 1;
  }

  assert.equal(
    isValidIbmRow({ argument: "", topic: "Some topic", WA: 0.5 }),
    false
  );
});
