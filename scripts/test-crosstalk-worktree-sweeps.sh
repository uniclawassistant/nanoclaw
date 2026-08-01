#!/bin/bash
# Deterministic safety tests for Crosstalk worktree/cache sweep dry-runs.
# Leaves its temp fixture in place; if trash(1) exists the EXIT trap moves it to Trash.

set -u

fail() {
  echo "FAIL: $*" >&2
  echo "fixture: ${TMP_ROOT:-not-created}" >&2
  exit 1
}

assert_contains() {
  local file="$1" pattern="$2" label="$3"
  if ! grep -qF -- "$pattern" "$file"; then
    echo "--- $file ---" >&2
    sed 's/^/| /' "$file" >&2
    fail "$label: missing [$pattern]"
  fi
}

assert_not_contains() {
  local file="$1" pattern="$2" label="$3"
  if grep -qF -- "$pattern" "$file"; then
    echo "--- $file ---" >&2
    sed 's/^/| /' "$file" >&2
    fail "$label: unexpected [$pattern]"
  fi
}

assert_count() {
  local expected="$1" pattern="$2" file="$3" label="$4" actual
  actual=$(grep -cF -- "$pattern" "$file" 2>/dev/null || true)
  if [ "$actual" != "$expected" ]; then
    echo "--- $file ---" >&2
    sed 's/^/| /' "$file" >&2
    fail "$label: expected $expected got $actual for [$pattern]"
  fi
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd -P) || exit 1
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/crosstalk-sweep-test.XXXXXX") || exit 1
TMP_ROOT=$(cd "$TMP_ROOT" && pwd -P) || exit 1
trap 'if command -v trash >/dev/null 2>&1 && [ -n "${TMP_ROOT:-}" ] && [ -e "$TMP_ROOT" ]; then trash "$TMP_ROOT" >/dev/null 2>&1 || echo "fixture left at $TMP_ROOT" >&2; else echo "fixture left at ${TMP_ROOT:-unknown}" >&2; fi' EXIT

BIN_DIR="$TMP_ROOT/bin"
CLIP_DIR_FIXTURE="$TMP_ROOT/clip"
ROOT="$CLIP_DIR_FIXTURE/demo-worktrees"
OTHER_ROOT="$CLIP_DIR_FIXTURE/other-worktrees"
LOG_DIR_FIXTURE="$TMP_ROOT/logs"
PCP_COUNT="$TMP_ROOT/pcp-count.log"
GH_COUNT="$TMP_ROOT/gh-count.log"
REMOTE="$TMP_ROOT/remote.git"
OTHER_REMOTE="$TMP_ROOT/other-remote.git"
MAIN="$TMP_ROOT/main"
OTHER_MAIN="$TMP_ROOT/other-main"
OUTSIDE="$TMP_ROOT/outside-CRO-777-done"
OLD_STAMP=202001010000

mkdir -p "$BIN_DIR" "$ROOT" "$OTHER_ROOT" "$LOG_DIR_FIXTURE" || exit 1
ROOT=$(cd "$ROOT" && pwd -P) || exit 1
OTHER_ROOT=$(cd "$OTHER_ROOT" && pwd -P) || exit 1
CLIP_DIR_FIXTURE=$(cd "$CLIP_DIR_FIXTURE" && pwd -P) || exit 1
LOG_DIR_FIXTURE=$(cd "$LOG_DIR_FIXTURE" && pwd -P) || exit 1
: > "$PCP_COUNT"
: > "$GH_COUNT"

cat > "$BIN_DIR/fake-gh" <<EOF
#!/bin/bash
echo "\$*" >> "$GH_COUNT"
exit 0
EOF
chmod +x "$BIN_DIR/fake-gh"

cat > "$BIN_DIR/fake-ssh" <<EOF
#!/bin/bash
exec git-upload-pack "$REMOTE"
EOF
chmod +x "$BIN_DIR/fake-ssh"

cat > "$BIN_DIR/fake-pcp" <<EOF
#!/bin/bash
echo "\$*" >> "$PCP_COUNT"
if [ "\$1" != "issue" ]; then exit 2; fi
case "\$2" in
  CRO-101) echo '{"status":{"name":"done"}}' ;;
  CRO-202) echo '{"status":{"name":"todo"}}' ;;
  CRO-333) echo '{"status":{"name":"done"}}' ;;
  CRO-404) echo '404 not found' ;;
  CRO-444) echo '{"status":{"name":"done"}}' ;;
  *) echo '{"status":{"name":"blocked"}}' ;;
esac
EOF
chmod +x "$BIN_DIR/fake-pcp"

# Keep Xcode/lsof/pgrep behavior deterministic for host-independent tests.
cat > "$BIN_DIR/pgrep" <<'EOF'
#!/bin/bash
exit 1
EOF
chmod +x "$BIN_DIR/pgrep"

PATH="$BIN_DIR:$PATH"
export PATH

