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
  if (process.env.npm_lifecycle_event !== "prepare") return false;
  // When the user explicitly runs `npm run prepare`, npm sets npm_command to
  // "run-script" (npm < 11) or "run" (npm 11+). During `npm install` or
  // `npm ci`, npm_command is "install" or "ci". Skip only for the lifecycle
  // case so a pre-existing BENCHMARK_SEED in .env does not trigger
  // preparation during install.
  const npmCommand = process.env.npm_command;
  return npmCommand !== "run-script" && npmCommand !== "run";
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
