import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32 — fast, good quality, no external deps)
// ---------------------------------------------------------------------------

function seedToUint32(seed: string): number {
  // djb2 hash of the seed string → uint32
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: string): () => number {
  let s = seedToUint32(seed);
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic shuffle in-place (Fisher–Yates).
export function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Sample n items without replacement, deterministically.
export function sample<T>(arr: T[], n: number, rng: () => number): T[] {
  const copy = arr.slice();
  shuffle(copy, rng);
  return copy.slice(0, n);
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

// ---------------------------------------------------------------------------
// Content hash for stable IDs
// ---------------------------------------------------------------------------

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// HF datasets-server fetch helper
// ---------------------------------------------------------------------------

export interface HFRow {
  row_idx: number;
  row: Record<string, unknown>;
}

export interface HFRowsResponse {
  features: Array<{ name: string; feature_idx: number }>;
  rows: HFRow[];
  num_rows_total?: number;
}

const HF_BASE = "https://datasets-server.huggingface.co";

export async function fetchHFRows(
  dataset: string,
  config: string,
  split: string,
  offset: number,
  length: number,
  token?: string
): Promise<HFRowsResponse> {
  const url = `${HF_BASE}/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `HF API error for ${dataset}: HTTP ${resp.status} ${resp.statusText}. ${body}`
    );
  }
  return (await resp.json()) as HFRowsResponse;
}

export async function fetchAllHFRows(
  dataset: string,
  config: string,
  split: string,
  maxRows: number,
  batchSize = 100,
  token?: string
): Promise<HFRow[]> {
  const all: HFRow[] = [];
  let offset = 0;
  let total: number | undefined;

  while (all.length < maxRows) {
    const remaining = maxRows - all.length;
    const length = Math.min(batchSize, remaining);
    const resp = await fetchHFRows(dataset, config, split, offset, length, token);

    if (total === undefined && resp.num_rows_total !== undefined) {
      total = resp.num_rows_total;
    }

    all.push(...resp.rows);
    offset += resp.rows.length;

    if (resp.rows.length < length) break; // end of dataset
    if (total !== undefined && all.length >= total) break;
  }

  return all;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvEscape).join(",");
}
