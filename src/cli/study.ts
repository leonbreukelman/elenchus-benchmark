import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAnalysisArtifacts } from "../analyze/metrics.js";
import { createPrepareConfig, readValidatorConfig } from "../lib/config.js";
import { csvEscape, ensureDir, pathExists, readJsonFile, writeJsonAtomic, writeTextAtomic } from "../lib/io.js";
import { resultsDir, scenariosDir, studiesDir } from "../lib/paths.js";
import { mean, sampleStandardDeviation } from "../lib/stats.js";
import { prepareScenarios } from "../prepare/index.js";
import { loadJoinedResults, runBenchmark } from "../run/runner.js";
import type { RunManifest } from "../types.js";

// ---------------------------------------------------------------------------
// Resilience: validator health gating
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 15_000;
const HEALTH_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export async function waitForValidator(
  validatorUrl: string,
  timeoutMs = HEALTH_POLL_TIMEOUT_MS,
  pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = new URL("/api/health", validatorUrl).toString();

  while (true) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const body = await response.text();
        if (body.includes('"status":"ok"')) return;
      }
    } catch {
      // Validator not reachable — will retry
    }

    if (Date.now() >= deadline) {
      throw new Error(`Validator at ${validatorUrl} did not become healthy within ${Math.round(timeoutMs / 60_000)} minutes.`);
    }

    const remaining = deadline - Date.now();
    const delay = Math.min(pollIntervalMs, remaining);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Resilience: per-seed retry
// ---------------------------------------------------------------------------

const MAX_SEED_RETRIES = 3;
const SEED_RETRY_BASE_DELAY_MS = 30_000;

type StudyMode = "pilot" | "full";

interface ParsedArgs {
  mode: StudyMode;
  resume: boolean;
  studyId?: string;
  count: number;
  seedPrefix: string;
  explicitSeeds?: string[];
}

