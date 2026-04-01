# Elenchus Benchmark

Standalone Node.js/TypeScript benchmark CLI for the Elenchus validator.

The benchmark talks to the validator over HTTP only. It does not import validator source code at runtime, and it treats the validator response contract as the source of truth for verdicts.

## What it does

It prepares normalized benchmark scenarios from public datasets, runs them sequentially against `POST /api/v1/intercept`, persists resumable checkpoints, and generates analysis artifacts.

Primary benchmark source:

- `Navy0067/contrastive-pairs-for-logical-fallacy`

Exploratory calibration source:

- `ibm-research/argument_quality_ranking_30k`

Conditional source:

- `tasksource/folio` only when source-provided reasoning or proof text is actually present. If not, the benchmark excludes FOLIO explicitly in `scenarios/manifest.json`.

## Install

```bash
npm install
```

The `prepare` npm lifecycle is intentionally skipped during `npm install` and `npm ci`. Run scenario preparation explicitly once your environment is configured.

## Environment

Copy `.env.example` to `.env` or export variables directly.

- `BENCHMARK_SEED` is required for deterministic scenario preparation.
- `VALIDATOR_GIT_SHA` is required for benchmark runs.
- `VALIDATOR_URL` defaults to `http://localhost:3000`.
- `VALIDATOR_VERSION` is optional metadata.
- `HF_TOKEN` is optional and only needed if a dataset endpoint requires authentication.

## Commands

```bash
npm run prepare
npm run benchmark:pilot
npm run benchmark -- --resume
npm run analyze
npm run study
npm run study:run
```

Useful validation commands:

```bash
npm test
npm run typecheck
```

## Generated outputs

Scenario preparation writes:

- `scenarios/manifest.json`
- `scenarios/*.json`

Benchmark runs write:

- `results/run-manifest.json`
- `results/checkpoints/*.json`
- `results/pilot/<run-id>/raw/*.json`
- `results/full/<run-id>/raw/*.json`

Analysis writes:

- `results/summary.csv`
- `results/metrics.json`
- `results/pair-breakdown.csv`

Study automation writes:

- `results/studies/<study-id>/manifest.json`
- `results/studies/<study-id>/summary.json`
- `results/studies/<study-id>/summary.csv`
- `results/studies/<study-id>/runs/<seed>/scenarios/*`
- `results/studies/<study-id>/runs/<seed>/results/run-manifest.json`
- `results/studies/<study-id>/runs/<seed>/results/metrics.json`
- `results/studies/<study-id>/runs/<seed>/results/summary.csv`
- `results/studies/<study-id>/runs/<seed>/results/pair-breakdown.csv`
- `results/studies/<study-id>/runs/<seed>/results/checkpoints/<run-id>.json`
- `results/studies/<study-id>/runs/<seed>/results/<mode>/<run-id>/raw/*.json`

## Automated multi-seed studies

`npm run study` is the low-touch command for producing meaningful benchmark data.

By default it runs the full benchmark sequentially for 10 deterministic seeds:

- `study-seed-001`
- `study-seed-002`
- ...
- `study-seed-010`

Each seed run is prepared, benchmarked, analyzed, and then archived under a study directory so later seeds do not overwrite earlier artifacts.

Useful variants:

```bash
# Default: full runs across 10 seeds
npm run study

# Custom seed count and prefix
npm run study -- --count 20 --seed-prefix release-candidate

# Explicit seed list
npm run study -- --seeds rc-a-001,rc-a-002,rc-a-003

# Smoke-test the automation path with pilot runs
npm run study -- --pilot --count 2

# Resume the latest interrupted study
npm run study -- --resume

# Resume a specific study
npm run study -- --resume --study-id study-full-2026-03-31T02-00-00-000Z-ab12cd34
```

Study-level resume tracks which seeds are complete and which seed was active when the process stopped. If the active seed already has a matching top-level benchmark run in `results/run-manifest.json`, the study runner resumes that benchmark before archiving and continuing.

## Overnight wrapper

If you want the benchmark to run unattended, use the shell wrapper:

```bash
# Start a new full study in the background
npm run study:run

# Resume the latest recorded study in the background
npm run study:resume

# Smoke-test in the foreground
npm run study:run -- --pilot --foreground --seeds auto-smoke-001,auto-smoke-002
```

The wrapper:

- checks `GET ${VALIDATOR_URL}/api/health` before launching
- defaults `VALIDATOR_URL` to `http://localhost:3000`
- defaults `VALIDATOR_GIT_SHA` to `5f7d500b5e5cb9287cf1b2ca57071b6cb98cdcea`
- writes the active study ID to `results/studies/_latest/study-id.txt`
- writes study environment exports to `results/studies/_latest/study-env.sh`
- writes the background PID to `results/studies/_latest/pid.txt`
- appends logs to `results/studies/_latest/logs/<study-id>.log`

You can override validator settings with environment variables:

```bash
VALIDATOR_URL=http://localhost:3000 \
VALIDATOR_GIT_SHA=5f7d500b5e5cb9287cf1b2ca57071b6cb98cdcea \
npm run study:run -- --count 20 --seed-prefix release-candidate
```

## Notes on dataset handling

The benchmark never generates reasoning with an LLM. It only uses source-provided reasoning verbatim or near-verbatim, with provenance recorded per scenario.

For the fallacy dataset, the source rows are single sentences. The benchmark reconstructs pairs conservatively by grouping rows on the shared claim prefix before the first `because`, and uses the text after `because` as near-verbatim reasoning.

For IBM Argument Quality, the benchmark uses source argument text verbatim as reasoning and treats the dataset as calibration-only. It computes rank correlation and does not derive benchmark-local pass/fail verdicts.
