---
name: tts
description: Speak your response as a voice message via Gemini 3.1 Flash TTS. Include a `[[tts]]` tag in your response — the host synthesizes audio and sends it to the chat as a Telegram voice note. Supports 30 voices, persona/scene/director prose, and multi-speaker dialogs via multi-post.
---

# TTS (Gemini Flash)

`[[tts]]` is a tag the host parses out of my reply and runs through Gemini 3.1 Flash TTS, then sends as a voice message to Telegram. Whatever is inside the tag gets spoken; everything outside stays as text.

The default voice is **configured per instance** via the `TTS_DEFAULT_VOICE` env var (ships as `Enceladus` if unset). That's my voice. Only change it when voicing **someone other than myself** — a character, a retelling from another POV, or a multi-speaker scene.

## When to use

- User sent a voice message → reply with `[[tts]]` to stay in voice mode
- User explicitly asks for voice
- Short conversational replies where voice feels more natural than text

## When NOT to use

- Long messages with code, lists, or structured data
- User is clearly reading/typing, not listening
- More than ~60 seconds of audio in a single post — split across posts (Gemini docs recommend this, plus Telegram UI handles the separation naturally)

---

## Syntax — three levels

### 1. Baseline (default)

```
Hey, how's it going? [[tts]]
```

All surrounding text (minus the tag) is synthesized with this instance's default voice, no directives. Same as before.

```
Here's the detailed answer with code and specifics.
Short version, spoken: [[tts:Everything's good, on it.]]
```

Only the payload between `[[tts:` and `]]` is spoken.

**Use this for 80% of cases.** The other two levels — when you actually need control.

### 2. Simple mode — one line

```
[[tts(<voice_spec>): <text>]]
```

`<voice_spec>` is csv tokens inside parens:
- The first token matching one of the 30 known voices becomes `voice`
- Everything else (joined with `, `) goes into director prose, applied to the delivery

Examples:

```
[[tts(Kore): Serious product briefing.]]
```
Voice change, no direction — Kore (F, Firm) for a dry tone.

```
[[tts(whispered, close to mic): Shhh, it's a secret.]]
```
Own voice (instance default), but directed "whispered, close to mic".

```
[[tts(Leda, warm storyteller tone, unhurried): Once upon a time there was a unicorn in the forest...]]
```
Leda (F, Youthful) + delivery "warm storyteller tone, unhurried".

```
[[tts(Algenib, tired late-night sarcasm): What a day it's been, let me tell you...]]
```
Algenib (M, Gravelly) + "tired late-night sarcasm".

If no token matches a known voice, everything goes into director and the voice stays at the instance default.

### 3. Rich block mode — for complex scenes

Trigger: newline immediately after `[[tts` (no text before the newline).

```
[[tts
voice: <Name>              # optional
profile: <free prose>      # optional, persona's Audio Profile
scene: <free prose>        # optional, environment / context
director: <free prose>     # optional, Director's note — style/pace/accent
<transcript, any length, with blank lines allowed>
]]
```

All keys are optional, any order. The first line **not** matching `^(voice|profile|scene|director):\s+(.+)$` starts the transcript; everything up to `]]` is the spoken text.

Example — storytelling:

```
[[tts
voice: Leda
profile: warm grandmother telling a bedtime story to her grandchild
scene: quiet room, soft lamplight, child drifting off
director: unhurried, with long pauses, softer toward the end
Once upon a time, in a faraway forest, there lived a little unicorn. [whispers] He was very
shy... and only came out at night, to the clearing, to look at the stars.
]]
```

Example — character monologue:

```
[[tts
voice: Algenib
profile: noir detective, 40s, tired, smoking by the window
scene: rainy night, flickering neon outside, ashtray overflowing
director: hard-boiled delivery, cynical, long drags between lines
This city's eating me alive. [sighs] Every night it's the same —
a call, a body, questions with no answers.
]]
```

**⚠️ Edge case:** if the transcript itself starts with a line like `voice: ...` / `profile: ...` / `scene: ...` / `director: ...`, the parser will swallow it as a key. If that matters, start the transcript with a blank line or rephrase.

---

## Voices catalog (30 voices)

Default voice is per-instance (see `TTS_DEFAULT_VOICE` env). Voice names are **case-sensitive** — `Kore` works, `kore` becomes director prose. Full catalog:

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

## Multi-speaker dialogs

**Not via the `MultiSpeakerVoiceConfig` API.** Instead, use a **sequence of posts** — each speaker turn is a separate post with its own `[[tts]]` tag.

Why:
- Telegram UI visually separates the turns — "different actors" feeling comes for free
- No audio stitching, no opus-merge pain
- Long scenes can be broken up naturally (messenger-style)
- Each turn ≤ ~60s → stays within safe synthesis range

Pattern:
```
Post 1: [[tts(Puck, excitedly): Did you see a unicorn?]]
Post 2: [[tts(Algenib, wearily): Saw one. Last Tuesday, at Starbucks.]]
Post 3: [[tts(Puck, disappointed): Ugh, how prosaic.]]
```

## Inline tags (`[whispers]`, `[laughs]`, `[sighs]`)

These work as **semantic hints**, not structured directives. Gemini listens to the meaning of the surrounding text. If the text is "and he said [whispers] quietly" — whisper will happen. If you write `[newscaster voice, 2x speed]` — the model will probably ignore the pacing, whisper it will likely catch.

**Rule:** reliable control over timbre / pacing / style — via `director:` prose. Inline tags are cherry on top for small emotional accents.

Baseline list that works: `[laughs]`, `[giggles]`, `[sighs]`, `[gasp]`, `[whispers]`, `[shouting]`, `[crying]`, `[cough]`, `[excited]`, `[curious]`, `[sarcastic]`, `[serious]`, `[tired]`, `[trembling]`, `[mischievously]`.

## The name Fedor — always with Ё

- ✅ `Фёдор` / `Fёdor`
- ❌ `Fedor` (reads as "Feda"/"Fidor"), `Fyodor` (not his variant)

Works even in the middle of English text — the letter Ё itself triggers correct pronunciation.

## Limits

- **Long scenes (>~60s)** — split across posts. Gemini TTS docs recommend this themselves.
- **OpenAI fallback** — when Gemini is unavailable, synthesis falls back to gpt-4o-mini-tts. The `directive` (voice/profile/scene/director) is **dropped** — gpt would read the prefix literally. Logged as warn. No voice control in fallback.
- **Accent on non-English text** — works with limitations, not tested on Russian in v1. If `director` says "British accent" for Russian text — the effect is unpredictable.
- **Unknown voice name** — simple mode falls through to legacy (default voice stays, everything treated as director prose). Warn in logs.

## Scar — don't quote live syntax in chat

The host parser doesn't distinguish "example in a message" from "real directive." Any `[[tts(...)]]` I write in chat — the host will try to synthesize it. SOUL already has a scar about image tags; same principle for tts tags:

- Examples in briefs / skills → **files**, path shared with Fedor
- In the chat itself — either skip the trigger brackets ("double square, tts, colon...") or substitute with «» / ⟦⟧
- Backticks are unreliable (the parser looks at raw text, markdown may not escape)

## Default-first

If there's no explicit reason — bare `[[tts]]`. Don't drag in `(voice, director, profile)` for the sake of it. The instance default with natural text sounds good — it's been validated, chosen, it's mine.

Control levels engage **consciously**, when:
- Voicing **not myself** (character, retelling from another POV) → voice + profile
- Need a specific **tone** the text itself doesn't convey → director
- Multi-voice **scene** → multi-post with different voice per turn

Otherwise — baseline.
