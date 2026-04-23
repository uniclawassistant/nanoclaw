---
name: image-gen
description: Generate or edit images using GPT Image. Use special tags in your response — the host processes them and sends the result as a photo (compressed JPEG preview) or as a document (uncompressed PNG original).
---

# Image Generation

You can generate, edit, and re-send images by including special tags in your response. The host intercepts these tags, calls the API or reads the file, saves results to your group's `attachments/` directory, and sends them to the chat.

## Generate an image

```
[[image: your prompt here]]
```

The host generates an image from the prompt, converts it to a JPEG preview (q=85), and sends the JPEG as a photo. The full-resolution PNG is kept on disk under `attachments/image_<timestamp>.png`.

**Default** is `1024x1024` at `quality=low` — fast and cheap, suitable for most chat replies. When the user explicitly wants sharp / detailed / print-quality output, use the `hd` preset below.

The host records the send in the message store with generation metadata attached. If the user later replies to the preview and asks for the original, the prompt, or an edit, call `get_message({message_id: <reply_to_id>})` — the response includes `file_path` (the JPEG preview), `generation.prompt`, and `generation.original_png_path` (the untouched PNG for `[[image-file: ...]]` follow-ups).

## Presets

Adjust size and quality with comma-separated presets between the colons:

```
[[image:portrait: prompt]]
[[image:landscape,hd: prompt]]
[[image:auto,hd: prompt]]
```

| Preset | Effect |
|---|---|
| *(none)* | square, fast/cheap (default: 1024x1024, quality=low) |
| `portrait` | 1024x1536 |
| `landscape` | 1536x1024 |
| `auto` | OpenAI picks aspect ratio from the prompt |
| `hd` | quality=high (slower, more expensive) |
| `med` | quality=medium |

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

The path is relative to your group directory (`/workspace/group/`). Use paths from photos the user sent you or from previously generated images. Same JPEG-preview + PNG-original behavior as `[[image:]]`, and the same presets apply.

## Send the original PNG (no compression)

```
[[image-file: attachments/image_1776894040343.png]]
```

The host sends the file as a Telegram **document** (no compression, full resolution). Use this when:

- The user explicitly asks for the original / file / without compression / unprocessed (in any language: «оригинал», «файлом», «без сжатия», «raw», «full resolution», ...)
- You're forwarding a previously generated image and want to preserve quality

The path must come from `generation.original_png_path` returned by `get_message` for the preview message the user is referring to. Do not guess paths or try to `ls` the attachments folder — the stored record tells you exactly which PNG corresponds to each preview you sent.

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
- Generated images are saved as `attachments/image_<timestamp>.png` (original) and `attachments/image_<timestamp>.jpg` (preview that ships to chat).
- If generation fails (API error, missing source file, network), the tag is silently dropped and only the text part is sent.
- If OpenAI rejects the request for content reasons, you'll see a short `[host] ...` message in the chat on the next turn. `[host]` messages are **not** from the user or from you — they're system notices from the nanoclaw host. `[host] OpenAI declined image generation (moderation). Rephrase the prompt and try again.` means safety rejected the prompt; rewrite and retry. If the signal includes `Stop retrying with rewrites — switch topic or ask the user.`, you've hit 3 consecutive rejections on this group — don't loop on variations, ask the user what they want instead. Generic signals of the form `[host] OpenAI declined image generation (reason: <code>). Adjust the request and try again.` mean a parameter error (unsupported size, etc.); fix the tag and retry.
- If JPEG conversion fails (sips not available or errors), the host falls back to sending the PNG directly as photo — you don't need to handle this.
- If the preview file is larger than Telegram's ~10MB photo cap (rare, but possible for large-resolution `hd` renders), the host automatically switches to sending the original PNG as a document so you still get full-fidelity delivery.
