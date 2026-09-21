#!/usr/bin/env bash
# Exercise open_work/list_work/close_work through the image's real MCP server.
# Database access in this script is read-only; all state changes go through MCP.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/smoke-work-continuation.sh \
    --checkout PATH \
    --image IMAGE \
    --group GROUP_FOLDER \
    --chat-jid CHAT_JID \
    [--work-id WORK_ID] \
    [--remaining TEXT] \
    [--existing-work] \
    [--container-runtime PATH] \
    [--expect-open-text TEXT] \
    [--expect-close-text TEXT] \
    [--close-work-id WORK_ID]

Default mode is synthetic: without --work-id the script creates a unique id;
an explicitly supplied id must not already exist. The script opens and removes
it through MCP. --existing-work is the explicit destructive mode for reopening
a known row; it requires --work-id, and its complete original state (including
remaining) is printed before open_work overwrites it.

The expectation overrides and --close-work-id are intended for red acceptance
runs. If a deliberately wrong close id leaves the target open, the script
closes the real id through MCP before reporting failure.
EOF
}

require_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    echo "Missing value for $1" >&2
    usage >&2
    exit 64
  fi
}

CHECKOUT=
IMAGE=
GROUP=
CHAT_JID=
WORK_ID=
REMAINING=
EXISTING_WORK=0
CONTAINER_RUNTIME=${CONTAINER_RUNTIME:-container}
EXPECT_OPEN_TEXT='{"ok":true}'
EXPECT_CLOSE_TEXT='{"ok":true,"closed":true}'
CLOSE_WORK_ID=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --checkout)
      require_value "$@"; CHECKOUT=$2; shift 2 ;;
    --image)
      require_value "$@"; IMAGE=$2; shift 2 ;;
    --group)
      require_value "$@"; GROUP=$2; shift 2 ;;
    --chat-jid)
      require_value "$@"; CHAT_JID=$2; shift 2 ;;
    --work-id)
      require_value "$@"; WORK_ID=$2; shift 2 ;;
    --remaining)
      require_value "$@"; REMAINING=$2; shift 2 ;;
    --existing-work)
      EXISTING_WORK=1; shift ;;
    --container-runtime)
      require_value "$@"; CONTAINER_RUNTIME=$2; shift 2 ;;
    --expect-open-text)
      require_value "$@"; EXPECT_OPEN_TEXT=$2; shift 2 ;;
    --expect-close-text)
      require_value "$@"; EXPECT_CLOSE_TEXT=$2; shift 2 ;;
    --close-work-id)
      require_value "$@"; CLOSE_WORK_ID=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64 ;;
  esac
done

for required in CHECKOUT IMAGE GROUP CHAT_JID; do
  if [ -z "${!required}" ]; then
    echo "Missing required argument: ${required}" >&2
    usage >&2
    exit 64
  fi
done
if [ "$EXISTING_WORK" -eq 1 ] && [ -z "$WORK_ID" ]; then
  echo '--existing-work requires --work-id' >&2
  usage >&2
  exit 64
fi
if [ -z "$WORK_ID" ]; then
  WORK_ID="smoke-work-continuation-$(date -u '+%Y%m%dT%H%M%SZ')-$$-$RANDOM"
fi

CHECKOUT=$(cd "$CHECKOUT" && pwd)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT="$SCRIPT_DIR/work-continuation-smoke-client.mjs"
DB="$CHECKOUT/store/messages.db"
IPC="$CHECKOUT/data/ipc/$GROUP"
STDOUT_LOG="$CHECKOUT/logs/nanoclaw.log"
STDERR_LOG="$CHECKOUT/logs/nanoclaw.error.log"
CLOSE_WORK_ID=${CLOSE_WORK_ID:-$WORK_ID}
REMAINING=${REMAINING:-"NanoClaw work-continuation smoke $(date -u '+%Y-%m-%dT%H:%M:%SZ')"}

