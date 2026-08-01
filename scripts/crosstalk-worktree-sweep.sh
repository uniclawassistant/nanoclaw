#!/bin/bash
# com.uniclaw.crosstalk-worktree-sweep
# Host-side teardown of stale Crosstalk per-task worktrees.
#
# Default mode is DRY RUN. --apply performs removals/deletions, guarded by the
# same fail-closed classification used in dry-run.

set -uo pipefail

CLIP_DIR="${CLIP_DIR:-$HOME/clip}"
WORKTREE_GLOB="${WORKTREE_GLOB:-$CLIP_DIR/*-worktrees}"
PCP_CLI="${PCP_CLI:-/Users/fedor/nanoclaw-unic/groups/unic-shared-memory/scripts/pcp.sh}"
GH_CLI="${GH_CLI:-gh}"
LOG_DIR="${LOG_DIR:-/Users/fedor/nanoclaw-unic/groups/unic-shared-memory/memory/projects/crosstalk/worktree-sweep-logs}"
AGE_REAP_SECS=$((24 * 3600))      # 24h guard for all reap candidates
AGE_DETACHED_SECS=$((14 * 86400)) # 14d guard for detached/temp trees

usage() {
  echo "usage: $0 [--apply]" >&2
}

APPLY=0
case "$#" in
  0) ;;
  1)
    case "${1:-}" in
      --apply) APPLY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) usage; exit 2 ;;
    esac
    ;;
  *) usage; exit 2 ;;
esac

PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

mkdir -p "$LOG_DIR"
NOW=$(date +%s)
STAMP=$(date +%Y-%m-%dT%H-%M-%S)
LOG="$LOG_DIR/sweep-$STAMP.log"
mode="DRY-RUN"; [ "$APPLY" = "1" ] && mode="APPLY"

roots=(); nongit_children=(); standalone_repos=(); linked_children=(); ignored_linked_repos=()
repo_common=(); repo_rep=(); repo_gh=(); repo_branch_ctx=()
root_reclaim_path=(); root_reclaim_kb=()
removed=(); removal_failed=(); skipped_active=(); skipped_dirty=(); review_needed=(); skipped_fresh=(); skipped_detached=(); skipped_xcode=(); skipped_registered=()
br_removed=(); br_fresh=(); br_unmerged=()
ticket_ids=(); ticket_results=()
PAPERCLIP_RESULT=""
FAILURE_COUNT=0

logline() { echo "$1" | tee -a "$LOG"; }

