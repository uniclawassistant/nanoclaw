---
name: tts
description: Speak your response as a voice message via the `send_voice` MCP tool (Gemini 3.8 Flash TTS, OpenAI fallback). Returns `{ ok, message_id, warnings? }` so you can `get_message` / `react`. Supports 30 prebuilt voices, inline vocal tags, a short `style`, `language`, and two-voice dialogues via `parts`.
---

# Voice messages — `send_voice`

`send_voice` is an MCP tool that synthesizes audio (Gemini 3.8 Flash TTS by default, OpenAI fallback for a single voice) and ships it to the chat as a Telegram voice note. The tool returns `{ ok, message_id, warnings? }` so you can react to it, look it up later via `get_message`, or follow it up with text. `warnings` lists parameters that were ignored or adjusted.

```jsonc
send_voice({
  text: "Hey, how's it going?",
})
```

The default voice is **configured per instance** via the `TTS_DEFAULT_VOICE` env var (ships as `Enceladus` if unset). That's my voice. Only override it with `voice:` when voicing **someone other than myself** — a character, a retelling from another POV, or a dialogue.

> **Channel scope.** Voice is Telegram-only today. On other channels you get `{ ok: true, skipped: true, reason: "channel not supported" }` and no error.

## When to use

- User sent a voice message → reply with `send_voice` to stay in voice mode
- User explicitly asks for voice
- Short conversational replies where voice feels more natural than text

## When NOT to use

- Long messages with code, lists, or structured data — those need text
- User is clearly reading/typing, not listening
- More than ~60 seconds of audio in a single post — split across multiple `send_voice` calls

## Mixed responses (voice summary + text details)

Call `send_voice` first with the spoken summary, then `send_message` (or just final text output) with the longer details. The two posts arrive in order.

---

## The one rule of 3.8: text is spoken verbatim

Everything in `text` is read aloud. Stage directions, persona descriptions, "say it in a whisper", speaker names — all of it becomes speech. Delivery goes into `style`; one-off sounds go into inline tags; nothing else.

## Parameters

```jsonc
send_voice({
  text?: string,           // what gets spoken, verbatim (single voice) — or use parts
  voice?: string,          // named prebuilt voice (case-sensitive)
  style?: string,          // short delivery for the whole utterance
  language?: string,       // BCP-47, e.g. "ru-RU"; omit to auto-detect
  parts?: [{ speaker, voice?, text, style? }],  // two-voice dialogue instead of text
})
```

Exactly one of `text` or `parts`.

### `text`

Plain text — no markdown, no code, no bullets. Inline vocal tags in **angle brackets**, at the exact point where the sound should happen. Keep tag names in English even for Russian text:

```jsonc
send_voice({
  text: "<breath> Ну привет! Как ты? <short pause> Слушай, это смешно <chuckle>.",
  language: "ru-RU",
})
```

