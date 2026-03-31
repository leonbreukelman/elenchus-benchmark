import "dotenv/config";
import { readRunConfig } from "../lib/config.js";
import { runBenchmark } from "../run/runner.js";

function parseArgs(argv: string[]): { resume: boolean; mode: "pilot" | "full" } {
  return {
    resume: argv.includes("--resume"),
    mode: argv.includes("--pilot") ? "pilot" : "full",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = readRunConfig();
  const manifest = await runBenchmark({
    mode: args.mode,
    resume: args.resume,
    validatorUrl: config.validatorUrl,
    validatorGitSha: config.validatorGitSha,
    validatorVersion: config.validatorVersion,
    benchmarkSeed: config.benchmarkSeed,
  });

  console.log(
    `Run ${manifest.runId} completed ${manifest.counts.completed}/${manifest.counts.total} scenarios.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
