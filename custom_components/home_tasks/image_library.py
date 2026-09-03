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

# How much a word may grow or shrink and still count as the same word:
# "bin"/"bins", "plant"/"plants". Anything else is a different word.
MIN_WORD_LENGTH = 3
MAX_SUFFIX_DIFFERENCE = 2

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
    """Whether two words are the same word, allowing an inflected ending.

    Only a short suffix may differ, and only on top of the whole other word:
    "bin"/"bins", "plant"/"plants". Not a similarity score — "saugen" and
    "sagen" are 0.91 similar and mean entirely different things, which is
    exactly the kind of match that puts the wrong picture on a task.
    """
    if a == b:
        return True
    short, long = sorted((a, b), key=len)
    if len(short) < MIN_WORD_LENGTH:
        return False  # "1l" is not "2l", "mia" is not "ben"
    if len(long) - len(short) > MAX_SUFFIX_DIFFERENCE:
        return False
    return long.startswith(short)


def is_near_match(a: str, b: str) -> bool:
    """Whether two normalised titles are the same title.

    Every word has to be there, in whatever order, and a word only counts as
    present if it is the same word — an inflected ending is allowed, a
    different word is not. That last part is the whole rule:

        "Bens Zimmer aufraeumen" and "Bens Zimmer saugen" are two chores.
        "Kevins Wand streichen" and "Kevins Decke streichen" are two jobs.
        "Zimmer aufraeumen Mia" and "Zimmer aufraeumen Ben" are two children.

    Nothing about the sentence tells us which word carries the meaning, so
    none of them may differ. What is left is tolerance for plurals and
    inflection, which is what makes a recreated task find its own picture
    back rather than a stranger's.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    ta, tb = _tokens(a), _tokens(b)
    if len(ta) != len(tb):
        return False

    unmatched = list(tb)
    for word in ta:
        hit = next((w for w in unmatched if _same_word(word, w)), None)
        if hit is None:
            return False
        unmatched.remove(hit)
    return True


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


    async def async_backfill(self) -> int:
        """Learn the pictures that were already on tasks when we arrived.

        Without this the library only knows what it saw generated, so every
        picture made before it existed is invisible and gets paid for again
        the next time that title comes up. Only lists that take part in the
        shared pool contribute, same as everywhere else.
        """
        from .websocket_api import _async_get_external_tasks, _is_real_image

        learned = 0
        for store in list(self.hass.data.get(DOMAIN, {}).values()):
            if not hasattr(store, "get_settings"):
                continue
            try:
                if not store.get_settings()["share_images"]:
                    continue
            except Exception:  # noqa: BLE001
                continue
            if hasattr(store, "tasks"):
                tasks = list(store.tasks)
            else:
                # A linked list: its pictures live in the overlay, and the
                # titles with the provider - the merged view has both. One
                # provider being down must not stop the others from being
                # learned.
                entity_id = getattr(store, "entity_id", None)
                if not entity_id:
                    continue
                try:
                    tasks, _overlay = await _async_get_external_tasks(self.hass, entity_id)
                except Exception as err:  # noqa: BLE001
                    _LOGGER.debug("Image library backfill skipped %s: %s", entity_id, err)
                    continue
            for task in tasks:
                title, url = task.get("title"), task.get("image_url")
                if not title or not _is_real_image(url):
                    continue
                if self.find(title) is None:
                    await self.async_remember(title, url)
                    learned += 1
        if learned:
            _LOGGER.debug("Image library learned %s existing picture(s)", learned)
        return learned


@callback
def async_register_image_library(hass: HomeAssistant) -> None:
    """Create the library once, globally."""
    if hass.data.get(DATA_IMAGE_LIBRARY):
        return
    hass.data[DATA_IMAGE_LIBRARY] = ImageLibrary(hass)


def async_get_image_library(hass: HomeAssistant) -> ImageLibrary | None:
    """Return the library instance, if it has been registered."""
    return hass.data.get(DATA_IMAGE_LIBRARY)
