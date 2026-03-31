import { sampleDeterministic } from "../lib/random.js";
import { stableId } from "../lib/hash.js";
import { fetchCsvRecords, fetchDatasetMetadata } from "../lib/huggingface.js";
import { normalizeWhitespace } from "../lib/strings.js";
import type { DatasetManifestEntry, NormalizedScenario } from "../types.js";

const DATASET_ID = "ibm-research/argument_quality_ranking_30k";
const SAMPLE_TARGET = 50;

interface IbmRow {
  argument: string;
  topic: string;
  set: string;
  WA: string;
  "MACE-P": string;
  stance_WA: string;
  stance_WA_conf: string;
}

interface BucketedRow {
  row: IbmRow;
  bucket: number;
}

function parseQuality(row: IbmRow): number | null {
  const value = Number.parseFloat(row.WA);
  return Number.isFinite(value) ? value : null;
}

function createBuckets(rows: IbmRow[]): BucketedRow[] {
  return rows
    .map((row) => {
      const quality = parseQuality(row);
      if (quality === null) {
        return null;
      }

      return {
        row,
        bucket: Math.min(4, Math.max(0, Math.floor(quality * 5))),
      };
    })
    .filter((value): value is BucketedRow => value !== null);
}

export async function prepareIbmArgumentQuality(
  seed: string,
  token?: string,
): Promise<{
  scenarios: NormalizedScenario[];
  manifest: DatasetManifestEntry;
}> {
  const metadata = await fetchDatasetMetadata(DATASET_ID, token);
  const rows = await fetchCsvRecords<IbmRow>(DATASET_ID, "train.csv", token);
  const usableRows = rows.filter((row) => normalizeWhitespace(row.argument).length > 0);
  const bucketed = createBuckets(usableRows);
  const selected: BucketedRow[] = [];

  for (let bucket = 0; bucket < 5; bucket += 1) {
    const bucketRows = bucketed.filter((item) => item.bucket === bucket);
    const target = Math.floor(SAMPLE_TARGET / 5);
    selected.push(...sampleDeterministic(bucketRows, target, seed, `ibm-bucket-${bucket}`));
  }

  if (selected.length < SAMPLE_TARGET) {
    const selectedIds = new Set(selected.map((item) => `${item.row.topic}::${item.row.argument}`));
    const remainder = bucketed.filter((item) => !selectedIds.has(`${item.row.topic}::${item.row.argument}`));
    selected.push(...sampleDeterministic(remainder, SAMPLE_TARGET - selected.length, seed, "ibm-remainder"));
  }

  const scenarios = selected
    .slice(0, SAMPLE_TARGET)
    .map(({ row }) => {
      const topic = normalizeWhitespace(row.topic);
      const argument = normalizeWhitespace(row.argument);
      const scenarioId = stableId("ibm", `${topic}:${argument}`);
      const humanQualityScore = parseQuality(row);
      if (humanQualityScore === null) {
        throw new Error(`Invalid IBM WA quality score for topic "${row.topic}".`);
      }

      return {
        id: scenarioId,
        source: "ibm-aq",
        evaluationMode: "correlation",
        context: `Debate topic: ${topic}. Evaluate whether this argument supports the proposed position with hard-to-vary reasoning.`,
        proposedAction: {
          type: "stance-evaluation",
          topic,
          stanceLabel: Number.parseInt(row.stance_WA, 10),
        },
        reasoning: argument,
        humanQualityScore,
        metadata: {
          datasetId: DATASET_ID,
          datasetRevision: metadata.datasetRevision,
          datasetUrl: metadata.datasetUrl,
          sourceRecordId: `${row.set}:${scenarioId}`,
          reasoningProvenance: {
            sourceField: "argument",
            transform: "verbatim",
          },
          topic,
          maceP: Number.parseFloat(row["MACE-P"]),
          stanceWa: Number.parseInt(row.stance_WA, 10),
          stanceWaConfidence: Number.parseFloat(row.stance_WA_conf),
        },
      } satisfies NormalizedScenario;
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    scenarios,
    manifest: {
      source: "ibm-aq",
      datasetId: DATASET_ID,
      datasetRevision: metadata.datasetRevision,
      datasetUrl: metadata.datasetUrl,
      included: true,
      sampleTarget: SAMPLE_TARGET,
      selectedCount: scenarios.length,
      skippedCount: usableRows.length - scenarios.length,
      exclusions: [],
      notes: [
        "Sample stratified across five WA quality-score buckets from train.csv.",
      ],
    },
  };
}
