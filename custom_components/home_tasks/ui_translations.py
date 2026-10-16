"""Shared translations for the distributed card and backend calendar."""
from functools import lru_cache
import json
from pathlib import Path


@lru_cache(maxsize=1)
def load_ui_translations() -> dict[str, dict[str, str]]:
    """Load once, in an executor during integration setup."""
    return json.loads(Path(__file__).with_name("ui_translations.json").read_text(encoding="utf-8"))


def get_ui_translation(language: str | None) -> dict[str, str]:
    """Resolve regional locales and Norwegian aliases, then fall back to English."""
    translations = load_ui_translations()
    language = (language or "en").replace("_", "-").casefold()
    locales = {key.casefold(): value for key, value in translations.items()}
    base = language.split("-")[0]
    if base in {"nb", "nn"}:
        base = "no"
    return locales.get(language, locales.get(base, translations["en"]))
