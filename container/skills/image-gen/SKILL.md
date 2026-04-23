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

The host asks OpenAI for a JPEG at 85% quality and saves it under `attachments/image_<timestamp>.jpg`. The same file ships as the Telegram photo and is the "original" for `[[image-file: ...]]` re-sends — there is no separate PNG on disk by default.

**Default** is `1024x1024` at `quality=low`, output JPEG 85% — fast, small on disk/wire, and indistinguishable from PNG for most photo-realistic content. When the user explicitly wants sharp / detailed / print-quality output, use the `hd` preset. For graphics, UI mockups, text-heavy content, or any case where you need lossless pixels, add the `png` preset (see Presets below).

If the user asks for a higher-fidelity version later, use `[[image-edit: <path> | upscale to 2048x2048 quality high, keep composition]]` — OpenAI's edit endpoint recovers detail well from the JPEG source, validated in production. You don't need to render at `hd` up front if cost/speed matter.

The host records the send in the message store with generation metadata attached. If the user later replies to the preview and asks for the original, the prompt, or an edit, call `get_message({message_id: <reply_to_id>})` — the response includes `file_path` (the delivered JPEG), `generation.prompt`, and `generation.original_png_path` (the full-quality source; name is historical — it points to JPEG by default, PNG when the `png` preset was used).

## Presets

Adjust size and quality with comma-separated presets between the colons:

```
[[image:portrait: prompt]]
[[image:landscape,hd: prompt]]
[[image:auto,hd: prompt]]
```

| Preset | Effect |
|---|---|
| *(none)* | square, fast/cheap (default: 1024x1024, quality=low, output JPEG 85%) |
| `portrait` | 1024x1536 |
| `landscape` | 1536x1024 |
| `auto` | OpenAI picks aspect ratio from the prompt |
| `hd` | quality=high (slower, more expensive) |
| `med` | quality=medium |
| `png` | lossless PNG output (use for graphics, UI, text, or when the user explicitly asks for PNG) |

Combine freely (`portrait,hd`). Unknown presets are ignored with a warning. Conflicting size presets (e.g. `portrait,landscape`) fall back to the default square size. Same syntax works for `[[image-edit:portrait,hd: path | prompt]]`.

Note: the preset list must be lowercase ASCII words separated by commas with no spaces. If the host sees `[[image:Word: ...]]` with uppercase or a space before the second colon, it treats the whole inner text as the prompt instead — so Cyrillic prompts like `[[image: котик]]` work as expected.

## Custom sizes

Pass an explicit `WxH` instead of a named size preset when you need a non-standard aspect ratio or resolution:

```
[[image:2048x1024: prompt]]
[[image:2048x2048,hd: prompt]]
[[image:1920x1088,hd: cinematic still]]
```

Valid dimensions: each edge ≤3840, **each edge a multiple of 16**, aspect ratio ≤3:1, total pixels between 655360 and 8388608. Anything out of bounds falls back to the default 1024x1024 with a warning in the host log.

Pitfall: `1920x1080` is **not** valid — 1080 is not a multiple of 16. Use `1920x1088` (or drop to `1536x864` if budget matters).

## Edit an existing image

```
[[image-edit: attachments/photo_12345.jpg | describe the changes you want]]
[[image-edit:portrait,hd: attachments/photo_12345.jpg | describe the changes]]
```

The path is relative to your group directory (`/workspace/group/`). Use paths from photos the user sent you or from previously generated images. Same default JPEG behavior as `[[image:]]` — including `png` preset if you need lossless output from the edit. The same presets apply.

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
- Generated images are saved as `attachments/image_<timestamp>.jpg` by default (same file ships to chat and is the source for `[[image-file:...]]`). With the `png` preset, output is `attachments/image_<timestamp>.png` plus a `.jpg` preview for the photo send — the PNG is the lossless source for re-sends.
- If generation fails (API error, missing source file, network), the tag is silently dropped and only the text part is sent.
- If OpenAI rejects the request for content reasons, you'll see a short `[host] ...` message in the chat on the next turn. `[host]` messages are **not** from the user or from you — they're system notices from the nanoclaw host. `[host] OpenAI declined image generation (moderation). Rephrase the prompt and try again.` means safety rejected the prompt; rewrite and retry. If the signal includes `Stop retrying with rewrites — switch topic or ask the user.`, you've hit 3 consecutive rejections on this group — don't loop on variations, ask the user what they want instead. Generic signals of the form `[host] OpenAI declined image generation (reason: <code>). Adjust the request and try again.` mean a parameter error (unsupported size, etc.); fix the tag and retry.
- If JPEG conversion fails (sips not available or errors), the host falls back to sending the PNG directly as photo — you don't need to handle this.
- If the preview file is larger than Telegram's ~10MB photo cap (rare, but possible for large-resolution `hd` renders), the host automatically switches to sending the original PNG as a document so you still get full-fidelity delivery.
