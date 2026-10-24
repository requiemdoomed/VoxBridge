"""Small, dependency-free language guesser for typed text.

Whisper reports the spoken language on its own. Typed text (and speech
captured by the browser recogniser) has no such label, so this module
makes a quick guess from the writing system first and, for Latin-script
text, from a handful of very common words.
"""

import re

_SCRIPTS = [
    ("ja", re.compile(r"[぀-ヿ]")),          # kana wins over kanji
    ("ko", re.compile(r"[가-힯]")),
    ("zh", re.compile(r"[一-鿿]")),
    ("ar", re.compile(r"[؀-ۿ]")),
    ("bn", re.compile(r"[ঀ-৿]")),
    ("hi", re.compile(r"[ऀ-ॿ]")),          # refined below for Nepali
    ("uk", re.compile(r"[ієїґІЄЇҐ]")),
    ("ru", re.compile(r"[Ѐ-ӿ]")),
]

_COMMON_WORDS = {
    "en": "the and is are you to of it that this what with have for not my your hello i am fine good thanks please yes where how we can do",
    "es": "el la los las es que de y a en un una por para con no hola gracias estoy está estás del muy qué dónde cómo sí bien buenos días",
    "fr": "le la les est et de des un une que je vous pour pas avec bonjour merci",
    "de": "der die das und ist ich du nicht ein eine mit zu auf hallo danke wie",
    "it": "il lo la gli che di e un una per non sono ciao grazie come questo",
    "pt": "o a os as que de e um uma para com não você obrigado olá está muito onde bom dia",
    "nl": "de het een en is ik je niet van dat met voor hallo dank wat",
    "pl": "i w nie się na to jest że jak co dzień dobry dziękuję cześć",
    "tr": "ve bir bu da de ne için ben sen merhaba teşekkür nasıl evet",
    "vi": "và là của không có tôi bạn một những xin chào cảm ơn",
    "id": "dan yang di ini itu saya anda tidak dengan untuk apa terima kasih",
}
_COMMON_WORDS = {code: set(words.split()) for code, words in _COMMON_WORDS.items()}

# Letters that give a Latin-script language away
_TELLTALE = {
    "es": "ñ¿¡", "pt": "ãõ", "de": "ßäöü", "fr": "çèêëœàù",
    "pl": "ąęłńśźż", "tr": "ğışİ", "vi": "ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ",
}

# Everyday words found in only one of Nepali / Hindi
_NEPALI_HINTS = {"छ", "छु", "छन्", "छैन", "हुन्छ", "हुनुहुन्छ", "तपाईं", "तपाईँ", "मेरो", "गर्नु", "कस्तो", "कहाँ", "म"}


def guess_language(text: str, fallback: str = "en", prefer=()) -> str:
    """Best guess at the language of `text`.

    `prefer` lists the languages already in the conversation; they win
    close calls, which matters a lot for short phrases.
    """
    text = (text or "").strip()
    if not text:
        return fallback

    for code, pattern in _SCRIPTS:
        if pattern.search(text):
            if code == "hi" and _NEPALI_HINTS & set(text.split()):
                return "ne"
            return code

    words = re.findall(r"[^\W\d_]+", text.lower())
    if not words:
        return fallback

    lowered = text.lower()
    best, best_score = fallback, 0.0
    for code, vocab in _COMMON_WORDS.items():
        score = float(sum(1 for w in words if w in vocab))
        score += 2 * sum(1 for ch in _TELLTALE.get(code, "") if ch in lowered)
        if code in prefer and score:
            score += 1.25
        if score > best_score:
            best, best_score = code, score
    return best


_RUSSIAN_ONLY = re.compile(r"[ыэъёЫЭЪЁ]")
_HINDI_ONLY_HINTS = {"है", "हैं", "हूँ", "हूं", "मैं", "आप", "क्या", "नहीं", "यह", "वह", "कैसे", "मेरा", "मुझे"}


def script_language(text: str, prefer=()):
    """Language that the writing system proves, or None.

    Unlike guess_language this never guesses from words. Where one script
    serves two languages here (Han: Chinese/Japanese, Devanagari:
    Hindi/Nepali, Cyrillic: Russian/Ukrainian) a language from `prefer`
    (the two languages in the conversation) settles it; failing that,
    letters or words only one of them uses; otherwise None, and the caller
    keeps the language the speaker chose.
    """
    text = text or ""
    if re.search(r"[\u3040-\u30ff]", text):
        return "ja"
    if re.search(r"[\uac00-\ud7af]", text):
        return "ko"
    if re.search(r"[\u4e00-\u9fff]", text):
        return "ja" if "ja" in prefer and "zh" not in prefer else "zh"
    if re.search(r"[\u0600-\u06ff]", text):
        return "ar"
    if re.search(r"[\u0980-\u09ff]", text):
        return "bn"
    if re.search(r"[\u0900-\u097f]", text):
        return _pick(text, prefer, ("hi", "ne"), _hindi_or_nepali)
    if re.search(r"[\u0400-\u04ff]", text):
        return _pick(text, prefer, ("ru", "uk"), _russian_or_ukrainian)
    return None


def _pick(text, prefer, pair, decide):
    """Choose between two languages sharing a script."""
    found = decide(text)
    if found:
        return found
    in_play = [code for code in pair if code in prefer]
    return in_play[0] if len(in_play) == 1 else None


def _hindi_or_nepali(text):
    words = set(re.findall(r"[\u0900-\u097f]+", text))
    if words & _NEPALI_HINTS and not words & _HINDI_ONLY_HINTS:
        return "ne"
    if words & _HINDI_ONLY_HINTS and not words & _NEPALI_HINTS:
        return "hi"
    return None


_UKRAINIAN_HINTS = {"як", "справи", "дякую", "будь", "ласка", "добре", "що", "це", "так", "ні", "мене", "звати"}
_RUSSIAN_HINTS = {"как", "дела", "спасибо", "пожалуйста", "хорошо", "что", "это", "да", "нет", "меня", "зовут"}


def _russian_or_ukrainian(text):
    if re.search(r"[ієїґІЄЇҐ]", text):
        return "uk"
    if _RUSSIAN_ONLY.search(text):
        return "ru"
    words = set(re.findall(r"[\u0400-\u04ff]+", text.lower()))
    uk, ru = len(words & _UKRAINIAN_HINTS), len(words & _RUSSIAN_HINTS)
    if uk != ru:
        return "uk" if uk > ru else "ru"
    return None
