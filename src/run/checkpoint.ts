import path from "node:path";
import { ensureDir, pathExists, readJsonFile, writeJsonAtomic } from "../lib/io.js";
import { checkpointsDir } from "../lib/paths.js";
import type { RunCheckpoint, RunManifest } from "../types.js";

export function checkpointPath(runId: string): string {
  return path.join(checkpointsDir, `${runId}.json`);
}

export async function loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
  const targetPath = checkpointPath(runId);
  if (!(await pathExists(targetPath))) {
    return undefined;
  }

  return readJsonFile<RunCheckpoint>(targetPath);
}

export async function writeCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
  await ensureDir(checkpointsDir);
  await writeJsonAtomic(checkpointPath(checkpoint.runId), checkpoint);
}

export function createCheckpointFromManifest(manifest: RunManifest): RunCheckpoint {
  return {
    schemaVersion: "1.0.0",
    runId: manifest.runId,
    mode: manifest.mode,
    scenarioManifestPath: manifest.scenarioManifestPath,
    scenarioManifestPreparedAt: manifest.scenarioManifestPreparedAt,
    scenarioIds: manifest.scenarioIds,
    resultPaths: manifest.resultPaths,
    completedScenarioIds: [],
    validator: manifest.validator,
    environment: manifest.environment,
    startedAt: manifest.startedAt,
    updatedAt: manifest.startedAt,
  };
}

export function selectPendingScenarioIds(
  scenarioIds: readonly string[],
  completedScenarioIds: readonly string[],
): string[] {
  const completed = new Set(completedScenarioIds);
  return scenarioIds.filter((scenarioId) => !completed.has(scenarioId));
}
