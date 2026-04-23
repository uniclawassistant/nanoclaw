---
name: tts
description: Speak your response as a voice message via Gemini 3.1 Flash TTS. Include a `[[tts]]` tag in your response — the host synthesizes audio and sends it to the chat as a Telegram voice note. Supports 30 voices, persona/scene/director prose, and multi-speaker dialogs via multi-post.
---

# TTS (Gemini Flash)

`[[tts]]` — тег который хост парсит из моего ответа и синтезирует через Gemini 3.1 Flash TTS, отправляет как voice-message в Telegram. Всё что в теге — произносится, всё вне — остаётся текстом.

Дефолтный голос — **Enceladus** (M, Breathy, close-mic). Это мой голос. Менять только когда озвучиваю **не себя** (персонаж, пересказ от лица другого, multi-speaker сценка).

## Когда использовать

- Пользователь прислал voice message → отвечаю `[[tts]]`
- Пользователь просит голосом
- Короткий разговорный ответ где голос ощущается естественнее текста

## Когда НЕ использовать

- Длинные сообщения с кодом, списками, структурой
- Пользователь явно читает/печатает, не слушает
- Больше ~60 секунд озвучки в одном посте — дроби на несколько постов (Gemini сам так советует в docs, плюс Telegram UI это и так естественный разделитель)

---

## Синтаксис — три уровня

### 1. Baseline (дефолт)

```
Привет, как дела? [[tts]]
```

Весь surrounding текст (минус тег) → синтез голосом Enceladus, без каких-либо директив. Как раньше.

```
Вот ответ текстом с кодом и подробностями.
А кратко скажу голосом: [[tts:Всё норм, делаю.]]
```

Озвучивается только payload между `[[tts:` и `]]`.

**Используй это в 80% случаев.** Остальные два уровня — когда реально нужен контроль.

### 2. Simple mode — одна строка

```
[[tts(<voice_spec>): <text>]]
```

`<voice_spec>` — csv токены в круглых скобках:
- Первый токен, матчащий one of 30 known voices — становится `voice`
- Всё остальное (join через `, `) — director prose, накладывается на подачу

Примеры:

```
[[tts(Kore): Серьёзный бриф по продукту.]]
```
Смена голоса без режиссуры — Kore (F, Firm) для сухого тона.

```
[[tts(whispered, close to mic): Тссс, это секрет.]]
```
Свой голос (Enceladus), но режиссура "шёпотом, близко к микрофону".

```
[[tts(Leda, warm storyteller tone, unhurried): Жил-был единорог в лесу...]]
```
Leda (F, Youthful) + подача "тёплый рассказчик, неспешно".

```
[[tts(Algenib, tired late-night sarcasm): Ну и денёк был, скажу я тебе...]]
```
Algenib (M, Gravelly) + "уставший ночной сарказм".

Если ни один токен не совпал с known voice — всё идёт в director, голос остаётся Enceladus.

### 3. Rich block mode — для сложных сцен

Триггер: newline сразу после `[[tts` (никакого текста до newline).

```
[[tts
voice: <Name>              # опц.
profile: <free prose>      # опц., Audio Profile персоны
scene: <free prose>        # опц., окружение/контекст
director: <free prose>     # опц., Director's note — стиль/темп/акцент
<транскрипт, любой длины, с пустыми строками внутри>
]]
```

Все ключи опциональны, порядок любой. Первая строка **не** матчащая `^(voice|profile|scene|director):\s+(.+)$` — начало транскрипта; всё до `]]` = текст для озвучки.

Пример — storytelling:

```
[[tts
voice: Leda
profile: тёплая бабушка рассказывает сказку внуку перед сном
scene: тихая комната, мягкий свет лампы, ребёнок засыпает
director: неспешно, с долгими паузами, в конце тише
Жил-был в далёком лесу маленький единорог. [whispers] Он был очень
застенчивый... И только ночью выходил на поляну, чтобы посмотреть
на звёзды.
]]
```

Пример — монолог персонажа:

```
[[tts
voice: Algenib
profile: детектив нуар, 40s, уставший, курит у окна
scene: дождливая ночь, мигающий неон за окном, пепельница полная
director: hard-boiled delivery, cynical, с длинными затяжками между фразами
Этот город меня сжирает. [sighs] Каждую ночь одно и то же —
звонок, труп, вопросы без ответов.
]]
```

**⚠️ Edge case:** если транскрипт сам начинается со строки вида `voice: ...` / `profile: ...` / `scene: ...` / `director: ...` — парсер её съест как ключ. Если критично — начни транскрипт с пустой строки или переформулируй.

---

## Voices catalog (30 голосов)

Дефолт — **Enceladus**. Имена **case-sensitive** — `Kore` работает, `kore` уходит в director prose. Full catalog:

| Имя | Пол | Характеристика |
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
| **Enceladus** | **M** | **Breathy — мой дефолт** |
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

Баланс: 16 M / 14 F.

## Voice-selection guide — под задачу

