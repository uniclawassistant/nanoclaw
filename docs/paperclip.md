# Paperclip integration

Nanoclaw can be woken by a [Paperclip](https://paperclip.ing) instance. When
enabled, nanoclaw exposes two endpoints:

- `POST /paperclip/wake` — accept a wake, verify auth, enqueue the wake onto
  the target group's container, respond `202 Accepted` immediately.
- `GET /paperclip/runs/{runId}` — idempotent status lookup for the Paperclip
  adapter to reconnect if the wake response was dropped mid-flight.

Together these let either the built-in `http` adapter or a dedicated
`paperclip-adapter` plugin drive nanoclaw as a first-class adapter target.

## Endpoints

### `POST /paperclip/wake`

- Request: JSON body from the Paperclip adapter
- Success: `202 Accepted` with `{accepted, runId, agentId}` as soon as the
  wake is verified and enqueued
- Errors: `401` auth failure, `400` invalid JSON, `413` body > 1 MiB, `404`
  method/path mismatch

### `GET /paperclip/runs/{runId}`

- Success: `200` with `{runId, agentId, status, startedAt, finishedAt, error}`
  - `status` ∈ `pending | done | error`
- Not found: `404` with `{runId, status: "not_found"}` when nanoclaw has no
  record of that runId (either never delivered or evicted from the in-memory
  store; see "Run status lifecycle" below)
- Errors: `401` auth failure

Status is tracked in-memory only — it does not survive a nanoclaw restart.
The store holds the most recent 1000 wakes; older finished runs are pruned as
new ones arrive.

## Enabling the webhook

Nanoclaw leaves both endpoints disabled unless `PAPERCLIP_WAKE_SECRET` is set.
Other knobs have safe defaults.

| Env var | Default | Description |
|---|---|---|
| `PAPERCLIP_WAKE_SECRET` | _(unset)_ | Shared secret. Setting it enables the server. Must match the value Paperclip uses when signing/bearing. |
| `PAPERCLIP_WAKE_HOST` | `127.0.0.1` | Interface to bind. Keep loopback unless you front it with a reverse proxy that terminates TLS and forwards. |
| `PAPERCLIP_WAKE_PORT` | `3002` | Port to bind (serves both endpoints). |
| `PAPERCLIP_WAKE_REPLAY_WINDOW_SECONDS` | `300` | Max allowed clock skew for HMAC-signed requests. Ignored for bearer auth. |

Production deployments should put the endpoint behind a reverse proxy that
handles TLS and, optionally, IP allow-listing — the webhook itself only does
auth and payload validation.

## Authentication

Both endpoints share one secret and accept two modes. They pass on whichever
is valid.

### 1. Bearer token (works today)

```
Authorization: Bearer <PAPERCLIP_WAKE_SECRET>
```

This works with the Paperclip `http` adapter today — configure the adapter's
`headers` with an `Authorization` entry pointing at the shared secret. No
server-side Paperclip change needed.

### 2. HMAC signature (forward-compatible)

```
X-Paperclip-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Where `|now - t| <= PAPERCLIP_WAKE_REPLAY_WINDOW_SECONDS` and `v1` is computed
over a canonical string that differs by endpoint:

- `POST /paperclip/wake`: `v1 = hex(HMAC_SHA256(secret, f"{t}.{rawBody}"))`
- `GET /paperclip/runs/{runId}`: `v1 = hex(HMAC_SHA256(secret, f"{t}.GET.{path}"))`
  where `path` is the exact request URI (including the `{runId}` segment and
  any query string).

The wake-endpoint canonical string matches the Stripe scheme. The runs
endpoint incorporates method + path instead of body since GET has no body.

## Payload (wake)

The Paperclip adapter sends:

```jsonc
{
  "agentId": "...",
  "runId": "...",
  "context": {
    "taskId": "...",
    "issueId": "...",
    "wakeReason": "issue_assigned | issue_commented | ...",
    "wakeCommentId": "..."
    // plus any fields from the agent's payloadTemplate
  }
}
```

Nanoclaw additionally expects one of the following so it can route the wake
to a registered group:

- `context.chatJid` — preferred. The full group JID (including suffix).
- `context.groupFolder` — nanoclaw group folder name. Used if `chatJid` is
  absent; the first registered group matching this folder wins.

Use the adapter's `payloadTemplate` to inject the routing field, e.g.:

```json
{
  "payloadTemplate": {
    "context": {
      "chatJid": "<main-group-jid>"
    }
  }
}
```

## What happens on a wake

1. Verify auth (bearer or HMAC).
2. Parse JSON. Reject 400 on invalid payloads; reject 413 on bodies > 1 MiB.
3. Record the runId in the status store (status: `pending`).
4. Respond `202` with `{accepted, runId, agentId}`.
5. Asynchronously:
   - Write the full raw body to
     `data/ipc/<groupFolder>/paperclip-wakes/<ts>-<runId>.json`. The
     container mounts this directory at `/workspace/ipc/paperclip-wakes/`
     so the agent can read the full wake payload (including callback
     credentials if Paperclip supplies them via `payloadTemplate`).
   - Store a synthetic inbound message on the target group summarising
     the wake (`runId`, `agentId`, `wakeReason`, `taskId`, `commentId`) and
     enqueue the group for processing through the normal router.
   - For non-main groups the summary is prefixed with the group's trigger,
     so trigger-gated groups still react.

The agent, on waking, should use the `paperclip` skill and the wake file to
check out the task and continue the heartbeat.

## Run status lifecycle

The runs store is a thin mailbox, not a log aggregator:

- On successful wake: `pending`, `startedAt` set, `finishedAt` null
- `markDone` / `markError` transitions are wired to future integration with
  the container-runner — the store exposes those hooks but the initial drop
  leaves a run in `pending` until that wiring lands. The common case the
  Paperclip adapter needs today is simply "did my wake land?", which the
  store already answers: `404` ⇒ wake never arrived (retry); `200 pending`
  ⇒ wake arrived, container is (or will be) processing.

The adapter plugin's `execute()` should:

1. POST `/paperclip/wake` with `runId` from its execution context
2. On connection error mid-response, GET `/paperclip/runs/{runId}`
3. On `200` any status — treat the wake as delivered; continue streaming logs
   via the adapter's normal callback path (container-side REST back to
   Paperclip)
4. On `404` — re-POST the wake

## Smoke testing locally

Start nanoclaw with the secret set:

```bash
PAPERCLIP_WAKE_SECRET=dev-secret npm run dev
```

Fire a wake from another terminal (bearer):

```bash
curl -v -X POST http://127.0.0.1:3002/paperclip/wake \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer dev-secret' \
  -d '{
    "agentId":"unic",
    "runId":"run-smoke-1",
    "context":{
      "wakeReason":"issue_assigned",
      "taskId":"FEDA-94",
      "chatJid":"<your-main-group-jid>"
    }
  }'
