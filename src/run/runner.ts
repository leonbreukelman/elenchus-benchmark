import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NormalizedScenario, RunCheckpoint, RunManifest, RunResult, ValidatorResponse } from "../types.js";
import { describeEnvironment } from "../lib/config.js";
import { getGitShaIfAvailable } from "../lib/git.js";
import { cleanDirectory, ensureDir, pathExists, readJsonFile, writeJsonAtomic } from "../lib/io.js";
import { projectRoot, resolveProjectPath, resultsDir, scenariosDir } from "../lib/paths.js";
import {
  assertResumeCompatible,
  createCheckpointFromManifest,
  loadCheckpoint,
  selectPendingScenarioIds,
  writeCheckpoint,
} from "./checkpoint.js";
import { parseTerminalLog } from "./log-parser.js";

async function loadScenarioIds(): Promise<string[]> {
  const manifestPath = path.join(scenariosDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error("scenarios/manifest.json not found. Run `npm run prepare` first.");
  }

  const manifest = await readJsonFile<{ preparedAt: string; scenarios: { order: string[] } }>(manifestPath);
  if (!Array.isArray(manifest.scenarios?.order)) {
    throw new Error("Scenario manifest is invalid: missing scenarios.order.");
  }

  return manifest.scenarios.order;
}

async function loadScenario(scenarioId: string): Promise<NormalizedScenario> {
  return readJsonFile<NormalizedScenario>(path.join(scenariosDir, `${scenarioId}.json`));
}

