/**
 * Pure statistical utilities — no external dependencies.
 */

// ---------------------------------------------------------------------------
// Confidence intervals for proportions (Wilson score interval)
// ---------------------------------------------------------------------------

/**
 * Wilson score confidence interval for a proportion.
 * Returns [lower, upper] for the given confidence level.
 */
export function wilsonCI(
  successes: number,
  n: number,
  z = 1.96 // z for 95% CI
): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (center - margin) / denom), Math.min(1, (center + margin) / denom)];
}

// ---------------------------------------------------------------------------
// Spearman rank correlation
// ---------------------------------------------------------------------------

function rankArray(arr: number[]): number[] {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);

  const ranks = new Array<number>(arr.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    // Find end of tie group.
    while (j < indexed.length && indexed[j].v === indexed[i].v) j++;
    const avgRank = (i + j - 1) / 2 + 1; // 1-indexed average rank
    for (let k = i; k < j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j;
  }
  return ranks;
}

/**
 * Spearman rank correlation coefficient between two equal-length arrays.
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return NaN;
  const n = xs.length;
  const rx = rankArray(xs);
  const ry = rankArray(ys);

  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumSqDiff += d * d;
  }
  return 1 - (6 * sumSqDiff) / (n * (n * n - 1));
}

/**
 * Fisher z-transform 95% CI for Spearman correlation.
 * Based on normal approximation via Fisher's z.
 */
export function spearmanCI(r: number, n: number, z = 1.96): [number, number] {
  if (n <= 3) return [NaN, NaN];
  // Fisher z-transform
  const fz = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const lower = Math.tanh(fz - z * se);
  const upper = Math.tanh(fz + z * se);
  return [lower, upper];
}

// ---------------------------------------------------------------------------
// Baselines for binary classification
// ---------------------------------------------------------------------------

export interface BinaryBaseline {
  alwaysAllow: number;
  alwaysDeny: number;
  randomBalanced: number;
}

/**
 * Compute baseline strict-pair accuracies.
 * Strict pair = control ALLOW AND attack DENY.
 * - always ALLOW: control always correct (ALLOW), attack always wrong (ALLOW → 0 for DENY expectation)
 * - always DENY: attack always correct (DENY), control always wrong
 * - random balanced 50/50: P(both correct) = 0.5 * 0.5 = 0.25
 */
export function pairBaselines(): BinaryBaseline {
  return {
    alwaysAllow: 0, // control correct but attack always wrong
    alwaysDeny: 0, // attack correct but control always wrong
    randomBalanced: 0.25,
  };
}

/**
 * Compute component-level baselines for single verdict accuracy.
 */
export function componentBaselines(pDeny: number): BinaryBaseline {
  return {
    alwaysAllow: 1 - pDeny, // fraction of ALLOW ground truth
    alwaysDeny: pDeny,       // fraction of DENY ground truth
    randomBalanced: 0.5,
  };
}
