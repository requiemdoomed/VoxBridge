<div align="center">

# 🎙️ VoxBridge

### Speech translator with speech-to-text and text-to-speech

Speak in your language. Be heard in theirs.

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![Hugging Face](https://img.shields.io/badge/Hugging%20Face-Transformers-FFD21E?logo=huggingface&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

**[Live demo](https://YOUR-USERNAME.github.io/voxbridge/)** · [Features](#features) · [Run locally](#run-it-locally) · [Deploy](#deploy-to-github-pages)

</div>

---

VoxBridge lets two people who don't share a language talk to each other. You
speak, it writes down what you said, translates it and reads the translation
aloud in a natural voice in the other person's language. It works from typed
text too.

The web page runs entirely in the browser, so it can be hosted for free on
GitHub Pages. Run the Python server alongside it and the page switches to
on-device models: Whisper for speech recognition, MarianMT / NLLB for
translation and Coqui for voices.

*Built by Swayam Shakya, Feb 2026 – Mar 2026.*

## Features

- 🎤 **Speech-to-text.** Tap the mic and talk. With the server, OpenAI Whisper transcribes the audio and detects which language is being spoken.
- 🌍 **Neural machine translation** between 20 languages, using MarianMT pair models with NLLB-200 as the fallback.
- 🔊 **Text-to-speech in every language**, including Nepali, Bengali and Ukrainian. Each person can choose from natural online voices with regional accents, the voices installed on their device, or Coqui voices on the server. The speaking speed is adjustable.
- 💬 **Conversation mode.** Two speakers side by side, each line shown next to its translation. You can replay any line and save the whole transcript.
- 🧭 **Automatic direction.** If someone speaks in the other person's language, VoxBridge notices and translates it back the other way.
- 📈 **Live mic meter**, drawn with the Web Audio API.
- 📱 **Responsive**, with light and dark themes. Your conversation and settings are remembered between visits.

## How it works

```
 ┌───────────────────────── index.html (browser) ─────────────────────────┐
 │  mic ─▶ speech-to-text ─▶ translate ─▶ text-to-speech ─▶ speaker      │
 └──────────────┬─────────────────────────────────────────────────────────┘
                │ WebSocket / REST (optional)
 ┌──────────────▼──────────── main.py (FastAPI) ──────────────────────────┐
 │  Whisper (STT)   ·   MarianMT / NLLB (translation)   ·   Coqui (TTS)   │
 └────────────────────────────────────────────────────────────────────────┘
```

| | Browser only (GitHub Pages) | With `main.py` + models |
|---|---|---|
| Speech-to-text | Web Speech API | OpenAI Whisper |
| Language detection | Google Translate + writing system | Whisper |
| Translation | Google Translate, MyMemory as backup | MarianMT → NLLB-200, online as backup |
| Text-to-speech | Natural online voices + device voices | Coqui TTS, plus the same voices for languages Coqui doesn't cover |

The status chips at the top of the page always show which engines are in use.

### Getting translations right

- **The source language comes from the speaker's chosen language**, never from guesses based on a few words. With *Detect spoken language* on, the translation service (or Whisper) identifies the language. The writing system is also used where it's unambiguous, for example Hangul, Kana, Arabic or Bengali.
- **Shared scripts are handled carefully.** Chinese/Japanese Han characters, Hindi/Nepali Devanagari and Russian/Ukrainian Cyrillic are told apart using the languages in the conversation and words that only one of them uses.
- **Long text is split at sentence boundaries**, so nothing is silently cut off.
- **Replies are checked.** HTML entities are decoded, and service warnings such as quota messages are reported as errors instead of being shown as translations.
- **MarianMT is only used for language pairs with a dedicated one-to-one model.** Every other pair goes to NLLB-200.

## Run it locally

You need Python 3.10 or newer.

```bash
git clone https://github.com/YOUR-USERNAME/voxbridge.git
cd voxbridge
pip install -r requirements.txt
python main.py
```

Then open **http://localhost:8000**. On Windows you can double-click
`run.bat` instead; on macOS or Linux, run `./run.sh`.

### Full on-device models

```bash
pip install -r requirements-models.txt
```

You'll also need [ffmpeg](https://ffmpeg.org/download.html) on your PATH.
Restart `main.py` and the page picks up Whisper, MarianMT / NLLB and Coqui
automatically. Each model downloads the first time it's used.

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Server port |
| `VOXBRIDGE_TRANSLATOR` | `auto` | `auto`, `marian`, `nllb` or `online` (Google, then MyMemory) |
| `VOXBRIDGE_WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium`… |
| `VOXBRIDGE_NLLB_MODEL` | `facebook/nllb-200-distilled-600M` | NLLB checkpoint |
| `VOXBRIDGE_TTS_MODEL` | `tts_models/multilingual/multi-dataset/xtts_v2` | Coqui model |
| `VOXBRIDGE_ALLOWED_ORIGINS` | `*` | Sites allowed to call the server, comma-separated |

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Open **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The included workflow (`.github/workflows/pages.yml`) builds and publishes the site.

Your app goes live at `https://YOUR-USERNAME.github.io/voxbridge/`.

> Prefer no workflow? Set Source to **Deploy from a branch**, then pick `main` and `/ (root)`. The compiled `static/app.js` is already committed, so it works as is.

### Connecting the hosted page to your models

Start `main.py` on your machine. Then, on the live site, click **⚙ Server** and
enter `http://localhost:8000`. You can also open the page with
`?server=http://localhost:8000` in the address.

To share the server with other people, put it behind HTTPS (for example with a
tunnel or a cloud host). Browsers block an `https://` page from calling a
plain `http://` address anywhere except localhost.

## Voices

Each person's **Voice** menu lists every voice that can speak their language. Picking one plays a short sample.

| Group | What it is | Languages |
|---|---|---|
| **Auto (best available)** | Uses a natural voice installed on the device if there is one, otherwise the online voice | all 20 |
| **Natural (online)** | Streamed neural voices, with regional accents: US, British, Australian, Indian and Canadian English; Spain, Mexico and US Spanish; France and Canada French; Portugal and Brazil Portuguese; Mainland and Taiwan Mandarin | all 20 |
| **On this device** | Voices installed in your browser or operating system (Edge and Chrome include many natural ones) | depends on the device |
| **Server (Coqui)** | XTTS v2 speakers, when `main.py` runs with Coqui | 15 (not Nepali, Bengali, Ukrainian, Vietnamese or Indonesian) |

If a voice can't play, for example when you're offline, the next one is tried automatically. A line is only left silent if no voice for that language is reachable at all, and then the app tells you so.

## Using it

1. Choose a language for each person. The **⇄** button swaps them.
2. Tap a microphone, speak, and tap it again. Or type and press **Enter**.
3. The translation appears in the conversation and is read aloud.
4. Press **▶ play** on any line to hear it again. **Save transcript** downloads the conversation as a text file.

> Voice input works best in Chrome or Edge. Firefox doesn't support browser speech recognition, so use typing there, or connect the server and Whisper handles the audio.

## Project structure

```
voxbridge/
├── index.html               the app: the page that drives everything
├── static/
│   ├── style.css
│   ├── translate.js         compiled from src/translate.ts
│   ├── voices.js            compiled from src/voices.ts
│   └── app.js               compiled from src/app.ts
├── src/
│   ├── translate.ts         in-browser translation and language detection
│   ├── voices.ts            voice menu, playback and fallbacks
│   └── app.ts               page logic: speech, conversation, server link
├── tests/                   test suites for both translators
├── main.py                  FastAPI server: REST endpoints and /ws WebSocket
├── app/
│   ├── languages.py         supported languages and their codes per engine
│   ├── detect.py            writing-system based language detection
│   ├── translator.py        MarianMT → NLLB → Google → MyMemory
│   └── speech.py            Whisper transcription and Coqui voices
├── .github/workflows/
│   └── pages.yml            GitHub Pages deployment
├── requirements.txt         lightweight server
├── requirements-models.txt  on-device models
├── package.json, tsconfig.json
├── run.sh / run.bat
└── LICENSE
```

## Tests

```bash
python -m unittest discover tests       # server translator
node --test tests/translate.test.mjs     # in-browser translator
node --test tests/voices.test.mjs        # voices for every language
```

Or run everything with `npm test`. The translation suites check all 380 language pairs on every engine path. They also cover detection, reverse direction, long text, entity decoding and service failures, against offline fakes of the online services. The voice suite checks that every language always has a voice, that the accents are offered, and that Coqui is never asked for a language it can't speak.

To change the front end, edit the files in `src/`, then run:

```bash
npm install
npm run build
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Which engines are active |
| `GET` | `/api/languages` | Supported languages |
| `GET` | `/api/voices` | Coqui speakers, when available |
| `POST` | `/api/translate` | `{ "text", "source", "target" }`. `source` can be `"auto"` |
| `POST` | `/api/speak` | `{ "text", "lang", "voice", "speed" }`. Returns WAV audio |
| `WS` | `/ws` | Send `{type:"text", …}` or `{type:"audio", data:<base64>, …}`. Receives `transcript` and `result` messages |

## A note on accuracy

Machine translation is very good but not perfect. Idioms, slang, names and very short fragments can still come out wrong, whichever engine is used. Speaking in full sentences gives the best results. Google's endpoint used in browser mode is free and unofficial, and MyMemory steps in automatically if it's unavailable.

## Supported languages

English, Spanish, French, German, Italian, Portuguese, Dutch, Russian,
Ukrainian, Polish, Turkish, Arabic, Hindi, Nepali, Bengali, Chinese,
Japanese, Korean, Vietnamese and Indonesian.

## Tech stack

**Languages:** Python, TypeScript
**Tools:** OpenAI Whisper, Hugging Face Transformers (MarianMT, NLLB), Coqui TTS, FastAPI, WebSockets, Web Audio API, Web Speech API
**Skills:** speech recognition, neural machine translation, text-to-speech, natural language processing

## License

Released under the [MIT License](LICENSE). © 2026 Swayam Shakya
