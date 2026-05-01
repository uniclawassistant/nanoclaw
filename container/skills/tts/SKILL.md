---
name: tts
description: Speak your response as a voice message via the `send_voice` MCP tool (Gemini 3.1 Flash TTS, OpenAI fallback). Returns `{ ok, message_id }` so you can `get_message` / `react`. Supports 30 voices, persona/scene/director prose, and multi-speaker scenes via sequential posts.
---

# Voice messages — `send_voice`

`send_voice` is an MCP tool that synthesizes audio (Gemini 3.1 Flash by default, OpenAI fallback) and ships it to the chat as a Telegram voice note. The tool returns `{ ok, message_id }` so you can react to it, look it up later via `get_message`, or follow it up with text.

```jsonc
send_voice({
  text: "Hey, how's it going?",
})
```

The default voice is **configured per instance** via the `TTS_DEFAULT_VOICE` env var (ships as `Enceladus` if unset). That's my voice. Only override it with `voice:` when voicing **someone other than myself** — a character, a retelling from another POV, or a multi-speaker scene.

> **Channel scope.** Voice is Telegram-only today. On other channels you get `{ ok: true, skipped: true, reason: "channel not supported" }` and no error.

## When to use

- User sent a voice message → reply with `send_voice` to stay in voice mode
- User explicitly asks for voice
- Short conversational replies where voice feels more natural than text

## When NOT to use

- Long messages with code, lists, or structured data — those need text
- User is clearly reading/typing, not listening
- More than ~60 seconds of audio in a single post — split across multiple `send_voice` calls (Gemini docs recommend this; Telegram UI handles the separation naturally)

## Mixed responses (voice summary + text details)

Call `send_voice` first with the spoken summary, then `send_message` (or just final text output) with the longer details. The two posts arrive in order.

```jsonc
send_voice({ text: "Short version, spoken: everything's good, on it." })
// Then your normal text reply with the full details.
```

---

## Parameters

```jsonc
send_voice({
  text: string,            // required, plain text — what gets spoken
  voice?: string,          // optional, named voice (case-sensitive)
  director?: string,       // optional, prose stage direction applied to delivery
  profile?: string,        // optional, persona / Audio Profile (block-mode equivalent)
  scene?: string,          // optional, environment / context (block-mode equivalent)
})
```

### `text` (required)

Plain text — no markdown, no code, no bullets (they read literally as "asterisk asterisk bold asterisk asterisk"). Inline Gemini expression tags work **inside** the text:

```jsonc
send_voice({
  text: "Ну привет! [laughs] Как ты? [whispers] Это секрет. [gasp] Да ладно!",
})
```

These are semantic hints, not structured directives. Gemini listens to the surrounding meaning, so `"...and he said [whispers] quietly"` whispers reliably; `[newscaster voice, 2x speed]` is more like a wish. For reliable control over timbre/pacing/style, use `director:` instead.

Baseline list that works: `[laughs]`, `[giggles]`, `[sighs]`, `[gasp]`, `[whispers]`, `[shouting]`, `[crying]`, `[cough]`, `[excited]`, `[curious]`, `[sarcastic]`, `[serious]`, `[tired]`, `[trembling]`, `[mischievously]`.

### `voice` (optional)

Named voice from the catalog (case-sensitive — `Kore` works, `kore` is silently ignored and the voice stays at the instance default). Full catalog below.

### `director` (optional)

Free-form prose stage direction applied to the whole utterance, e.g. `"whispered, close to mic"` / `"warm storyteller tone, unhurried"` / `"tired late-night sarcasm"`. Layered on top of `voice` — any voice can be colored differently.

### `profile` and `scene` (optional)

Free-form prose carried into the synthesis prompt. Use for richer characterizations than a one-liner director note:

- `profile`: who is speaking — `"warm grandmother telling a bedtime story"` / `"noir detective, 40s, tired, smoking by the window"`
- `scene`: where / when — `"quiet room, soft lamplight, child drifting off"` / `"rainy night, flickering neon outside, ashtray overflowing"`