function buildRunId(mode: "pilot" | "full"): string {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${mode}-${new Date().toISOString().replace(/[:.]/g, "-")}-${suffix}`;
}

function pilotSelection(scenarios: NormalizedScenario[]): NormalizedScenario[] {
  // Group fallacy scenarios by pairId so we can select complete pairs.
  const pairGroups = new Map<string, { control?: NormalizedScenario; attack?: NormalizedScenario }>();
  for (const scenario of scenarios) {
    if (scenario.source !== "fallacy-pairs" || !scenario.pairId) continue;
    const group = pairGroups.get(scenario.pairId) ?? {};
    if (scenario.pairRole === "control") group.control = scenario;
    else if (scenario.pairRole === "attack") group.attack = scenario;
    pairGroups.set(scenario.pairId, group);
  }

  // Take the first 3 complete pairs (both control and attack present).
  const fallacy: NormalizedScenario[] = [];
  for (const group of pairGroups.values()) {
    if (fallacy.length >= 6) break;
    if (group.control && group.attack) {
      fallacy.push(group.control, group.attack);
    }
  }
  fallacy.sort((left, right) => left.id.localeCompare(right.id));

  const ibm = scenarios.filter((scenario) => scenario.source === "ibm-aq").slice(0, 4);
  return [...fallacy, ...ibm];
}

async function createRunManifest(params: {
  runId: string;
  mode: "pilot" | "full";
  scenarioIds: string[];
  validatorUrl: string;
  validatorGitSha: string;
  validatorVersion?: string;
  benchmarkSeed: string;
}): Promise<RunManifest> {
  const scenarioManifest = await readJsonFile<{ preparedAt: string }>(path.join(scenariosDir, "manifest.json"));
  const benchmarkGitSha = await getGitShaIfAvailable(projectRoot);
  const validatorParser = parseTerminalLog(params.validatorGitSha, []);

  return {
    schemaVersion: "1.0.0",
    runId: params.runId,
    mode: params.mode,
    startedAt: new Date().toISOString(),
    resumed: false,
    scenarioManifestPath: resolveProjectPath("scenarios", "manifest.json"),
    scenarioManifestPreparedAt: scenarioManifest.preparedAt,
    scenarioIds: params.scenarioIds,
    resultPaths: {},
    validator: {
      url: params.validatorUrl,
      version: params.validatorVersion,
      gitSha: params.validatorGitSha,
      parserSupported: validatorParser.parserSupported,
    },
    environment: describeEnvironment(params.benchmarkSeed, benchmarkGitSha),
    counts: {
      total: params.scenarioIds.length,
      completed: 0,
      transportFailures: 0,
      validatorSystemFailures: 0,
      benchmarkOutcomes: 0,
    },
  };
}

async function invokeValidator(
  scenario: NormalizedScenario,
  validatorUrl: string,
): Promise<{ httpStatus?: number; response?: ValidatorResponse; error?: string; latencyMs: number }> {
  const endpoint = new URL("/api/v1/intercept", validatorUrl).toString();
  const start = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        traceId: scenario.id,
        context: scenario.context,
        proposedAction: scenario.proposedAction,
        reasoning: scenario.reasoning,
      }),
    });

    const latencyMs = Date.now() - start;
    const text = await response.text();

    if (!response.ok) {
      return {
        httpStatus: response.status,
        error: text || `HTTP ${response.status} ${response.statusText}`,
        latencyMs,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        httpStatus: response.status,
        error: `Validator returned non-JSON success response: ${text.slice(0, 300)}`,
        latencyMs,
      };
    }

    return {
      httpStatus: response.status,
      response: parsed as ValidatorResponse,
      latencyMs,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - start,
    };
  }
}

function buildRunResult(
  scenario: NormalizedScenario,
  invocation: Awaited<ReturnType<typeof invokeValidator>>,
  validator: { url: string; version?: string; gitSha: string },
): RunResult {
  const rawTerminalLog = invocation.response?.terminalLog ?? [];
  const parsedTerminalLog = parseTerminalLog(validator.gitSha, rawTerminalLog);

  if (invocation.error && invocation.httpStatus !== undefined) {
    return {
      scenarioId: scenario.id,
      source: scenario.source,
      evaluationMode: scenario.evaluationMode,
      traceId: scenario.id,
      validator,
      raw: {
        httpStatus: invocation.httpStatus,
        error: invocation.error,
      },
      rawTerminalLog,
      parsed: {
        latencyMs: invocation.latencyMs,
        systemFailure: false,
        failureClass: "http",
        outcomeCategory: "transport_failure",
        parserSupported: parsedTerminalLog.parserSupported,
      },
      timestamp: new Date().toISOString(),
    };
  }

  if (invocation.error && invocation.httpStatus === undefined) {
    return {
      scenarioId: scenario.id,
      source: scenario.source,
      evaluationMode: scenario.evaluationMode,
      traceId: scenario.id,
      validator,
      raw: {
        error: invocation.error,
      },
      rawTerminalLog,
      parsed: {
        latencyMs: invocation.latencyMs,
        systemFailure: false,
        failureClass: "network",
        outcomeCategory: "transport_failure",
        parserSupported: parsedTerminalLog.parserSupported,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const systemFailure = parsedTerminalLog.systemFailure;
  return {
    scenarioId: scenario.id,
    source: scenario.source,
    evaluationMode: scenario.evaluationMode,
    traceId: scenario.id,
    validator,
    raw: {
      httpStatus: invocation.httpStatus,
      response: invocation.response,
    },
    rawTerminalLog,
    parsed: {
      latencyMs: invocation.latencyMs,
      rounds: parsedTerminalLog.rounds,
      terminationReason: parsedTerminalLog.terminationReason,
      systemFailure,
      failureClass: parsedTerminalLog.failureClass,
      outcomeCategory: systemFailure ? "validator_system_failure" : "benchmark_outcome",
      parserSupported: parsedTerminalLog.parserSupported,
    },
    timestamp: new Date().toISOString(),
  };
}

function incrementCounts(manifest: RunManifest, result: RunResult): void {
  manifest.counts.completed += 1;
  switch (result.parsed.outcomeCategory) {
    case "transport_failure":
      manifest.counts.transportFailures += 1;
      break;
    case "validator_system_failure":
      manifest.counts.validatorSystemFailures += 1;
      break;
    case "benchmark_outcome":
      manifest.counts.benchmarkOutcomes += 1;
      break;
  }
}

async function writeRunManifest(manifest: RunManifest): Promise<void> {
  await writeJsonAtomic(path.join(resultsDir, "run-manifest.json"), manifest);
}

async function initializeRunDirectories(
  mode: "pilot" | "full",
  runId: string,
  preserveExisting = false,
): Promise<{ rawDir: string }> {
  const runRoot = path.join(resultsDir, mode, runId);
  const rawDir = path.join(runRoot, "raw");
  if (!preserveExisting) {
    await cleanDirectory(runRoot);
  }
  await ensureDir(rawDir);
  return { rawDir };
}

const VALID_OUTCOME_CATEGORIES = new Set<string>([
  "benchmark_outcome",
  "validator_system_failure",
  "transport_failure",
]);

/**
 * Reconciles manifest.resultPaths and manifest.counts from checkpoint state.
 *
 * When a run is interrupted after writeCheckpoint() but before writeRunManifest(),
 * the checkpoint may contain completed scenario entries that are absent from the
 * manifest. This function closes that gap by reading each such result file and
 * incorporating it into the manifest. Throws on any sign of corruption so that
 * stale or missing data is surfaced explicitly rather than silently skipped.
 *
 * If `persistPath` is provided and reconciliation added any entries, the corrected
 * manifest is written atomically to that path before returning, ensuring persisted
 * state is structurally reconciled before the run loop continues.
 */
export async function reconcileManifestFromCheckpoint(
  manifest: RunManifest,
  checkpoint: RunCheckpoint,
  persistPath?: string,
): Promise<void> {
  const manifestCompleted = new Set(Object.keys(manifest.resultPaths));
  let changed = false;

  for (const scenarioId of checkpoint.completedScenarioIds) {
    if (manifestCompleted.has(scenarioId)) continue;

    const resultPath = checkpoint.resultPaths[scenarioId];
    if (!resultPath) {
      throw new Error(
        `Resume corruption: checkpoint lists scenario ${scenarioId} as completed but checkpoint.resultPaths has no entry for it.`,
      );
    }

    if (!(await pathExists(resultPath))) {
      throw new Error(
        `Resume corruption: checkpoint lists scenario ${scenarioId} as completed but result file does not exist: ${resultPath}`,
      );
    }

    let result: RunResult;
    try {
      result = await readJsonFile<RunResult>(resultPath);
    } catch (error) {
      throw new Error(
        `Resume corruption: failed to read result file for scenario ${scenarioId} at ${resultPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (result.scenarioId !== scenarioId) {
      throw new Error(
        `Resume corruption: result file for scenario ${scenarioId} has mismatched scenarioId "${result.scenarioId}" at ${resultPath}`,
      );
    }

    if (!result.parsed?.outcomeCategory || !VALID_OUTCOME_CATEGORIES.has(result.parsed.outcomeCategory as string)) {
      throw new Error(
        `Resume corruption: result file for scenario ${scenarioId} has invalid outcomeCategory "${result.parsed?.outcomeCategory}" at ${resultPath}`,
      );
    }

    manifest.resultPaths[scenarioId] = resultPath;
    incrementCounts(manifest, result);
    changed = true;
  }

  if (changed && persistPath !== undefined) {
    await writeJsonAtomic(persistPath, manifest);
  }
}

