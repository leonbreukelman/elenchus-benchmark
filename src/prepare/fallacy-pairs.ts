import { sampleDeterministic } from "../lib/random.js";
import { stableId } from "../lib/hash.js";
import { fetchDatasetMetadata, fetchDatasetRows, type DatasetRow } from "../lib/huggingface.js";
import { normalizeClaimKey, normalizeWhitespace, splitClaimAndReasoning } from "../lib/strings.js";
import type { DatasetManifestEntry, NormalizedScenario } from "../types.js";

const DATASET_ID = "Navy0067/contrastive-pairs-for-logical-fallacy";
const DATASET_CONFIG = "default";
const DATASET_SPLIT = "train";
const SAMPLE_TARGET_PAIRS = 30;

interface FallacyRow {
  text: string;
  label: string;
}

export interface PairCandidate {
  pairId: string;
  claim: string;
  control: DatasetRow<FallacyRow>;
  attack: DatasetRow<FallacyRow>;
}

export function buildFallacyScenario(
  pair: PairCandidate,
  row: DatasetRow<FallacyRow>,
  role: "control" | "attack",
  datasetRevision: string | undefined,
  datasetUrl: string,
): NormalizedScenario {
  const split = splitClaimAndReasoning(row.row.text);
  if (!split) {
    throw new Error(`Unexpected fallacy pair row without usable reasoning: ${row.row.text}`);
  }

  const scenarioId = stableId(
    `fallacy-${role}`,
    `${pair.pairId}:${row.rowIdx}:${row.row.text}`,
  );

  return {
    id: scenarioId,
    source: "fallacy-pairs",
    evaluationMode: "pair",
    context: `Role evaluation: ${pair.claim}.`,
    proposedAction: {
      type: "candidate-evaluation",
      claim: pair.claim,
      source: "logical-fallacy-contrastive-pairs",
    },
    reasoning: split.reasoning,
    expectedVerdict: role === "control" ? "ALLOW" : "DENY",
    pairId: pair.pairId,
    pairRole: role,
    metadata: {
      datasetId: DATASET_ID,
      datasetRevision,
      datasetUrl,
      sourceRecordId: `${DATASET_SPLIT}:${row.rowIdx}`,
      reasoningProvenance: {
        sourceField: "text",
        transform: "near-verbatim",
        notes: "Reasoning extracted as the clause after the first 'because'.",
      },
      originalText: row.row.text,
      claimText: split.claim,
      label: row.row.label,
      fallacyType: role === "attack" ? "unspecified_in_source_dataset" : "not_applicable",
    },
  };
}

export function reconstructFallacyPairs(rows: DatasetRow<FallacyRow>[]): {
  pairs: PairCandidate[];
  skippedNoBecause: number;
  skippedUnpaired: number;
} {
  const groups = new Map<
    string,
    {
      claim: string;
      valid: DatasetRow<FallacyRow>[];
      fallacy: DatasetRow<FallacyRow>[];
    }
  >();

  let skippedNoBecause = 0;

  for (const row of rows) {
    const split = splitClaimAndReasoning(row.row.text);
    if (!split) {
      skippedNoBecause += 1;
      continue;
    }

    const key = normalizeClaimKey(split.claim);
    const group = groups.get(key) ?? {
      claim: normalizeWhitespace(split.claim),
      valid: [],
      fallacy: [],
    };

    if (row.row.label === "valid") {
      group.valid.push(row);
    } else if (row.row.label === "fallacy") {
      group.fallacy.push(row);
    }

    groups.set(key, group);
  }

  const pairs: PairCandidate[] = [];
  let skippedUnpaired = 0;

  for (const [key, group] of groups.entries()) {
    const pairCount = Math.min(group.valid.length, group.fallacy.length);
    skippedUnpaired += group.valid.length + group.fallacy.length - pairCount * 2;

    for (let index = 0; index < pairCount; index += 1) {
      const control = group.valid[index];
      const attack = group.fallacy[index];
      const pairId = stableId("pair", `${key}:${control.rowIdx}:${attack.rowIdx}`);
      pairs.push({
        pairId,
        claim: group.claim,
        control,
        attack,
      });
    }
  }

  pairs.sort((left, right) => left.pairId.localeCompare(right.pairId));

  return { pairs, skippedNoBecause, skippedUnpaired };
}

export async function prepareFallacyPairs(seed: string, token?: string): Promise<{
  scenarios: NormalizedScenario[];
  manifest: DatasetManifestEntry;
}> {
  const metadata = await fetchDatasetMetadata(DATASET_ID, token);
  const rows = await fetchDatasetRows<FallacyRow>(DATASET_ID, DATASET_CONFIG, DATASET_SPLIT, token);
  const { pairs, skippedNoBecause, skippedUnpaired } = reconstructFallacyPairs(rows);
  const selectedPairs = sampleDeterministic(pairs, SAMPLE_TARGET_PAIRS, seed, "fallacy-pairs");

  const scenarios = selectedPairs
    .flatMap((pair) => [
      buildFallacyScenario(pair, pair.control, "control", metadata.datasetRevision, metadata.datasetUrl),
      buildFallacyScenario(pair, pair.attack, "attack", metadata.datasetRevision, metadata.datasetUrl),
    ])
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    scenarios,
    manifest: {
      source: "fallacy-pairs",
      datasetId: DATASET_ID,
      datasetRevision: metadata.datasetRevision,
      datasetUrl: metadata.datasetUrl,
      included: true,
      sampleTarget: SAMPLE_TARGET_PAIRS * 2,
      selectedCount: scenarios.length,
      skippedCount: skippedNoBecause + skippedUnpaired,
      exclusions: [
        ...(skippedNoBecause > 0
          ? [{ reason: "missing_reasoning_pattern", count: skippedNoBecause, details: ["Rows without a usable 'because' split were excluded."] }]
          : []),
        ...(skippedUnpaired > 0
          ? [{ reason: "unpaired_rows", count: skippedUnpaired, details: ["Rows without both a valid and fallacy counterpart for the same claim were excluded."] }]
          : []),
      ],
      notes: [
        "Pairs reconstructed conservatively by grouping rows on the shared claim prefix before the first 'because'.",
      ],
    },
  };
}
