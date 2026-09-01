"""Background image generation for tasks, independent of any open dashboard.

The card can auto-generate an image when a task is created, but only while a
browser has it open — a task added by voice, a service call or a recurrence
at 3am gets nothing. This queue closes that gap: it walks the lists that
asked for it, remembers which tasks still need a picture, and works through
them one at a time.

Three properties matter and shape the design:

* **One request at a time, paced.** Image models are slow and cost money, and
  several providers rate-limit. A single worker holds the queue, and after
  every provider call it sits out a randomised cooldown (default 20-35
  minutes). Reusing an image that already exists locally costs nothing and
  therefore does *not* consume the cooldown.
* **It survives restarts.** Queue, cooldown and configuration live in HA
  storage, so a restart neither forgets the backlog nor lets a pending
  cooldown lapse — otherwise restarting would be a way to bypass the pacing.
* **It does not fight the user.** A task whose image was removed goes back
  into the queue (it is open and has no image, so the next scan finds it),
  but behind the cooldown that is already ticking.
"""

from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_point_in_time
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = f"{DOMAIN}_image_queue"
STORAGE_VERSION = 1

DATA_IMAGE_QUEUE = f"{DOMAIN}_image_queue"

# Waiting this long after startup lets external todo entities from other
# integrations finish loading before their tasks are read (the due-date
# checker uses the same delay for the same reason).
STARTUP_DELAY = 150
# A scan is cheap for native lists but reads every linked list from its
# provider, so it runs on the same order as the cooldown, not continuously.
SCAN_INTERVAL = timedelta(minutes=15)

DEFAULT_MIN_MINUTES = 20
DEFAULT_MAX_MINUTES = 35
# Nothing to do: look again on the scan interval rather than never.
IDLE_RETRY = timedelta(minutes=15)


def _now() -> datetime:
    return dt_util.utcnow()


