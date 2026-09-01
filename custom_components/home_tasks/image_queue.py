"""Background image generation for tasks, independent of any open dashboard.

`auto_generate_image` on a column generates a picture the moment a task is
created — but only while a browser has that card open. A task added by voice,
by a service call or by a recurrence at 3am gets nothing. This queue closes
that gap: the same switch also tells the integration to generate for that
list on its own.

Deliberately unpaced: turning the option on means you want pictures on your
lists in the next few minutes, not one every half hour. What keeps this from
running away is that there are **no retries** — a task is attempted once, and
a failure is recorded as such (the task gets a "generation failed" placeholder
so it is visible, and is not tried again). Switching the option off and on
clears those marks and gives them another go, and the button in the task
details always works regardless.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

STORAGE_KEY = f"{DOMAIN}_image_queue"
STORAGE_VERSION = 1

DATA_IMAGE_QUEUE = f"{DOMAIN}_image_queue"

# Shown on a task whose generation failed, so the failure is visible on the
# card instead of the task just staying blank forever.
FAILED_IMAGE_URL = f"/{DOMAIN}/generation_failed.svg"
# Shown while a task waits in the queue, so a list that is filling up looks
# like it is working rather than like nothing is happening.
PENDING_IMAGE_URL = f"/{DOMAIN}/generating.svg"
# Neither is a real picture: they must never be reused for another task, and
# a task wearing one still counts as needing an image.
PLACEHOLDER_IMAGE_URLS = (FAILED_IMAGE_URL, PENDING_IMAGE_URL)

# Waiting this long after startup lets external todo entities from other
# integrations finish loading before their tasks are read.
STARTUP_DELAY = 150
# Safety net only: new tasks are picked up from the task_created event, so
# this catches what happened while HA was down or an event was missed.
SCAN_INTERVAL = timedelta(minutes=5)
# Generous ceiling per pass so a mistake cannot spin forever; whatever is
# left over is taken by the next scan.
MAX_PER_PASS = 50


class ImageQueue:
    """Queue and worker for background image generation."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise (call async_load before use)."""
        self.hass = hass
        self._store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._data: dict = {"config": {}, "queue": [], "failed": []}
        self._running = False
        self._unsub_scan = None

    # -- persistence ---------------------------------------------------------

    async def async_load(self) -> None:
        """Load queue, failure marks and config from disk."""
        data = await self._store.async_load()
        if data:
            self._data = {
                "config": data.get("config") or {},
                "queue": list(data.get("queue") or []),
                "failed": [tuple(k) for k in (data.get("failed") or [])],
            }

    async def _async_save(self) -> None:
        await self._store.async_save({
            "config": self._data["config"],
            "queue": self._data["queue"],
            "failed": [list(k) for k in self._data["failed"]],
        })

    # -- configuration -------------------------------------------------------

    @property
    def config(self) -> dict:
        """Which AI entity to use, and the prompt prefix.

        Both mirror the card's `image_generation` block: the queue has no
        dashboard to read, so the card hands them over whenever it loads a
        configuration that asks for automatic images.
        """
        c = self._data.get("config") or {}
        return {
            "ai_task_entity_id": c.get("ai_task_entity_id") or None,
            "prompt_prefix": c.get("prompt_prefix") or "",
        }

    async def async_sync_config(
        self, ai_task_entity_id: str | None = None, prompt_prefix: str | None = None
    ) -> dict:
        """Adopt the card's image-generation settings."""
        cfg = self.config
        if ai_task_entity_id is not None:
            cfg["ai_task_entity_id"] = ai_task_entity_id or None
        if prompt_prefix is not None:
            cfg["prompt_prefix"] = prompt_prefix
        if cfg != self.config:
            self._data["config"] = cfg
            await self._async_save()
        return cfg

    # -- queue ---------------------------------------------------------------

    @staticmethod
    def _key(entry: dict) -> tuple:
        return (entry.get("list_id"), entry.get("entity_id"), entry.get("task_id"))

    @property
    def queue(self) -> list[dict]:
        """The pending entries, oldest first."""
        return list(self._data.get("queue") or [])

    @property
    def failed(self) -> list[tuple]:
        """Keys that were attempted once and failed."""
        return list(self._data.get("failed") or [])

    async def async_enqueue(self, entries: list[dict]) -> int:
        """Add entries that are neither queued nor already failed."""
        known = {self._key(e) for e in self.queue} | set(self.failed)
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
        for entry in added:
            await self._async_set_image(entry, PENDING_IMAGE_URL)
        return len(added)

    async def async_cancel(self, keys: list[tuple]) -> int:
        """Drop entries from the queue. Returns how many were removed."""
        drop = set(keys)
        remaining = [e for e in self.queue if self._key(e) not in drop]
        dropped = [e for e in self.queue if self._key(e) in drop]
        if not dropped:
            return 0
        self._data["queue"] = remaining
        await self._async_save()
        await self._async_clear_pending(dropped)
        return len(dropped)

    async def async_drop_for(self, list_id: str | None, entity_id: str | None) -> int:
        """Forget everything queued for one list.

        Switching automatic generation off has to stop the pending work too —
        otherwise the next pass would still generate for a list the user just
        turned off, and its tasks would wear the "generating" placeholder for
        ever.
        """
        keys = [
            self._key(e) for e in self.queue
            if e.get("list_id") == list_id and e.get("entity_id") == entity_id
        ]
        return await self.async_cancel(keys)

    async def _async_clear_pending(self, entries: list[dict]) -> None:
        """Remove the waiting placeholder from tasks that are no longer queued.

        Only where it is still showing: a task that meanwhile got a real
        picture (or the failure placeholder) must keep it.
        """
        for entry in entries:
            try:
                current = await self._async_current_image(entry)
            except Exception:  # noqa: BLE001
                continue
            if current and current.split("?")[0] == PENDING_IMAGE_URL:
                await self._async_set_image(entry, None)

    async def _async_current_image(self, entry: dict) -> str | None:
        from .websocket_api import _get_overlay_store, _get_store

        if entry.get("entity_id"):
            store = _get_overlay_store(self.hass, entry["entity_id"])
            return store.get_overlay(entry["task_id"]).get("image_url")
        store = _get_store(self.hass, entry["list_id"])
        return store.get_task(entry["task_id"]).get("image_url")

    async def async_clear_failed_for(self, list_id: str | None, entity_id: str | None) -> None:
        """Forget the failure marks of one list.

        Called when its automatic generation is switched on again: the
        placeholder image on those tasks must not keep them out of the queue
        forever.
        """
        keep = [k for k in self.failed if not (k[0] == list_id and k[1] == entity_id)]
        if len(keep) != len(self.failed):
            self._data["failed"] = keep
            await self._async_save()

    async def _async_mark_failed(self, entry: dict) -> None:
        self._data["failed"] = self.failed + [self._key(entry)]
        await self._async_save()

    # -- scanning ------------------------------------------------------------

    def _needs_image(self, task: dict) -> bool:
        url = task.get("image_url")
        return bool(task.get("title")) and not task.get("completed") and (
            not url or url.split("?")[0] in PLACEHOLDER_IMAGE_URLS
        )

    async def async_scan(self) -> int:
        """Find open tasks without an image in lists that asked for it."""
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
                    if self._needs_image(task):
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
                if self._needs_image(task):
                    entries.append({
                        "entity_id": entity_id,
                        "task_id": task["id"],
                        "title": task["title"],
                    })

        added = await self.async_enqueue(entries)
        if added:
            _LOGGER.debug("Image queue picked up %s task(s)", added)
        return added

    # -- worker --------------------------------------------------------------

    @callback
    def async_kick(self) -> None:
        """Run the queue soon (after a scan, an enqueue or a config change)."""
        self.hass.async_create_task(self.async_run())

    async def async_run(self, scan: bool = True) -> None:
        """Work the queue empty, one generation at a time."""
        if self._running:
            return  # a pass is already in flight; it will see what we added
        self._running = True
        try:
            if scan:
                await self.async_scan()
            for _ in range(MAX_PER_PASS):
                queue = self.queue
                if not queue:
                    return
                entry = queue[0]
                # Take it off first: a crash mid-generation must not make the
                # task block the queue forever.
                self._data["queue"] = queue[1:]
                await self._async_save()
                if not self._wants_images(entry):
                    # Switched off while this was waiting (or left over from an
                    # older version) — drop it, placeholder and all.
                    await self._async_clear_pending([entry])
                    continue
                await self._async_generate(entry)
        finally:
            self._running = False

    def _wants_images(self, entry: dict) -> bool:
        """Whether the entry's list still asks for automatic generation."""
        from .websocket_api import _get_overlay_store

        try:
            if entry.get("entity_id"):
                store = _get_overlay_store(self.hass, entry["entity_id"])
            else:
                store = self.hass.data.get(DOMAIN, {}).get(entry.get("list_id"))
            if store is None or not hasattr(store, "get_settings"):
                return False
            return bool(store.get_settings()["auto_generate_images"])
        except Exception:  # noqa: BLE001
            return False

    async def _async_generate(self, entry: dict) -> None:
        """Generate one image. A failure is marked, never retried."""
        from .websocket_api import async_generate_task_image

        cfg = self.config
        try:
            await async_generate_task_image(
                self.hass,
                None,  # no websocket client here
                task_id=entry["task_id"],
                entry_id=entry.get("list_id"),
                todo_entity_id=entry.get("entity_id"),
                prompt_prefix=cfg["prompt_prefix"],
                ai_entity_id=cfg["ai_task_entity_id"],
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.warning(
                "Background image generation failed for '%s': %s", entry.get("title"), err
            )
            await self._async_mark_failed(entry)
            await self._async_set_image(entry, FAILED_IMAGE_URL)

    async def _async_set_image(self, entry: dict, url: str | None) -> None:
        """Put a placeholder on the task (None clears it). Best effort."""
        from .websocket_api import _get_overlay_store, _get_store

        try:
            if entry.get("entity_id"):
                store = _get_overlay_store(self.hass, entry["entity_id"])
                await store.async_set_overlay(entry["task_id"], image_url=url)
            else:
                store = _get_store(self.hass, entry["list_id"])
                await store.async_update_task(entry["task_id"], image_url=url)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Could not set placeholder on '%s': %s", entry.get("title"), err)


@callback
def async_register_image_queue(hass: HomeAssistant) -> None:
    """Create the queue and start it once, globally."""
    if hass.data.get(DATA_IMAGE_QUEUE):
        return
    queue = ImageQueue(hass)
    hass.data[DATA_IMAGE_QUEUE] = queue

    @callback
    def _on_task_created(event) -> None:
        """A new task anywhere is a candidate — no need to wait for a scan."""
        data = event.data
        entry = {
            "task_id": data.get("task_id"),
            "title": data.get("task_title"),
        }
        if data.get("entity_id"):
            entry["entity_id"] = data["entity_id"]
        else:
            entry["list_id"] = data.get("entry_id")
        if not entry["task_id"] or not entry["title"]:
            return
        hass.async_create_task(_enqueue_if_wanted(entry))

    async def _enqueue_if_wanted(entry: dict) -> None:
        store = hass.data.get(DOMAIN, {}).get(entry.get("list_id")) if entry.get("list_id") else None
        if store is None and entry.get("entity_id"):
            from .websocket_api import _get_overlay_store

            try:
                store = _get_overlay_store(hass, entry["entity_id"])
            except ValueError:
                return
        if store is None or not hasattr(store, "get_settings"):
            return
        if not store.get_settings()["auto_generate_images"]:
            return
        if await queue.async_enqueue([entry]):
            queue.async_kick()

    async def _start() -> None:
        await queue.async_load()
        await queue.async_run()

    @callback
    def _delayed_start(_now) -> None:
        hass.async_create_task(_start())

    @callback
    def _periodic(_now) -> None:
        hass.async_create_task(queue.async_run())

    async_call_later(hass, STARTUP_DELAY, _delayed_start)
    hass.bus.async_listen(f"{DOMAIN}_task_created", _on_task_created)
    async_track_time_interval(hass, _periodic, SCAN_INTERVAL, cancel_on_shutdown=True)


def async_get_image_queue(hass: HomeAssistant) -> ImageQueue | None:
    """Return the queue instance, if it has been registered."""
    return hass.data.get(DATA_IMAGE_QUEUE)
