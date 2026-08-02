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
: > "$GH_COUNT"

cat > "$BIN_DIR/fake-gh" <<EOF
#!/bin/bash
echo "\$*" >> "$GH_COUNT"
case "\$*" in
  *"--head exact-merged-CRO-606"*) echo 606 ;;
esac
exit 0
EOF
chmod +x "$BIN_DIR/fake-gh"

cat > "$BIN_DIR/fake-ssh" <<EOF
#!/bin/bash
exec git-upload-pack "$REMOTE"
EOF
chmod +x "$BIN_DIR/fake-ssh"

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

add_wt identical-CRO-101 "$ROOT/identical-CRO-101"
add_wt differs-CRO-202 "$ROOT/differs-CRO-202"
add_wt dirty-CRO-333 "$ROOT/dirty-CRO-333"
add_wt integrated-CRO-303 "$ROOT/integrated-CRO-303"
add_wt exact-merged-CRO-606 "$ROOT/exact-merged-CRO-606"
add_wt active-CRO-505-origin "$ROOT/active-CRO-505-origin"
add_wt temporary-unrelated "$ROOT/unrelated-CRO-808"
add_wt outside-CRO-777 "$OUTSIDE"
git -C "$MAIN" worktree add --detach "$ROOT/detached-old" main >/dev/null 2>&1 || exit 1
touch -t "$OLD_STAMP" "$ROOT/detached-old"

printf 'changed\n' > "$ROOT/differs-CRO-202/README.md"
printf 'one\ntwo\n' > "$ROOT/differs-CRO-202/extra.txt"
git -C "$ROOT/differs-CRO-202" add README.md extra.txt >/dev/null || exit 1
git -C "$ROOT/differs-CRO-202" commit -m differs >/dev/null || exit 1

printf 'integrated one\nintegrated two\n' > "$ROOT/integrated-CRO-303/integrated.txt"
git -C "$ROOT/integrated-CRO-303" add integrated.txt >/dev/null || exit 1
git -C "$ROOT/integrated-CRO-303" commit -m integrated-branch >/dev/null || exit 1

printf 'merged elsewhere\n' > "$ROOT/exact-merged-CRO-606/README.md"
git -C "$ROOT/exact-merged-CRO-606" add README.md >/dev/null || exit 1
git -C "$ROOT/exact-merged-CRO-606" commit -m exact-merged >/dev/null || exit 1

git -C "$ROOT/unrelated-CRO-808" checkout --orphan unrelated-CRO-808 >/dev/null 2>&1 || exit 1
git -C "$ROOT/unrelated-CRO-808" rm -f README.md >/dev/null || exit 1
printf 'unrelated\n' > "$ROOT/unrelated-CRO-808/unrelated.txt"
git -C "$ROOT/unrelated-CRO-808" add unrelated.txt >/dev/null || exit 1
git -C "$ROOT/unrelated-CRO-808" commit -m unrelated >/dev/null || exit 1

touch -t "$OLD_STAMP" "$ROOT/differs-CRO-202" "$ROOT/integrated-CRO-303" "$ROOT/exact-merged-CRO-606" "$ROOT/unrelated-CRO-808"

printf 'main advanced\n' > "$MAIN/main-only.txt"
printf 'integrated one\nintegrated two\n' > "$MAIN/integrated.txt"
git -C "$MAIN" add main-only.txt integrated.txt >/dev/null || exit 1
git -C "$MAIN" commit -m advance-main >/dev/null || exit 1
git -C "$MAIN" push origin main >/dev/null 2>&1 || exit 1

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

echo dirty > "$ROOT/dirty-CRO-333/untracked.txt"
touch -t "$OLD_STAMP" "$ROOT/dirty-CRO-333"

mkdir -p "$ROOT/not-git-child" || exit 1
git init "$ROOT/standalone-repo" >/dev/null || exit 1
git -C "$ROOT/standalone-repo" config user.email test@example.invalid
git -C "$ROOT/standalone-repo" config user.name Test
echo standalone > "$ROOT/standalone-repo/file.txt"
git -C "$ROOT/standalone-repo" add file.txt >/dev/null || exit 1
git -C "$ROOT/standalone-repo" commit -m standalone >/dev/null || exit 1

DIRS_BEFORE="$TMP_ROOT/dirs.before"
REFS_BEFORE="$TMP_ROOT/refs.before"
WORKTREES_BEFORE="$TMP_ROOT/worktrees.before"
find "$ROOT" "$OTHER_ROOT" "$OUTSIDE" -type d -print | sort > "$DIRS_BEFORE" || exit 1
git -C "$MAIN" for-each-ref --format='%(refname) %(objectname)' | sort > "$REFS_BEFORE" || exit 1
git -C "$MAIN" worktree list --porcelain > "$WORKTREES_BEFORE" || exit 1

