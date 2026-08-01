#!/bin/bash

# Bound rebuildable Crosstalk caches without deleting worktrees or source state.
# The normal window keeps a day of warm caches. Under disk pressure, completed
# builds are eligible after two quiet hours; active compiler working directories
# are always excluded.

set -u

CLIP_ROOT="${HOME}/clip"
DERIVED_ROOT="${HOME}/Library/Developer/Xcode/DerivedData"
PREVIEWS_ROOT="${HOME}/Library/Developer/Xcode/UserData/Previews"

LOW_WATER_KB=$((40 * 1024 * 1024))
XCODE_WATER_KB=$((30 * 1024 * 1024))
NORMAL_IDLE_MINUTES=$((24 * 60))
LOW_IDLE_MINUTES=120
XCODE_IDLE_MINUTES=360

APPLY=0
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
elif [ "${1:-}" = "--dry-run" ] || [ -z "${1:-}" ]; then
  APPLY=0
else
  echo "usage: $0 [--dry-run|--apply]" >&2
  exit 2
fi

failure_count=0
abort=0
tmp_files=""

cleanup_tmp_files() {
  local file
  for file in $tmp_files; do
    [ -n "$file" ] && unlink "$file" >/dev/null 2>&1
  done
}
trap cleanup_tmp_files EXIT

make_tmp_file() {
  local __var="$1" file
  file=$(mktemp "${TMPDIR:-/tmp}/crosstalk-build-cache-sweep.XXXXXX") || return 1
  tmp_files="${tmp_files}${tmp_files:+ }${file}"
  eval "$__var=\$file"
}

abort_with_failure() {
  echo "ERROR $*" >&2
  failure_count=$((failure_count + 1))
  abort=1
  return 1
}

scan_find() {
  local output="$1" err
  shift
  make_tmp_file err || abort_with_failure "mktemp failed for find stderr"
  [ "$abort" = "0" ] || return 1
  if ! find "$@" >"$output" 2>"$err"; then
    [ -s "$err" ] && sed 's/^/ERROR find: /' "$err" >&2
    abort_with_failure "critical scan failed: find $*"
    return 1
  fi
  return 0
}

candidate_action() {
  if [ "$APPLY" = "1" ]; then
    printf 'trash'
  else
    printf 'would-trash'
  fi
}

print_candidate() {
  local root="$1" path="$2" size_kb="$3"
  printf 'candidate root=%s path=%s size_kb=%s action=%s\n' "$root" "$path" "$size_kb" "$(candidate_action)"
}

free_kb() {
  df -k / | awk 'NR == 2 { print $4 }'
}

directory_has_recent_file() {
  local directory="$1" minutes="$2"
  find "$directory" -type f -mmin "-${minutes}" -print -quit 2>/dev/null | grep -q .
}

