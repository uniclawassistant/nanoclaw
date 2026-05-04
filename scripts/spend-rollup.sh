#!/bin/bash
#
# Daily spend roll-up. Reads store/spend-daily.jsonl entries for a target UTC
# date and appends a "## YYYY-MM-DD" section to the human-readable spend log.
# Idempotent — skips dates that already have a section.
#
# Usage:  ./scripts/spend-rollup.sh [--date YYYY-MM-DD] [--jsonl PATH] [--out PATH] [--dry-run]
#
# Env overrides (used by scheduled tasks):
#   SPEND_DAILY_JSONL_PATH   path to JSONL produced by usage-tracker
#   SPEND_LOG_OUT_PATH       path to markdown log (target file)
#   SPEND_ROLLUP_DATE        UTC date to roll up (default: yesterday)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

JSONL_PATH="${SPEND_DAILY_JSONL_PATH:-$PROJECT_ROOT/store/spend-daily.jsonl}"
OUT_PATH="${SPEND_LOG_OUT_PATH:-$PROJECT_ROOT/groups/unic-shared-memory/memory/spend-log.md}"
TARGET_DATE="${SPEND_ROLLUP_DATE:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) TARGET_DATE="$2"; shift 2 ;;
    --jsonl) JSONL_PATH="$2"; shift 2 ;;
    --out) OUT_PATH="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET_DATE" ]]; then
  TARGET_DATE="$(date -u -v -1d +%Y-%m-%d 2>/dev/null || date -u -d 'yesterday' +%Y-%m-%d)"
fi

if [[ ! -f "$JSONL_PATH" ]]; then
  echo "[spend-rollup] no JSONL at $JSONL_PATH — nothing to do"
  exit 0
fi

if [[ -f "$OUT_PATH" ]] && grep -qE "^## ${TARGET_DATE}\$" "$OUT_PATH" 2>/dev/null; then
  echo "[spend-rollup] section for $TARGET_DATE already present in $OUT_PATH — skipping"
  exit 0
fi

SECTION="$(awk -v target="$TARGET_DATE" '
BEGIN {
  total_cost = 0; turns = 0; null_cost_turns = 0;
  scheduled_cost = 0; scheduled_turns = 0;
  interactive_cost = 0; interactive_turns = 0;
  ctx_sum = 0; ctx_n = 0;
}
{
  line = $0;
  ts = ""; cost = ""; ctx = ""; origin = "";

  if (match(line, /"ts":"[^"]+"/)) {
    ts = substr(line, RSTART + 6, RLENGTH - 7);
  }
  if (substr(ts, 1, 10) != target) next;

  if (match(line, /"cost":(null|-?[0-9]+(\.[0-9]+)?)/)) {
    val = substr(line, RSTART + 7, RLENGTH - 7);
    if (val == "null") {
      null_cost_turns++;
      cost = 0;
    } else {
      cost = val + 0;
      total_cost += cost;
    }
  }
  if (match(line, /"contextUsed":-?[0-9]+/)) {
    val = substr(line, RSTART + 14, RLENGTH - 14);
    ctx = val + 0;
    ctx_sum += ctx;
    ctx_n++;
  }
  if (match(line, /"origin":"(scheduled|interactive)"/)) {
    origin = substr(line, RSTART + 10, RLENGTH - 11);
  }
  turns++;
  if (origin == "scheduled") {
    scheduled_turns++;
    scheduled_cost += cost;
  } else {
    interactive_turns++;
    interactive_cost += cost;
  }
}
END {
  if (turns == 0) { print "EMPTY"; exit 0; }
  printf "## %s\n", target;
  printf "- Total: $%.2f (%d turns)\n", total_cost, turns;
  printf "- Interactive: $%.2f (%d turns)\n", interactive_cost, interactive_turns;
  printf "- Scheduled: $%.2f (%d turns)\n", scheduled_cost, scheduled_turns;
  if (ctx_n > 0) {
    avg_k = (ctx_sum / ctx_n) / 1000;
    printf "- Avg context: %.0fk tokens\n", avg_k;
  }
  if (null_cost_turns > 0) {
    printf "- Turns with no cost data: %d\n", null_cost_turns;
  }
}
' "$JSONL_PATH")"

if [[ "$SECTION" == "EMPTY" ]]; then
  echo "[spend-rollup] no entries for $TARGET_DATE — skipping"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[spend-rollup] DRY RUN — would append to $OUT_PATH:"
  echo "---"
  echo "$SECTION"
  echo "---"
  exit 0
fi

mkdir -p "$(dirname "$OUT_PATH")"
{
  if [[ -s "$OUT_PATH" ]]; then echo ""; fi
  echo "$SECTION"
} >> "$OUT_PATH"

echo "[spend-rollup] appended section for $TARGET_DATE to $OUT_PATH"
