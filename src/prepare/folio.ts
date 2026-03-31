import { fetchDatasetMetadata, fetchJsonlRecords } from "../lib/huggingface.js";
import type { DatasetManifestEntry, NormalizedScenario } from "../types.js";

const DATASET_ID = "tasksource/folio";

interface FolioRow {
  story_id: number;
  premises: string;
  "premises-FOL": string;
  conclusion: string;
  "conclusion-FOL": string;
  label: string;
  example_id: number;
}

function hasUsableReasoning(row: FolioRow): boolean {
  return Boolean(row["premises-FOL"]?.trim() || row["conclusion-FOL"]?.trim());
}

export async function prepareFolioIfEligible(
  _seed: string,
  token?: string,
): Promise<{
  scenarios: NormalizedScenario[];
  manifest: DatasetManifestEntry;
}> {
  const metadata = await fetchDatasetMetadata(DATASET_ID, token);
  const rows = await fetchJsonlRecords<FolioRow>(DATASET_ID, "folio_v2_train.jsonl", token);
  const rowsWithFormalFields = rows.filter(hasUsableReasoning);

  return {
    scenarios: [],
    manifest: {
      source: "folio",
      datasetId: DATASET_ID,
      datasetRevision: metadata.datasetRevision,
      datasetUrl: metadata.datasetUrl,
      included: false,
      sampleTarget: 0,
      selectedCount: 0,
      skippedCount: rows.length,
      exclusions: [
        {
          reason: "missing_source_reasoning_text",
          count: rows.length,
          details: [
            `Inspected ${rows.length} records from folio_v2_train.jsonl.`,
            `Found ${rowsWithFormalFields.length} records with FOL formulas, but no source-provided natural-language proof or reasoning text suitable for verbatim/near-verbatim use as validator reasoning.`,
            "FOLIO is excluded from v1 to preserve the no-synthetic-reasoning rule.",
          ],
        },
      ],
      notes: [
        "Premises and conclusion are available, but they are not equivalent to source-provided proof text for this benchmark's reasoning field.",
      ],
    },
  };
}