command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 69; }
command -v "$CONTAINER_RUNTIME" >/dev/null || {
  echo "Container runtime not found: $CONTAINER_RUNTIME" >&2
  exit 69
}
[ -f "$CLIENT" ] || { echo "MCP client not found: $CLIENT" >&2; exit 66; }
[ -r "$DB" ] || { echo "Database is not readable: $DB" >&2; exit 66; }
[ -d "$IPC" ] || { echo "IPC directory not found: $IPC" >&2; exit 66; }
[ -r "$STDOUT_LOG" ] || { echo "Log is not readable: $STDOUT_LOG" >&2; exit 66; }
[ -r "$STDERR_LOG" ] || { echo "Log is not readable: $STDERR_LOG" >&2; exit 66; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-work-smoke.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
RESULT="$TMP/result.json"
BEFORE="$TMP/before.json"
AFTER="$TMP/after.json"
LOG_SCAN="$TMP/log-scan.json"
RUNTIME_STDOUT="$TMP/runtime.stdout"
RUNTIME_STDERR="$TMP/runtime.stderr"

STDOUT_LOG=$STDOUT_LOG STDERR_LOG=$STDERR_LOG python3 - "$TMP/log-before.json" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

records = []
for name, value in (
    ('nanoclaw.log', os.environ['STDOUT_LOG']),
    ('nanoclaw.error.log', os.environ['STDERR_LOG']),
):
    path = pathlib.Path(value)
    data = path.read_bytes()
    stat = path.stat()
    records.append({
        'name': name,
        'path': str(path),
        'device': stat.st_dev,
        'inode': stat.st_ino,
        'size': len(data),
        'prefixSha256': hashlib.sha256(data).hexdigest(),
    })
with open(sys.argv[1], 'w') as output:
    json.dump(records, output, separators=(',', ':'))
    output.write('\n')
PY

read_state() {
  local destination=$1
  DB_PATH=$DB GROUP_FOLDER=$GROUP TARGET_WORK_ID=$WORK_ID python3 - "$destination" <<'PY'
import json
import os
import pathlib
import sqlite3
import sys

path = pathlib.Path(os.environ['DB_PATH']).resolve()
connection = sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
try:
    rows = connection.execute(
        'SELECT * FROM open_work WHERE group_folder = ? AND id = ?',
        (os.environ['GROUP_FOLDER'], os.environ['TARGET_WORK_ID']),
    ).fetchall()
finally:
    connection.close()
with open(sys.argv[1], 'w') as output:
    json.dump([dict(row) for row in rows], output, ensure_ascii=False, separators=(',', ':'))
    output.write('\n')
PY
}

read_state "$BEFORE"
BEFORE_COUNT=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$BEFORE")
if [ "$EXISTING_WORK" -eq 0 ] && [ "$BEFORE_COUNT" -ne 0 ]; then
  echo 'smoke-work-continuation/1'
  echo "STATE before (read-only): $(cat "$BEFORE")"
  echo "FAIL step=preflight-synthetic-id work id already exists; use --existing-work only for an intentional live-row check" >&2
  exit 2
fi
if [ "$EXISTING_WORK" -eq 1 ] && [ "$BEFORE_COUNT" -eq 0 ]; then
  echo 'smoke-work-continuation/1'
  echo "STATE before (read-only): $(cat "$BEFORE")"
  echo 'FAIL step=preflight-existing-work requested row does not exist' >&2
  exit 2
fi

set +e
"$CONTAINER_RUNTIME" run --rm \
  --entrypoint node \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/node \
  -e "NANOCLAW_CHAT_JID=$CHAT_JID" \
  -e "NANOCLAW_GROUP_FOLDER=$GROUP" \
  -e NANOCLAW_IS_MAIN=0 \
  -e SMOKE_RESULT_PATH=/smoke-output/result.json \
  -e "SMOKE_WORK_ID=$WORK_ID" \
  -e "SMOKE_CLOSE_WORK_ID=$CLOSE_WORK_ID" \
  -e "SMOKE_REMAINING=$REMAINING" \
  -v "$IPC:/workspace/ipc" \
  -v "$SCRIPT_DIR:/smoke" \
  -v "$TMP:/smoke-output" \
  "$IMAGE" /smoke/work-continuation-smoke-client.mjs \
  >"$RUNTIME_STDOUT" 2>"$RUNTIME_STDERR"
RUNTIME_STATUS=$?
set -e

read_state "$AFTER"

STDOUT_LOG=$STDOUT_LOG STDERR_LOG=$STDERR_LOG TMP_PATH=$TMP python3 - "$LOG_SCAN" <<'PY'
import hashlib
import json
import os
import pathlib
import re
import sys

root = pathlib.Path(os.environ['TMP_PATH'])
before_records = {
    record['name']: record
    for record in json.loads((root / 'log-before.json').read_text())
}
error_pattern = re.compile(r'(?i)(\berror\b|\bfatal\b|exception|uncaught|unhandled|panic)')
records = []
for name, path_text in (
    ('nanoclaw.log', os.environ['STDOUT_LOG']),
    ('nanoclaw.error.log', os.environ['STDERR_LOG']),
):
    before = before_records[name]
    path = pathlib.Path(path_text)
    data = path.read_bytes()
    stat = path.stat()
    offset = before['size']
    prefix_matches = (
        len(data) >= offset
        and hashlib.sha256(data[:offset]).hexdigest() == before['prefixSha256']
    )
    rotated = (
        stat.st_dev != before['device']
        or stat.st_ino != before['inode']
        or len(data) < offset
        or not prefix_matches
    )
    scanned = data if rotated else data[offset:]
    lines = scanned.decode('utf-8', errors='replace').splitlines()
    records.append({
        'name': name,
        'offset': offset,
        'finalBytes': len(data),
        'rotatedOrTruncated': rotated,
        'scanScope': 'whole-current-file-after-rotation' if rotated else 'appended-bytes',
        'foreignKeyConstraintFailed': [
            line for line in lines if 'FOREIGN KEY constraint failed' in line
        ],
        'errors': [line for line in lines if error_pattern.search(line)],
    })
with open(sys.argv[1], 'w') as output:
    json.dump(records, output, ensure_ascii=False, separators=(',', ':'))
    output.write('\n')
PY

CHECKOUT=$CHECKOUT \
WORK_ID=$WORK_ID \
REMAINING=$REMAINING \
EXISTING_WORK=$EXISTING_WORK \
EXPECT_OPEN_TEXT=$EXPECT_OPEN_TEXT \
EXPECT_CLOSE_TEXT=$EXPECT_CLOSE_TEXT \
CLOSE_WORK_ID=$CLOSE_WORK_ID \
RUNTIME_STATUS=$RUNTIME_STATUS \
RUNTIME_STDOUT=$RUNTIME_STDOUT \
RUNTIME_STDERR=$RUNTIME_STDERR \
BEFORE=$BEFORE \
AFTER=$AFTER \
RESULT=$RESULT \
LOG_SCAN=$LOG_SCAN \
python3 <<'PY'
import json
import os
import pathlib
import sys


def read_text(name):
    return pathlib.Path(os.environ[name]).read_text(errors='replace')


def event_for(events, step):
    return next((event for event in events if event.get('step') == step), None)


def response_body(event):
    if not event or 'text' not in event:
        return None
    try:
        return json.loads(event['text'])
    except (TypeError, json.JSONDecodeError):
        return None


before_text = read_text('BEFORE').strip()
after_text = read_text('AFTER').strip()
before = json.loads(before_text)
after = json.loads(after_text)
logs = json.loads(read_text('LOG_SCAN'))
runtime_status = int(os.environ['RUNTIME_STATUS'])
result_path = pathlib.Path(os.environ['RESULT'])
result = json.loads(result_path.read_text()) if result_path.is_file() else None
events = result.get('events', []) if result else []
work_id = os.environ['WORK_ID']
remaining = os.environ['REMAINING']

print('smoke-work-continuation/1')
print(f"checkout={os.environ['CHECKOUT']}")
print(f'work_id={work_id}')
print(f"mode={'existing' if os.environ['EXISTING_WORK'] == '1' else 'synthetic'}")
print(f'STATE before (read-only): {before_text}')
if os.environ['EXISTING_WORK'] == '1' and before:
    print(f"ORIGINAL remaining: {before[0].get('remaining', '')}")

if result:
    for event in events:
        step = event.get('step', 'unknown')
        tool = event.get('tool', 'unknown')
        if 'responseJson' in event:
            print(f'MCP step={step} tool={tool} response:')
            print(event['responseJson'])
            print(f'MCP step={step} tool={tool} text:')
            print(event.get('text', ''))
        else:
            print(f"MCP step={step} tool={tool} exception: {event.get('exception', '')}")
    if result.get('serverStderr'):
        print('MCP server stderr:')
        print(result['serverStderr'], end='' if result['serverStderr'].endswith('\n') else '\n')
else:
    print('MCP result: (missing)')

print(f'STATE after (read-only): {after_text}')
for record in logs:
    print(
        f"LOG {record['name']} offset={record['offset']} "
        f"final_bytes={record['finalBytes']} "
        f"rotated_or_truncated={str(record['rotatedOrTruncated']).lower()} "
        f"scan_scope={record['scanScope']}"
    )
    print(
        f"LOG {record['name']} FOREIGN_KEY_CONSTRAINT_FAILED "
        f"count={len(record['foreignKeyConstraintFailed'])}"
    )
    for line in record['foreignKeyConstraintFailed']:
        print(line)
    print(f"LOG {record['name']} ERRORS count={len(record['errors'])}")
    for line in record['errors']:
        print(line)

failure = None

def fail(step, message):
    global failure
    if failure is None:
        failure = (step, message)

if runtime_status != 0:
    fail('container-client', f'container client exited {runtime_status}')
if result is None:
    fail('container-client', 'result.json was not produced')
elif result.get('exitCode') != 0:
    fail('container-client', f"MCP client exited {result.get('exitCode')}")

opened = event_for(events, 'open_work')
if not opened or 'responseJson' not in opened:
    fail('open_work', 'literal MCP response is missing')
elif opened.get('text') != os.environ['EXPECT_OPEN_TEXT']:
    fail(
        'open_work-exact',
        f"expected {os.environ['EXPECT_OPEN_TEXT']!r}, got {opened.get('text')!r}",
    )
open_body = response_body(opened)
if open_body is None or open_body.get('ok') is not True:
    fail('open_work-semantic', f'expected ok=true, got {opened.get("text") if opened else None!r}')

listed = event_for(events, 'list_work')
if not listed or 'responseJson' not in listed:
    fail('list_work', 'literal MCP response is missing')
else:
    listed_text = listed.get('text', '')
    if f'[{work_id}]' not in listed_text:
        fail('list_work-id', f'work id [{work_id}] is absent')
    remaining_preview = remaining if len(remaining) <= 50 else f'{remaining[:50]}...'
    if remaining_preview not in listed_text:
        fail(
            'list_work-remaining',
            f'expected remaining preview {remaining_preview!r} is absent',
        )
    if ' - open, continuations: 0,' not in listed_text:
        fail('list_work-state', 'expected status open and continuations: 0')

closed = event_for(events, 'close_work')
if not closed or 'responseJson' not in closed:
    fail('close_work', 'literal MCP response is missing')
elif closed.get('text') != os.environ['EXPECT_CLOSE_TEXT']:
    fail(
        'close_work-exact',
        f"expected {os.environ['EXPECT_CLOSE_TEXT']!r}, got {closed.get('text')!r}",
    )
close_body = response_body(closed)
if close_body is None or close_body.get('ok') is not True or close_body.get('closed') is not True:
    fail('close_work-semantic', f'expected ok=true and closed=true, got {closed.get("text") if closed else None!r}')

cleanup = event_for(events, 'cleanup_close_work')
if cleanup:
    cleanup_body = response_body(cleanup)
    if cleanup_body is None or cleanup_body.get('closed') is not True:
        fail('cleanup-close-work', f'cleanup did not close target: {cleanup.get("text")!r}')

post_list = event_for(events, 'post_close_list')
if not post_list or 'responseJson' not in post_list:
    fail('post-close-list', 'literal MCP response is missing')
elif f'[{work_id}]' in post_list.get('text', ''):
    fail('post-close-list', f'work id [{work_id}] is still visible')

if after:
    fail('post-close-db', 'target row still exists after close_work')

for record in logs:
    if record['rotatedOrTruncated']:
        fail(f"logs-{record['name']}-rotation", 'log rotated or was truncated after the initial offset')
    if record['foreignKeyConstraintFailed']:
        fail(f"logs-{record['name']}-foreign-key", 'new FOREIGN KEY constraint failed line found')
    if record['errors']:
        fail(f"logs-{record['name']}-errors", 'new error/fatal/exception line found')

if failure:
    runtime_stdout = read_text('RUNTIME_STDOUT')
    runtime_stderr = read_text('RUNTIME_STDERR')
    if runtime_stdout:
        print('Container runtime stdout:', file=sys.stderr)
        print(runtime_stdout, file=sys.stderr, end='' if runtime_stdout.endswith('\n') else '\n')
    if runtime_stderr:
        print('Container runtime stderr:', file=sys.stderr)
        print(runtime_stderr, file=sys.stderr, end='' if runtime_stderr.endswith('\n') else '\n')
    print(f'FAIL step={failure[0]} {failure[1]}', file=sys.stderr)
    raise SystemExit(1)

print('PASS work-continuation smoke')
PY