export async function runBenchmark(config: {
  mode: "pilot" | "full";
  resume: boolean;
  validatorUrl: string;
  validatorGitSha: string;
  validatorVersion?: string;
  benchmarkSeed: string;
  onProgress?: (manifest: RunManifest) => void | Promise<void>;
}): Promise<RunManifest> {
  const scenarioIds = await loadScenarioIds();
  const allScenarios = await Promise.all(scenarioIds.map((id) => loadScenario(id)));
  const selectedScenarios = config.mode === "pilot" ? pilotSelection(allScenarios) : allScenarios;

  if (selectedScenarios.length === 0) {
    throw new Error("No scenarios available to run.");
  }

  let manifest: RunManifest;
  let checkpoint: RunCheckpoint;

  if (config.resume) {
    const latestPath = path.join(resultsDir, "run-manifest.json");
    if (!(await pathExists(latestPath))) {
      throw new Error("Cannot resume: results/run-manifest.json does not exist.");
    }
    manifest = await readJsonFile<RunManifest>(latestPath);
    assertResumeCompatible(manifest, config.mode, config.validatorGitSha);
    checkpoint = (await loadCheckpoint(manifest.runId)) ?? createCheckpointFromManifest(manifest);
    manifest.resumed = true;
    await reconcileManifestFromCheckpoint(manifest, checkpoint, latestPath);
    await initializeRunDirectories(manifest.mode, manifest.runId, true);
  } else {
    const runId = buildRunId(config.mode);
    manifest = await createRunManifest({
      runId,
      mode: config.mode,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
      validatorUrl: config.validatorUrl,
      validatorGitSha: config.validatorGitSha,
      validatorVersion: config.validatorVersion,
      benchmarkSeed: config.benchmarkSeed,
    });
    checkpoint = createCheckpointFromManifest(manifest);
    await initializeRunDirectories(config.mode, runId, false);
  }

  await writeCheckpoint(checkpoint);
  await writeRunManifest(manifest);
  if (config.onProgress) {
    await config.onProgress(structuredClone(manifest));
  }

  const { rawDir } = await initializeRunDirectories(manifest.mode, manifest.runId, true);
  const scenariosById = new Map(selectedScenarios.map((scenario) => [scenario.id, scenario]));
  const scenarioIdOrder = config.resume ? manifest.scenarioIds : selectedScenarios.map((scenario) => scenario.id);

  for (const scenarioId of selectPendingScenarioIds(scenarioIdOrder, checkpoint.completedScenarioIds)) {
    const scenario = scenariosById.get(scenarioId);
    if (!scenario) {
      throw new Error(`Scenario ${scenarioId} referenced by the run manifest is missing from scenarios/*.json.`);
    }

    const invocation = await invokeValidator(scenario, config.validatorUrl);
    const result = buildRunResult(scenario, invocation, {
      url: config.validatorUrl,
      version: config.validatorVersion,
      gitSha: config.validatorGitSha,
    });

    const resultPath = path.join(rawDir, `${scenario.id}.json`);
    await writeJsonAtomic(resultPath, result);
    manifest.resultPaths[scenario.id] = resultPath;
    checkpoint.resultPaths[scenario.id] = resultPath;
    checkpoint.completedScenarioIds.push(scenario.id);
    checkpoint.updatedAt = new Date().toISOString();

    incrementCounts(manifest, result);
    await writeCheckpoint(checkpoint);
    await writeRunManifest(manifest);
    if (config.onProgress) {
      await config.onProgress(structuredClone(manifest));
    }
  }

  manifest.completedAt = new Date().toISOString();
  await writeRunManifest(manifest);
  if (config.onProgress) {
    await config.onProgress(structuredClone(manifest));
  }
  return manifest;
}

export async function loadJoinedResults(): Promise<{
  manifest: RunManifest;
  scenarios: NormalizedScenario[];
  results: RunResult[];
}> {
  const manifestPath = path.join(resultsDir, "run-manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error("results/run-manifest.json not found. Run a benchmark first.");
  }

  const manifest = await readJsonFile<RunManifest>(manifestPath);
  const scenarios = await Promise.all(manifest.scenarioIds.map((scenarioId) => loadScenario(scenarioId)));
  const results = await Promise.all(
    Object.values(manifest.resultPaths).map((resultPath) => readJsonFile<RunResult>(resultPath)),
  );

  return { manifest, scenarios, results };
}

export async function resetResults(): Promise<void> {
  await fs.rm(resultsDir, { recursive: true, force: true });
}