SWEEP_OUT="$TMP_ROOT/sweep.out"
CLIP_DIR="$CLIP_DIR_FIXTURE" LOG_DIR="$LOG_DIR_FIXTURE" GH_CLI="$BIN_DIR/fake-gh" GIT_SSH_COMMAND="$BIN_DIR/fake-ssh" \
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
assert_contains "$SWEEP_OUT" "$ROOT/dirty-CRO-333 :: DIRTY" "dirty zero-own worktree safe"
assert_not_contains "$SWEEP_OUT" "$ROOT/dirty-CRO-333 :: WOULD-TRASH" "dirty is not candidate"
assert_contains "$SWEEP_OUT" "$ROOT/identical-CRO-101 :: WOULD-TRASH" "clean zero-own branch candidate after main advances"
assert_contains "$SWEEP_OUT" "no own changes since merge-base" "merge-base reason"
assert_contains "$SWEEP_OUT" "$ROOT/detached-old :: WOULD-TRASH" "old detached zero-own candidate"
assert_contains "$SWEEP_OUT" "$ROOT/differs-CRO-202 :: own changes since merge-base" "own changes review reason"
assert_contains "$SWEEP_OUT" "files=2 +3/-1" "own committed diff stats"
assert_not_contains "$SWEEP_OUT" "$ROOT/differs-CRO-202 :: WOULD-TRASH" "own different content is not candidate"
assert_contains "$SWEEP_OUT" "$ROOT/integrated-CRO-303 :: own changes since merge-base" "integrated patch stays review without reliable reverse gate"
assert_contains "$SWEEP_OUT" "files=1 +2/-0" "integrated patch own diff stats"
assert_not_contains "$SWEEP_OUT" "$ROOT/integrated-CRO-303 :: WOULD-TRASH" "unreliable reverse-apply path is disabled"
assert_contains "$SWEEP_OUT" "$ROOT/unrelated-CRO-808 :: merge-base with origin/main unavailable" "missing merge-base fail-closed"
assert_not_contains "$SWEEP_OUT" "$ROOT/unrelated-CRO-808 :: WOULD-TRASH" "missing merge-base is not candidate"
assert_contains "$SWEEP_OUT" "$ROOT/exact-merged-CRO-606 :: WOULD-TRASH" "exact merged PR remains candidate"
assert_contains "$SWEEP_OUT" "merged PR #606" "exact merged PR reason"
assert_contains "$GH_COUNT" "--head exact-merged-CRO-606" "fake GitHub exact merged-PR path used"

DIRS_AFTER="$TMP_ROOT/dirs.after"
REFS_AFTER="$TMP_ROOT/refs.after"
WORKTREES_AFTER="$TMP_ROOT/worktrees.after"
find "$ROOT" "$OTHER_ROOT" "$OUTSIDE" -type d -print | sort > "$DIRS_AFTER" || exit 1
git -C "$MAIN" for-each-ref --format='%(refname) %(objectname)' | sort > "$REFS_AFTER" || exit 1
git -C "$MAIN" worktree list --porcelain > "$WORKTREES_AFTER" || exit 1
cmp -s "$DIRS_BEFORE" "$DIRS_AFTER" || fail "dry-run changed fixture directories"
cmp -s "$REFS_BEFORE" "$REFS_AFTER" || fail "dry-run changed refs"
cmp -s "$WORKTREES_BEFORE" "$WORKTREES_AFTER" || fail "dry-run changed worktree registration"

MISSING_OUT="$TMP_ROOT/missing-origin-main.out"
git -C "$MAIN" update-ref -d refs/remotes/origin/main || exit 1
CLIP_DIR="$CLIP_DIR_FIXTURE" LOG_DIR="$LOG_DIR_FIXTURE" GH_CLI="$BIN_DIR/fake-gh" GIT_SSH_COMMAND="$BIN_DIR/fake-ssh" \
  bash "$REPO_ROOT/scripts/crosstalk-worktree-sweep.sh" > "$MISSING_OUT" 2>&1 || fail "missing-origin/main sweep dry-run failed"
assert_contains "$MISSING_OUT" "$ROOT/identical-CRO-101 :: origin/main unavailable — fail closed" "missing origin/main review fail-closed"
assert_not_contains "$MISSING_OUT" "$ROOT/identical-CRO-101 :: WOULD-TRASH" "missing origin/main is not candidate"

mkdir -p "$ROOT/identical-CRO-101/.build/checkouts" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts" || exit 1
echo cache > "$ROOT/identical-CRO-101/.build/checkouts/stale.txt"
echo other-cache > "$OTHER_ROOT/cto-fed42-adr/.build/checkouts/stale.txt"
touch -t "$OLD_STAMP" "$ROOT/identical-CRO-101/.build/checkouts/stale.txt" "$ROOT/identical-CRO-101/.build/checkouts" "$ROOT/identical-CRO-101/.build"
touch -t "$OLD_STAMP" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts/stale.txt" "$OTHER_ROOT/cto-fed42-adr/.build/checkouts" "$OTHER_ROOT/cto-fed42-adr/.build"

CACHE_OUT="$TMP_ROOT/cache.out"
HOME="$TMP_ROOT" bash "$REPO_ROOT/scripts/crosstalk-build-cache-sweep.sh" --dry-run > "$CACHE_OUT" 2>&1 || fail "build cache sweep dry-run failed"
assert_contains "$CACHE_OUT" "candidate root=$ROOT path=$ROOT/identical-CRO-101/.build" "cache dry-run candidate reporting"
assert_contains "$CACHE_OUT" "action=would-trash" "cache dry-run action"
assert_contains "$CACHE_OUT" "standalone_repo root=$ROOT path=$ROOT/standalone-repo action=skip" "cache standalone skipped"
assert_contains "$CACHE_OUT" "ignored_linked_repo root=$OTHER_ROOT path=$OTHER_ROOT/cto-fed42-adr" "cache non-Crosstalk linked repo ignored"
assert_not_contains "$CACHE_OUT" "candidate root=$OTHER_ROOT path=$OTHER_ROOT/cto-fed42-adr/.build" "cache non-Crosstalk .build is not candidate"
[ -d "$ROOT/identical-CRO-101/.build" ] || fail "cache dry-run deleted .build"
[ -d "$OTHER_ROOT/cto-fed42-adr/.build" ] || fail "cache dry-run deleted non-Crosstalk .build"

printf 'PASS fixture=%s\n' "$TMP_ROOT"
