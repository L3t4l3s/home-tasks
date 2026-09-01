"""A picture outlives the task it was made for.

Same-title reuse only ever looked at tasks that exist *right now*: tick off
"take out the bins", let the recurrence delete and recreate it, and the next
generation pays for the same picture again. This library remembers the
mapping from a task title to the picture it got, independently of any task,
so a title that came up before is answered from disk instead of the provider.

Two things make that safe rather than surprising:

* **Matching is conservative and local.** An exact match on the normalised
  title first; only then a near match, and only when the two titles differ in
  a single word, that word is not a number, and both the word overlap and the
  character similarity are high. No model is asked, nothing is guessed —
  "book a blood draw" finds "book a blood test", "milk 1l" does not find
  "milk 2l".
* **It is the shared pool, so it follows the same switch.** A list with
  `share_images` off neither reads from the library nor writes to it: three
  children with the same chore keep their own pictures, which is exactly what
  that switch is for.

The library is capped and evicts least-recently-used entries, deleting the
files they point at unless a task still uses them.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = f"{DOMAIN}_image_library"
STORAGE_VERSION = 1

DATA_IMAGE_LIBRARY = f"{DOMAIN}_image_library"

# Roughly 2000 pictures at a few hundred kB is a manageable folder; beyond
# that the oldest unused ones go.
MAX_ENTRIES = 2000

# A near match needs to clear all of these. They are deliberately strict:
# a wrong picture is worse than a missing one, and the provider call it saves
# costs cents.
MIN_SIMILARITY = 0.72   # character-level, over the whole normalised title
MIN_TOKEN_OVERLAP = 0.6  # shared words / all words
MIN_TOKENS = 2           # single-word titles are matched exactly or not at all
MAX_DIFFERING_TOKENS = 1

_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACE = re.compile(r"\s+")


def normalize_title(title: str) -> str:
    """Lower-case, strip punctuation, collapse whitespace."""
    if not title:
        return ""
    return _SPACE.sub(" ", _PUNCT.sub(" ", title.lower())).strip()


def _tokens(normalized: str) -> list[str]:
    return [t for t in normalized.split(" ") if t]


def _same_word(a: str, b: str) -> bool:
    """Whether two words are the same word for our purposes.

    Singular and plural, or a spelling variant, should not cost a second
    picture: "plant"/"plants", "aufraumen"/"aufraeumen". Anything shorter
    than four characters is compared strictly — "mia" and "mum" are not the
    same person, and "1l" is not "2l".
    """
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    if a.startswith(b) or b.startswith(a):
        return True
    return SequenceMatcher(None, a, b).ratio() >= 0.85


def is_near_match(a: str, b: str) -> bool:
    """Whether two normalised titles mean the same task, conservatively.

    Same words but for one, that one not a number, and the strings still
    similar as strings — which keeps "buy 2 apples" apart from "buy 3
    apples" and "call mum" apart from "call mia".
    """
    if not a or not b or a == b:
        return a == b and bool(a)
    ta, tb = _tokens(a), _tokens(b)
    if len(ta) < MIN_TOKENS or len(tb) < MIN_TOKENS:
        return False
    if abs(len(ta) - len(tb)) > MAX_DIFFERING_TOKENS:
        return False

    # Pair the words up first, so a plural does not read as a different word.
    unmatched_b = list(tb)
    shared = 0
    only_a: list[str] = []
    for word in ta:
        hit = next((w for w in unmatched_b if _same_word(word, w)), None)
        if hit is None:
            only_a.append(word)
        else:
            unmatched_b.remove(hit)
            shared += 1
    only_b = unmatched_b

    if len(only_a) > MAX_DIFFERING_TOKENS or len(only_b) > MAX_DIFFERING_TOKENS:
        return False
    # A quantity is never noise: "milk 1l" and "milk 2l" are different things.
    if any(any(c.isdigit() for c in t) for t in only_a + only_b):
        return False

    overlap = shared / (shared + len(only_a) + len(only_b))
    if overlap < MIN_TOKEN_OVERLAP:
        return False
    return SequenceMatcher(None, a, b).ratio() >= MIN_SIMILARITY


class ImageLibrary:
    """Title-to-picture memory that outlives the tasks."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise (call async_load before use)."""
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        # url -> {"aliases": [normalised titles], "last_used": iso}
        self._data: dict = {"entries": {}}

    # -- persistence ---------------------------------------------------------

    async def async_load(self) -> None:
        """Read the library from disk."""
        data = await self._store.async_load()
        if data and isinstance(data.get("entries"), dict):
            self._data = {"entries": data["entries"]}

    async def _async_save(self) -> None:
        await self._store.async_save(self._data)

    @property
    def entries(self) -> dict:
        """url -> entry, for tests and diagnostics."""
        return dict(self._data.get("entries") or {})

    # -- lookup --------------------------------------------------------------

    def find(self, title: str) -> str | None:
        """The picture a title had before, or one from a near-identical title."""
        key = normalize_title(title)
        if not key:
            return None
        entries = self._data.get("entries") or {}
        for url, entry in entries.items():
            if key in (entry.get("aliases") or []):
                return url
        for url, entry in entries.items():
            for alias in entry.get("aliases") or []:
                if is_near_match(key, alias):
                    _LOGGER.debug("Image library: '%s' matched '%s'", key, alias)
                    return url
        return None

    async def async_touch(self, url: str) -> None:
        """Mark an entry as used just now, so eviction takes it last."""
        entry = (self._data.get("entries") or {}).get(url)
        if entry is None:
            return
        entry["last_used"] = datetime.now(timezone.utc).isoformat()
        await self._async_save()

    # -- writing -------------------------------------------------------------

    async def async_remember(self, title: str, url: str) -> None:
        """Record that *title* is illustrated by *url*."""
        key = normalize_title(title)
        if not key or not url:
            return
        entries = self._data.setdefault("entries", {})
        entry = entries.setdefault(url, {"aliases": [], "last_used": None})
        if key not in entry["aliases"]:
            entry["aliases"].append(key)
        entry["last_used"] = datetime.now(timezone.utc).isoformat()
        await self._async_save()
        await self._async_evict()

    async def async_forget(self, url: str, *, delete_file: bool = True) -> None:
        """Drop a picture from the library.

        Used when someone removes an image from a task: they rejected it, so
        it must not come back on the next generation. Every alias goes with
        it, and the file too unless a task still points at it.
        """
        entries = self._data.get("entries") or {}
        if url not in entries:
            return
        del entries[url]
        await self._async_save()
        if delete_file:
            from .websocket_api import _cleanup_orphan_image

            await _cleanup_orphan_image(self.hass, url, None)

    async def _async_evict(self) -> None:
        """Keep the library at its cap, oldest use first."""
        entries = self._data.get("entries") or {}
        if len(entries) <= MAX_ENTRIES:
            return
        ordered = sorted(entries.items(), key=lambda kv: kv[1].get("last_used") or "")
        for url, _entry in ordered[: len(entries) - MAX_ENTRIES]:
            _LOGGER.debug("Image library full, evicting %s", url)
            await self.async_forget(url)


@callback
def async_register_image_library(hass: HomeAssistant) -> None:
    """Create the library once, globally."""
    if hass.data.get(DATA_IMAGE_LIBRARY):
        return
    hass.data[DATA_IMAGE_LIBRARY] = ImageLibrary(hass)


def async_get_image_library(hass: HomeAssistant) -> ImageLibrary | None:
    """Return the library instance, if it has been registered."""
    return hass.data.get(DATA_IMAGE_LIBRARY)
