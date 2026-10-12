---
name: supapowa
description: Call provider APIs (Gemini, Figma, and whatever the owner connects) through Supapowa, the owner's gateway on the host Mac, without holding any API key. Use when a task needs such an API, or to see which connections and how many calls you have ("what can I call", "Gemini", "Figma API", "Supapowa"). Only when SUPAPOWA_URL is set.
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
  minutes). Use a long curl timeout (`--max-time 700`) and do not retry while it waits.
- If `/tmp/h.txt` has `X-Agent-Desktop-Gateway-Error: true`, the body is `{code, message}`: the
  gateway (not the provider) refused — say the message, do not retry the same call.
  Codes: `noAllowance`/`allowanceUsedUp`/`allowanceExpired` (no calls; owner was asked or did not
  answer), `deniedByOwner`, `pathNotAllowed`, `methodNotAllowed`, `requestTooLarge`,
  `unknownConnection`, `notRegistered` (token problem on the host), `notThisAgent` (missing or stale
  `SUPAPOWA_KEY`), `supapowaUnreachable` (Supapowa not running or quit by the owner).
- Ticket runs in Clip still use their own run headers and your `gateway-grant` blocks; this is for
  your own calls.
