"""Language table shared by the speech, translation and voice modules.

Each entry keeps the codes every backend expects, so the rest of the
code only ever deals with the short ISO 639-1 code.
"""

# iso: (display name, NLLB-200 code, browser/BCP-47 locale)
LANGUAGES = {
    "en": ("English", "eng_Latn", "en-US"),
    "es": ("Spanish", "spa_Latn", "es-ES"),
    "fr": ("French", "fra_Latn", "fr-FR"),
    "de": ("German", "deu_Latn", "de-DE"),
    "it": ("Italian", "ita_Latn", "it-IT"),
    "pt": ("Portuguese", "por_Latn", "pt-PT"),
    "nl": ("Dutch", "nld_Latn", "nl-NL"),
    "ru": ("Russian", "rus_Cyrl", "ru-RU"),
    "uk": ("Ukrainian", "ukr_Cyrl", "uk-UA"),
    "pl": ("Polish", "pol_Latn", "pl-PL"),
    "tr": ("Turkish", "tur_Latn", "tr-TR"),
    "ar": ("Arabic", "arb_Arab", "ar-SA"),
    "hi": ("Hindi", "hin_Deva", "hi-IN"),
    "ne": ("Nepali", "npi_Deva", "ne-NP"),
    "bn": ("Bengali", "ben_Beng", "bn-IN"),
    "zh": ("Chinese", "zho_Hans", "zh-CN"),
    "ja": ("Japanese", "jpn_Jpan", "ja-JP"),
    "ko": ("Korean", "kor_Hang", "ko-KR"),
    "vi": ("Vietnamese", "vie_Latn", "vi-VN"),
    "id": ("Indonesian", "ind_Latn", "id-ID"),
}


def is_supported(code: str) -> bool:
    return code in LANGUAGES


def name_of(code: str) -> str:
    return LANGUAGES.get(code, (code,))[0]


def nllb_code(code: str) -> str:
    return LANGUAGES[code][1]


def as_list():
    return [
        {"code": code, "name": name, "locale": locale}
        for code, (name, _nllb, locale) in LANGUAGES.items()
    ]
