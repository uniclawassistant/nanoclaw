---
name: image-gen
description: Generate, edit, and re-send images via the `generate_image`, `edit_image`, and `send_image` MCP tools. Each call returns `{ ok, message_id }` so you can `get_message` / `react` / `edit_image` against it. JPEG 85% by default, with `format=png|webp` opt-ins for lossless or web delivery.
---

# Image Generation

Three MCP tools cover the full image lifecycle. They all ship to the chat as a **compressed photo with native preview** (Telegram `sendPhoto`). For arbitrary attachments without compression — markdown, pdf, json, code dumps — use `send_file` instead, not these.

| Need | Tool |
|---|---|
| Make a new image | `generate_image` |
| Modify a previous image | `edit_image` |
| Re-send an image already on disk | `send_image` |

All three return `{ ok: true, message_id, file_path, message_type }` on success or `{ ok: false, error }` on terminal failure. The `message_id` is usable with `get_message`, `react`, and (for follow-up edits) `edit_image`.

> **Channel scope.** Image tools are Telegram-only today. On non-Telegram channels you get `{ ok: true, skipped: true, reason: "channel not supported" }` and no error.

## `generate_image`

```jsonc
generate_image({
  prompt: "golden hour portrait of a violinist, moody",
  preset: ["landscape", "quality=high"],
  caption: "first take, can iterate"
})
```

**Default with no preset** — `1024x1024`, quality `medium`, output JPEG at 85% compression. Fast, small on disk/wire, indistinguishable from PNG for photo-realistic content. The file is saved under `attachments/image_<timestamp>.jpg`; the same file ships to chat AND serves as the source for later `send_image` re-sends. No separate PNG on disk by default.

The host stores the send with `generation.prompt` + `generation.original_png_path` attached. If the user later replies to the preview and asks for the original or an edit, call `get_message({ message_id: <reply_to_id> })` — the response includes `file_path`, `generation.prompt`, and `generation.original_png_path` (field name is historical: it points to the JPEG by default, PNG/WebP when you requested those). Edit results additionally carry `generation.source_message_id` pointing at the message that was used as the edit input — walk that chain backwards via repeated `get_message` calls to recover the full edit history (`source_message_id` is absent on `generate_image` results and on user-uploaded photos).

**High-fidelity later:** if the user asks for a sharper version after you've already generated something at the default, don't re-generate from scratch — call `edit_image` with the previous photo's `message_id` and a prompt like `"upscale to 2048x2048 quality high, keep composition"` plus `preset: ["2048x2048","quality=high"]`. The edit endpoint recovers detail well from a JPEG source, validated in production.

### Tuning `preset`: think about what you need

There are no "HD" / "lossless" shortcut presets — for anything beyond the default, you express the parameters explicitly. Ask yourself:

- **Aspect ratio** — square default, or portrait / landscape for non-square prompts
- **Resolution** — 1024 default; bigger only when the user or use-case requires (posters, print, fine detail)
- **Quality** — `medium` default; go `high` only when detail matters (editorial, product shots) and accept the cost/latency; drop to `low` for quick drafts
- **Format** — JPEG default for photos; **PNG only for graphics / UI / text-rendering** or when the user asked for lossless; WebP if the user is shipping to the web and wants smaller files
- **Compression** — 85 default for JPEG/WebP; raise if the user complained about JPEG artifacts; ignored for PNG

`preset` is an array of tokens. Three token shapes are accepted:

| Shape | Example | Meaning |
|---|---|---|
| Named size | `"portrait"`, `"landscape"`, `"square"`, `"auto"` | Canonical aspect ratios |
| Custom WxH | `"1920x1088"`, `"2048x2048"` | Any dimensions within gpt-image-2 bounds |
| Keyword | `"format=png"`, `"quality=high"`, `"compression=92"`, `"size=1536x1024"` | Explicit per-parameter override |

You can freely mix shapes in the same call.

### Worked examples

```jsonc
// Editorial landscape, need detail, acceptable cost+latency
generate_image({
  prompt: "golden hour portrait of a violinist, moody",
  preset: ["landscape", "quality=high"]
})

// Logo / UI mockup — lossless needed, small size OK
generate_image({
  prompt: "minimal badge with word \"OPUS\" centered",
  preset: ["format=png", "quality=high"]
})

// Web hero at 3:2 with sharper-than-default JPEG
generate_image({
  prompt: "slate-blue lake at pre-dawn",
  preset: ["1536x1024", "compression=92"]
})

// Big poster — expensive; use sparingly
generate_image({
  prompt: "poster for a jazz festival in deep teal and brass",
  preset: ["2048x2048", "quality=high"]
})

// WebP for a web asset
generate_image({
  prompt: "rounded hexagonal icon for a bookmark tool",
  preset: ["format=webp", "1024x1024", "compression=90"]
})
```

