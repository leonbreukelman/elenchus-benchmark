export interface PrepareConfig {
  benchmarkSeed: string;
  hfToken?: string;
  benchmarkGitSha?: string;
}

export interface ValidatorConfig {
  validatorUrl: string;
  validatorGitSha: string;
  validatorVersion?: string;
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

function requireBenchmarkSeed(seed: string | undefined): string {
  const benchmarkSeed = seed?.trim();
  if (!benchmarkSeed) {
    throw new Error("BENCHMARK_SEED is required. Set it in your environment or .env before running npm run prepare.");
  }
  return benchmarkSeed;
}

export function readOptionalHfToken(): string | undefined {
  return process.env.HF_TOKEN?.trim() || undefined;
}

export function createPrepareConfig(benchmarkSeed: string): PrepareConfig {
  return {
    benchmarkSeed: requireBenchmarkSeed(benchmarkSeed),
    hfToken: readOptionalHfToken(),
  };
}

export function readPrepareConfig(): PrepareConfig {
  return createPrepareConfig(requireBenchmarkSeed(process.env.BENCHMARK_SEED));
}

export function readValidatorConfig(): ValidatorConfig {
  const validatorGitSha = process.env.VALIDATOR_GIT_SHA?.trim();

  if (!validatorGitSha) {
    throw new Error("VALIDATOR_GIT_SHA is required. The benchmark refuses to run without an explicit validator revision.");
  }

  return {
    validatorUrl: process.env.VALIDATOR_URL?.trim() || "http://localhost:3000",
    validatorGitSha,
    validatorVersion: process.env.VALIDATOR_VERSION?.trim() || undefined,
  };
}

export function createRunConfig(benchmarkSeed: string): RunConfig {
  return {
    ...createPrepareConfig(benchmarkSeed),
    ...readValidatorConfig(),
  };
}

export function readRunConfig(): RunConfig {
  return createRunConfig(requireBenchmarkSeed(process.env.BENCHMARK_SEED));
}

export function describeEnvironment(seed: string, benchmarkGitSha?: string): BenchmarkEnvironment {
  return {
    benchmarkGitSha,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    benchmarkSeed: seed,
  };
}

// Re-exported from types.ts for convenience; keeps describeEnvironment's return
// type aligned with the declared interface.
import type { BenchmarkEnvironment } from "../types.js";
