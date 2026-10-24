"""Neural machine translation.

Engines, in the order "auto" tries them (override with VOXBRIDGE_TRANSLATOR):

  marian  Helsinki-NLP MarianMT, only for pairs that have a dedicated,
          single-target model (see MARIAN_PAIRS)
  nllb    Meta NLLB-200, one model covering every language here
  online  Google Translate's public endpoint, with MyMemory as a backup,
          so a plain install still translates properly

Long text is split on sentence boundaries before it is sent anywhere, so
nothing gets cut off, and the result is checked before it is returned.
"""

import html
import logging
import os
import re
from functools import lru_cache

import httpx

from . import languages
from .detect import script_language

log = logging.getLogger("voxbridge.translate")

MODE = os.getenv("VOXBRIDGE_TRANSLATOR", "auto").lower()
NLLB_MODEL = os.getenv("VOXBRIDGE_NLLB_MODEL", "facebook/nllb-200-distilled-600M")
TIMEOUT = 15

# Marian pairs with their own one-to-one model. Other opus-mt names either
# don't exist or cover several target languages and need special tokens,
# so those pairs go to NLLB instead.
MARIAN_PAIRS = {
    "en-es", "es-en", "en-fr", "fr-en", "en-de", "de-en", "en-it", "it-en",
    "en-nl", "nl-en", "en-ru", "ru-en", "en-uk", "uk-en", "en-hi", "hi-en",
    "en-vi", "vi-en", "en-id", "id-en", "zh-en", "ja-en", "ko-en", "ar-en",
    "tr-en", "pl-en", "fr-de", "de-fr", "es-fr", "fr-es",
}

try:
    import torch
    from transformers import (
        AutoModelForSeq2SeqLM,
        AutoTokenizer,
        MarianMTModel,
        MarianTokenizer,
    )

    HAS_TRANSFORMERS = True
except Exception:  # not installed, or a broken torch build
    HAS_TRANSFORMERS = False

# the codes the online services expect, where they differ from ours
_SERVICE_CODES = {"zh": "zh-CN"}

_WARNINGS = ("MYMEMORY WARNING", "PLEASE SELECT", "INVALID LANGUAGE", "QUERY LENGTH LIMIT",
             "IS AN INVALID TARGET LANGUAGE", "NO QUERY SPECIFIED")


class TranslationError(RuntimeError):
    pass


# ---------- text helpers ----------

_SENTENCE_END = re.compile(r"(?<=[.!?。！？।؟])\s+|(?<=[。！？])")


def split_text(text, limit, measure=len):
    """Split text into pieces no longer than `limit`, preferring sentence ends."""
    if measure(text) <= limit:
        return [text]
    pieces, current = [], ""
    for sentence in filter(None, _SENTENCE_END.split(text)):
        candidate = f"{current} {sentence}".strip() if current else sentence
        if measure(candidate) <= limit:
            current = candidate
            continue
        if current:
            pieces.append(current)
        current = ""
        # a single sentence that is still too long: break it on spaces,
        # or character by character for scripts without spaces
        words = sentence.split(" ") if " " in sentence else list(sentence)
        joiner = " " if " " in sentence else ""
        for word in words:
            candidate = f"{current}{joiner}{word}" if current else word
            if measure(candidate) <= limit:
                current = candidate
            else:
                if current:
                    pieces.append(current)
                current = word
    if current:
        pieces.append(current)
    return pieces


def _utf8_len(s):
    return len(s.encode("utf-8"))


def _clean(text):
    text = html.unescape(text or "")
    return re.sub(r"[ \t]+", " ", text).strip()


def _normalise_code(code):
    code = (code or "").lower().split("-")[0]
    return code if languages.is_supported(code) else None


# ---------- MarianMT ----------

_marian_cache = {}


def _marian(src, tgt):
    key = f"{src}-{tgt}"
    if key not in MARIAN_PAIRS:
        return None
    if key not in _marian_cache:
        name = f"Helsinki-NLP/opus-mt-{key}"
        try:
            log.info("loading %s", name)
            _marian_cache[key] = (MarianTokenizer.from_pretrained(name),
                                  MarianMTModel.from_pretrained(name))
        except Exception as exc:
            log.warning("couldn't load %s (%s)", name, exc)
            _marian_cache[key] = None
    return _marian_cache[key]


def _translate_marian(text, src, tgt):
    pair = _marian(src, tgt)
    if pair is None:
        return None
    tokenizer, model = pair
    out = []
    for chunk in split_text(text, 400):
        batch = tokenizer([chunk], return_tensors="pt", truncation=True)
        with torch.no_grad():
            tokens = model.generate(**batch, max_new_tokens=512, num_beams=4)
        out.append(tokenizer.decode(tokens[0], skip_special_tokens=True))
    return " ".join(out)


# ---------- NLLB ----------

@lru_cache(maxsize=1)
def _nllb():
    log.info("loading %s", NLLB_MODEL)
    return (AutoTokenizer.from_pretrained(NLLB_MODEL),
            AutoModelForSeq2SeqLM.from_pretrained(NLLB_MODEL))


