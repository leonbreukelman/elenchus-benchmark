#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_VALIDATOR_URL="http://localhost:3000"
DEFAULT_VALIDATOR_GIT_SHA="5f7d500b5e5cb9287cf1b2ca57071b6cb98cdcea"
STATE_DIR="${ROOT_DIR}/results/studies/_latest"
STUDY_ID_FILE="${STATE_DIR}/study-id.txt"
STUDY_ENV_FILE="${STATE_DIR}/study-env.sh"
LOG_DIR="${STATE_DIR}/logs"

COUNT=10
SEED_PREFIX="study-seed"
RESUME=0
FOREGROUND=0
PILOT=0
EXPLICIT_SEEDS=""
STUDY_ID=""

usage() {
  cat <<'EOF'
Usage: scripts/run-study.sh [options]

Launches or resumes an automated Elenchus benchmark study and records the active
study ID under results/studies/_latest/.

Options:
  --resume               Resume the study recorded in results/studies/_latest/study-id.txt
  --study-id ID          Use or resume a specific study ID
  --count N              Number of seeds for a new study (default: 10)
  --seed-prefix PREFIX   Seed prefix for a new study (default: study-seed)
  --seeds A,B,C          Explicit comma-separated seed list for a new study
  --pilot                Run pilot mode instead of full mode
  --foreground           Run in the foreground instead of detaching
  -h, --help             Show this help

Environment overrides:
  VALIDATOR_URL
  VALIDATOR_GIT_SHA
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      RESUME=1
      shift
      ;;
    --study-id)
      STUDY_ID="${2:-}"
      if [[ -z "$STUDY_ID" ]]; then
        echo "--study-id requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --count)
      COUNT="${2:-}"
      if [[ -z "$COUNT" ]]; then
        echo "--count requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --seed-prefix)
      SEED_PREFIX="${2:-}"
      if [[ -z "$SEED_PREFIX" ]]; then
        echo "--seed-prefix requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --seeds)
      EXPLICIT_SEEDS="${2:-}"
      if [[ -z "$EXPLICIT_SEEDS" ]]; then
        echo "--seeds requires a value" >&2
        exit 1
      fi
      shift 2
      ;;
    --pilot)
      PILOT=1
      shift
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

VALIDATOR_URL="${VALIDATOR_URL:-$DEFAULT_VALIDATOR_URL}"
VALIDATOR_GIT_SHA="${VALIDATOR_GIT_SHA:-$DEFAULT_VALIDATOR_GIT_SHA}"

mkdir -p "$STATE_DIR" "$LOG_DIR"

HEALTH_RESPONSE="$(curl -fsS "${VALIDATOR_URL}/api/health")" || {
  echo "Validator health check failed at ${VALIDATOR_URL}/api/health" >&2
  exit 1
}

if ! printf '%s' "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
  echo "Validator health check returned unexpected payload: $HEALTH_RESPONSE" >&2
  exit 1
fi

MODE_LABEL="full"
if [[ "$PILOT" -eq 1 ]]; then
  MODE_LABEL="pilot"
fi

if [[ "$RESUME" -eq 1 && -z "$STUDY_ID" ]]; then
  if [[ ! -f "$STUDY_ID_FILE" ]]; then
    echo "Cannot resume: ${STUDY_ID_FILE} does not exist" >&2
    exit 1
  fi
  STUDY_ID="$(tr -d '\n' < "$STUDY_ID_FILE")"
fi

if [[ -z "$STUDY_ID" ]]; then
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  random_suffix="$(openssl rand -hex 4)"
  STUDY_ID="study-${MODE_LABEL}-${timestamp}-${random_suffix}"
fi

printf '%s\n' "$STUDY_ID" > "$STUDY_ID_FILE"
cat > "$STUDY_ENV_FILE" <<EOF
export STUDY_ID="${STUDY_ID}"
export VALIDATOR_URL="${VALIDATOR_URL}"
export VALIDATOR_GIT_SHA="${VALIDATOR_GIT_SHA}"
export STUDY_MODE="${MODE_LABEL}"
EOF

study_args=(npm run study --)
if [[ "$PILOT" -eq 1 ]]; then
  study_args+=(--pilot)
fi
if [[ "$RESUME" -eq 1 ]]; then
  study_args+=(--resume)
fi
study_args+=(--study-id "$STUDY_ID")
if [[ "$RESUME" -eq 0 ]]; then
  if [[ -n "$EXPLICIT_SEEDS" ]]; then
    study_args+=(--seeds "$EXPLICIT_SEEDS")
  else
    study_args+=(--count "$COUNT" --seed-prefix "$SEED_PREFIX")
  fi
fi

export VALIDATOR_URL
export VALIDATOR_GIT_SHA

log_file="${LOG_DIR}/${STUDY_ID}.log"

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "Starting study ${STUDY_ID} in foreground. Log: ${log_file}"
  "${study_args[@]}" 2>&1 | tee -a "$log_file"
fi

echo "Starting study ${STUDY_ID} in background. Log: ${log_file}"
nohup "${study_args[@]}" >>"$log_file" 2>&1 &
pid=$!
echo "$pid" > "${STATE_DIR}/pid.txt"
echo "PID: ${pid}"
echo "Study ID recorded in ${STUDY_ID_FILE}"
echo "Resume with: scripts/run-study.sh --resume"
