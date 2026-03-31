import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

export const projectRoot = path.resolve(currentDir, "../..");
export const scenariosDir = path.join(projectRoot, "scenarios");
export const resultsDir = path.join(projectRoot, "results");
export const checkpointsDir = path.join(resultsDir, "checkpoints");

export function resolveProjectPath(...segments: string[]): string {
  return path.join(projectRoot, ...segments);
}
