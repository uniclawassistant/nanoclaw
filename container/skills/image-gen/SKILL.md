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

After a successful generation, the next prompt you receive will start with a system hint like:

```
[system: last generated image original: attachments/image_1776894040343.png. if user asks for the original/file/uncompressed version, respond with [[image-file: attachments/image_1776894040343.png]]]
```

That hint is **only visible to you** — it never appears in the chat.

## Edit an existing image

```
[[image-edit: attachments/photo_12345.jpg | describe the changes you want]]
```

The path is relative to your group directory (`/workspace/group/`). Use paths from photos the user sent you or from previously generated images. Same JPEG-preview + PNG-original behavior as `[[image:]]`.

## Send the original PNG (no compression)

```
[[image-file: attachments/image_1776894040343.png]]
```

The host sends the file as a Telegram **document** (no compression, full resolution). Use this when:

- The user explicitly asks for the original / file / without compression / unprocessed (in any language: «оригинал», «файлом», «без сжатия», «raw», «full resolution», ...)
- You're forwarding a previously generated image and want to preserve quality

The path **must** come from the system hint shown above. Do not guess paths or try to `ls` the attachments folder — the hint tells you exactly which PNG corresponds to the most recent preview you sent.

If multiple images are in flight and the user is asking about one that isn't the most recent, ask them to reply (Telegram reply) to the specific preview message — for now, when in doubt, just send the most recent original and confirm in text whether that's the right one.

## Rules

- One image tag per message. Put it on its own line for clarity.
- Any text outside the tag is sent as a regular text message alongside the photo/document.
- Tags can be combined with `[[tts]]` — image is processed first, then TTS runs on remaining text.
- Generated images are saved as `attachments/image_<timestamp>.png` (original) and `attachments/image_<timestamp>.jpg` (preview that ships to chat).
- If generation fails (API error, missing source file, network), the tag is silently dropped and only the text part is sent.
- If JPEG conversion fails (sips not available or errors), the host falls back to sending the PNG directly as photo — you don't need to handle this.
