"""Tests for the translation pipeline.

The online services are replaced by a small fake that behaves like the real
endpoints (same request parameters, same reply format), so the tests run
offline and check that VoxBridge sends the right language codes, keeps the
whole text, reads the replies correctly and recovers from failures.

    python -m unittest discover tests
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import logging  # noqa: E402

import httpx  # noqa: E402

logging.disable(logging.WARNING)  # expected fallback warnings would clutter the output

from app import languages, translator  # noqa: E402
from app.detect import script_language  # noqa: E402

# The same sentence in every supported language
GREETING = {
    "en": "Good morning, how are you?",
    "es": "Buenos días, ¿cómo estás?",
    "fr": "Bonjour, comment allez-vous ?",
    "de": "Guten Morgen, wie geht es dir?",
    "it": "Buongiorno, come stai?",
    "pt": "Bom dia, como você está?",
    "nl": "Goedemorgen, hoe gaat het met je?",
    "ru": "Доброе утро, как дела?",
    "uk": "Доброго ранку, як справи?",
    "pl": "Dzień dobry, jak się masz?",
    "tr": "Günaydın, nasılsın?",
    "ar": "صباح الخير، كيف حالك؟",
    "hi": "सुप्रभात, आप कैसे हैं?",
    "ne": "शुभ प्रभात, तपाईं कस्तो हुनुहुन्छ?",
    "bn": "সুপ্রভাত, আপনি কেমন আছেন?",
    "zh": "早上好，你好吗？",
    "ja": "おはようございます、お元気ですか？",
    "ko": "좋은 아침입니다, 어떻게 지내세요?",
    "vi": "Chào buổi sáng, bạn khỏe không?",
    "id": "Selamat pagi, apa kabar?",
}
SERVICE_CODE = {"zh": "zh-CN"}
FROM_SERVICE = {v: k for k, v in SERVICE_CODE.items()}


def lang_of(sentence):
    for code, text in GREETING.items():
        if text == sentence:
            return code
    return None


class FakeServices:
    """Stands in for translate.googleapis.com and api.mymemory.translated.net."""

    def __init__(self, google_ok=True, mymemory_reply=None):
        self.google_ok = google_ok
        self.mymemory_reply = mymemory_reply
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, dict(params)))
        if "googleapis" in url:
            return self._google(params)
        return self._mymemory(params)

    @staticmethod
    def _response(payload, status=200):
        request = httpx.Request("GET", "https://example.test")
        return httpx.Response(status, json=payload, request=request)

    def _google(self, p):
        if not self.google_ok:
            raise httpx.ConnectError("blocked")
        assert p["client"] == "gtx" and p["dt"] == "t"
        assert p["tl"] in SERVICE_CODE.values() or languages.is_supported(p["tl"]), p["tl"]
        tl = FROM_SERVICE.get(p["tl"], p["tl"])
        detected = lang_of(p["q"]) or "en"
        if p["sl"] != "auto":
            assert FROM_SERVICE.get(p["sl"], p["sl"]) == detected, f"wrong source {p['sl']}"
        out = GREETING.get(tl, p["q"]) if lang_of(p["q"]) else f"[{tl}]{p['q']}"
        # real replies split long text into several segments
        half = len(out) // 2
        segments = [[out[:half], "x", None, None, 10], [out[half:], "y", None, None, 10]]
        return self._response([segments, None, SERVICE_CODE.get(detected, detected)])

    def _mymemory(self, p):
        if self.mymemory_reply is not None:
            return self._response(self.mymemory_reply)
        src, tgt = p["langpair"].split("|")
        assert len(p["q"].encode()) <= 500, "MyMemory limit exceeded"
        tgt = FROM_SERVICE.get(tgt, tgt)
        out = GREETING.get(tgt) if lang_of(p["q"]) else f"[{tgt}]{p['q']}"
        return self._response({"responseStatus": 200, "responseData": {"translatedText": out}})


def run(fake, *args, **kwargs):
    with mock.patch.object(translator, "HAS_TRANSFORMERS", False), \
            mock.patch.object(translator.httpx, "get", fake.get):
        return translator.translate(*args, **kwargs)


class EveryPair(unittest.TestCase):
    def test_all_380_pairs_through_google(self):
        fake = FakeServices()
        for src in GREETING:
            for tgt in GREETING:
                if src == tgt:
                    continue
                with self.subTest(src=src, tgt=tgt):
                    r = run(fake, GREETING[src], src, tgt)
                    self.assertEqual(r["translation"], GREETING[tgt])
                    self.assertEqual((r["source"], r["target"]), (src, tgt))
                    self.assertEqual(r["engine"], "google")

    def test_all_pairs_through_mymemory_fallback(self):
        fake = FakeServices(google_ok=False)
        for src in GREETING:
            for tgt in GREETING:
                if src != tgt:
                    with self.subTest(src=src, tgt=tgt):
                        r = run(fake, GREETING[src], src, tgt)
                        self.assertEqual(r["translation"], GREETING[tgt])
                        self.assertEqual(r["engine"], "mymemory")

    def test_chinese_uses_service_code(self):
        fake = FakeServices()
        run(fake, GREETING["en"], "en", "zh")
        self.assertEqual(fake.calls[-1][1]["tl"], "zh-CN")


class Detection(unittest.TestCase):
    def test_detects_any_language_typed_on_either_side(self):
        fake = FakeServices()
        for actual in GREETING:
            tgt = "ja" if actual != "ja" else "ko"
            with self.subTest(actual=actual):
                r = run(fake, GREETING[actual], "en", tgt, detect=True, speaker="en")
                self.assertEqual(r["source"], actual)
                self.assertEqual(r["translation"], GREETING[tgt])

    def test_reply_in_listeners_language_goes_back_to_speaker(self):
        fake = FakeServices()
        # person A chose English, but typed Spanish (the listener's language)
        r = run(fake, GREETING["es"], "en", "es", detect=True, speaker="en")
        self.assertEqual((r["source"], r["target"]), ("es", "en"))
        self.assertEqual(r["translation"], GREETING["en"])

    def test_without_detect_whisper_language_still_flips(self):
        r = run(FakeServices(), GREETING["fr"], "fr", "fr", speaker="de")
        self.assertEqual(r["target"], "de")
        self.assertEqual(r["translation"], GREETING["de"])

    def test_same_language_both_sides_is_untouched(self):
        r = run(FakeServices(), "hello", "en", "en", speaker="en")
        self.assertEqual((r["translation"], r["engine"]), ("hello", "passthrough"))

    def test_script_rules(self):
        cases = [
            ("こんにちは", (), "ja"), ("東京", ("ja", "en"), "ja"), ("你好", ("en", "es"), "zh"),
            ("안녕하세요", (), "ko"), ("مرحبا", (), "ar"), ("নমস্কার", (), "bn"),
            ("तपाईं कस्तो हुनुहुन्छ", ("en", "hi"), "ne"), ("आप कैसे हैं", ("en", "ne"), "hi"),
            ("नमस्ते", ("en", "hi"), "hi"), ("नमस्ते", ("en", "es"), None),
            ("Як справи? Дякую", (), "uk"), ("Где вы живёте?", (), "ru"),
            ("Привет", ("uk", "en"), "uk"), ("Как дела? Спасибо", (), "ru"),
            ("Доброго ранку, як справи?", ("en", "ru"), "uk"), ("Hello there", ("en", "es"), None),
        ]
        for text, prefer, want in cases:
            with self.subTest(text=text):
                self.assertEqual(script_language(text, prefer), want)


class Robustness(unittest.TestCase):
    def test_long_text_is_split_not_cut(self):
        fake = FakeServices()
        text = " ".join(f"This is sentence number {i}." for i in range(150))  # ~4000 chars
        r = run(fake, text, "en", "de")
        sent = " ".join(call[1]["q"] for call in fake.calls)
        self.assertEqual(sent, text)
        self.assertGreater(len(fake.calls), 1)
        self.assertTrue(r["translation"].endswith("sentence number 149."))

    def test_mymemory_chunks_stay_under_byte_limit(self):
        fake = FakeServices(google_ok=False)
        text = "Это очень длинное предложение для проверки. " * 40
        run(fake, text.strip(), "ru", "en")
        self.assertTrue(all(len(c[1]["q"].encode()) <= 450 for c in fake.calls if "mymemory" in c[0]))

    def test_unspaced_text_is_split_too(self):
        pieces = translator.split_text("字" * 1000, 300)
        self.assertEqual("".join(pieces), "字" * 1000)
        self.assertTrue(all(len(p) <= 300 for p in pieces))

    def test_html_entities_are_decoded(self):
        fake = FakeServices(google_ok=False, mymemory_reply={
            "responseStatus": 200, "responseData": {"translatedText": "I&#39;m &quot;fine&quot; &amp; you?"}})
        self.assertEqual(run(fake, "x", "en", "es")["translation"], 'I\'m "fine" & you?')

    def test_quota_warning_is_an_error_not_a_translation(self):
        fake = FakeServices(google_ok=False, mymemory_reply={
            "responseStatus": 200, "quotaFinished": True, "responseData": {
                "translatedText": "MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY."}})
        with self.assertRaises(translator.TranslationError):
            run(fake, "hello", "en", "es")

    def test_bad_language_pair_is_rejected(self):
        with self.assertRaises(translator.TranslationError):
            run(FakeServices(), "hello", "en", "xx")

    def test_empty_text_is_rejected(self):
        with self.assertRaises(translator.TranslationError):
            run(FakeServices(), "   ", "en", "es")


class NeuralRouting(unittest.TestCase):
    """MarianMT only for real one-to-one models, NLLB for everything else."""

    def test_marian_only_for_known_pairs(self):
        with mock.patch.object(translator, "HAS_TRANSFORMERS", True), \
                mock.patch.object(translator, "_marian", side_effect=lambda s, t: None if f"{s}-{t}" not in translator.MARIAN_PAIRS else ("tok", "model")), \
                mock.patch.object(translator, "_translate_marian", side_effect=lambda x, s, t: f"marian:{s}-{t}" if f"{s}-{t}" in translator.MARIAN_PAIRS else None), \
                mock.patch.object(translator, "_translate_nllb", side_effect=lambda x, s, t: f"nllb:{s}-{t}"):
            self.assertEqual(translator.translate("hi", "en", "es")["engine"], "marian")
            self.assertEqual(translator.translate("hi", "en", "ne")["engine"], "nllb")
            self.assertEqual(translator.translate("hi", "en", "ar")["engine"], "nllb")  # en-ar is multi-target
            self.assertEqual(translator.translate("hi", "ko", "ja")["engine"], "nllb")

    def test_every_language_has_an_nllb_code(self):
        for code in languages.LANGUAGES:
            self.assertRegex(languages.nllb_code(code), r"^[a-z]{3}_[A-Z][a-z]{3}$")


if __name__ == "__main__":
    unittest.main()
