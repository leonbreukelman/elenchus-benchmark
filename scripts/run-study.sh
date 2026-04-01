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

# ---------------------------------------------------------------------------
# Auto-restart loop
#
# If the study process exits non-zero, wait with exponential backoff and
# resume automatically. This handles process-level crashes, OOM kills, and
# transient infrastructure failures that survive the in-process retry logic.
# ---------------------------------------------------------------------------

MAX_RESTARTS=10
RESTART_BASE_DELAY=60  # seconds

run_with_restarts() {
  local restart_count=0
  local resume_args=(npm run study -- --resume --study-id "$STUDY_ID")

  while true; do
    if [[ "$restart_count" -eq 0 ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting study ${STUDY_ID}" >> "$log_file"
      "${study_args[@]}" >> "$log_file" 2>&1 && return 0
    else
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Restart ${restart_count}/${MAX_RESTARTS}: resuming study ${STUDY_ID}" >> "$log_file"
      "${resume_args[@]}" >> "$log_file" 2>&1 && return 0
    fi

    restart_count=$((restart_count + 1))
    if [[ "$restart_count" -gt "$MAX_RESTARTS" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Study ${STUDY_ID} failed after ${MAX_RESTARTS} restarts. Giving up." >> "$log_file"
      return 1
    fi

    local delay=$(( RESTART_BASE_DELAY * (2 ** (restart_count - 1)) ))
    if [[ "$delay" -gt 1800 ]]; then
      delay=1800  # cap at 30 minutes
    fi
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Study exited non-zero. Restarting in ${delay}s (attempt ${restart_count}/${MAX_RESTARTS})..." >> "$log_file"
    sleep "$delay"
  done
}

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "Starting study ${STUDY_ID} in foreground (auto-restart enabled). Log: ${log_file}"
  run_with_restarts 2>&1 | tee -a "$log_file"
  exit $?
fi

# Background mode: re-invoke this script with --foreground so the restart loop
# runs inside a proper bash process with full array/function support.
bg_args=(--foreground --study-id "$STUDY_ID")
if [[ "$PILOT" -eq 1 ]]; then bg_args+=(--pilot); fi
if [[ "$RESUME" -eq 1 ]]; then
  bg_args+=(--resume)
else
  if [[ -n "$EXPLICIT_SEEDS" ]]; then
    bg_args+=(--seeds "$EXPLICIT_SEEDS")
  else
    bg_args+=(--count "$COUNT" --seed-prefix "$SEED_PREFIX")
  fi
fi

echo "Starting study ${STUDY_ID} in background (auto-restart enabled, max ${MAX_RESTARTS} restarts). Log: ${log_file}"
nohup "${BASH_SOURCE[0]}" "${bg_args[@]}" >>"$log_file" 2>&1 &
pid=$!
echo "$pid" > "${STATE_DIR}/pid.txt"
echo "PID: ${pid}"
echo "Study ID recorded in ${STUDY_ID_FILE}"
echo "Tail log: tail -f ${log_file}"
echo "Resume manually: scripts/run-study.sh --resume"
