---
name: supapowa
description: Call provider APIs (Gemini, Figma, and whatever the owner connects) through Supapowa, the owner's gateway on the host Mac, without holding any API key. Use when a task needs such an API, or to see which connections and how many calls you have ("what can I call", "Gemini", "Figma API", "Supapowa"). If the owner made you admin, also to configure Supapowa (connections, devices, managers, allowances, leases). Only when SUPAPOWA_URL is set.
---

# Supapowa

The host gives this container `SUPAPOWA_URL` and `SUPAPOWA_KEY` (a key for this run only). The host
forwarder swaps it for your agent token; you never see the token or any API key. Do not look for
keys elsewhere.

## What you may call

```bash
curl -sS "$SUPAPOWA_URL/_access" -H "Authorization: Bearer $SUPAPOWA_KEY"
```

JSON: each connection with its origin, methods, allowed paths, request size limit and `callsLeft`.

## A call

`$SUPAPOWA_URL/<connection>/<provider path>` with the provider's own request, minus any key:

```bash
curl -sS -D /tmp/h.txt -o /tmp/out.json -X POST \
  "$SUPAPOWA_URL/gemini/v1beta/models/gemini-2.5-flash:generateContent" \
  -H "Authorization: Bearer $SUPAPOWA_KEY" -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"..."}]}]}'

curl -sS "$SUPAPOWA_URL/figma/v1/files/<file key>?depth=1" -H "Authorization: Bearer $SUPAPOWA_KEY"
```

- The answer is the provider's, unchanged. Each request spends one call, failed ones too.
- With no calls left the owner is asked on the Mac; the request waits for the answer (up to 10
  minutes). Use a long curl timeout (`--max-time 700`). Sending it again while the owner's window
  is open opens no second window: it joins the open one (one answer, granted once).
- Not to hold the connection: add `-H "Prefer: respond-async"`. If the answer is not ready within
  5 s you get `202` with `{"request": ID, "state": "waiting", "check": "/_requests/ID"}`; later
  `curl "$SUPAPOWA_URL/_requests/ID" -H "Authorization: Bearer $SUPAPOWA_KEY"` gives `202` while it
  waits, then the answer itself (kept for an hour). Works for `/_admin` too.
- If `/tmp/h.txt` has `X-Supapowa-Error: true`,
  the body is `{code, message}`: the
  gateway (not the provider) refused — say the message, do not retry the same call.
  Codes: `noAllowance`/`allowanceUsedUp`/`allowanceExpired` (no calls; owner was asked or did not
  answer), `deniedByOwner`, `pathNotAllowed`, `methodNotAllowed`, `requestTooLarge`,
  `unknownConnection`, `unknownRequest` (no such ID for you, or older than an hour), `notRegistered` (token problem on the host), `notThisAgent` (missing or stale
  `SUPAPOWA_KEY`), `supapowaUnreachable` (Supapowa not running or quit by the owner).
- Ticket runs in Paperclip still use their own run headers and your `gateway-grant` blocks; this is for
  your own calls.

## Admin: configuring Supapowa

Only if the owner gave this agent the admin role (otherwise `403` with `notAdmin`). One endpoint,
the gateway's command language as an array of words:

```bash
curl -sS --max-time 700 -X POST "$SUPAPOWA_URL/_admin" -H "Authorization: Bearer $SUPAPOWA_KEY" \
  -H "Content-Type: application/json" -d '{"args":["help"]}'          # what an admin can send
curl -sS --max-time 700 -X POST "$SUPAPOWA_URL/_admin" -H "Authorization: Bearer $SUPAPOWA_KEY" \
  -H "Content-Type: application/json" -d '{"args":["devices"]}'
curl -sS --max-time 700 -X POST "$SUPAPOWA_URL/_admin" -H "Authorization: Bearer $SUPAPOWA_KEY" \
  -H "Content-Type: application/json" -d '{"args":["allow","<agent>","gemini","--calls","100","--for","7d"]}'
curl -sS --max-time 700 -X POST "$SUPAPOWA_URL/_admin" -H "Authorization: Bearer $SUPAPOWA_KEY" \
  -H "Content-Type: application/json" -d '{"args":["connection","save","-"],"input":{"name":"jira",
  "space":"work","origin":"https://example.atlassian.net","authHeader":"Authorization",
  "basicUser":"me@example.com","secret":"jira","methods":["GET"],"paths":["/rest/api/3/"]}}'
# basicUser: Supapowa sends Authorization: Basic base64(basicUser:key); the key is the API token alone
```

- `200`: the command's JSON answer. `400` `{code:"commandFailed", message}`: refused or wrong
  arguments — the message says why; `["help"]` lists the commands.
- You never send keys or KVM passwords. A new connection, a key going to another origin/header/
  prefix, or a new KVM opens a window on the owner's Mac: the owner types the key and approves. The
  request waits for that (up to 10 minutes; or use `Prefer: respond-async` as above) — tell the user
  the owner is asked; a resend joins the same window.
- Paths, methods and limits of an existing connection, devices, managers, allowances (yours too),
  grants and leases are yours to change; the owner sees them in History.
- A ticket run waiting for a device: `POST $SUPAPOWA_URL/_devices/<device>/lease` with
  `{"reason": "...", "wait": 120}` holds its place and answers when the device is free (or after
  120 s with its position — then ask again).
- Task systems (Paperclip) are Supapowa extensions; `["extension","list"]` shows them. Managers of
  a task system are `--task-managers paperclip:<agent id>[@<company id>]`; tickets `CRO-1175`.
- Refused for admins: `secret`, changing extensions, `call`, and acting as another agent
  (`--agent`/`--manager` must be your own name).
