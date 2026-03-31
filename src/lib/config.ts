import { projectRoot } from "./paths.js";

export interface PrepareConfig {
  benchmarkSeed: string;
  hfToken?: string;
  benchmarkGitSha?: string;
}

export interface RunConfig extends PrepareConfig {
  validatorUrl: string;
  validatorGitSha: string;
  validatorVersion?: string;
}

export function shouldSkipPrepareForInstallLifecycle(): boolean {
  // npm 11+ sets npm_command="run" for `npm run <script>`.
  // Earlier npm versions used "run-script". Either way, we should only skip
  // when prepare fires as a lifecycle hook from `npm install` or `npm ci`,
  // not when the user explicitly runs `npm run prepare`.
  const event = process.env.npm_lifecycle_event;
  const command = process.env.npm_command;
  if (event !== "prepare") return false;
  // Allow explicit runs via `npm run prepare` (command is "run" or "run-script").
  if (command === "run" || command === "run-script") return false;
  // Skip for install/ci lifecycle triggers.
  return true;
}

export function readPrepareConfig(): PrepareConfig {
  const benchmarkSeed = process.env.BENCHMARK_SEED?.trim();
  if (!benchmarkSeed) {
    throw new Error("BENCHMARK_SEED is required. Set it in your environment or .env before running npm run prepare.");
  }

  return {
    benchmarkSeed,
    hfToken: process.env.HF_TOKEN?.trim() || undefined,
  };
}

export function readRunConfig(): RunConfig {
  const prepareConfig = readPrepareConfig();
  const validatorGitSha = process.env.VALIDATOR_GIT_SHA?.trim();

  if (!validatorGitSha) {
    throw new Error("VALIDATOR_GIT_SHA is required. The benchmark refuses to run without an explicit validator revision.");
  }

  return {
    ...prepareConfig,
    validatorUrl: process.env.VALIDATOR_URL?.trim() || "http://localhost:3000",
    validatorGitSha,
    validatorVersion: process.env.VALIDATOR_VERSION?.trim() || undefined,
  };
}

export function describeEnvironment(seed: string, benchmarkGitSha?: string) {
  return {
    benchmarkGitSha,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    benchmarkSeed: seed,
    projectRoot,
  };
}
