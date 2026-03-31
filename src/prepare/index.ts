import path from "node:path";
import { getGitShaIfAvailable } from "../lib/git.js";
import { cleanDirectory, writeJsonAtomic } from "../lib/io.js";
import { projectRoot, scenariosDir } from "../lib/paths.js";
import type { NormalizedScenario, ScenarioManifest } from "../types.js";
import { prepareFallacyPairs } from "./fallacy-pairs.js";
import { prepareFolioIfEligible } from "./folio.js";
import { prepareIbmArgumentQuality } from "./ibm-aq.js";

export async function prepareScenarios(config: {
  benchmarkSeed: string;
  hfToken?: string;
}): Promise<ScenarioManifest> {
  const benchmarkGitSha = await getGitShaIfAvailable(projectRoot);
  const [fallacy, ibm, folio] = await Promise.all([
    prepareFallacyPairs(config.benchmarkSeed, config.hfToken),
    prepareIbmArgumentQuality(config.benchmarkSeed, config.hfToken),
    prepareFolioIfEligible(config.benchmarkSeed, config.hfToken),
  ]);

  const scenarios: NormalizedScenario[] = [...fallacy.scenarios, ...ibm.scenarios, ...folio.scenarios].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  await cleanDirectory(scenariosDir);

  for (const scenario of scenarios) {
    const filePath = path.join(scenariosDir, `${scenario.id}.json`);
    await writeJsonAtomic(filePath, scenario);
  }

  const manifest: ScenarioManifest = {
    schemaVersion: "1.0.0",
    preparedAt: new Date().toISOString(),
    benchmarkSeed: config.benchmarkSeed,
    benchmarkGitSha,
    datasets: [fallacy.manifest, ibm.manifest, folio.manifest],
    scenarios: {
      total: scenarios.length,
      bySource: scenarios.reduce<ScenarioManifest["scenarios"]["bySource"]>((accumulator, scenario) => {
        accumulator[scenario.source] = (accumulator[scenario.source] ?? 0) + 1;
        return accumulator;
      }, {}),
      order: scenarios.map((scenario) => scenario.id),
    },
    selections: scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      source: scenario.source,
      sourceRecordId: scenario.metadata.sourceRecordId,
      pairId: scenario.pairId,
      pairRole: scenario.pairRole,
    })),
    notes: [
      "Scenarios are ordered by stable scenario ID for deterministic output.",
      "FOLIO exclusion is explicit and data-backed in the dataset manifest entry when no source-provided reasoning text is available.",
    ],
  };

  await writeJsonAtomic(path.join(scenariosDir, "manifest.json"), manifest);
  return manifest;
}
