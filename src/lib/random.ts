import { sha256Hex } from "./hash.js";

function createState(seed: string): number {
  const fragment = sha256Hex(seed).slice(0, 16);
  return Number.parseInt(fragment, 16) >>> 0;
}

export function createSeededRng(seed: string, namespace = ""): () => number {
  let state = createState(`${seed}::${namespace}`) || 0x6d2b79f5;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleDeterministic<T>(values: readonly T[], seed: string, namespace = ""): T[] {
  const rng = createSeededRng(seed, namespace);
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

export function sampleDeterministic<T>(
  values: readonly T[],
  count: number,
  seed: string,
  namespace = "",
): T[] {
  return shuffleDeterministic(values, seed, namespace).slice(0, Math.max(0, count));
}