git init --bare "$REMOTE" >/dev/null || exit 1
git init "$MAIN" >/dev/null || exit 1
git -C "$MAIN" config user.email test@example.invalid
git -C "$MAIN" config user.name Test
git -C "$MAIN" config init.defaultBranch main
git -C "$MAIN" checkout -b main >/dev/null 2>&1 || exit 1
echo base > "$MAIN/README.md"
git -C "$MAIN" add README.md >/dev/null || exit 1
git -C "$MAIN" commit -m base >/dev/null || exit 1
git -C "$MAIN" remote add origin "file://$REMOTE" || exit 1
git -C "$MAIN" push -u origin main >/dev/null 2>&1 || exit 1

add_wt() {
  local branch="$1" path="$2"
  git -C "$MAIN" worktree add -b "$branch" "$path" main >/dev/null 2>&1 || exit 1
  touch -t "$OLD_STAMP" "$path"
}

add_wt clean-CRO-101-done "$ROOT/clean-CRO-101-done"
add_wt keep-CRO-202-todo "$ROOT/keep-CRO-202-todo"
add_wt dirty-CRO-333-done "$ROOT/dirty-CRO-333-done"
add_wt bad-CRO-404-output "$ROOT/bad-CRO-404-output"
add_wt dup-a-CRO-444-done "$ROOT/dup-a-CRO-444-done"
add_wt dup-b-CRO-444-done "$ROOT/dup-b-CRO-444-done"
add_wt active-CRO-505-origin "$ROOT/active-CRO-505-origin"
add_wt no-ticket-branch "$ROOT/no-ticket-branch"
add_wt outside-CRO-777-done "$OUTSIDE"

git -C "$ROOT/active-CRO-505-origin" push -u origin active-CRO-505-origin >/dev/null 2>&1 || exit 1
git -C "$MAIN" remote set-url origin git@github.com:acme/crosstalk-demo.git || exit 1

git init --bare "$OTHER_REMOTE" >/dev/null || exit 1
git init "$OTHER_MAIN" >/dev/null || exit 1
git -C "$OTHER_MAIN" config user.email test@example.invalid
git -C "$OTHER_MAIN" config user.name Test
git -C "$OTHER_MAIN" checkout -b main >/dev/null 2>&1 || exit 1
echo other > "$OTHER_MAIN/README.md"
git -C "$OTHER_MAIN" add README.md >/dev/null || exit 1
git -C "$OTHER_MAIN" commit -m base >/dev/null || exit 1
git -C "$OTHER_MAIN" remote add origin "file://$OTHER_REMOTE" || exit 1
git -C "$OTHER_MAIN" push -u origin main >/dev/null 2>&1 || exit 1
git -C "$OTHER_MAIN" worktree add -b cto-fed42-adr "$OTHER_ROOT/cto-fed42-adr" main >/dev/null 2>&1 || exit 1
touch -t "$OLD_STAMP" "$OTHER_ROOT/cto-fed42-adr"
git -C "$OTHER_MAIN" remote set-url origin git@github.com:Fedos/swift-flush.git || exit 1

echo dirty > "$ROOT/dirty-CRO-333-done/untracked.txt"
touch -t "$OLD_STAMP" "$ROOT/dirty-CRO-333-done"

mkdir -p "$ROOT/not-git-child" || exit 1
git init "$ROOT/standalone-repo" >/dev/null || exit 1
git -C "$ROOT/standalone-repo" config user.email test@example.invalid
git -C "$ROOT/standalone-repo" config user.name Test
echo standalone > "$ROOT/standalone-repo/file.txt"
git -C "$ROOT/standalone-repo" add file.txt >/dev/null || exit 1
git -C "$ROOT/standalone-repo" commit -m standalone >/dev/null || exit 1

SWEEP_OUT="$TMP_ROOT/sweep.out"
CLIP_DIR="$CLIP_DIR_FIXTURE" LOG_DIR="$LOG_DIR_FIXTURE" PCP_CLI="$BIN_DIR/fake-pcp" GH_CLI="$BIN_DIR/fake-gh" GIT_SSH_COMMAND="$BIN_DIR/fake-ssh" \
  bash "$REPO_ROOT/scripts/crosstalk-worktree-sweep.sh" > "$SWEEP_OUT" 2>&1 || fail "worktree sweep dry-run failed"

