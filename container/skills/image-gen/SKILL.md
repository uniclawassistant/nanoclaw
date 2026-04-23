---
name: image-gen
description: Generate or edit images using GPT Image. Use special tags in your response — the host processes them and sends the result as a photo (JPEG 85% by default, or full PNG when `png` preset is requested) or as a document via [[image-file:...]].
---

# Image Generation

You can generate, edit, and re-send images by including special tags in your response. The host intercepts these tags, calls the API or reads the file, saves results to your group's `attachments/` directory, and sends them to the chat.

## Generate an image

```
[[image: your prompt here]]
```

**Default with no parameters** — `1024x1024`, quality `medium`, output JPEG at 85% compression. Fast, small on disk/wire, indistinguishable from PNG for photo-realistic content. The file is saved under `attachments/image_<timestamp>.jpg`; the same file ships to chat AND serves as the "original" for `[[image-file: ...]]` re-sends. No separate PNG on disk by default.

The host records the send in the message store with generation metadata attached. If the user later replies to the preview and asks for the original, the prompt, or an edit, call `get_message({message_id: <reply_to_id>})` — the response includes `file_path`, `generation.prompt`, and `generation.original_png_path` (field name is historical — it points to JPEG by default, PNG/WebP when you requested those).

**High-fidelity later:** if the user asks for a sharper version after you've already generated something at the default, don't re-generate from scratch — use `[[image-edit: <path> | upscale to 2048x2048 quality high, keep composition]]`. The edit endpoint recovers detail well from a JPEG source, validated in production.

## Tuning generation: think about what you need

There are no "HD" / "lossless" shortcut presets — for anything beyond the default, you express the parameters explicitly. Ask yourself:

- **Aspect ratio** — square default, or portrait / landscape for non-square prompts
- **Resolution** — 1024 default; bigger only when the user or use-case requires (posters, print, fine detail)
- **Quality** — `medium` default; go `high` only when detail matters (editorial, product shots) and accept the cost/latency; drop to `low` for quick drafts
- **Format** — JPEG default for photos; **PNG only for graphics / UI / text-rendering** or when the user asked for lossless; WebP if the user is shipping to the web and wants smaller files
- **Compression** — 85 default for JPEG/WebP; raise if the user complained about JPEG artifacts; ignored for PNG

The syntax is a comma-separated list between the colons. Three token shapes are accepted:

| Shape | Example | Meaning |
|---|---|---|
| Named size | `portrait`, `landscape`, `square`, `auto` | Canonical aspect ratios |
| Custom WxH | `1920x1088`, `2048x2048` | Any dimensions within gpt-image-2 bounds |
| Keyword | `format=png`, `quality=high`, `compression=92`, `size=1536x1024` | Explicit per-parameter override |

You can freely mix shapes in the same tag.

### Worked examples

```
# Editorial landscape, need detail, acceptable cost+latency
[[image:landscape,quality=high: golden hour portrait of a violinist, moody]]

# Logo / UI mockup — lossless needed, small size OK
[[image:format=png,quality=high: minimal badge with word "OPUS" centered]]

# Web hero at 3:2 with sharper-than-default JPEG
[[image:1536x1024,compression=92: slate-blue lake at pre-dawn]]

# Big poster — expensive; use sparingly
[[image:2048x2048,quality=high: poster for a jazz festival in deep teal and brass]]

# WebP for a web asset
[[image:format=webp,1024x1024,compression=90: rounded hexagonal icon for a bookmark tool]]
```

**Rules and failure modes**

- Keyword value with bad input (e.g. `format=tiff`, `quality=ultra`, `compression=0`) → warned in host log, that single keyword is dropped, rest of the tag still applies.
- Conflicting size tokens (e.g. `portrait,landscape` or `portrait,size=1536x1024`) → fallback to default `1024x1024`, warned.
- `format=png` + `compression=X` → compression is silently dropped (PNG is lossless; the param is meaningless), warned in log.
- Same-key keyword repeated (`quality=low,quality=high`) → last write wins.
- Custom WxH must satisfy gpt-image-2 constraints: each edge ≤3840, **each edge a multiple of 16**, aspect ratio ≤3:1, total pixels 655360–8388608. `1920x1080` is a common mistake (1080 is not /16) — use `1920x1088`.
- Token list must be lowercase ASCII with no spaces before the second colon. `[[image: Plot: a graph]]` (uppercase) or `[[image: author=Fedor: biography]]` (unknown keyword key) are treated as a plain prompt, not a tag list — Cyrillic prompts like `[[image: котик]]` work as expected.

## Edit an existing image

```
[[image-edit: attachments/photo_12345.jpg | describe the changes you want]]
[[image-edit:format=png,quality=high: attachments/photo_12345.jpg | describe the changes]]
```

The path is relative to your group directory (`/workspace/group/`). Use paths from photos the user sent you or from previously generated images. Same default JPEG behavior as `[[image:]]`; the same token vocabulary (named sizes, custom WxH, keywords) applies.