- **Я → Fedor, дефолт:** Enceladus (M, Breathy). Писать `voice:` не нужно.
- **Storytelling, сказки, воспоминания:** Leda (F, Youthful), Sulafat (F, Warm), Achernar (F, Soft)
- **News / briefing / сухая сводка:** Charon (M, Informative), Rasalgethi (M, Informative), Kore (F, Firm)
- **Late-night rant, тёмное, саркастичное:** Algenib (M, Gravelly), Gacrux (F, Mature)
- **Upbeat / excited / промо:** Puck (M, Upbeat), Laomedeia (F, Upbeat), Fenrir (M, Excitable)
- **Calm / reassuring / soothing:** Vindemiatrix (F, Gentle), Achernar (F, Soft), Umbriel (M, Easy-going)
- **Authoritative / firm / executive:** Orus (M, Firm), Alnilam (M, Firm), Kore (F, Firm)
- **Technical explainer / clear:** Iapetus (M, Clear), Erinome (F, Clear), Sadaltager (M, Knowledgeable)
- **Casual / friendly chat:** Achird (M, Friendly), Zubenelgenubi (M, Casual), Callirrhoe (F, Easy-going)

Характеристика = baseline тембра. `director` / `profile` / `scene` накладываются сверху — любой голос можно окрасить по-разному. Незнакомый голос перед продакшеном — проверить в AI Studio на тестовом промпте, чтобы не промахнуться с настроением.

---

## Multi-speaker диалоги

**Не через API `MultiSpeakerVoiceConfig`.** Через **последовательность постов** — каждый speaker-turn = отдельный пост со своим `[[tts]]` тегом.

Почему:
- Telegram UI сам визуально разделяет реплики — "ощущение разных актёров" бесплатно
- Никакого audio-stitching, никаких opus-merge боли
- Можно длинную сцену дробить естественно (как в мессенджере)
- Один turn ≤ ~60s → можно перегонять без риска потери качества

Паттерн:
```
Post 1: [[tts(Puck, восторженно): А ты видел единорога?]]
Post 2: [[tts(Algenib, устало): Видел. В прошлый вторник, в Starbucks.]]
Post 3: [[tts(Puck, разочарованно): Фу, какая проза.]]
```

## Inline tags (`[whispers]`, `[laughs]`, `[sighs]`)

Работают как **семантические подсказки**, а не структурированные директивы. Gemini слушает смысл текста вокруг них. Если текст "И он сказал [whispers] тише" — шёпот будет. Если `[newscaster voice, 2x speed]` — модель скорее всего проигнорит темп, шепот уловит.

**Правило:** надёжный контроль тембра/темпа/стиля — через `director:` прозу. Inline tags — cherry on top для мелких эмоциональных акцентов.

Список, который точно работает (baseline): `[laughs]`, `[giggles]`, `[sighs]`, `[gasp]`, `[whispers]`, `[shouting]`, `[crying]`, `[cough]`, `[excited]`, `[curious]`, `[sarcastic]`, `[serious]`, `[tired]`, `[trembling]`, `[mischievously]`.

## Имя Fedor — всегда с Ё

- ✅ `Фёдор` / `Fёdor`
- ❌ `Fedor` (читается "Феда"/"Фидор"), `Fyodor` (не его вариант)

Работает даже посреди английского текста — буква Ё сама триггерит правильную озвучку.

## Ограничения

- **Длинные сцены (>~60s)** — дроби на посты. Gemini TTS сам это советует в docs.
- **OpenAI fallback** — когда Gemini недоступен, синтез уходит на gpt-4o-mini-tts. `directive` (voice/profile/scene/director) **дропается** — gpt прочитает prefix буквально. В логах warn. Voice контроль в fallback отсутствует.
- **Accent на не-английских текстах** — работает ограниченно, в v1 не тестировано на русском. Если в director написано "British accent" для русского текста — эффект непредсказуем.
- **Неизвестное voice name** — simple mode fall-through на legacy (voice остаётся дефолтный, всё считается director prose). Warn в лог.

## Scar — не цитировать живой синтаксис в чат

Парсер хоста не отличает "пример в сообщении" от "реальная директива". Любой `[[tts(...)]]` который я напишу в чате — хост попытается озвучить. В SOUL уже есть scar про image-теги; для tts-тегов тот же принцип:

- Примеры в брифах/скиллах → **файл**, путь передаю Fedor'у
- В самом чате — либо без тригерных скобок ("двойные квадратные, tts, двоеточие..."), либо через «» / ⟦⟧ замену
- Бэктики — ненадёжно (парсер смотрит сырой текст, markdown может не экранировать)

## Дефолт-first

Если нет явной причины — голый `[[tts]]`. Не тащить `(voice, director, profile)` ради красоты. Дефолт Enceladus с твоим натуральным текстом звучит хорошо — это проверено, выбрано, моё.

Контрольные уровни включаются **осознанно**, когда:
- Озвучиваю **не себя** (персонаж, пересказ от лица другого) → voice + profile
- Нужен конкретный **тон** который текст сам не передаёт → director
- Многоголосая **сценка** → multi-post с разными voice на каждый turn

Иначе — baseline.