assert_contains "$SWEEP_OUT" "# GH_CLI=$BIN_DIR/fake-gh" "GH_CLI env hook"
assert_contains "$SWEEP_OUT" "# log: $LOG_DIR_FIXTURE/sweep-" "LOG_DIR env hook"
assert_contains "$SWEEP_OUT" "repos=1" "discovery only targets Crosstalk repo"
assert_contains "$SWEEP_OUT" "ignored-linked=1" "non-Crosstalk linked repo ignored"
assert_contains "$SWEEP_OUT" "$OTHER_ROOT/cto-fed42-adr :: linked worktree common=" "non-Crosstalk linked worktree reported ignored"
assert_contains "$SWEEP_OUT" "repo=Fedos/swift-flush basename=swift-flush action=ignore-non-Crosstalk" "non-Crosstalk repo basename ignored"
assert_not_contains "$SWEEP_OUT" "$OTHER_ROOT/cto-fed42-adr :: WOULD-TRASH" "non-Crosstalk linked worktree is not candidate"
assert_contains "$SWEEP_OUT" "$ROOT/not-git-child :: not a git worktree/repo" "nongit reporting"
assert_contains "$SWEEP_OUT" "$ROOT/standalone-repo :: standalone repo (not deleted)" "standalone reporting"
assert_contains "$SWEEP_OUT" "$MAIN :: registered main checkout" "main checkout safe"
assert_contains "$SWEEP_OUT" "$OUTSIDE :: registered worktree outside discovered roots" "outside worktree safe"
assert_contains "$SWEEP_OUT" "$ROOT/dirty-CRO-333-done :: DIRTY" "dirty terminal ticket safe"
assert_not_contains "$SWEEP_OUT" "$ROOT/dirty-CRO-333-done :: WOULD-TRASH" "dirty is not candidate"
assert_contains "$SWEEP_OUT" "$ROOT/clean-CRO-101-done :: WOULD-TRASH" "terminal gone branch candidate"
assert_contains "$SWEEP_OUT" "$ROOT/keep-CRO-202-todo :: Paperclip CRO-202 nonterminal status=todo" "nonterminal kept"
assert_contains "$SWEEP_OUT" "$ROOT/bad-CRO-404-output :: Paperclip status parse failed for CRO-404" "malformed Paperclip output review-needed"
assert_contains "$SWEEP_OUT" "$ROOT/no-ticket-branch :: branch gone, no exact merged PR" "no ticket review-needed"
assert_contains "$SWEEP_OUT" "# paperclip: unique-ticket-queries=4" "unique ticket summary"
assert_count 1 "issue CRO-444" "$PCP_COUNT" "ticket cache avoids duplicate Paperclip lookup"
assert_contains "$GH_COUNT" "--head clean-CRO-101-done" "fake GitHub CLI used"

for path in "$ROOT/clean-CRO-101-done" "$ROOT/dup-a-CRO-444-done" "$ROOT/dup-b-CRO-444-done" "$ROOT/dirty-CRO-333-done" "$OUTSIDE"; do
  [ -d "$path" ] || fail "dry-run removed directory $path"
done
git -C "$MAIN" show-ref --verify --quiet refs/heads/clean-CRO-101-done || fail "dry-run deleted local branch ref"
git -C "$MAIN" worktree list --porcelain | grep -qF "$ROOT/clean-CRO-101-done" || fail "dry-run pruned worktree registration"

mkdir -p "$ROOT/clean-CRO-101-done/.build/checkouts" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts" || exit 1
echo cache > "$ROOT/clean-CRO-101-done/.build/checkouts/stale.txt"
echo other-cache > "$OTHER_ROOT/cto-fed42-adr/.build/checkouts/stale.txt"
touch -t "$OLD_STAMP" "$ROOT/clean-CRO-101-done/.build/checkouts/stale.txt" "$ROOT/clean-CRO-101-done/.build/checkouts" "$ROOT/clean-CRO-101-done/.build"
touch -t "$OLD_STAMP" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts/stale.txt" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts" "$OTHER_ROOT/cto-fed42-adr/.build"

CACHE_OUT="$TMP_ROOT/cache.out"
HOME="$TMP_ROOT" bash "$REPO_ROOT/scripts/crosstalk-build-cache-sweep.sh" --dry-run > "$CACHE_OUT" 2>&1 || fail "build cache sweep dry-run failed"
assert_contains "$CACHE_OUT" "candidate root=$ROOT path=$ROOT/clean-CRO-101-done/.build" "cache dry-run candidate reporting"
assert_contains "$CACHE_OUT" "action=would-trash" "cache dry-run action"
assert_contains "$CACHE_OUT" "standalone_repo root=$ROOT path=$ROOT/standalone-repo action=skip" "cache standalone skipped"
assert_contains "$CACHE_OUT" "ignored_linked_repo root=$OTHER_ROOT path=$OTHER_ROOT/cto-fed42-adr" "cache non-Crosstalk linked repo ignored"
assert_not_contains "$CACHE_OUT" "candidate root=$OTHER_ROOT path=$OTHER_ROOT/cto-fed42-adr/.build" "cache non-Crosstalk .build is not candidate"
[ -d "$ROOT/clean-CRO-101-done/.build" ] || fail "cache dry-run deleted .build"
[ -d "$OTHER_ROOT/cto-fed42-adr/.build" ] || fail "cache dry-run deleted non-Crosstalk .build"

printf 'PASS fixture=%s\n' "$TMP_ROOT"
