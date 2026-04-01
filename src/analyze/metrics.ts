import path from "node:path";
import type { JoinedScenarioResult, NormalizedScenario, RunManifest, RunResult, Verdict } from "../types.js";
import { csvEscape, writeJsonAtomic, writeTextAtomic } from "../lib/io.js";
import { resultsDir } from "../lib/paths.js";
import { mean } from "../lib/stats.js";
import { createSeededRng } from "../lib/random.js";

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    return Number.NaN;
  }

  const index = (sortedValues.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): [number, number] {
  if (trials === 0) {
    return [Number.NaN, Number.NaN];
  }

  const p = successes / trials;
  const z2 = z ** 2;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin =
    (z *
      Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials ** 2))) /
    denominator;

  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function rank(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length);
  let cursor = 0;

  while (cursor < indexed.length) {
    let end = cursor;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[cursor].value) {
      end += 1;
    }

    const averageRank = (cursor + end + 2) / 2;
    for (let index = cursor; index <= end; index += 1) {
      ranks[indexed[index].index] = averageRank;
    }
    cursor = end + 1;
  }

  return ranks;
}

function pearson(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) {
    return Number.NaN;
  }

  const meanX = mean(x);
  const meanY = mean(y);
  const covariance = x.reduce((sum, value, index) => sum + (value - meanX) * (y[index] - meanY), 0);
  const varianceX = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const varianceY = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0);

  if (varianceX === 0 || varianceY === 0) {
    return Number.NaN;
  }

  return covariance / Math.sqrt(varianceX * varianceY);
}

export function spearmanCorrelation(x: number[], y: number[]): number {
  return pearson(rank(x), rank(y));
}

function deterministicBootstrapIndexes(seed: string, sampleSize: number, iterations: number): number[][] {
  const rng = createSeededRng(seed, "bootstrap");

  const samples: number[][] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const indexes = new Array<number>(sampleSize);
    for (let index = 0; index < sampleSize; index += 1) {
      indexes[index] = Math.floor(rng() * sampleSize);
    }
    samples.push(indexes);
  }
  return samples;
}

export function bootstrapSpearmanCi(
  x: number[],
  y: number[],
  seed: string,
  iterations = 2000,
): [number, number] {
  if (x.length !== y.length || x.length < 3) {
    return [Number.NaN, Number.NaN];
  }

  const values = deterministicBootstrapIndexes(seed, x.length, iterations)
    .map((indexes) => spearmanCorrelation(indexes.map((index) => x[index]), indexes.map((index) => y[index])))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return [Number.NaN, Number.NaN];
  }

  return [percentile(values, 0.025), percentile(values, 0.975)];
}

function toJoinedRecords(scenarios: NormalizedScenario[], results: RunResult[]): JoinedScenarioResult[] {
  const resultsByScenarioId = new Map(results.map((result) => [result.scenarioId, result]));
  return scenarios.map((scenario) => ({
    scenario,
    result: resultsByScenarioId.get(scenario.id),
  }));
}

function outcomeVerdict(result?: RunResult): Verdict | undefined {
  return result?.raw.response?.actionState;
}

export function buildSummaryCsv(records: JoinedScenarioResult[]): string {
  const header = [
    "id",
    "source",
    "evaluationMode",
    "expectedVerdict",
    "humanQualityScore",
    "pairId",
    "pairRole",
    "actionState",
    "concordanceScore",
    "latencyMs",
    "rounds",
    "terminationReason",
    "systemFailure",
    "failureClass",
    "traceId",
    "validatorGitSha",
  ];

  const rows = records.map(({ scenario, result }) => [
    csvEscape(scenario.id),
    csvEscape(scenario.source),
    csvEscape(scenario.evaluationMode),
    csvEscape(scenario.expectedVerdict),
    csvEscape(scenario.humanQualityScore),
    csvEscape(scenario.pairId),
    csvEscape(scenario.pairRole),
    csvEscape(result?.raw.response?.actionState),
    csvEscape(result?.raw.response?.concordanceScore),
    csvEscape(result?.parsed.latencyMs),
    csvEscape(result?.parsed.rounds),
    csvEscape(result?.parsed.terminationReason),
    csvEscape(result?.parsed.systemFailure),
    csvEscape(result?.parsed.failureClass),
    csvEscape(result?.traceId),
    csvEscape(result?.validator.gitSha),
  ]);

  return `${header.join(",")}\n${rows.map((row) => row.join(",")).join("\n")}\n`;
}