path_is_under() {
  local child="$1" parent="$2"
  case "$child" in
    "$parent"|"$parent"/*) return 0 ;;
  esac
  return 1
}

absolute_path() {
  local path="$1" base="$2" dir name
  case "$path" in
    /*) ;;
    *) path="$base/$path" ;;
  esac
  dir=$(dirname "$path")
  name=$(basename "$path")
  if [ -d "$dir" ]; then
    dir=$(cd "$dir" 2>/dev/null && pwd -P) || return 1
    printf '%s/%s\n' "$dir" "$name"
    return 0
  fi
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

linked_worktree_common_abs() {
  local child="$1" common common_abs child_git_abs
  [ -d "$child" ] || return 1
  common=$(git -C "$child" rev-parse --git-common-dir 2>/dev/null) || return 1
  common_abs=$(absolute_path "$common" "$child") || return 1
  child_git_abs=$(absolute_path ".git" "$child") || return 1
  if path_is_under "$common_abs" "$child_git_abs"; then
    return 1
  fi
  printf '%s\n' "$common_abs"
}

linked_worktree_gh_repo() {
  local child="$1" origin
  origin=$(git -C "$child" remote get-url origin 2>/dev/null) || return 1
  origin_to_gh_repo "$origin"
}

delete_with_trash() {
  local target="$1"
  if [ "$APPLY" != "1" ]; then
    return 0
  fi
  if ! command -v trash >/dev/null 2>&1; then
    abort_with_failure "trash command not found; refusing to delete: $target"
    return 1
  fi
  if ! trash "$target"; then
    abort_with_failure "trash failed: $target"
    return 1
  fi
  if [ -e "$target" ]; then
    abort_with_failure "path still exists after trash: $target"
    return 1
  fi
  return 0
}

# Capture compiler working directories once. This protects a build even if its
# filesystem timestamps happen not to change during the check/remove window.
ACTIVE_BUILD_CWDS=""
for pid in $(pgrep -f '(^|/)(xcodebuild|swift-build|swiftc|swift-frontend)( |$)' 2>/dev/null || true); do
  cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
  [ -n "$cwd" ] && ACTIVE_BUILD_CWDS="${ACTIVE_BUILD_CWDS}${cwd}
"
done

worktree_has_active_build() {
  local worktree="$1" cwd
  while IFS= read -r cwd; do
    case "$cwd" in
      "$worktree"|"$worktree"/*) return 0 ;;
    esac
  done <<< "$ACTIVE_BUILD_CWDS"
  return 1
}

candidate_count=0
candidate_kb=0
swift_candidate_count=0
swift_candidate_kb=0
xcode_candidate_count=0
xcode_candidate_kb=0
skipped_active=0
skipped_recent=0
linked_worktree_count=0
non_worktree_count=0
standalone_repo_count=0
ignored_linked_count=0
roots_count=0
xcode_skipped_recent=0

initial_free_kb=$(free_kb)
idle_minutes=$NORMAL_IDLE_MINUTES
[ "$initial_free_kb" -lt "$LOW_WATER_KB" ] && idle_minutes=$LOW_IDLE_MINUTES

printf 'mode=%s idle_minutes=%d free_before_gb=%d\n' "$([ "$APPLY" = "1" ] && echo apply || echo dry-run)" "$idle_minutes" "$((initial_free_kb / 1024 / 1024))"

if [ -d "$CLIP_ROOT" ]; then
  for root in "$CLIP_ROOT"/*-worktrees; do
    [ "$abort" = "0" ] || break
    [ -d "$root" ] || continue
    roots_count=$((roots_count + 1))
    root_candidates=0
    root_candidate_kb=0
    root_linked=0
    root_non_worktree=0
    root_standalone=0
    root_ignored_linked=0
    root_skipped_active=0
    root_skipped_recent=0
    make_tmp_file children_file || abort_with_failure "mktemp failed for root scan"
    [ "$abort" = "0" ] || break
    scan_find "$children_file" "$root" -mindepth 1 -maxdepth 1 -type d -print || break

    while IFS= read -r child; do
      [ "$abort" = "0" ] || break
      [ -d "$child" ] || continue
      common_abs=$(linked_worktree_common_abs "$child" 2>/dev/null || true)
      if [ -n "$common_abs" ]; then
        gh_repo=$(linked_worktree_gh_repo "$child" 2>/dev/null || true)
        if [ -z "$gh_repo" ]; then
          root_ignored_linked=$((root_ignored_linked + 1))
          ignored_linked_count=$((ignored_linked_count + 1))
          printf 'ignored_linked_repo root=%s path=%s common=%s reason=origin-unparseable action=skip\n' "$root" "$child" "$common_abs"
          continue
        fi
        if ! is_crosstalk_gh_repo "$gh_repo"; then
          root_ignored_linked=$((root_ignored_linked + 1))
          ignored_linked_count=$((ignored_linked_count + 1))
          printf 'ignored_linked_repo root=%s path=%s common=%s repo=%s reason=non-Crosstalk action=skip\n' "$root" "$child" "$common_abs" "$gh_repo"
          continue
        fi
        root_linked=$((root_linked + 1))
        linked_worktree_count=$((linked_worktree_count + 1))
        make_tmp_file build_dirs_file || abort_with_failure "mktemp failed for build scan"
        [ "$abort" = "0" ] || break
        scan_find "$build_dirs_file" "$child" -type d -name .build -prune -print || break
        while IFS= read -r build_dir; do
          [ "$abort" = "0" ] || break
          if worktree_has_active_build "$child"; then
            skipped_active=$((skipped_active + 1))
            root_skipped_active=$((root_skipped_active + 1))
            continue
          fi
          if directory_has_recent_file "$build_dir" "$idle_minutes"; then
            skipped_recent=$((skipped_recent + 1))
            root_skipped_recent=$((root_skipped_recent + 1))
            continue
          fi

          size_kb=$(du -sk "$build_dir" 2>/dev/null) || { abort_with_failure "du failed: $build_dir"; break; }
          size_kb=${size_kb%%[[:space:]]*}
          size_kb=${size_kb:-0}
          print_candidate "$root" "$build_dir" "$size_kb"
          root_candidates=$((root_candidates + 1))
          root_candidate_kb=$((root_candidate_kb + size_kb))
          candidate_count=$((candidate_count + 1))
          candidate_kb=$((candidate_kb + size_kb))
          swift_candidate_count=$((swift_candidate_count + 1))
          swift_candidate_kb=$((swift_candidate_kb + size_kb))
          delete_with_trash "$build_dir" || break
        done < "$build_dirs_file"
      else
        if git -C "$child" rev-parse --git-dir >/dev/null 2>&1; then
          root_standalone=$((root_standalone + 1))
          standalone_repo_count=$((standalone_repo_count + 1))
          printf 'standalone_repo root=%s path=%s action=skip\n' "$root" "$child"
        else
          root_non_worktree=$((root_non_worktree + 1))
          non_worktree_count=$((non_worktree_count + 1))
          printf 'non_worktree_child root=%s path=%s action=skip\n' "$root" "$child"
        fi
      fi
    done < "$children_file"

    printf 'root_summary root=%s linked_worktrees=%d ignored_linked_repos=%d candidates=%d reclaim_estimate_mb=%d skipped_active=%d skipped_recent=%d standalone_repos=%d non_worktree_children=%d\n' \
      "$root" "$root_linked" "$root_ignored_linked" "$root_candidates" "$((root_candidate_kb / 1024))" "$root_skipped_active" "$root_skipped_recent" "$root_standalone" "$root_non_worktree"
  done
fi

# Xcode caches are a secondary pressure valve. Keep them while there is at
# least 30 GiB free; below that line, remove only individually idle entries.
after_swift_free_kb=$(free_kb)
if [ "$abort" = "0" ] && [ "$after_swift_free_kb" -lt "$XCODE_WATER_KB" ]; then
  if [ -d "$DERIVED_ROOT" ]; then
    make_tmp_file xcode_dirs_file || abort_with_failure "mktemp failed for Xcode scan"
    if [ "$abort" = "0" ]; then
      scan_find "$xcode_dirs_file" "$DERIVED_ROOT" -mindepth 1 -maxdepth 1 -type d -print
    fi
    while [ "$abort" = "0" ] && IFS= read -r cache_dir; do
      if directory_has_recent_file "$cache_dir" "$XCODE_IDLE_MINUTES"; then
        xcode_skipped_recent=$((xcode_skipped_recent + 1))
        continue
      fi
      size_kb=$(du -sk "$cache_dir" 2>/dev/null) || { abort_with_failure "du failed: $cache_dir"; break; }
      size_kb=${size_kb%%[[:space:]]*}
      size_kb=${size_kb:-0}
      print_candidate "$DERIVED_ROOT" "$cache_dir" "$size_kb"
      candidate_count=$((candidate_count + 1))
      candidate_kb=$((candidate_kb + size_kb))
      xcode_candidate_count=$((xcode_candidate_count + 1))
      xcode_candidate_kb=$((xcode_candidate_kb + size_kb))
      delete_with_trash "$cache_dir" || break
    done < "$xcode_dirs_file"
  fi

  if [ "$abort" = "0" ] && [ -d "$PREVIEWS_ROOT" ]; then
    if directory_has_recent_file "$PREVIEWS_ROOT" "$XCODE_IDLE_MINUTES"; then
      xcode_skipped_recent=$((xcode_skipped_recent + 1))
    else
      size_kb=$(du -sk "$PREVIEWS_ROOT" 2>/dev/null) || abort_with_failure "du failed: $PREVIEWS_ROOT"
      if [ "$abort" = "0" ]; then
        size_kb=${size_kb%%[[:space:]]*}
        size_kb=${size_kb:-0}
        print_candidate "$PREVIEWS_ROOT" "$PREVIEWS_ROOT" "$size_kb"
        candidate_count=$((candidate_count + 1))
        candidate_kb=$((candidate_kb + size_kb))
        xcode_candidate_count=$((xcode_candidate_count + 1))
        xcode_candidate_kb=$((xcode_candidate_kb + size_kb))
        delete_with_trash "$PREVIEWS_ROOT"
      fi
    fi
  fi
else
  if [ "$abort" = "0" ]; then
    printf 'xcode_summary action=skip reason=free_space_above_watermark free_gb=%d watermark_gb=%d\n' \
      "$((after_swift_free_kb / 1024 / 1024))" "$((XCODE_WATER_KB / 1024 / 1024))"
  fi
fi

final_free_kb=$(free_kb)
mode="dry-run"
[ "$APPLY" = "1" ] && mode="apply"
printf '%s mode=%s roots=%d linked_worktrees=%d ignored_linked_repos=%d swift_candidates=%d swift_reclaim_estimate_mb=%d xcode_candidates=%d xcode_reclaim_estimate_mb=%d total_candidates=%d total_reclaim_estimate_mb=%d skipped_active=%d skipped_recent=%d xcode_skipped_recent=%d standalone_repos=%d non_worktree_children=%d failures=%d free_before_gb=%d free_after_gb=%d\n' \
  "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$mode" "$roots_count" "$linked_worktree_count" "$ignored_linked_count" \
  "$swift_candidate_count" "$((swift_candidate_kb / 1024))" "$xcode_candidate_count" "$((xcode_candidate_kb / 1024))" \
  "$candidate_count" "$((candidate_kb / 1024))" "$skipped_active" "$skipped_recent" "$xcode_skipped_recent" \
  "$standalone_repo_count" "$non_worktree_count" "$failure_count" "$((initial_free_kb / 1024 / 1024))" "$((final_free_kb / 1024 / 1024))"

[ "$failure_count" -eq 0 ] || exit 1
exit 0
