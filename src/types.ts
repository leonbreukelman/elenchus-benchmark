export type ScenarioSource = "fallacy-pairs" | "ibm-aq" | "folio";

export type EvaluationMode = "pair" | "correlation" | "verdict";

export type Verdict = "ALLOW" | "DENY";

export type PairRole = "control" | "attack";

export type FailureClass =
  | "missing_api_key"
  | "timeout"
  | "saboteur_error"
  | "judge_error"
  | "network"
  | "http";

export type OutcomeCategory =
  | "benchmark_outcome"
  | "validator_system_failure"
  | "transport_failure";

export interface ReasoningProvenance {
  sourceField: string;
  transform: "verbatim" | "near-verbatim";
  notes?: string;
}

export interface ScenarioMetadata {
  datasetId: string;
  datasetRevision?: string;
  datasetUrl: string;
  sourceRecordId: string;
  reasoningProvenance: ReasoningProvenance;
  [key: string]: unknown;
}

export interface NormalizedScenario {
  id: string;
  source: ScenarioSource;
  evaluationMode: EvaluationMode;
  context: string;
  proposedAction: Record<string, unknown>;
  reasoning: string;
  expectedVerdict?: Verdict;
  humanQualityScore?: number;
  pairId?: string;
  pairRole?: PairRole;
  metadata: ScenarioMetadata;
}

export interface ValidatorResponse {
  actionState: Verdict;
  concordanceScore: number;
  terminalLog: string[];
}

export interface RunResult {
  scenarioId: string;
  source: NormalizedScenario["source"];
  evaluationMode: NormalizedScenario["evaluationMode"];
  traceId: string;
  validator: {
    url: string;
    version?: string;
    gitSha: string;
  };
  raw: {
    httpStatus?: number;
    response?: ValidatorResponse;
    error?: string;
  };
  rawTerminalLog: string[];
  parsed: {
    latencyMs: number;
    rounds?: number;
    terminationReason?: string;
    systemFailure: boolean;
    failureClass?: FailureClass;
    outcomeCategory: OutcomeCategory;
    parserSupported: boolean;
  };
  timestamp: string;
}

export interface DatasetExclusion {
  reason: string;
  count: number;
  details?: string[];
}

export interface DatasetManifestEntry {
  source: ScenarioSource;
  datasetId: string;
  datasetRevision?: string;
  datasetUrl: string;
  included: boolean;
  sampleTarget: number;
  selectedCount: number;
  skippedCount: number;
  exclusions: DatasetExclusion[];
  notes?: string[];
}

export interface ScenarioManifestSelection {
  scenarioId: string;
  source: ScenarioSource;
  sourceRecordId: string;
  pairId?: string;
  pairRole?: PairRole;
}

export interface ScenarioManifest {
  schemaVersion: "1.0.0";
  preparedAt: string;
  benchmarkSeed: string;
  benchmarkGitSha?: string;
  datasets: DatasetManifestEntry[];
  scenarios: {
    total: number;
    bySource: Partial<Record<ScenarioSource, number>>;
    order: string[];
  };
  selections: ScenarioManifestSelection[];
  notes: string[];
}

export interface BenchmarkEnvironment {
  benchmarkGitSha?: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  benchmarkSeed: string;
}

export interface RunManifest {
  schemaVersion: "1.0.0";
  runId: string;
  mode: "pilot" | "full";
  startedAt: string;
  completedAt?: string;
  resumed: boolean;
  scenarioManifestPath: string;
  scenarioManifestPreparedAt: string;
  scenarioIds: string[];
  resultPaths: Record<string, string>;
  validator: {
    url: string;
    version?: string;
    gitSha: string;
    parserSupported: boolean;
  };
  environment: BenchmarkEnvironment;
  counts: {
    total: number;
    completed: number;
    transportFailures: number;
    validatorSystemFailures: number;
    benchmarkOutcomes: number;
  };
}

export interface RunCheckpoint {
  schemaVersion: "1.0.0";
  runId: string;
  mode: "pilot" | "full";
  scenarioManifestPath: string;
  scenarioManifestPreparedAt: string;
  scenarioIds: string[];
  resultPaths: Record<string, string>;
  completedScenarioIds: string[];
  validator: RunManifest["validator"];
  environment: BenchmarkEnvironment;
  startedAt: string;
  updatedAt: string;
}

export interface JoinedScenarioResult {
  scenario: NormalizedScenario;
  result?: RunResult;
}
