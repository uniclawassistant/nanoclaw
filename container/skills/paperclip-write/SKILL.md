---
name: paperclip-write
description: Guarded outbound writes to Paperclip (comment, patch issue, create issue). Use this INSTEAD of raw curl for any Paperclip write — path leaks and silent null-body writes are caught automatically. Triggers on "comment on issue", "update issue status", "patch issue", "create issue in clip", "поставь/обнови задачу в клип".
---

# Paperclip — Guarded Writes

Use these MCP tools for **every** Paperclip write. They run two guards that a raw
`curl` cannot, closing the two production incident classes from FED-29:

- **Guard 1 — path validation (pre-write):** rejects container-local paths
  (`/workspace`, `/tmp`, `/home/node`, `/root`) in any text field. Those are dead
  links for teammates on other machines (the CRO-108 leak). Inline the file's
  contents instead of linking to it.
- **Guard 2 — post-write verify:** re-fetches the resource after the write and
  loud-fails if it is missing (404), a field came back null/empty (the silent
  null-body class), or the stored value does not match what was sent.

Each tool returns JSON `{ ok: true, ..., verified: true }` on success, or an
error result with a specific reason on any failure. A success means the write was
confirmed present in Paperclip — not just that the API returned 2xx.

## Tools

```
paperclip_post_comment   { issueId, body }
paperclip_patch_issue    { issueId, status?, title?, description?, priority?,
                           assigneeAgentId?, projectId?, comment? }
paperclip_create_issue   { title, projectId, description?, status?,
                           assigneeAgentId?, priority?, parentId? }
```

Notes:

- Use `assigneeAgentId` (not `assigneeId`).
- `projectId` is required on create — no orphan issues.
- Comments cannot be edited in Paperclip (no PATCH on comments — only
  delete + repost), so Guard 1 runs **before** the write: there is no clean fix
  for a leaked comment after the fact.
- `paperclip_patch_issue` accepts an optional `comment` so a status update +
  comment is still a single call; the comment is verified for non-null body too.

## Examples

Status update with a comment, in one verified call:

```
paperclip_patch_issue({
  issueId: "32b67bd2-39fd-471e-9106-e4a76192379a",
  status: "done",
  comment: "Shipped. Summary inline:\n- ...",
})
```

Comment only:

```
paperclip_post_comment({
  issueId: "<id>",
  body: "## Update\n- ...",
})
```

Create a child issue:

```
paperclip_create_issue({
  title: "Phase 2 — Guard 3 schema enforcement",
  projectId: "<project-id>",
  parentId: "<parent-id>",
  status: "backlog",
})
```

## Config

The host injects `PCP_KEY`, `PCP_BASE`, and `PCP_COMPANY` into the container env
(see `container-runner.ts` + `.env`). If any are missing the tools return a clear
config error naming the missing var — they never fall back to a hardcoded
instance. `PCP_RUN_ID`, if set, is sent as the `X-Paperclip-Run-Id` audit header.

## Fallback / debug

For read-only queries, ad-hoc endpoints, or debugging, the `paperclip` skill's
raw `curl` reference still applies. Do not use raw `curl` for writes — it bypasses
the guards.
