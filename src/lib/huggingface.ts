import { parse } from "csv-parse/sync";

export interface DatasetMetadata {
  datasetId: string;
  datasetRevision?: string;
  datasetUrl: string;
}

export interface DatasetRow<T> {
  rowIdx: number;
  row: T;
}

function datasetPath(datasetId: string): string {
  return datasetId.split("/").map(encodeURIComponent).join("/");
}

function buildHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    "user-agent": "elenchus-benchmark/0.1.0",
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchText(url: string, token?: string): Promise<string> {
  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function fetchJson<T>(url: string, token?: string): Promise<T> {
  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export async function fetchDatasetMetadata(
  datasetId: string,
  token?: string,
): Promise<DatasetMetadata> {
  const response = await fetchJson<{ sha?: string }>(
    `https://huggingface.co/api/datasets/${datasetPath(datasetId)}`,
    token,
  );

  return {
    datasetId,
    datasetRevision: response.sha,
    datasetUrl: `https://huggingface.co/datasets/${datasetPath(datasetId)}`,
  };
}

export async function fetchDatasetRows<T>(
  datasetId: string,
  config: string,
  split: string,
  token?: string,
): Promise<DatasetRow<T>[]> {
  const firstPage = await fetchJson<{
    rows: Array<{ row: T; row_idx: number }>;
    num_rows_total: number;
    num_rows_per_page: number;
  }>(
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=0&length=100`,
    token,
  );

  const rows = [...(firstPage.rows ?? []).map((item) => ({ rowIdx: item.row_idx, row: item.row }))];
  const total = firstPage.num_rows_total ?? rows.length;
  const pageSize = firstPage.num_rows_per_page ?? 100;

  for (let offset = rows.length; offset < total; offset += pageSize) {
    const page = await fetchJson<{
      rows: Array<{ row: T; row_idx: number }>;
    }>(
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(datasetId)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=${pageSize}`,
      token,
    );
    rows.push(...(page.rows ?? []).map((item) => ({ rowIdx: item.row_idx, row: item.row })));
  }

  return rows;
}

export async function fetchCsvRecords<T>(
  datasetId: string,
  fileName: string,
  token?: string,
): Promise<T[]> {
  const csvText = await fetchText(
    `https://huggingface.co/datasets/${datasetPath(datasetId)}/raw/main/${fileName}`,
    token,
  );

  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as T[];
}

export async function fetchJsonlRecords<T>(
  datasetId: string,
  fileName: string,
  token?: string,
): Promise<T[]> {
  const text = await fetchText(
    `https://huggingface.co/datasets/${datasetPath(datasetId)}/raw/main/${fileName}`,
    token,
  );

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}
