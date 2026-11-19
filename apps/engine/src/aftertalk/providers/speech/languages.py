"""Turn the language a provider reports ("polish", "pl", "pt-BR") into a two-letter code, or None."""

import re

# Whisper reports English names; gpt-transcribe reports codes. Only common languages are listed: an unknown
# name becomes None, which means "not known", never a wrong code.
_NAMES: dict[str, str] = {
    "arabic": "ar",
    "bulgarian": "bg",
    "catalan": "ca",
    "chinese": "zh",
    "croatian": "hr",
    "czech": "cs",
    "danish": "da",
    "dutch": "nl",
    "english": "en",
    "estonian": "et",
    "finnish": "fi",
    "french": "fr",
    "german": "de",
    "greek": "el",
    "hebrew": "he",
    "hindi": "hi",
    "hungarian": "hu",
    "indonesian": "id",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "latvian": "lv",
    "lithuanian": "lt",
    "norwegian": "no",
    "persian": "fa",
    "polish": "pl",
    "portuguese": "pt",
    "romanian": "ro",
    "russian": "ru",
    "serbian": "sr",
    "slovak": "sk",
    "slovenian": "sl",
    "spanish": "es",
    "swedish": "sv",
    "thai": "th",
    "turkish": "tr",
    "ukrainian": "uk",
    "vietnamese": "vi",
}
# ISO 639-2/3 codes for the same languages.
_THREE_LETTER: dict[str, str] = {
    "ara": "ar",
    "bul": "bg",
    "cat": "ca",
    "ces": "cs",
    "zho": "zh",
    "cmn": "zh",
    "hrv": "hr",
    "dan": "da",
    "nld": "nl",
    "eng": "en",
    "est": "et",
    "fin": "fi",
    "fra": "fr",
    "deu": "de",
    "ell": "el",
    "heb": "he",
    "hin": "hi",
    "hun": "hu",
    "ind": "id",
    "ita": "it",
    "jpn": "ja",
    "kor": "ko",
    "lav": "lv",
    "lit": "lt",
    "nor": "no",
    "fas": "fa",
    "pol": "pl",
    "por": "pt",
    "ron": "ro",
    "rus": "ru",
    "srp": "sr",
    "slk": "sk",
    "slv": "sl",
    "spa": "es",
    "swe": "sv",
    "tha": "th",
    "tur": "tr",
    "ukr": "uk",
    "vie": "vi",
}
_REGION = re.compile(r"^([a-z]{2})[-_][a-z0-9]{2,8}$")


def normalize_language(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if re.fullmatch(r"[a-z]{2}", text):
        return text
    if (match := _REGION.match(text)) is not None:
        return match.group(1)
    return _NAMES.get(text) or _THREE_LETTER.get(text)
