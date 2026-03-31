import "dotenv/config";
import { generateAnalysisArtifacts } from "../analyze/metrics.js";
import { loadJoinedResults } from "../run/runner.js";

async function main(): Promise<void> {
  const { manifest, scenarios, results } = await loadJoinedResults();
  await generateAnalysisArtifacts({ manifest, scenarios, results });
  console.log(`Analysis written for run ${manifest.runId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