```

Expected: `HTTP/1.1 202 Accepted`, nanoclaw logs `paperclip-wake: accepted`
then `paperclip-wake: routed to group`, and the target group's agent
container starts processing.

Look up the run:

```bash
curl -v http://127.0.0.1:3002/paperclip/runs/run-smoke-1 \
  -H 'authorization: Bearer dev-secret'
# 200 {"runId":"run-smoke-1","status":"pending",...}
```

HMAC-signed wake variant:

```bash
BODY='{"agentId":"unic","runId":"run-smoke-2","context":{"chatJid":"<jid>"}}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac dev-secret -hex | awk '{print $2}')
curl -v -X POST http://127.0.0.1:3002/paperclip/wake \
  -H 'content-type: application/json' \
  -H "x-paperclip-signature: t=$TS,v1=$SIG" \
  -d "$BODY"
```

HMAC-signed runs lookup:

```bash
RUN_ID=run-smoke-2
PATH_FOR_SIG="/paperclip/runs/$RUN_ID"
TS=$(date +%s)
SIG=$(printf '%s.GET.%s' "$TS" "$PATH_FOR_SIG" | openssl dgst -sha256 -hmac dev-secret -hex | awk '{print $2}')
curl -v "http://127.0.0.1:3002$PATH_FOR_SIG" \
  -H "x-paperclip-signature: t=$TS,v1=$SIG"
```

## Configuring Paperclip

Either the built-in `http` adapter (bearer, wake-only) or a dedicated
`paperclip-adapter` plugin (bearer or HMAC, wake + runs polling) can drive
this endpoint. See `.claude/skills/add-paperclip-adapter/SKILL.md` for the
feature-skill install path.