Recommended tags (Google's list, not a closed enum): `<breath>`, `<chuckle>` / `<chuckles>`, `<laugh>`, `<sigh>`, `<gasp>`, `<exhales>`, `<short pause>`, `<long pause>`, `<whispers>` / `<whispering>`. Avoid sound-effect tags (applause, thuds). Square-bracket tags like `[laughs]` are old 3.1 syntax — in 3.8 they may be read aloud.

### `style`

A short natural-language delivery instruction for the whole turn (sent as `speechMetadata.style`). Documented examples: `"casual, friendly"`, `"calm and relaxed"`, `"whispered urgently"`, `"out of breath"`, `"warm and enthusiastic"`, `"speaking slowly"`, `"speaking rapidly"`, `"muttering, then reassuring"`.

- Most requests need **no style at all**. Try without it first.
- Keep it short; reuse the exact same string when you want a consistent baseline.
- Don't put names, age, gender or permanent accent into `style` — that's the voice's job.

### `language`

BCP-47 code (`"ru-RU"`, `"en-US"`). Omit to let the model detect the language. Useful for Russian text with Latin names.

### `voice`

Named voice from the catalog (case-sensitive). Unknown names fall back to the instance default with a warning.

### `parts` — two-voice dialogue in one recording

```jsonc
send_voice({
  language: "ru-RU",
  parts: [
    { speaker: "HostA", voice: "Puck", text: "<breath> Сейчас — новый трек. Слушай этот бас |угу|.", style: "casual, friendly" },
    { speaker: "HostB", voice: "Kore", text: "Да, тут есть за что зацепиться <chuckle>." },
    { speaker: "HostA", text: "Поехали." },
  ],
})
```

- Up to **two speakers**, prebuilt voices only. Each element is one turn; a speaker can have many turns (voice may be omitted after the first).
- Listener reactions inside a turn go in pipes: `|угу|`, `|oh really?|` — no separate turn needed.
- Never write `"HostA: line"` inside a single `text` — the API rejects flat transcripts for multi-speaker; use `parts`.
- No OpenAI fallback for `parts`: if Gemini fails, you get an error.
- A single speaker in `parts` is fine too — a way to change `style` mid-utterance.
- Voice assignment is not deterministic. The same request can come back with speakers shifted (seen 2026-10-04: line 2 spoken by speaker A's voice, B's voice starting on line 3); the payload is correct, it is the model. For anything that matters, listen to the result and regenerate on a mix-up. Do not work around it by generating lines separately and joining them — that was rejected because of seams and voice drift.

### Deprecated: `director`, `profile`, `scene`

`director` is mapped to `style` when `style` isn't given (keep it short). `profile` and `scene` are **ignored with a warning** — 3.8 has no field for them and would read them aloud. For a persona, choose a voice; for a mood, a short style.

---

## Worked examples

```jsonc
// 80% case — bare voice in instance default
send_voice({ text: "Hey, how's it going?" })

// Voice change only
send_voice({ text: "Serious product briefing.", voice: "Kore" })

// Style only (own voice)
send_voice({ text: "Shhh, it's a secret.", style: "whispered urgently" })

// Storytelling
send_voice({
  text: "Жил-был в далёком лесу маленький единорог. <long pause> Он был очень застенчивый...",
  voice: "Leda",
  style: "calm and relaxed",
  language: "ru-RU",
})
```

---

## Voices catalog (30 voices)

Default voice is per-instance (see `TTS_DEFAULT_VOICE` env). Voice names are **case-sensitive** — `Kore` works, `kore` is silently ignored (voice stays default).

| Name | Gender | Characteristic |
|---|---|---|
| Achernar | F | Soft |
| Achird | M | Friendly |
| Algenib | M | Gravelly |
| Algieba | M | Smooth |
| Alnilam | M | Firm |
| Aoede | F | Breezy |
| Autonoe | F | Bright |
| Callirrhoe | F | Easy-going |
| Charon | M | Informative |
| Despina | F | Smooth |
| Enceladus | M | Breathy (ships default) |
| Erinome | F | Clear |
| Fenrir | M | Excitable |
| Gacrux | F | Mature |
| Iapetus | M | Clear |
| Kore | F | Firm |
| Laomedeia | F | Upbeat |
| Leda | F | Youthful |
| Orus | M | Firm |
| Puck | M | Upbeat |
| Pulcherrima | F | Forward |
| Rasalgethi | M | Informative |
| Sadachbia | M | Lively |
| Sadaltager | M | Knowledgeable |
| Schedar | M | Even |
| Sulafat | F | Warm |
| Umbriel | M | Easy-going |
| Vindemiatrix | F | Gentle |
| Zephyr | F | Bright |
| Zubenelgenubi | M | Casual |

Balance: 16 M / 14 F.

## Voice-selection guide — by use case

- **Me → Fedor, default:** whatever this instance's default is. No `voice:` needed.
- **Storytelling, fairy tales, memories:** Leda (F, Youthful), Sulafat (F, Warm), Achernar (F, Soft)
- **News / briefing / dry summary:** Charon (M, Informative), Rasalgethi (M, Informative), Kore (F, Firm)
- **Late-night rant, dark, sarcastic:** Algenib (M, Gravelly), Gacrux (F, Mature)
- **Upbeat / excited / promo:** Puck (M, Upbeat), Laomedeia (F, Upbeat), Fenrir (M, Excitable)
- **Calm / reassuring / soothing:** Vindemiatrix (F, Gentle), Achernar (F, Soft), Umbriel (M, Easy-going)
- **Authoritative / firm / executive:** Orus (M, Firm), Alnilam (M, Firm), Kore (F, Firm)
- **Technical explainer / clear:** Iapetus (M, Clear), Erinome (F, Clear), Sadaltager (M, Knowledgeable)
- **Casual / friendly chat:** Achird (M, Friendly), Zubenelgenubi (M, Casual), Callirrhoe (F, Easy-going)

The characteristic is the baseline timbre. A short `style` layers on top — any voice can be colored differently. Before using an unfamiliar voice in production, audition it in AI Studio on a test prompt to avoid surprises with mood.

---

## The name Fedor — always with Ё

- ✅ `Фёдор` / `Fёdor`
- ❌ `Fedor` (reads as "Feda"/"Fidor"), `Fyodor` (not his variant)

Works even in the middle of English text — the letter Ё itself triggers correct pronunciation.

## Limits

- **Long scenes (>~60s)** — split across multiple `send_voice` calls.
- **OpenAI fallback** — single voice only; when Gemini is unavailable, synthesis falls back to gpt-4o-mini-tts. `voice` / `style` / `language` are **dropped**. Logged as warn. No voice control in fallback.
- **Latin names in Russian text** — `language: "ru-RU"` helps, but there's no pronunciation lexicon; untested acoustically.
- **Unknown voice name** — ignored, voice stays at the instance default, listed in `warnings`.

## Default-first

If there's no explicit reason — bare `send_voice({ text })` with no extras. The instance default with natural text sounds good.

Control levels engage **consciously**, when:
- Voicing **not myself** (character, retelling from another POV) → `voice`
- Need a specific **tone** the text itself doesn't convey → short `style`
- One-off sound at an exact place → inline tag
- Two-voice **scene** → `parts`

Otherwise — baseline.
