import crypto from "node:crypto";

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, value: string, length = 12): string {
  return `${prefix}-${sha256Hex(value).slice(0, length)}`;
}