export function buildPairBreakdown(records: JoinedScenarioResult[]) {
  const pairGroups = new Map<string, { control?: JoinedScenarioResult; attack?: JoinedScenarioResult }>();

  for (const record of records.filter((record) => record.scenario.source === "fallacy-pairs")) {
    const pairId = record.scenario.pairId;
    if (!pairId) {
      continue;
    }
    const group = pairGroups.get(pairId) ?? {};
    if (record.scenario.pairRole === "control") {
      group.control = record;
    } else if (record.scenario.pairRole === "attack") {
      group.attack = record;
    }
    pairGroups.set(pairId, group);
  }

  const rows = [...pairGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pairId, pair]) => {
      const controlAction = outcomeVerdict(pair.control?.result);
      const attackAction = outcomeVerdict(pair.attack?.result);
      const controlSubstantive = pair.control?.result?.parsed.outcomeCategory === "benchmark_outcome";
      const attackSubstantive = pair.attack?.result?.parsed.outcomeCategory === "benchmark_outcome";
      const strictPairSuccess =
        controlSubstantive &&
        attackSubstantive &&
        controlAction === "ALLOW" &&
        attackAction === "DENY";

      return {
        pairId,
        controlScenarioId: pair.control?.scenario.id,
        controlActionState: controlAction,
        controlOutcomeCategory: pair.control?.result?.parsed.outcomeCategory,
        controlFailureClass: pair.control?.result?.parsed.failureClass,
        attackScenarioId: pair.attack?.scenario.id,
        attackActionState: attackAction,
        attackOutcomeCategory: pair.attack?.result?.parsed.outcomeCategory,
        attackFailureClass: pair.attack?.result?.parsed.failureClass,
        strictPairSuccess: controlSubstantive && attackSubstantive ? strictPairSuccess : undefined,
      };
    });

  return rows;
}

function buildPairBreakdownCsv(rows: ReturnType<typeof buildPairBreakdown>): string {
  const header = [
    "pairId",
    "controlScenarioId",
    "controlActionState",
    "controlOutcomeCategory",
    "controlFailureClass",
    "attackScenarioId",
    "attackActionState",
    "attackOutcomeCategory",
    "attackFailureClass",
    "strictPairSuccess",
  ];

  const body = rows.map((row) => [
    csvEscape(row.pairId),
    csvEscape(row.controlScenarioId),
    csvEscape(row.controlActionState),
    csvEscape(row.controlOutcomeCategory),
    csvEscape(row.controlFailureClass),
    csvEscape(row.attackScenarioId),
    csvEscape(row.attackActionState),
    csvEscape(row.attackOutcomeCategory),
    csvEscape(row.attackFailureClass),
    csvEscape(row.strictPairSuccess),
  ]);

  return `${header.join(",")}\n${body.map((row) => row.join(",")).join("\n")}\n`;
}

function computeFallacyMetrics(records: JoinedScenarioResult[]) {
  const pairRows = buildPairBreakdown(records);
  const evaluatedPairs = pairRows.filter((row) => typeof row.strictPairSuccess === "boolean");
  const strictSuccesses = evaluatedPairs.filter((row) => row.strictPairSuccess).length;
  const controlEvaluated = pairRows.filter((row) => row.controlOutcomeCategory === "benchmark_outcome");
  const attackEvaluated = pairRows.filter((row) => row.attackOutcomeCategory === "benchmark_outcome");
  const controlAllows = controlEvaluated.filter((row) => row.controlActionState === "ALLOW").length;
  const attackDenies = attackEvaluated.filter((row) => row.attackActionState === "DENY").length;
  const falseAllows = attackEvaluated.filter((row) => row.attackActionState === "ALLOW").length;
  const falseDenies = controlEvaluated.filter((row) => row.controlActionState === "DENY").length;

  return {
    selectedPairs: pairRows.length,
    evaluatedPairs: evaluatedPairs.length,
    excludedPairs: pairRows.length - evaluatedPairs.length,
    strictPairAccuracy: {
      value: evaluatedPairs.length > 0 ? strictSuccesses / evaluatedPairs.length : Number.NaN,
      ci95: wilsonInterval(strictSuccesses, evaluatedPairs.length),
      successes: strictSuccesses,
      trials: evaluatedPairs.length,
    },
    componentBreakdown: {
      controlAllowRate: {
        value: controlEvaluated.length > 0 ? controlAllows / controlEvaluated.length : Number.NaN,
        ci95: wilsonInterval(controlAllows, controlEvaluated.length),
        successes: controlAllows,
        trials: controlEvaluated.length,
      },
      attackDenyRate: {
        value: attackEvaluated.length > 0 ? attackDenies / attackEvaluated.length : Number.NaN,
        ci95: wilsonInterval(attackDenies, attackEvaluated.length),
        successes: attackDenies,
        trials: attackEvaluated.length,
      },
      falseAllowOnAttacks: {
        value: attackEvaluated.length > 0 ? falseAllows / attackEvaluated.length : Number.NaN,
        ci95: wilsonInterval(falseAllows, attackEvaluated.length),
        successes: falseAllows,
        trials: attackEvaluated.length,
      },
      falseDenyOnControls: {
        value: controlEvaluated.length > 0 ? falseDenies / controlEvaluated.length : Number.NaN,
        ci95: wilsonInterval(falseDenies, controlEvaluated.length),
        successes: falseDenies,
        trials: controlEvaluated.length,
      },
    },
    baselines: {
      alwaysAllow: {
        strictPairAccuracy: 0,
        controlAllowRate: 1,
        attackDenyRate: 0,
        falseAllowOnAttacks: 1,
        falseDenyOnControls: 0,
      },
      alwaysDeny: {
        strictPairAccuracy: 0,
        controlAllowRate: 0,
        attackDenyRate: 1,
        falseAllowOnAttacks: 0,
        falseDenyOnControls: 1,
      },
      randomBalancedGuessing: {
        strictPairAccuracy: 0.25,
        controlAllowRate: 0.5,
        attackDenyRate: 0.5,
        falseAllowOnAttacks: 0.5,
        falseDenyOnControls: 0.5,
      },
    },
    pairBreakdown: pairRows,
  };
}