interface StudySeedRecord {
  seed: string;
  status: "pending" | "in_progress" | "done";
  runId?: string;
  archiveDir: string;
  scenarioManifestPreparedAt?: string;
  counts?: RunManifest["counts"];
  metricsPath?: string;
  summaryPath?: string;
  pairBreakdownPath?: string;
  runManifestPath?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

interface StudyManifest {
  schemaVersion: "1.0.0";
  studyId: string;
  mode: StudyMode;
  createdAt: string;
  updatedAt: string;
  resumeSupported: true;
  validator: {
    url: string;
    gitSha: string;
    version?: string;
  };
  plan: {
    seeds: string[];
    count: number;
    seedPrefix: string;
    explicitSeeds?: string[];
  };
  activeSeed?: string;
  completedSeeds: string[];
  seedRuns: StudySeedRecord[];
}

interface ArchivedRunSummary {
  seed: string;
  runId: string;
  mode: StudyMode;
  validator: RunManifest["validator"];
  counts: RunManifest["counts"];
  metrics: {
    fallacyStrictPairAccuracy: number;
    fallacyEvaluatedPairs: number;
    fallacyStrictPairSuccesses: number;
    ibmSpearman: number;
    ibmEvaluatedScenarios: number;
  };
  archivedPaths: {
    runManifest: string;
    metrics: string;
    summaryCsv: string;
    pairBreakdownCsv: string;
    rawDir: string;
    scenariosDir: string;
  };
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

export function parseStudyArgs(argv: string[]): ParsedArgs {
  let mode: StudyMode = "full";
  let resume = false;
  let studyId: string | undefined;
  let count = 10;
  let seedPrefix = "study-seed";
  let explicitSeeds: string[] | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--pilot":
        mode = "pilot";
        break;
      case "--resume":
        resume = true;
        break;
      case "--count":
        if (index + 1 >= argv.length) throw new Error("--count requires a value.");
        count = parsePositiveInteger(argv[index + 1], "--count");
        index += 1;
        break;
      case "--seed-prefix":
        if (index + 1 >= argv.length) throw new Error("--seed-prefix requires a value.");
        seedPrefix = argv[index + 1].trim();
        if (!seedPrefix) throw new Error("--seed-prefix cannot be empty.");
        index += 1;
        break;
      case "--seeds":
        if (index + 1 >= argv.length) throw new Error("--seeds requires a comma-separated value.");
        explicitSeeds = argv[index + 1]
          .split(",")
          .map((seed) => seed.trim())
          .filter(Boolean);
        if (explicitSeeds.length === 0) throw new Error("--seeds must include at least one seed.");
        count = explicitSeeds.length;
        index += 1;
        break;
      case "--study-id":
        if (index + 1 >= argv.length) throw new Error("--study-id requires a value.");
        studyId = argv[index + 1].trim();
        if (!studyId) throw new Error("--study-id cannot be empty.");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    mode,
    resume,
    studyId,
    count,
    seedPrefix,
    explicitSeeds,
  };
}

export function buildSeedList(args: ParsedArgs): string[] {
  if (args.explicitSeeds) {
    return args.explicitSeeds;
  }

  const width = Math.max(3, String(args.count).length);
  return Array.from({ length: args.count }, (_value, index) => `${args.seedPrefix}-${String(index + 1).padStart(width, "0")}`);
}

function buildStudyId(mode: StudyMode): string {
  return `study-${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

function studyManifestPath(studyId: string): string {
  return path.join(studiesDir, studyId, "manifest.json");
}

function studySummaryJsonPath(studyId: string): string {
  return path.join(studiesDir, studyId, "summary.json");
}

function studySummaryCsvPath(studyId: string): string {
  return path.join(studiesDir, studyId, "summary.csv");
}

function seedArchiveDir(studyId: string, seed: string): string {
  return path.join(studiesDir, studyId, "runs", seed);
}

async function writeStudyManifest(manifest: StudyManifest): Promise<void> {
  manifest.updatedAt = new Date().toISOString();
  await writeJsonAtomic(studyManifestPath(manifest.studyId), manifest);
}

async function loadStudyManifest(studyId?: string): Promise<StudyManifest> {
  if (studyId) {
    return readJsonFile<StudyManifest>(studyManifestPath(studyId));
  }

  if (!(await pathExists(studiesDir))) {
    throw new Error("Cannot resume study: results/studies does not exist.");
  }

  const entries = await fs.readdir(studiesDir, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const manifestPath = studyManifestPath(entry.name);
        if (!(await pathExists(manifestPath))) return undefined;
        const manifest = await readJsonFile<StudyManifest>(manifestPath);
        return manifest;
      }),
  );
  const manifests = candidates.filter((manifest): manifest is StudyManifest => manifest !== undefined);
  const latest = manifests.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1);
  if (!latest) {
    throw new Error("Cannot resume study: no study directories exist.");
  }
  return latest;
}

function createStudyManifest(args: ParsedArgs): StudyManifest {
  const validator = readValidatorConfig();
  const seeds = buildSeedList(args);
  const studyId = args.studyId ?? buildStudyId(args.mode);
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: "1.0.0",
    studyId,
    mode: args.mode,
    createdAt,
    updatedAt: createdAt,
    resumeSupported: true,
    validator: {
      url: validator.validatorUrl,
      gitSha: validator.validatorGitSha,
      version: validator.validatorVersion,
    },
    plan: {
      seeds,
      count: seeds.length,
      seedPrefix: args.seedPrefix,
      explicitSeeds: args.explicitSeeds,
    },
    completedSeeds: [],
    seedRuns: seeds.map((seed) => ({
      seed,
      status: "pending",
      archiveDir: seedArchiveDir(studyId, seed),
    })),
  };
}

function buildStudyRunConfig(manifest: StudyManifest, seed: string) {
  const prepareConfig = createPrepareConfig(seed);
  return {
    ...prepareConfig,
    validatorUrl: manifest.validator.url,
    validatorGitSha: manifest.validator.gitSha,
    validatorVersion: manifest.validator.version,
  };
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await ensureDir(path.dirname(targetDir));
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
}

async function copyFile(sourcePath: string, targetPath: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function readMetricsSnapshot(metricsPath: string): Promise<ArchivedRunSummary["metrics"]> {
  const metrics = await readJsonFile<{
    fallacyPairs?: { strictPairAccuracy?: { value?: number; successes?: number; trials?: number } };
    ibmAq?: { spearman?: { value?: number }; evaluatedScenarios?: number };
  }>(metricsPath);

  return {
    fallacyStrictPairAccuracy: metrics.fallacyPairs?.strictPairAccuracy?.value ?? Number.NaN,
    fallacyEvaluatedPairs: metrics.fallacyPairs?.strictPairAccuracy?.trials ?? 0,
    fallacyStrictPairSuccesses: metrics.fallacyPairs?.strictPairAccuracy?.successes ?? 0,
    ibmSpearman: metrics.ibmAq?.spearman?.value ?? Number.NaN,
    ibmEvaluatedScenarios: metrics.ibmAq?.evaluatedScenarios ?? 0,
  };
}

async function archiveCurrentRun(studyId: string, seed: string, manifest: RunManifest): Promise<ArchivedRunSummary> {
  const archiveDir = seedArchiveDir(studyId, seed);
  const scenariosArchiveDir = path.join(archiveDir, "scenarios");
  const resultsArchiveDir = path.join(archiveDir, "results");
  const checkpointSourcePath = path.join(resultsDir, "checkpoints", `${manifest.runId}.json`);
  const checkpointTargetPath = path.join(resultsArchiveDir, "checkpoints", `${manifest.runId}.json`);
  const rawSourceDir = path.join(resultsDir, manifest.mode, manifest.runId);
  const rawTargetDir = path.join(resultsArchiveDir, manifest.mode, manifest.runId);

  await ensureDir(archiveDir);
  await copyDirectory(scenariosDir, scenariosArchiveDir);
  await ensureDir(resultsArchiveDir);
  await copyFile(path.join(resultsDir, "run-manifest.json"), path.join(resultsArchiveDir, "run-manifest.json"));
  await copyFile(path.join(resultsDir, "metrics.json"), path.join(resultsArchiveDir, "metrics.json"));
  await copyFile(path.join(resultsDir, "summary.csv"), path.join(resultsArchiveDir, "summary.csv"));
  await copyFile(path.join(resultsDir, "pair-breakdown.csv"), path.join(resultsArchiveDir, "pair-breakdown.csv"));
  await copyFile(checkpointSourcePath, checkpointTargetPath);
  await copyDirectory(rawSourceDir, rawTargetDir);

  const metricsPath = path.join(resultsArchiveDir, "metrics.json");
  const summaryCsvPath = path.join(resultsArchiveDir, "summary.csv");
  const pairBreakdownCsvPath = path.join(resultsArchiveDir, "pair-breakdown.csv");
  const runManifestPath = path.join(resultsArchiveDir, "run-manifest.json");
  const metrics = await readMetricsSnapshot(metricsPath);

  return {
    seed,
    runId: manifest.runId,
    mode: manifest.mode,
    validator: manifest.validator,
    counts: manifest.counts,
    metrics,
    archivedPaths: {
      runManifest: runManifestPath,
      metrics: metricsPath,
      summaryCsv: summaryCsvPath,
      pairBreakdownCsv: pairBreakdownCsvPath,
      rawDir: path.join(rawTargetDir, "raw"),
      scenariosDir: scenariosArchiveDir,
    },
  };
}

function updateSeedRecord(manifest: StudyManifest, seed: string, update: Partial<StudySeedRecord>): void {
  const record = manifest.seedRuns.find((candidate) => candidate.seed === seed);
  if (!record) {
    throw new Error(`Study manifest corruption: seed ${seed} not found.`);
  }
  Object.assign(record, update);
}

function toSummaryCsv(rows: ArchivedRunSummary[]): string {
  const header = [
    "seed",
    "runId",
    "mode",
    "completed",
    "total",
    "benchmarkOutcomes",
    "transportFailures",
    "validatorSystemFailures",
    "fallacyStrictPairAccuracy",
    "fallacyEvaluatedPairs",
    "ibmSpearman",
    "ibmEvaluatedScenarios",
    "metricsPath",
  ];

  const body = rows.map((row) => [
    csvEscape(row.seed),
    csvEscape(row.runId),
    csvEscape(row.mode),
    csvEscape(row.counts.completed),
    csvEscape(row.counts.total),
    csvEscape(row.counts.benchmarkOutcomes),
    csvEscape(row.counts.transportFailures),
    csvEscape(row.counts.validatorSystemFailures),
    csvEscape(row.metrics.fallacyStrictPairAccuracy),
    csvEscape(row.metrics.fallacyEvaluatedPairs),
    csvEscape(row.metrics.ibmSpearman),
    csvEscape(row.metrics.ibmEvaluatedScenarios),
    csvEscape(row.archivedPaths.metrics),
  ]);

  return `${header.join(",")}\n${body.map((row) => row.join(",")).join("\n")}\n`;
}

export function buildAggregateStudySummary(manifest: StudyManifest, rows: ArchivedRunSummary[]) {
  const strictPairValues = rows
    .map((row) => row.metrics.fallacyStrictPairAccuracy)
    .filter((value) => Number.isFinite(value));
  const ibmValues = rows
    .map((row) => row.metrics.ibmSpearman)
    .filter((value) => Number.isFinite(value));

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    studyId: manifest.studyId,
    mode: manifest.mode,
    validator: manifest.validator,
    seedsRequested: manifest.plan.seeds.length,
    seedsCompleted: rows.length,
    runs: rows,
    aggregate: {
      fallacyStrictPairAccuracy: {
        mean: strictPairValues.length > 0 ? mean(strictPairValues) : Number.NaN,
        sampleStdDev: strictPairValues.length > 1 ? sampleStandardDeviation(strictPairValues) : Number.NaN,
        min: strictPairValues.length > 0 ? Math.min(...strictPairValues) : Number.NaN,
        max: strictPairValues.length > 0 ? Math.max(...strictPairValues) : Number.NaN,
      },
      ibmSpearman: {
        mean: ibmValues.length > 0 ? mean(ibmValues) : Number.NaN,
        sampleStdDev: ibmValues.length > 1 ? sampleStandardDeviation(ibmValues) : Number.NaN,
        min: ibmValues.length > 0 ? Math.min(...ibmValues) : Number.NaN,
        max: ibmValues.length > 0 ? Math.max(...ibmValues) : Number.NaN,
      },
      totals: rows.reduce(
        (accumulator, row) => {
          accumulator.completed += row.counts.completed;
          accumulator.benchmarkOutcomes += row.counts.benchmarkOutcomes;
          accumulator.transportFailures += row.counts.transportFailures;
          accumulator.validatorSystemFailures += row.counts.validatorSystemFailures;
          return accumulator;
        },
        {
          completed: 0,
          benchmarkOutcomes: 0,
          transportFailures: 0,
          validatorSystemFailures: 0,
        },
      ),
    },
  };
}

async function writeStudySummary(manifest: StudyManifest): Promise<void> {
  const completedRows: ArchivedRunSummary[] = [];
  for (const record of manifest.seedRuns.filter((seedRun) => seedRun.status === "done")) {
    if (!record.runManifestPath || !record.metricsPath || !record.summaryPath || !record.pairBreakdownPath || !record.runId || !record.counts) {
      throw new Error(`Study manifest corruption: seed ${record.seed} is done but archived paths are incomplete.`);
    }

    const archivedRunManifest = await readJsonFile<RunManifest>(record.runManifestPath);

    completedRows.push({
      seed: record.seed,
      runId: record.runId,
      mode: manifest.mode,
      validator: archivedRunManifest.validator,
      counts: record.counts,
      metrics: await readMetricsSnapshot(record.metricsPath),
      archivedPaths: {
        runManifest: record.runManifestPath,
        metrics: record.metricsPath,
        summaryCsv: record.summaryPath,
        pairBreakdownCsv: record.pairBreakdownPath,
        rawDir: path.join(record.archiveDir, "results", manifest.mode, record.runId, "raw"),
        scenariosDir: path.join(record.archiveDir, "scenarios"),
      },
    });
  }

  const summary = buildAggregateStudySummary(manifest, completedRows);
  await writeJsonAtomic(studySummaryJsonPath(manifest.studyId), summary);
  await writeTextAtomic(studySummaryCsvPath(manifest.studyId), toSummaryCsv(completedRows));
}

async function loadMatchingTopLevelRun(
  manifest: StudyManifest,
  seed: string,
  expectedRunId?: string,
): Promise<RunManifest | undefined> {
  if (!expectedRunId) {
    return undefined;
  }

  const topLevelRunManifestPath = path.join(resultsDir, "run-manifest.json");
  if (!(await pathExists(topLevelRunManifestPath))) {
    return undefined;
  }

  const topLevelManifest = await readJsonFile<RunManifest>(topLevelRunManifestPath);
  if (
    topLevelManifest.mode === manifest.mode &&
    topLevelManifest.validator.gitSha === manifest.validator.gitSha &&
    topLevelManifest.environment.benchmarkSeed === seed &&
    topLevelManifest.runId === expectedRunId
  ) {
    return topLevelManifest;
  }

  return undefined;
}

async function resetTopLevelBenchmarkOutputs(): Promise<void> {
  await Promise.all([
    fs.rm(path.join(resultsDir, "run-manifest.json"), { force: true }),
    fs.rm(path.join(resultsDir, "metrics.json"), { force: true }),
    fs.rm(path.join(resultsDir, "summary.csv"), { force: true }),
    fs.rm(path.join(resultsDir, "pair-breakdown.csv"), { force: true }),
    fs.rm(path.join(resultsDir, "checkpoints"), { recursive: true, force: true }),
    fs.rm(path.join(resultsDir, "pilot"), { recursive: true, force: true }),
    fs.rm(path.join(resultsDir, "full"), { recursive: true, force: true }),
  ]);
}

async function runSeed(manifest: StudyManifest, seed: string): Promise<void> {
  manifest.activeSeed = seed;
  updateSeedRecord(manifest, seed, {
    status: "in_progress",
    startedAt: new Date().toISOString(),
    error: undefined,
  });
  await writeStudyManifest(manifest);

  const currentRecord = manifest.seedRuns.find((seedRun) => seedRun.seed === seed);
  const existingTopLevelRun = await loadMatchingTopLevelRun(manifest, seed, currentRecord?.runId);
  const prepareConfig = createPrepareConfig(seed);
  const runConfig = buildStudyRunConfig(manifest, seed);

  const handleProgress = async (runManifest: RunManifest) => {
    updateSeedRecord(manifest, seed, {
      runId: runManifest.runId,
      scenarioManifestPreparedAt: runManifest.scenarioManifestPreparedAt,
      counts: runManifest.counts,
    });
    await writeStudyManifest(manifest);
  };

  let latestManifest: RunManifest;

  if (!existingTopLevelRun) {
    await resetTopLevelBenchmarkOutputs();
    await prepareScenarios(prepareConfig);
    latestManifest = await runBenchmark({
      mode: manifest.mode,
      resume: false,
      validatorUrl: runConfig.validatorUrl,
      validatorGitSha: runConfig.validatorGitSha,
      validatorVersion: runConfig.validatorVersion,
      benchmarkSeed: runConfig.benchmarkSeed,
      onProgress: handleProgress,
    });
  } else if (!existingTopLevelRun.completedAt) {
    updateSeedRecord(manifest, seed, {
      runId: existingTopLevelRun.runId,
      scenarioManifestPreparedAt: existingTopLevelRun.scenarioManifestPreparedAt,
      counts: existingTopLevelRun.counts,
    });
    await writeStudyManifest(manifest);
    latestManifest = await runBenchmark({
      mode: manifest.mode,
      resume: true,
      validatorUrl: runConfig.validatorUrl,
      validatorGitSha: runConfig.validatorGitSha,
      validatorVersion: runConfig.validatorVersion,
      benchmarkSeed: runConfig.benchmarkSeed,
      onProgress: handleProgress,
    });
  } else {
    latestManifest = existingTopLevelRun;
    updateSeedRecord(manifest, seed, {
      runId: existingTopLevelRun.runId,
      scenarioManifestPreparedAt: existingTopLevelRun.scenarioManifestPreparedAt,
      counts: existingTopLevelRun.counts,
    });
    await writeStudyManifest(manifest);
  }

  const { manifest: joinedManifest, scenarios, results } = await loadJoinedResults();
  await generateAnalysisArtifacts({ manifest: joinedManifest, scenarios, results });
  const archived = await archiveCurrentRun(manifest.studyId, seed, joinedManifest);

  updateSeedRecord(manifest, seed, {
    status: "done",
    runId: archived.runId,
    scenarioManifestPreparedAt: joinedManifest.scenarioManifestPreparedAt,
    counts: joinedManifest.counts,
    metricsPath: archived.archivedPaths.metrics,
    summaryPath: archived.archivedPaths.summaryCsv,
    pairBreakdownPath: archived.archivedPaths.pairBreakdownCsv,
    runManifestPath: archived.archivedPaths.runManifest,
    completedAt: new Date().toISOString(),
    error: undefined,
  });
  if (!manifest.completedSeeds.includes(seed)) {
    manifest.completedSeeds.push(seed);
  }
  manifest.activeSeed = undefined;
  await writeStudyManifest(manifest);
  await writeStudySummary(manifest);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

async function executeStudy(args: ParsedArgs): Promise<StudyManifest> {
  const manifest = args.resume ? await loadStudyManifest(args.studyId) : createStudyManifest(args);

  if (!args.resume) {
    await writeStudyManifest(manifest);
    await writeStudySummary(manifest);
  }

  const pendingSeeds = manifest.seedRuns
    .filter((seedRun) => seedRun.status !== "done")
    .map((seedRun) => seedRun.seed);

  for (const seed of pendingSeeds) {
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_SEED_RETRIES; attempt++) {
      try {
        console.log(`[${manifest.studyId}] Waiting for validator at ${manifest.validator.url}...`);
        await waitForValidator(manifest.validator.url);

        console.log(`[${manifest.studyId}] Running seed ${seed} (attempt ${attempt}/${MAX_SEED_RETRIES})...`);
        await runSeed(manifest, seed);
        succeeded = true;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        updateSeedRecord(manifest, seed, {
          status: "pending",
          error: `Attempt ${attempt}/${MAX_SEED_RETRIES}: ${message}`,
        });
        manifest.activeSeed = seed;
        await writeStudyManifest(manifest);

        if (attempt < MAX_SEED_RETRIES) {
          const delay = SEED_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          console.error(`[${manifest.studyId}] Seed ${seed} failed (attempt ${attempt}/${MAX_SEED_RETRIES}): ${message}`);
          console.error(`[${manifest.studyId}] Retrying in ${formatDuration(delay)}...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          console.error(`[${manifest.studyId}] Seed ${seed} failed after ${MAX_SEED_RETRIES} attempts: ${message}`);
        }
      }
    }

    if (!succeeded) {
      updateSeedRecord(manifest, seed, {
        status: "pending",
        error: `All ${MAX_SEED_RETRIES} attempts exhausted.`,
      });
      manifest.activeSeed = undefined;
      await writeStudyManifest(manifest);
      throw new Error(`Seed ${seed} failed after ${MAX_SEED_RETRIES} attempts. Study paused — resume with --resume.`);
    }
  }

  manifest.activeSeed = undefined;
  await writeStudyManifest(manifest);
  await writeStudySummary(manifest);
  return manifest;
}

async function main(): Promise<void> {
  const args = parseStudyArgs(process.argv.slice(2));
  const manifest = await executeStudy(args);
  console.log(
    `Study ${manifest.studyId} completed ${manifest.completedSeeds.length}/${manifest.plan.seeds.length} seeds. Summary: ${studySummaryJsonPath(manifest.studyId)}`,
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const currentModulePath = fileURLToPath(import.meta.url);

if (entryPath === currentModulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
