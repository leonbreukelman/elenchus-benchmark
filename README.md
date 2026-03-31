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

## Notes on dataset handling

The benchmark never generates reasoning with an LLM. It only uses source-provided reasoning verbatim or near-verbatim, with provenance recorded per scenario.

For the fallacy dataset, the source rows are single sentences. The benchmark reconstructs pairs conservatively by grouping rows on the shared claim prefix before the first `because`, and uses the text after `because` as near-verbatim reasoning.

For IBM Argument Quality, the benchmark uses source argument text verbatim as reasoning and treats the dataset as calibration-only. It computes rank correlation and does not derive benchmark-local pass/fail verdicts.
