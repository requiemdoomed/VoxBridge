"""Speech-to-text (Whisper) and text-to-speech (Coqui TTS).

Both are optional. When a package is missing the server says so on
/api/health and the page switches to the browser's own speech engines,
so the prototype keeps working on a plain install.
"""

import io
import logging
import os
import tempfile
import threading
from functools import lru_cache

from . import languages

log = logging.getLogger("voxbridge.speech")

WHISPER_SIZE = os.getenv("VOXBRIDGE_WHISPER_MODEL", "base")
TTS_MODEL = os.getenv("VOXBRIDGE_TTS_MODEL", "tts_models/multilingual/multi-dataset/xtts_v2")

try:
    import whisper  # openai-whisper

    HAS_WHISPER = True
except Exception:
    HAS_WHISPER = False

try:
    from TTS.api import TTS as CoquiTTS

    HAS_COQUI = True
except Exception:
    HAS_COQUI = False

_lock = threading.Lock()

# languages the default Coqui model (XTTS v2) can speak; the page uses an
# online or device voice for the rest
COQUI_LANGS = {"en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru", "nl",
               "ar", "zh", "ja", "ko", "hi"}


# ---------- speech to text ----------

@lru_cache(maxsize=1)
def _whisper_model():
    log.info("loading whisper '%s'", WHISPER_SIZE)
    return whisper.load_model(WHISPER_SIZE)


def transcribe(audio: bytes, hint: str | None = None):
    """Transcribe a recorded clip. Returns (text, detected_language)."""
    if not HAS_WHISPER:
        raise RuntimeError("Whisper is not installed on the server")
    if not audio:
        return "", hint or "en"

    # whisper reads through ffmpeg, which wants a real file
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        tmp.write(audio)
        path = tmp.name
    try:
        with _lock:
            result = _whisper_model().transcribe(
                path,
                language=hint if hint and hint != "auto" else None,
                fp16=False,
            )
    finally:
        os.unlink(path)

    detected = result.get("language") or hint or "en"
    if not languages.is_supported(detected):
        detected = hint if hint and hint != "auto" else "en"
    return result.get("text", "").strip(), detected


# ---------- text to speech ----------

@lru_cache(maxsize=1)
def _coqui():
    log.info("loading Coqui model %s", TTS_MODEL)
    return CoquiTTS(TTS_MODEL)


def list_voices():
    if not HAS_COQUI:
        return []
    try:
        return list(_coqui().speakers or [])
    except Exception:
        return []


def synthesize(text: str, lang: str, voice: str | None = None, speed: float = 1.0) -> bytes:
    """Return a WAV file with the spoken text."""
    if not HAS_COQUI:
        raise RuntimeError("Coqui TTS is not installed on the server")
    if lang not in COQUI_LANGS:
        raise ValueError(f"Coqui can't speak {languages.name_of(lang)}")
    import numpy as np
    import soundfile as sf

    engine = _coqui()
    kwargs = {"text": text}
    if getattr(engine, "is_multi_lingual", False):
        kwargs["language"] = "zh-cn" if lang == "zh" else lang
    speakers = engine.speakers or []
    if speakers:
        kwargs["speaker"] = voice if voice in speakers else speakers[0]
    speed = min(max(float(speed), 0.5), 2.0)

    with _lock:
        try:
            wav = engine.tts(speed=speed, **kwargs)
        except TypeError:  # older models have no speed argument
            wav = engine.tts(**kwargs)

    rate = engine.synthesizer.output_sample_rate
    buf = io.BytesIO()
    sf.write(buf, np.asarray(wav, dtype="float32"), rate, format="WAV")
    return buf.getvalue()