function computeIbmMetrics(records: JoinedScenarioResult[], seed: string) {
  const rows = records
    .filter((record) => record.scenario.source === "ibm-aq")
    .filter(
      (record) =>
        record.result?.parsed.outcomeCategory === "benchmark_outcome" &&
        typeof record.scenario.humanQualityScore === "number" &&
        typeof record.result.raw.response?.concordanceScore === "number",
    );

  const human = rows.map((row) => row.scenario.humanQualityScore as number);
  const concordance = rows.map((row) => row.result?.raw.response?.concordanceScore as number);
  return {
    selectedScenarios: records.filter((record) => record.scenario.source === "ibm-aq").length,
    evaluatedScenarios: rows.length,
    excludedScenarios: records.filter((record) => record.scenario.source === "ibm-aq").length - rows.length,
    spearman: {
      value: rows.length >= 2 ? spearmanCorrelation(human, concordance) : Number.NaN,
      ci95: rows.length >= 3 ? bootstrapSpearmanCi(human, concordance, `${seed}:ibm-spearman`) : [Number.NaN, Number.NaN],
    },
    note: "Exploratory calibration only. No threshold-based pass/fail claim is made.",
  };
}

function computeFolioMetrics(records: JoinedScenarioResult[]) {
  const folioRecords = records.filter((record) => record.scenario.source === "folio");

  if (folioRecords.length === 0) {
    return {
      included: false,
      note: "FOLIO excluded from v1 because no suitable source-provided reasoning/proof text was available for the benchmark reasoning field.",
    };
  }

  const evaluated = folioRecords.filter(
    (record) =>
      record.result?.parsed.outcomeCategory === "benchmark_outcome" &&
      record.scenario.expectedVerdict &&
      record.result.raw.response?.actionState,
  );

  const correct = evaluated.filter(
    (record) => record.scenario.expectedVerdict === record.result?.raw.response?.actionState,
  ).length;

  const labelCounts = new Map<string, { total: number; correct: number }>();
  for (const record of evaluated) {
    const label = String(record.scenario.metadata.label ?? record.scenario.expectedVerdict);
    const current = labelCounts.get(label) ?? { total: 0, correct: 0 };
    current.total += 1;
    if (record.scenario.expectedVerdict === record.result?.raw.response?.actionState) {
      current.correct += 1;
    }
    labelCounts.set(label, current);
  }

  let majorityLabel = "";
  let majorityCount = -1;
  for (const [label, counts] of labelCounts) {
    if (counts.total > majorityCount) {
      majorityLabel = label;
      majorityCount = counts.total;
    }
  }

  return {
    included: true,
    selectedScenarios: folioRecords.length,
    evaluatedScenarios: evaluated.length,
    accuracy: {
      value: evaluated.length > 0 ? correct / evaluated.length : Number.NaN,
      ci95: wilsonInterval(correct, evaluated.length),
      successes: correct,
      trials: evaluated.length,
    },
    labelBreakdown: Object.fromEntries(
      [...labelCounts.entries()].map(([label, counts]) => [
        label,
        {
          total: counts.total,
          correct: counts.correct,
          accuracy: counts.total > 0 ? counts.correct / counts.total : Number.NaN,
        },
      ]),
    ),
    baselines: {
      majorityClass: majorityLabel,
      alwaysDeny: "DENY",
    },
  };
}

export async function generateAnalysisArtifacts(params: {
  manifest: RunManifest;
  scenarios: NormalizedScenario[];
  results: RunResult[];
}): Promise<void> {
  const records = toJoinedRecords(params.scenarios, params.results);
  const summaryCsv = buildSummaryCsv(records);
  const pairBreakdown = computeFallacyMetrics(records);
  const ibmMetrics = computeIbmMetrics(records, params.manifest.environment.benchmarkSeed);
  const folioMetrics = computeFolioMetrics(records);

  const metrics = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    runManifestPath: path.join(resultsDir, "run-manifest.json"),
    runId: params.manifest.runId,
    mode: params.manifest.mode,
    validator: params.manifest.validator,
    counts: params.manifest.counts,
    fallacyPairs: {
      ...pairBreakdown,
      pairBreakdown: undefined,
    },
    ibmAq: ibmMetrics,
    folio: folioMetrics,
  };

  await writeTextAtomic(path.join(resultsDir, "summary.csv"), summaryCsv);
  await writeTextAtomic(path.join(resultsDir, "pair-breakdown.csv"), buildPairBreakdownCsv(pairBreakdown.pairBreakdown));
  await writeJsonAtomic(path.join(resultsDir, "metrics.json"), metrics);
}

export { buildPairBreakdownCsv };
