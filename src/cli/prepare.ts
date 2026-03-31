import "dotenv/config";
import { readPrepareConfig, shouldSkipPrepareForInstallLifecycle } from "../lib/config.js";
import { prepareScenarios } from "../prepare/index.js";

async function main(): Promise<void> {
  if (shouldSkipPrepareForInstallLifecycle()) {
    console.log("Skipping scenario preparation during npm install lifecycle.");
    return;
  }

  const config = readPrepareConfig();
  const manifest = await prepareScenarios(config);
  console.log(`Prepared ${manifest.scenarios.total} scenarios.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
