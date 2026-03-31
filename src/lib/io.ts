import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextAtomic(targetPath: string, text: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  const tempPath = `${targetPath}.tmp`;
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, targetPath);
}

export async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  await writeTextAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonFile<T>(targetPath: string): Promise<T> {
  const raw = await fs.readFile(targetPath, "utf8");
  return JSON.parse(raw) as T;
}

export async function cleanDirectory(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}

export function csvEscape(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) {
    return "";
  }

  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}