def _translate_nllb(text, src, tgt):
    tokenizer, model = _nllb()
    tokenizer.src_lang = languages.nllb_code(src)
    target_id = tokenizer.convert_tokens_to_ids(languages.nllb_code(tgt))
    out = []
    for chunk in split_text(text, 400):
        batch = tokenizer(chunk, return_tensors="pt", truncation=True)
        with torch.no_grad():
            tokens = model.generate(**batch, forced_bos_token_id=target_id,
                                    max_new_tokens=512, num_beams=4)
        out.append(tokenizer.batch_decode(tokens, skip_special_tokens=True)[0])
    joiner = "" if tgt in ("zh", "ja") else " "
    return joiner.join(out)


# ---------- online services ----------

def _google(text, src, tgt):
    """Returns (translation, detected_source). `src` may be 'auto'."""
    parts, detected = [], None
    for chunk in split_text(text, 1500):
        try:
            resp = httpx.get(
                "https://translate.googleapis.com/translate_a/single",
                params={"client": "gtx", "sl": _SERVICE_CODES.get(src, src),
                        "tl": _SERVICE_CODES.get(tgt, tgt), "dt": "t", "q": chunk},
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TranslationError(f"Google Translate unavailable: {exc}") from exc
        if not isinstance(data, list) or not isinstance(data[0], list):
            raise TranslationError("Google Translate sent an unexpected reply")
        parts.append("".join(seg[0] for seg in data[0]
                             if isinstance(seg, list) and isinstance(seg[0], str)))
        if detected is None and len(data) > 2 and isinstance(data[2], str):
            detected = _normalise_code(data[2])
    result = _clean(" ".join(parts) if " " in text else "".join(parts))
    if not result:
        raise TranslationError("Google Translate returned nothing")
    return result, detected


def _mymemory(text, src, tgt):
    parts = []
    for chunk in split_text(text, 450, measure=_utf8_len):
        try:
            resp = httpx.get(
                "https://api.mymemory.translated.net/get",
                params={"q": chunk, "mt": "1",
                        "langpair": f"{_SERVICE_CODES.get(src, src)}|{_SERVICE_CODES.get(tgt, tgt)}"},
                timeout=TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TranslationError(f"MyMemory unavailable: {exc}") from exc

        out = _clean((data.get("responseData") or {}).get("translatedText"))
        status = str(data.get("responseStatus"))
        if status != "200" or not out or data.get("quotaFinished") \
                or any(out.upper().startswith(w) for w in _WARNINGS):
            raise TranslationError(data.get("responseDetails") or out or "MyMemory returned nothing")
        parts.append(out)
    return " ".join(parts)


# ---------- public ----------

def engine_name():
    if HAS_TRANSFORMERS and MODE == "marian":
        return "marian"
    if HAS_TRANSFORMERS and MODE == "nllb":
        return "nllb"
    if HAS_TRANSFORMERS and MODE == "auto":
        return "marian+nllb"
    return "online"


def translate(text, src, tgt, detect=False, speaker=None):
    """Translate `text` into `tgt`.

    src      language the text is in (the speaker's chosen language)
    detect   let the engine work out the real source language; if it turns
             out to be the listener's language, translate back into `speaker`
    speaker  the speaker's own language, used for that reverse direction

    Returns a dict with translation, source, target and engine.
    """
    text = (text or "").strip()
    if not text:
        raise TranslationError("nothing to translate")
    for code in (src, tgt):
        if not languages.is_supported(code):
            raise TranslationError(f"unsupported language '{code}'")
    speaker = speaker if speaker and languages.is_supported(speaker) else src

    # the speaker used the listener's language: reply goes the other way
    if not detect and src == tgt and speaker != tgt:
        tgt = speaker

    use_neural = HAS_TRANSFORMERS and MODE in ("auto", "marian", "nllb")

    if detect:
        # writing systems are unambiguous; for everything else trust the
        # chosen language rather than guessing from a handful of words
        by_script = script_language(text, prefer=(speaker, tgt))
        if by_script:
            src = by_script

    if not use_neural:
        try:
            if detect:
                out, found = _google(text, "auto", tgt)
                if found:
                    src = found
                if src == tgt and speaker != tgt:
                    tgt = speaker
                    out, _ = _google(text, src, tgt)
            else:
                if src == tgt:
                    return _result(text, src, tgt, "passthrough")
                out, _ = _google(text, src, tgt)
            if src == tgt:
                return _result(text, src, tgt, "passthrough")
            return _result(out, src, tgt, "google")
        except TranslationError as exc:
            log.warning("%s; trying MyMemory", exc)

    if src == tgt and speaker != tgt:
        tgt = speaker
    if src == tgt:
        return _result(text, src, tgt, "passthrough")

    if use_neural:
        if MODE in ("auto", "marian"):
            out = _translate_marian(text, src, tgt)
            if out:
                return _result(out, src, tgt, "marian")
        try:
            return _result(_translate_nllb(text, src, tgt), src, tgt, "nllb")
        except Exception as exc:
            log.warning("NLLB failed (%s); using the online service", exc)
            try:
                return _result(_google(text, src, tgt)[0], src, tgt, "google")
            except TranslationError:
                pass

    return _result(_mymemory(text, src, tgt), src, tgt, "mymemory")


def _result(translation, src, tgt, engine):
    return {"translation": translation, "source": src, "target": tgt, "engine": engine}