abs_path() {
  local p="$1" d b
  if [ -d "$p" ]; then
    (cd "$p" 2>/dev/null && pwd -P)
  else
    d=$(dirname "$p"); b=$(basename "$p")
    (cd "$d" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$b")
  fi
}

array_has() {
  local needle="$1" item
  shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

origin_to_gh_repo() {
  local url="$1" x
  case "$url" in
    git@github.com:*) x=${url#git@github.com:} ;;
    ssh://git@github.com/*) x=${url#ssh://git@github.com/} ;;
    https://github.com/*) x=${url#https://github.com/} ;;
    http://github.com/*) x=${url#http://github.com/} ;;
    *) return 1 ;;
  esac
  x=${x%.git}
  case "$x" in */*) printf '%s\n' "$x"; return 0 ;; esac
  return 1
}

is_crosstalk_gh_repo() {
  local gh="$1" base
  base=$(basename "$gh")
  case "$base" in
    crosstalk|crosstalk-*) return 0 ;;
    *) return 1 ;;
  esac
}

add_repo_once() {
  local common="$1" rep="$2" origin gh base
  if array_has "$common" ${repo_common[@]+"${repo_common[@]}"}; then
    return
  fi
  origin=$(git -C "$rep" remote get-url origin 2>/dev/null || true)
  gh=$(origin_to_gh_repo "$origin" 2>/dev/null || true)
  if [ -z "$gh" ]; then
    ignored_linked_repos+=("$rep :: linked worktree common=$common origin-unparseable action=ignore-fail-closed")
    return
  fi
  if ! is_crosstalk_gh_repo "$gh"; then
    base=$(basename "$gh")
    ignored_linked_repos+=("$rep :: linked worktree common=$common repo=$gh basename=$base action=ignore-non-Crosstalk")
    return
  fi
  repo_common+=("$common")
  repo_rep+=("$rep")
  repo_gh+=("$gh")
  repo_branch_ctx+=("$rep")
}

add_reclaim() {
  local root="$1" kb="$2" i
  i=0
  while [ "$i" -lt "${#root_reclaim_path[@]}" ]; do
    if [ "${root_reclaim_path[$i]}" = "$root" ]; then
      root_reclaim_kb[$i]=$(( ${root_reclaim_kb[$i]} + kb ))
      return
    fi
    i=$((i + 1))
  done
  root_reclaim_path+=("$root")
  root_reclaim_kb+=("$kb")
}

path_under_discovered_root() {
  local w="$1" r
  for r in ${roots[@]+"${roots[@]}"}; do
    case "$w" in "$r"|"$r"/*) return 0 ;; esac
  done
  return 1
}

root_for_worktree() {
  local w="$1" r
  for r in ${roots[@]+"${roots[@]}"}; do
    case "$w" in "$r"|"$r"/*) printf '%s\n' "$r"; return 0 ;; esac
  done
  printf '%s\n' "(outside discovered roots)"
}

estimate_reclaim() {
  local w="$1" root kb
  root=$(root_for_worktree "$w")
  kb=$(du -sk "$w" 2>/dev/null | awk '{print $1}')
  [ -z "$kb" ] && kb=0
  add_reclaim "$root" "$kb"
}

extract_ticket() {
  local base="$1"
  case "$base" in
    *-CRO-[0-9]*) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$base" | sed -n 's/^.*-\(CRO-[0-9][0-9]*\)\(-.*\)*$/\1/p'
}

parse_issue_status() {
  python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
    status=data.get("status")
    if isinstance(status,dict):
        status=status.get("name") or status.get("id") or status.get("status")
    if not isinstance(status,str) or not status.strip():
        raise ValueError("missing status")
    print(status.strip())
except Exception as e:
    print("parse error: %s" % e, file=sys.stderr)
    sys.exit(1)
'
}

paperclip_ticket_result() {
  local ticket="$1" i out status
  PAPERCLIP_RESULT=""
  i=0
  while [ "$i" -lt "${#ticket_ids[@]}" ]; do
    if [ "${ticket_ids[$i]}" = "$ticket" ]; then
      PAPERCLIP_RESULT="${ticket_results[$i]}"
      return 0
    fi
    i=$((i + 1))
  done

  if [ ! -x "$PCP_CLI" ]; then
    PAPERCLIP_RESULT="ERR:PCP_CLI not executable: $PCP_CLI"
    ticket_ids+=("$ticket")
    ticket_results+=("$PAPERCLIP_RESULT")
    return 0
  fi

  out=$("$PCP_CLI" issue "$ticket" 2>&1)
  if [ "$?" -ne 0 ] || [ -z "$out" ]; then
    PAPERCLIP_RESULT="ERR:Paperclip issue query failed for $ticket"
    ticket_ids+=("$ticket")
    ticket_results+=("$PAPERCLIP_RESULT")
    return 0
  fi
  status=$(printf '%s\n' "$out" | parse_issue_status 2>/dev/null)
  if [ "$?" -ne 0 ] || [ -z "$status" ]; then
    PAPERCLIP_RESULT="ERR:Paperclip status parse failed for $ticket"
    ticket_ids+=("$ticket")
    ticket_results+=("$PAPERCLIP_RESULT")
    return 0
  fi
  PAPERCLIP_RESULT="OK:$status"
  ticket_ids+=("$ticket")
  ticket_results+=("$PAPERCLIP_RESULT")
}

# Xcode-open guard: never reap a worktree whose project/workspace is open.
XCODE_OPEN_DOCS=""
XCODE_QUERY_FAILED=0
if pgrep -qx Xcode; then
  if ! XCODE_OPEN_DOCS=$(osascript \
      -e "set AppleScript's text item delimiters to linefeed" \
      -e 'tell application "Xcode" to (path of every workspace document) as text' 2>/dev/null); then
    XCODE_QUERY_FAILED=1
  fi
fi

xcode_open_in() {
  local W="$1" doc
  [ -z "$XCODE_OPEN_DOCS" ] && return 1
  while IFS= read -r doc; do
    [ -z "$doc" ] && continue
    case "$doc" in "$W"|"$W"/*) return 0 ;; esac
  done <<EOF
$XCODE_OPEN_DOCS
EOF
  return 1
}

reap() {
  local W="$1" why="$2" repo_ctx="$3" err
  estimate_reclaim "$W"
  if [ "$APPLY" = "1" ]; then
    if ! command -v trash >/dev/null 2>&1; then
      removal_failed+=("$W :: REAP-QUALIFIED but trash command not found ($why)")
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
      return
    fi
    git -C "$repo_ctx" worktree unlock "$W" >/dev/null 2>&1
    if ! err=$(trash "$W" 2>&1); then
      removal_failed+=("$W :: REAP-QUALIFIED but trash failed [$err] ($why)")
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
      return
    fi
    if [ -e "$W" ]; then
      removal_failed+=("$W :: REAP-QUALIFIED but path still exists after trash ($why)")
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
      return
    fi
    if ! err=$(git -C "$repo_ctx" worktree prune --expire now 2>&1); then
      removal_failed+=("$W :: trashed but worktree prune failed [$err] ($why)")
      FAILURE_COUNT=$((FAILURE_COUNT + 1))
      return
    fi
    removed+=("$W :: $why")
  else
    removed+=("$W :: WOULD-TRASH (no unlock/prune in dry-run) — $why")
  fi
}

process_record() {
  local repo_idx="$1" W="$2" B="$3" D="$4" MAIN_W="$5"
  local rep="${repo_rep[$repo_idx]}" gh="${repo_gh[$repo_idx]}" repo_ctx
  local age age_h rc merged base ticket tres status porcelain
  [ -z "$W" ] && return

  if [ "$W" = "$MAIN_W" ]; then
    skipped_registered+=("$W :: registered main checkout (reported only; never deleted)")
    return
  fi
  if ! path_under_discovered_root "$W"; then
    skipped_registered+=("$W :: registered worktree outside discovered roots (reported only; never deleted)")
    return
  fi

  if [ ! -d "$W" ]; then
    review_needed+=("$W :: dir missing (prunable)"); return
  fi

  repo_ctx="$MAIN_W"
  [ -z "$repo_ctx" ] && repo_ctx="$rep"

  age=$(( NOW - $(stat -f %m "$W") ))
  age_h=$(( age / 3600 ))

  # Fail-closed guard order is intentional and must remain: dirty, Xcode,
  # origin, <24h, detached<14d, exact merged PR, terminal Paperclip status.
  porcelain=$(git -C "$W" status --porcelain 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    review_needed+=("$W :: git status failed [$porcelain] — fail closed"); return
  fi
  if [ -n "$porcelain" ]; then
    skipped_dirty+=("$W :: DIRTY (branch=${B:-detached})"); return
  fi

  if [ "$XCODE_QUERY_FAILED" = "1" ]; then
    review_needed+=("$W :: Xcode running but open-doc query failed — not removed"); return
  fi
  if xcode_open_in "$W"; then
    skipped_xcode+=("$W :: OPEN IN XCODE — not removed"); return
  fi

  if [ "$D" != "1" ] && [ -n "$B" ]; then
    git -C "$repo_ctx" ls-remote --exit-code --heads origin "$B" >/dev/null 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then
      skipped_active+=("$W :: branch on origin ($B)"); return
    fi
    if [ "$rc" -ne 2 ]; then
      review_needed+=("$W :: cannot query origin for branch $B — fail closed"); return
    fi
  fi

  if [ "$age" -le "$AGE_REAP_SECS" ]; then
    skipped_fresh+=("$W :: age=${age_h}h (<24h) — skip"); return
  fi

  if [ "$D" = "1" ] && [ "$age" -le "$AGE_DETACHED_SECS" ]; then
    skipped_detached+=("$W :: detached, age=${age_h}h (<14d) — skip"); return
  fi

  if [ -z "$gh" ]; then
    review_needed+=("$W :: cannot derive GitHub repo from origin — fail closed"); return
  fi
  if [ "$D" != "1" ] && [ -n "$B" ]; then
    merged=$("$GH_CLI" pr list --repo "$gh" --head "$B" --state merged --json number --jq '.[0].number' 2>/dev/null)
    rc=$?
    if [ "$rc" -ne 0 ]; then
      review_needed+=("$W :: GitHub merged-PR query failed for $gh/$B — fail closed"); return
    fi
    if [ -n "$merged" ]; then
      reap "$W" "merged PR #$merged, age=${age_h}h, clean, repo=$gh" "$repo_ctx"; return
    fi
  fi

  base=$(basename "$W")
  ticket=$(extract_ticket "$base" 2>/dev/null || true)
  if [ -z "$ticket" ]; then
    review_needed+=("$W :: branch gone, no exact merged PR, basename has no CRO ticket — fail closed"); return
  fi
  paperclip_ticket_result "$ticket"
  tres="$PAPERCLIP_RESULT"
  case "$tres" in
    OK:*)
      status=${tres#OK:}
      case "$status" in
        done|cancelled) reap "$W" "Paperclip $ticket terminal status=$status, age=${age_h}h, clean, repo=$gh" "$repo_ctx"; return ;;
        backlog|todo|in_progress|in_review|blocked) skipped_active+=("$W :: Paperclip $ticket nonterminal status=$status — keep"); return ;;
        *) review_needed+=("$W :: Paperclip $ticket unknown status=$status — fail closed"); return ;;
      esac
      ;;
    ERR:*) review_needed+=("$W :: ${tres#ERR:} — fail closed"); return ;;
    *) review_needed+=("$W :: Paperclip unexpected result for $ticket — fail closed"); return ;;
  esac
}

discover_roots_and_repos() {
  local root child git_dir common_dir abs_git abs_common
  for root in $WORKTREE_GLOB; do
    [ -d "$root" ] || continue
    roots+=("$(abs_path "$root")")
  done

  for root in ${roots[@]+"${roots[@]}"}; do
    for child in "$root"/*; do
      [ -d "$child" ] || continue
      child=$(abs_path "$child")
      if ! git -C "$child" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        nongit_children+=("$child :: not a git worktree/repo")
        continue
      fi
      git_dir=$(git -C "$child" rev-parse --git-dir 2>/dev/null || true)
      common_dir=$(git -C "$child" rev-parse --git-common-dir 2>/dev/null || true)
      if [ -z "$git_dir" ] || [ -z "$common_dir" ]; then
        nongit_children+=("$child :: git metadata unreadable")
        continue
      fi
      case "$git_dir" in /*) abs_git=$(abs_path "$git_dir") ;; *) abs_git=$(abs_path "$child/$git_dir") ;; esac
      case "$common_dir" in /*) abs_common=$(abs_path "$common_dir") ;; *) abs_common=$(abs_path "$child/$common_dir") ;; esac
      if [ "$abs_git" = "$abs_common" ]; then
        standalone_repos+=("$child :: standalone repo (not deleted)")
        continue
      fi
      add_repo_once "$abs_common" "$child"
      if array_has "$abs_common" ${repo_common[@]+"${repo_common[@]}"}; then
        linked_children+=("$child :: linked Crosstalk worktree common=$abs_common")
      fi
    done
  done
}

scan_repo_worktrees() {
  local idx="$1" rep="${repo_rep[$idx]}" common="${repo_common[$idx]}" gh="${repo_gh[$idx]}"
  local wt br det line main_wt
  logline ""
  logline "# repo common=$common rep=$rep gh=${gh:-UNAVAILABLE}"
  wt=""; br=""; det=0; main_wt=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*)
        if [ -n "$wt" ]; then
          process_record "$idx" "$wt" "$br" "$det" "$main_wt"
        fi
        wt="${line#worktree }"; br=""; det=0
        [ -z "$main_wt" ] && main_wt="$wt"
        ;;
      "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
      "detached") det=1 ;;
    esac
  done < <(git -C "$rep" worktree list --porcelain)
  [ -n "$wt" ] && process_record "$idx" "$wt" "$br" "$det" "$main_wt"
  [ -n "$main_wt" ] && repo_branch_ctx[$idx]="$main_wt"
}

branch_sweep_repo() {
  local idx="$1" rep="${repo_branch_ctx[$idx]}" gh="${repo_gh[$idx]}"
  local checked_out origin_heads origin_rc merged_tsv gh_rc b me age age_h err
  checked_out=$(git -C "$rep" worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')
  origin_heads=$(git -C "$rep" ls-remote --heads origin 2>/dev/null | sed 's#.*refs/heads/##')
  origin_rc=$?
  if [ -z "$gh" ]; then
    gh_rc=1
    merged_tsv=""
  else
    merged_tsv=$("$GH_CLI" pr list --repo "$gh" --state merged --limit 1000 \
      --json headRefName,mergedAt --jq '.[] | select(.mergedAt!=null) | "\(.headRefName)\t\(.mergedAt)"' 2>/dev/null)
    gh_rc=$?
  fi

  in_set() { printf '%s\n' "$2" | grep -qxF "$1"; }
  merged_epoch() {
    local at; at=$(printf '%s\n' "$merged_tsv" | awk -F'\t' -v b="$1" '$1==b{print $2; exit}')
    [ -z "$at" ] && return
    date -j -f "%Y-%m-%dT%H:%M:%SZ" "$at" +%s 2>/dev/null
  }

  while IFS= read -r b; do
    [ -z "$b" ] && continue
    if [ "$origin_rc" -ne 0 ]; then
      br_unmerged+=("${gh:-unknown}/$b :: origin branch query failed — fail closed"); continue
    fi
    in_set "$b" "$origin_heads" && continue
    in_set "$b" "$checked_out" && continue
    if [ "$gh_rc" -ne 0 ]; then
      br_unmerged+=("$gh/$b :: GitHub merged-PR query failed — fail closed"); continue
    fi
    me=$(merged_epoch "$b")
    if [ -z "$me" ]; then
      br_unmerged+=("$gh/$b :: gone on origin, NO merged PR — review"); continue
    fi
    age=$(( NOW - me )); age_h=$(( age / 3600 ))
    if [ "$age" -le "$AGE_REAP_SECS" ]; then
      br_fresh+=("$gh/$b :: merged ${age_h}h ago (<24h) — next run"); continue
    fi
    if [ "$APPLY" = "1" ]; then
      if err=$(git -C "$rep" branch -D "$b" 2>&1); then
        br_removed+=("$gh/$b :: merged ${age_h}h ago, gone on origin")
      else
        br_unmerged+=("$gh/$b :: DELETE-QUALIFIED but refused [$err]")
      fi
    else
      br_removed+=("$gh/$b :: WOULD-DELETE — merged ${age_h}h ago, gone on origin")
    fi
  done < <(git -C "$rep" for-each-ref --format='%(refname:short)' refs/heads/)
}

emit() {
  local title="$1" item count
  shift
  count="$#"
  logline ""
  logline "## $title ($count)"
  for item in "$@"; do logline "  - $item"; done
}

emit_reclaim() {
  local i mb
  logline ""
  logline "## DRY-RUN reclaim estimate by root (${#root_reclaim_path[@]})"
  i=0
  while [ "$i" -lt "${#root_reclaim_path[@]}" ]; do
    mb=$(( (${root_reclaim_kb[$i]} + 1023) / 1024 ))
    logline "  - ${root_reclaim_path[$i]} :: ${root_reclaim_kb[$i]} KiB (~${mb} MiB)"
    i=$((i + 1))
  done
}

logline "# Crosstalk worktree sweep — $STAMP — mode=$mode"
logline "# discovery=$WORKTREE_GLOB"
logline "# PCP_CLI=$PCP_CLI"
logline "# GH_CLI=$GH_CLI"
[ "$XCODE_QUERY_FAILED" = "1" ] && logline "WARN: Xcode running but workspace-document query failed — reap candidates fail closed"

discover_roots_and_repos

if [ "${#roots[@]}" -eq 0 ]; then
  logline "WARN: no worktree roots discovered"
fi

idx=0
while [ "$idx" -lt "${#repo_common[@]}" ]; do
  scan_repo_worktrees "$idx"
  idx=$((idx + 1))
done

idx=0
while [ "$idx" -lt "${#repo_common[@]}" ]; do
  branch_sweep_repo "$idx"
  idx=$((idx + 1))
done

emit "DISCOVERED roots" ${roots[@]+"${roots[@]}"}
emit "DISCOVERED linked Crosstalk worktree children" ${linked_children[@]+"${linked_children[@]}"}
emit "IGNORED linked non-Crosstalk/unparseable repos (reported only; never deleted)" ${ignored_linked_repos[@]+"${ignored_linked_repos[@]}"}
emit "DISCOVERED nongit children (reported only; never deleted)" ${nongit_children[@]+"${nongit_children[@]}"}
emit "DISCOVERED standalone repos (reported only; never deleted)" ${standalone_repos[@]+"${standalone_repos[@]}"}
emit "REMOVED" ${removed[@]+"${removed[@]}"}
emit "SKIPPED — active (branch on origin)" ${skipped_active[@]+"${skipped_active[@]}"}
emit "SKIPPED — fresh (<24h)" ${skipped_fresh[@]+"${skipped_fresh[@]}"}
emit "SKIPPED — detached (<14d)" ${skipped_detached[@]+"${skipped_detached[@]}"}
emit "SKIPPED — dirty" ${skipped_dirty[@]+"${skipped_dirty[@]}"}
emit "SKIPPED — open in Xcode" ${skipped_xcode[@]+"${skipped_xcode[@]}"}
emit "SKIPPED — registered outside roots/main checkout" ${skipped_registered[@]+"${skipped_registered[@]}"}
emit "REMOVAL FAILURES" ${removal_failed[@]+"${removal_failed[@]}"}
emit "REVIEW-NEEDED" ${review_needed[@]+"${review_needed[@]}"}
emit "BRANCHES — deleted (merged, gone on origin, >24h)" ${br_removed[@]+"${br_removed[@]}"}
emit "BRANCHES — fresh (merged <24h)" ${br_fresh[@]+"${br_fresh[@]}"}
emit "BRANCHES — review (gone on origin, no merged PR/query error)" ${br_unmerged[@]+"${br_unmerged[@]}"}
emit_reclaim

logline ""
logline "# summary: roots=${#roots[@]} repos=${#repo_common[@]} ignored-linked=${#ignored_linked_repos[@]} removed=${#removed[@]} removal-failures=${#removal_failed[@]} active=${#skipped_active[@]} fresh=${#skipped_fresh[@]} detached=${#skipped_detached[@]} dirty=${#skipped_dirty[@]} xcode-open=${#skipped_xcode[@]} registered-skip=${#skipped_registered[@]} review=${#review_needed[@]}"
logline "# branches: deleted=${#br_removed[@]} fresh=${#br_fresh[@]} review=${#br_unmerged[@]}"
logline "# paperclip: unique-ticket-queries=${#ticket_ids[@]}"
logline "# log: $LOG"

logline "# notification: no notification channel is configured"

if [ "$FAILURE_COUNT" -gt 0 ]; then
  exit 1
fi