class ImageQueue:
    """Queue and worker for background image generation."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise (call async_load before use)."""
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict = {"config": {}, "queue": [], "cooldown_until": None}
        self._unsub = None
        self._running = False
        self._last_scan: datetime | None = None

    # -- persistence ---------------------------------------------------------

    async def async_load(self) -> None:
        """Load queue, cooldown and config from disk."""
        data = await self._store.async_load()
        if data:
            self._data = {
                "config": data.get("config") or {},
                "queue": list(data.get("queue") or []),
                "cooldown_until": data.get("cooldown_until"),
            }

    async def _async_save(self) -> None:
        await self._store.async_save(self._data)

    # -- configuration -------------------------------------------------------

    @property
    def config(self) -> dict:
        """Effective configuration, defaults filled in."""
        c = self._data.get("config") or {}
        return {
            "enabled": c.get("enabled", False) is True,
            "ai_task_entity_id": c.get("ai_task_entity_id") or None,
            "prompt_prefix": c.get("prompt_prefix") or "",
            "min_minutes": int(c.get("min_minutes") or DEFAULT_MIN_MINUTES),
            "max_minutes": int(c.get("max_minutes") or DEFAULT_MAX_MINUTES),
        }

    async def async_configure(self, **changes) -> dict:
        """Update the configuration. Omitted keys keep their value."""
        cfg = self.config
        for key in ("enabled", "ai_task_entity_id", "prompt_prefix", "min_minutes", "max_minutes"):
            if key in changes and changes[key] is not None:
                cfg[key] = changes[key]
        if cfg["min_minutes"] < 1 or cfg["max_minutes"] < 1:
            raise ValueError("Cooldown minutes must be at least 1")
        if cfg["max_minutes"] < cfg["min_minutes"]:
            raise ValueError("max_minutes must not be smaller than min_minutes")
        self._data["config"] = cfg
        await self._async_save()
        # Turning it on should not wait for the next tick to notice.
        self._schedule(timedelta(seconds=5) if cfg["enabled"] else None)
        return cfg

    # -- queue ---------------------------------------------------------------

    @property
    def queue(self) -> list[dict]:
        """The pending entries, oldest first."""
        return list(self._data.get("queue") or [])

    @property
    def cooldown_until(self) -> datetime | None:
        """When the next provider call may happen, or None."""
        raw = self._data.get("cooldown_until")
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw)
        except (TypeError, ValueError):
            return None

    def _key(self, entry: dict) -> tuple:
        return (entry.get("list_id"), entry.get("entity_id"), entry.get("task_id"))

    async def async_enqueue(self, entries: list[dict]) -> int:
        """Add entries that are not queued yet. Returns how many were added."""
        known = {self._key(e) for e in self.queue}
        added: list[dict] = []
        for entry in entries:
            key = self._key(entry)
            if key in known:
                continue
            known.add(key)  # also dedups within this batch
            added.append(entry)
        if not added:
            return 0
        self._data["queue"] = self.queue + added
        await self._async_save()
        return len(added)

    async def _async_pop(self) -> dict | None:
        q = self.queue
        if not q:
            return None
        entry = q.pop(0)
        self._data["queue"] = q
        await self._async_save()
        return entry

    async def _async_set_cooldown(self) -> datetime:
        cfg = self.config
        minutes = random.randint(cfg["min_minutes"], cfg["max_minutes"])  # noqa: S311
        until = _now() + timedelta(minutes=minutes)
        self._data["cooldown_until"] = until.isoformat()
        await self._async_save()
        _LOGGER.debug("Image queue cooling down for %s minutes", minutes)
        return until

    # -- scanning ------------------------------------------------------------

    async def async_scan(self) -> int:
        """Find open tasks without an image in lists that opted in."""
        from .websocket_api import _async_get_external_tasks  # circular at import time

        entries: list[dict] = []
        for entry_id, store in list(self.hass.data.get(DOMAIN, {}).items()):
            if not hasattr(store, "get_settings"):
                continue
            try:
                if not store.get_settings()["auto_generate_images"]:
                    continue
            except Exception:  # noqa: BLE001
                continue

            if hasattr(store, "tasks"):  # native list
                for task in store.tasks:
                    if not task.get("completed") and not task.get("image_url") and task.get("title"):
                        entries.append({
                            "list_id": entry_id,
                            "task_id": task["id"],
                            "title": task["title"],
                        })
                continue

            entity_id = getattr(store, "entity_id", None)
            if not entity_id:
                continue
            try:
                tasks, _ = await _async_get_external_tasks(self.hass, entity_id)
            except Exception as err:  # noqa: BLE001 - one dead provider must not stop the scan
                _LOGGER.debug("Image queue skipped %s: %s", entity_id, err)
                continue
            for task in tasks:
                if not task.get("completed") and not task.get("image_url") and task.get("title"):
                    entries.append({
                        "entity_id": entity_id,
                        "task_id": task["id"],
                        "title": task["title"],
                    })

        self._last_scan = _now()
        added = await self.async_enqueue(entries)
        if added:
            _LOGGER.debug("Image queue picked up %s task(s)", added)
        return added

    # -- worker --------------------------------------------------------------

    def _schedule(self, delay: timedelta | None) -> None:
        """(Re)arm the worker. None cancels it."""
        if self._unsub:
            self._unsub()
            self._unsub = None
        if delay is None:
            return

        @callback
        def _fire(_now_dt) -> None:
            self._unsub = None
            self.hass.async_create_task(self.async_tick())

        self._unsub = async_track_point_in_time(self.hass, _fire, dt_util.utcnow() + delay)

    async def async_tick(self) -> None:
        """One pass: scan if due, then generate a single image if allowed."""
        if self._running:
            return
        self._running = True
        try:
            cfg = self.config
            if not cfg["enabled"]:
                self._schedule(None)
                return

            cooldown = self.cooldown_until
            if cooldown and cooldown > _now():
                # Still pacing: come back exactly when it lapses. A restart
                # lands here too, which is the point of persisting it.
                self._schedule(cooldown - _now())
                return

            if self._last_scan is None or _now() - self._last_scan >= SCAN_INTERVAL:
                await self.async_scan()

            entry = await self._async_pop()
            if entry is None:
                self._schedule(IDLE_RETRY)
                return

            reused = await self._async_generate(entry, cfg)
            # A local reuse costs the provider nothing, so it must not eat the
            # cooldown - otherwise a list of duplicates would trickle through
            # at one task per half hour for no reason.
            if reused is None or reused is False:
                until = await self._async_set_cooldown()
                self._schedule(until - _now())
            else:
                self._schedule(timedelta(seconds=2))
        finally:
            self._running = False

    async def _async_generate(self, entry: dict, cfg: dict) -> bool | None:
        """Generate one image. True = reused, False = provider call, None = failed."""
        from .websocket_api import async_generate_task_image

        try:
            result = await async_generate_task_image(
                self.hass,
                None,  # no websocket client here
                task_id=entry["task_id"],
                entry_id=entry.get("list_id"),
                todo_entity_id=entry.get("entity_id"),
                prompt_prefix=cfg["prompt_prefix"],
                ai_entity_id=cfg["ai_task_entity_id"],
            )
        except Exception as err:  # noqa: BLE001
            # A failed call still consumed provider quota (or hit a broken
            # setup); pace it the same way and let the next scan requeue the
            # task if it still needs a picture.
            _LOGGER.warning(
                "Background image generation failed for %s: %s", entry.get("title"), err
            )
            return None
        return bool(result.get("reused"))


@callback
def async_register_image_queue(hass: HomeAssistant) -> None:
    """Create the queue and start it once, globally."""
    if hass.data.get(DATA_IMAGE_QUEUE):
        return
    queue = ImageQueue(hass)
    hass.data[DATA_IMAGE_QUEUE] = queue

    async def _start() -> None:
        await queue.async_load()
        await queue.async_tick()

    @callback
    def _delayed_start(_now_dt) -> None:
        hass.async_create_task(_start())

    async_call_later(hass, STARTUP_DELAY, _delayed_start)


def async_get_image_queue(hass: HomeAssistant) -> ImageQueue | None:
    """Return the queue instance, if it has been registered."""
    return hass.data.get(DATA_IMAGE_QUEUE)
