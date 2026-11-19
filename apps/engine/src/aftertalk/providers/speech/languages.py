"""Turn the language a provider reports ("polish", "pl", "pt-BR", "cym") into a code from the Whisper table, or None.

The table is Whisper's language list (the one OpenAI-compatible servers report names from). A value that is not in it
maps to None, never to a guess.
"""

import re

# code, English name as Whisper reports it, ISO 639-2/3 code
_TABLE: tuple[tuple[str, str, str], ...] = (
    ("en", "english", "eng"),
    ("zh", "chinese", "zho"),
    ("de", "german", "deu"),
    ("es", "spanish", "spa"),
    ("ru", "russian", "rus"),
    ("ko", "korean", "kor"),
    ("fr", "french", "fra"),
    ("ja", "japanese", "jpn"),
    ("pt", "portuguese", "por"),
    ("tr", "turkish", "tur"),
    ("pl", "polish", "pol"),
    ("ca", "catalan", "cat"),
    ("nl", "dutch", "nld"),
    ("ar", "arabic", "ara"),
    ("sv", "swedish", "swe"),
    ("it", "italian", "ita"),
    ("id", "indonesian", "ind"),
    ("hi", "hindi", "hin"),
    ("fi", "finnish", "fin"),
    ("vi", "vietnamese", "vie"),
    ("he", "hebrew", "heb"),
    ("uk", "ukrainian", "ukr"),
    ("el", "greek", "ell"),
    ("ms", "malay", "msa"),
    ("cs", "czech", "ces"),
    ("ro", "romanian", "ron"),
    ("da", "danish", "dan"),
    ("hu", "hungarian", "hun"),
    ("ta", "tamil", "tam"),
    ("no", "norwegian", "nor"),
    ("th", "thai", "tha"),
    ("ur", "urdu", "urd"),
    ("hr", "croatian", "hrv"),
    ("bg", "bulgarian", "bul"),
    ("lt", "lithuanian", "lit"),
    ("la", "latin", "lat"),
    ("mi", "maori", "mri"),
    ("ml", "malayalam", "mal"),
    ("cy", "welsh", "cym"),
    ("sk", "slovak", "slk"),
    ("te", "telugu", "tel"),
    ("fa", "persian", "fas"),
    ("lv", "latvian", "lav"),
    ("bn", "bengali", "ben"),
    ("sr", "serbian", "srp"),
    ("az", "azerbaijani", "aze"),
    ("sl", "slovenian", "slv"),
    ("kn", "kannada", "kan"),
    ("et", "estonian", "est"),
    ("mk", "macedonian", "mkd"),
    ("br", "breton", "bre"),
    ("eu", "basque", "eus"),
    ("is", "icelandic", "isl"),
    ("hy", "armenian", "hye"),
    ("ne", "nepali", "nep"),
    ("mn", "mongolian", "mon"),
    ("bs", "bosnian", "bos"),
    ("kk", "kazakh", "kaz"),
    ("sq", "albanian", "sqi"),
    ("sw", "swahili", "swa"),
    ("gl", "galician", "glg"),
    ("mr", "marathi", "mar"),
    ("pa", "punjabi", "pan"),
    ("si", "sinhala", "sin"),
    ("km", "khmer", "khm"),
    ("sn", "shona", "sna"),
    ("yo", "yoruba", "yor"),
    ("so", "somali", "som"),
    ("af", "afrikaans", "afr"),
    ("oc", "occitan", "oci"),
    ("ka", "georgian", "kat"),
    ("be", "belarusian", "bel"),
    ("tg", "tajik", "tgk"),
    ("sd", "sindhi", "snd"),
    ("gu", "gujarati", "guj"),
    ("am", "amharic", "amh"),
    ("yi", "yiddish", "yid"),
    ("lo", "lao", "lao"),
    ("uz", "uzbek", "uzb"),
    ("fo", "faroese", "fao"),
    ("ht", "haitian creole", "hat"),
    ("ps", "pashto", "pus"),
    ("tk", "turkmen", "tuk"),
    ("nn", "nynorsk", "nno"),
    ("mt", "maltese", "mlt"),
    ("sa", "sanskrit", "san"),
    ("lb", "luxembourgish", "ltz"),
    ("my", "myanmar", "mya"),
    ("bo", "tibetan", "bod"),
    ("tl", "tagalog", "tgl"),
    ("mg", "malagasy", "mlg"),
    ("as", "assamese", "asm"),
    ("tt", "tatar", "tat"),
    ("haw", "hawaiian", "haw"),
    ("ln", "lingala", "lin"),
    ("ha", "hausa", "hau"),
    ("ba", "bashkir", "bak"),
    ("jv", "javanese", "jav"),
    ("su", "sundanese", "sun"),
    ("yue", "cantonese", "yue"),
)

CODES: frozenset[str] = frozenset(code for code, _, _ in _TABLE)

_ALIASES: dict[str, str] = {
    # other names for the same language
    "mandarin": "zh",
    "mandarin chinese": "zh",
    "cmn": "zh",
    "castilian": "es",
    "valencian": "ca",
    "flemish": "nl",
    "haitian": "ht",
    "letzeburgesch": "lb",
    "pushto": "ps",
    "panjabi": "pa",
    "moldavian": "ro",
    "moldovan": "ro",
    "sinhalese": "si",
    "burmese": "my",
    "farsi": "fa",
    "norwegian bokmal": "no",
    "norwegian bokmål": "no",
    "bokmal": "no",
    "bokmål": "no",
    "nb": "no",
    "filipino": "tl",
    "fil": "tl",
    # old and alternative codes
    "iw": "he",
    "in": "id",
    "ji": "yi",
    "jw": "jv",
    "mo": "ro",
    "zho": "zh",
    "chi": "zh",
    "fre": "fr",
    "ger": "de",
    "dut": "nl",
    "gre": "el",
    "cze": "cs",
    "slo": "sk",
    "rum": "ro",
    "wel": "cy",
    "baq": "eu",
    "arm": "hy",
    "geo": "ka",
    "ice": "is",
    "mac": "mk",
    "mao": "mi",
    "may": "ms",
    "per": "fa",
    "alb": "sq",
    "bur": "my",
    "tib": "bo",
}

_LOOKUP: dict[str, str] = {}
for _code, _name, _iso3 in _TABLE:
    _LOOKUP[_code] = _code
    _LOOKUP[_name] = _code
    _LOOKUP[_iso3] = _code
for _alias, _target in _ALIASES.items():
    if _target in CODES:
        _LOOKUP.setdefault(_alias, _target)

_SUBTAG = re.compile(r"^[a-z]{2,3}(-[a-z0-9]{2,8})*$")


def normalize_language(value: object) -> str | None:
    """ "polish", "pl", "pl-PL", "zh-Hans-CN", "cym" -> a code from the table; anything else -> None."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.strip().lower().replace("_", "-").split())
    if text in _LOOKUP:
        return _LOOKUP[text]
    if _SUBTAG.match(text):  # BCP-47: the language subtag decides, region and script are dropped
        return _LOOKUP.get(text.split("-", 1)[0])
    return None
