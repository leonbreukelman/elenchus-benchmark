import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { NormalizedScenario, RunCheckpoint, RunManifest, RunResult, ValidatorResponse } from "../types.js";
import { describeEnvironment } from "../lib/config.js";
import { getGitShaIfAvailable } from "../lib/git.js";
import { cleanDirectory, ensureDir, pathExists, readJsonFile, writeJsonAtomic } from "../lib/io.js";
import { projectRoot, resolveProjectPath, resultsDir, scenariosDir } from "../lib/paths.js";
import {
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
  const fallacy = scenarios.filter((scenario) => scenario.source === "fallacy-pairs").slice(0, 6);
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

export async function runBenchmark(config: {
  mode: "pilot" | "full";
  resume: boolean;
  validatorUrl: string;
  validatorGitSha: string;
  validatorVersion?: string;
  benchmarkSeed: string;
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
    checkpoint = (await loadCheckpoint(manifest.runId)) ?? createCheckpointFromManifest(manifest);
    manifest.resumed = true;
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
  }

  manifest.completedAt = new Date().toISOString();
  await writeRunManifest(manifest);
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
