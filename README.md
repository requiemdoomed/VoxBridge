<div align="center">

# 🎙️ VoxBridge

### Speech translator with speech-to-text and text-to-speech

Speak in your language. Be heard in theirs.

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![Hugging Face](https://img.shields.io/badge/Hugging%20Face-Transformers-FFD21E?logo=huggingface&logoColor=black)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

**[Live demo](https://requiemdoomed.github.io/voxbridge/)** · [Features](#features) · [Run locally](#run-it-locally) 

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

## Voices

Each person's **Voice** menu lists every voice that can speak their language. Picking one plays a short sample.

| Group | What it is | Languages |
|---|---|---|
| **Auto (best available)** | Uses a natural voice installed on the device if there is one, otherwise the online voice | all 20 |
| **Natural (online)** | Streamed neural voices, with regional accents: US, British, Australian, Indian and Canadian English; Spain, Mexico and US Spanish; France and Canada French; Portugal and Brazil Portuguese; Mainland and Taiwan Mandarin | all 20 |
| **On this device** | Voices installed in your browser or operating system (Edge and Chrome include many natural ones) | depends on the device |
| **Server (Coqui)** | XTTS v2 speakers, when `main.py` runs with Coqui | 15 (not Nepali, Bengali, Ukrainian, Vietnamese or Indonesian) |

If a voice can't play, for example when you're offline, the next one is tried automatically. A line is only left silent if no voice for that language is reachable at all, and then the app tells you so.

## A note on accuracy

Machine translation is very good but not perfect. Idioms, slang, names and very short fragments can still come out wrong, whichever engine is used. Speaking in full sentences gives the best results. Google's endpoint used in browser mode is free and unofficial, and MyMemory steps in automatically if it's unavailable.

## Supported languages

English, Spanish, French, German, Italian, Portuguese, Dutch, Russian,
Ukrainian, Polish, Turkish, Arabic, Hindi, Nepali, Bengali, Chinese,
Japanese, Korean, Vietnamese and Indonesian.

## License

Released under the [MIT License](LICENSE). © 2026 Swayam Shakya