You usually only need these for storytelling or character work. For everyday voice replies, leave them out.

---

## Worked examples

```jsonc
// 80% case — bare voice in instance default
send_voice({ text: "Hey, how's it going?" })

// Voice change only
send_voice({
  text: "Serious product briefing.",
  voice: "Kore",                  // F, Firm — dry tone
})

// Director only (own voice)
send_voice({
  text: "Shhh, it's a secret.",
  director: "whispered, close to mic",
})

// Voice + director
send_voice({
  text: "Once upon a time there was a unicorn in the forest...",
  voice: "Leda",
  director: "warm storyteller tone, unhurried",
})

// Storytelling — full block
send_voice({
  text: "Once upon a time, in a faraway forest, there lived a little unicorn. [whispers] He was very shy... and only came out at night, to the clearing, to look at the stars.",
  voice: "Leda",
  profile: "warm grandmother telling a bedtime story to her grandchild",
  scene: "quiet room, soft lamplight, child drifting off",
  director: "unhurried, with long pauses, softer toward the end",
})

// Character monologue
send_voice({
  text: "This city's eating me alive. [sighs] Every night it's the same — a call, a body, questions with no answers.",
  voice: "Algenib",
  profile: "noir detective, 40s, tired, smoking by the window",
  scene: "rainy night, flickering neon outside, ashtray overflowing",
  director: "hard-boiled delivery, cynical, long drags between lines",
})
```

---

## Multi-speaker dialogs

**Not via the `MultiSpeakerVoiceConfig` API.** Instead, send a **sequence of posts** — each speaker turn is a separate `send_voice` call.

Why:
- Telegram UI visually separates the turns — "different actors" feeling comes for free
- No audio stitching, no opus-merge pain
- Long scenes can be broken up naturally (messenger-style)
- Each turn ≤ ~60s → stays within safe synthesis range

```jsonc
send_voice({ text: "Did you see a unicorn?",                voice: "Puck",    director: "excitedly" })
send_voice({ text: "Saw one. Last Tuesday, at Starbucks.",  voice: "Algenib", director: "wearily" })
send_voice({ text: "Ugh, how prosaic.",                     voice: "Puck",    director: "disappointed" })
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

The characteristic is the baseline timbre. `director` / `profile` / `scene` layer on top — any voice can be colored differently. Before using an unfamiliar voice in production, audition it in AI Studio on a test prompt to avoid surprises with mood.

---

## The name Fedor — always with Ё

- ✅ `Фёдор` / `Fёdor`
- ❌ `Fedor` (reads as "Feda"/"Fidor"), `Fyodor` (not his variant)

Works even in the middle of English text — the letter Ё itself triggers correct pronunciation.

## Limits

- **Long scenes (>~60s)** — split across multiple `send_voice` calls. Gemini TTS docs recommend this themselves.
- **OpenAI fallback** — when Gemini is unavailable, synthesis falls back to gpt-4o-mini-tts. `voice` / `director` / `profile` / `scene` are **dropped** — gpt would read the prefix literally. Logged as warn. No voice control in fallback.
- **Accent on non-English text** — works with limitations, not tested on Russian in v1. If `director` says "British accent" for Russian text, the effect is unpredictable.
- **Unknown voice name** — silently ignored, voice stays at the instance default. Warn in host log.

## Default-first

If there's no explicit reason — bare `send_voice({ text })` with no extras. Don't drag in `voice` / `director` / `profile` for the sake of it. The instance default with natural text sounds good — it's been validated, chosen, it's mine.

Control levels engage **consciously**, when:
- Voicing **not myself** (character, retelling from another POV) → `voice` + `profile`
- Need a specific **tone** the text itself doesn't convey → `director`
- Multi-voice **scene** → sequential `send_voice` calls with different `voice` per turn

Otherwise — baseline.