**Rules and failure modes**

- Keyword value with bad input (e.g. `format=tiff`, `quality=ultra`, `compression=0`) → warned in host log, that single token is dropped, rest of the preset still applies.
- Conflicting size tokens (e.g. `["portrait","landscape"]` or `["portrait","size=1536x1024"]`) → fallback to default `1024x1024`, warned.
- `format=png` + `compression=X` → compression is silently dropped (PNG is lossless; the param is meaningless), warned in log.
- Same-key keyword repeated (`["quality=low","quality=high"]`) → last write wins.
- Custom WxH must satisfy gpt-image-2 constraints: each edge ≤3840, **each edge a multiple of 16**, aspect ratio ≤3:1, total pixels 655360–8388608. `1920x1080` is a common mistake (1080 is not /16) — use `1920x1088`.

## `edit_image`

```jsonc
edit_image({
  source_message_id: "12345",          // from a generate_image success or get_message lookup
  prompt: "make it bluer, keep composition",
  preset: ["quality=high"],
  caption: "iteration 2"
})
```

You pass the channel-native `message_id` of the source image, **not** a file path — the host resolves the source from the stored message. Get the id from:

- a previous `generate_image` success payload (the `message_id` field), or
- `get_message` against a user-replied preview, or against a photo the user sent.

The edit endpoint is iterative — small focused asks ("make it bluer", "add a snow leopard", "remove the watermark") work better than full rewrites. Same `preset` / `caption` vocabulary as `generate_image`.

Common errors:

- `"source message X not found in this chat"` — wrong `message_id`. Re-fetch via `get_message`.
- `"source message X has no attached image (type=text)"` — the message is a text/document, not a photo.
- `"source_missing: ..."` — the file rotated off disk; fall back to a fresh `generate_image`.
- `"moderation: ..."` — safety rejection; rephrase the prompt.
- `"transient: ..."` — network/API blip; retry the same call once. If it keeps failing, drop `quality=high`, switch `format=png` → default JPEG, or reduce size — large hd+png edits can legitimately exceed the host's 10-minute ceiling.

## `send_image`

```jsonc
send_image({
  path: "attachments/image_1776894040343.jpg",
  caption: "оригинал, без сжатия"
})
```

Re-send a file that already lives on disk as a compressed photo (Telegram `sendPhoto` with native preview). Use this when:

- The user asks for a previous image again ("send the violinist one again", "the cat from yesterday").
- You're forwarding a generated image to a different chat (rare, mostly only the main group can do this).

For **arbitrary attachments without compression** — markdown, pdf, json, code dumps, or when the user explicitly asks for the original file (in any language: «оригинал», «файлом», «без сжатия», «raw», «full resolution», ...) — use `send_file` instead. `send_image` always re-compresses; `send_file` ships the original bytes as a Telegram document.

**Path rules.** Relative paths resolve from `/workspace/group/` (your CWD). Absolute paths must be under `/workspace/group/` or `/workspace/extra/<mount>/`. Anything else (`..`, symlink escape) is rejected with `"path escapes its allowed root"`.

If the user didn't reply to a specific preview and there's any ambiguity about which image they mean, ask them to reply to the one they want before calling `send_image` — then `get_message({ message_id: <reply_to_id> })` gives you the exact `file_path` to pass.

## Workflow patterns

### Generate → react → edit if asked

```
1. react("👀")                         // tell the user we picked it up
2. generate_image(prompt, preset)      // returns { ok, message_id, ... }
3. react("👌")                         // signal done
4. (user replies asking for tweak)
5. edit_image(source_message_id: msg_id_from_step_2, prompt: "...")
```

### Send the original from a stored preview

```
1. get_message({ message_id: reply_to_id })     // returns generation.original_png_path
2. send_image({ path: <that path>, caption: "оригинал" })
```

> **Why caption matters.** Telegram attaches the caption to the photo in the same post — there's no follow-up text message and no risk of the photo and caption rendering out of order in fast multi-message turns. Prefer `caption` over a separate `send_message` whenever the text is a short label tied to the photo.

## Failure-mode reference

- API key missing → `"image generation not configured (no API key)"`. Operator issue, not yours; surface it back to the user.
- Channel doesn't support photos → `"channel does not support sendPhoto"` — only happens on non-Telegram, where the call should already short-circuit to `skipped: true` first.
- Preview > ~10MB → host automatically falls back to sending the full-fidelity original as a Telegram document. Success payload reports `message_type: "document"` instead of `"photo"`.
- All errors come back **directly in the tool result** as `{ ok: false, error }`. There are no host-injected `[host]` chat messages to wait for — the agent loop sees the error on the same call and can decide to retry, ask the user, or switch tactics.