## Send the original file (as document)

```
[[image-file: attachments/image_1776894040343.jpg]]
```

The host sends the file as a Telegram **document** — full resolution, no Telegram photo re-compression. Use this when:

- The user explicitly asks for the original / file / without compression / unprocessed (in any language: «оригинал», «файлом», «без сжатия», «raw», «full resolution», ...)
- You're forwarding a previously generated image and want to bypass Telegram's photo compression on re-send

The path must come from `generation.original_png_path` returned by `get_message` for the preview message the user is referring to. The field name is historical — the path points to the JPEG by default, or the PNG when the image was generated with the `png` preset. Do not guess paths or try to `ls` the attachments folder — the stored record tells you exactly which file corresponds to each preview you sent.

If the user didn't Telegram-reply to a specific preview and there's any ambiguity about which image they mean, ask them to reply to the one they want before calling `[[image-file:]]`.

## Message layout: tag in its own message, never mixed with text

**Important.** Put each `[[image:]]` / `[[image-edit:]]` / `[[image-file:]]` tag in a **separate assistant message**, with no surrounding text in the same message. The host strips the tag from the text before sending; if any text was alongside it in the same message, you get visible "holes" (empty lines / dangling whitespace) in the chat where the tag used to be.

❌ **Anti-pattern** — tag mixed with text in one message:

```
Вот тебе обложка, попробую в нуарной эстетике:
[[image: dramatic noir portrait of a photographer]]
Жду реакцию!
```
→ chat sees: `Вот тебе обложка, попробую в нуарной эстетике:\n\n\nЖду реакцию!` with a visible empty gap.

✅ **Correct** — split into two assistant messages within the same turn (a `tool_use` between them, e.g. a `react` call, makes Claude actually emit two separate text blocks):

```
Message 1 (text only):  Вот тебе обложка, в нуарной эстетике. Сейчас прилетит.
(tool_use here — react / TodoWrite / anything)
Message 2 (tag only):   [[image: dramatic noir portrait of a photographer]]
```

When a message contains **only** a tag and nothing else, the cleaned text after stripping is empty, the host sends nothing visible from that message, and just the photo/document arrives — clean.

The same rule applies to `[[tts:]]` and any other host-side strip-tag: **tag-only messages = clean delivery, mixed messages = visible holes**.

## Other rules

- One image tag per message (host only matches the first).
- Tags can be combined with `[[tts]]` across messages — image is processed in its message, TTS in its message, both run independently.
- Generated images are saved as `attachments/image_<timestamp>.<ext>` — `.jpg` by default, `.png` with `format=png`, `.webp` with `format=webp`. The same file ships to chat and is the source for `[[image-file:...]]` re-sends. When `format=png` is used, a `.jpg` preview is also created for the Telegram photo send; the PNG remains the lossless source.
- If generation fails (API error, missing source file, network), the tag is silently dropped and only the text part is sent.
- If OpenAI rejects the request for content reasons, you'll see a short `[host] ...` message in the chat on the next turn. `[host]` messages are **not** from the user or from you — they're system notices from the nanoclaw host. `[host] OpenAI declined image generation (moderation). Rephrase the prompt and try again.` means safety rejected the prompt; rewrite and retry. If the signal includes `Stop retrying with rewrites — switch topic or ask the user.`, you've hit 3 consecutive rejections on this group — don't loop on variations, ask the user what they want instead. Generic signals of the form `[host] OpenAI declined image generation (reason: <code>). Adjust the request and try again.` mean a parameter error (unsupported size, etc.); fix the tag and retry.
- If an `[[image-edit:...]]` source path is wrong / missing / empty, you'll see `[host] Image edit failed: Source file ... . Call get_message on the preview you want to edit to get the correct generation.original_png_path, or verify the file exists under attachments/.` **Always** prefer `get_message({message_id: <preview_id>})` to fetch the canonical path — don't guess or copy paths from earlier chat messages (especially across presets being renamed — the path may have changed format, e.g. `.png` → `.jpg` after default-JPEG rolled out).
- If an `[[image-edit:...]]` call times out or hits a network blip mid-upload, you'll see `[host] Image edit timed out or network blipped. The source file is intact — retry the same tag. If it fails again, drop size/quality ...`. This is OpenAI / network-level, not your fault. First retry the same tag as-is (usually succeeds). If still failing, drop `quality=high`, switch `format=png` → default JPEG, or reduce size — large hd+png edits can legitimately exceed the host's 10-minute ceiling. Generate tags never surface transient errors (nothing was promised to the user yet), only edits do.
- If JPEG preview conversion fails (sips not available or errors — only applies when `format=png` is used), the host falls back to sending the PNG directly as photo — you don't need to handle this.
- If the preview file is larger than Telegram's ~10MB photo cap (rare, but possible for large-resolution `quality=high` renders at high custom sizes), the host automatically switches to sending the original file as a document so you still get full-fidelity delivery.
