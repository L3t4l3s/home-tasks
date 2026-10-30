"""What happens to a linked list in its provider's own app (issue #88).

The card and the services tell us when they tick off or reopen a task; a tick
in the phone app, Thunderbird or Home Assistant's own to-do view does not.
This watcher looks at the provider's items whenever the todo entity changes
and catches up:

- a recurring task ticked off there is counted as completed - stamped, its
  count taken down, its reopen scheduled - as if ticked in the card;
- one reopened there gives the occurrence back, as a reopen in the card does;
- an open recurring task that disappears (deleted, or ticked and cleared
  between two looks) counts as done now and comes back at its next
  occurrence. A completed one that disappears - "clear completed" - needs
  nothing here: it is put back when it reopens (_vanished_external_tasks).

Only the card deletes a recurring task for good (it drops the overlay too).
Providers that run the recurrence themselves (Todoist) are left alone.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import logging
import time

from homeassistant.core import HassJob, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
    async_track_state_report_event,
)

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_OWN_CHANGES = f"{DOMAIN}_own_external_changes"
DATA_OWN_PENDING = f"{DOMAIN}_own_external_pending"
# A tick or reopen made through our own code is left to it for this long:
# the provider's echo of it is not an outside change.
OWN_CHANGE_WINDOW = 30.0
# After the todo entity changes, before looking: lets our own write that
# caused it finish first.
SETTLE_DELAY = 5.0
# An open recurring task must stay gone this long before it counts as done:
# a provider that briefly lists nothing must not end anything.
VANISH_CONFIRM = 60.0
FIRST_LOOK_DELAY = 120.0  # once the providers have loaded, like the timer recovery


def _now() -> float:
    return time.monotonic()


def note_own_change(hass: HomeAssistant, entity_id: str, task_uid: str) -> None:
    """Mark a tick or reopen of a linked task as ours (see OWN_CHANGE_WINDOW)."""
    changes = hass.data.setdefault(DATA_OWN_CHANGES, {})
    now = _now()
    for key in [k for k, t in changes.items() if now - t > OWN_CHANGE_WINDOW]:
        del changes[key]
    changes[(entity_id, str(task_uid))] = now


@contextmanager
def own_change(hass: HomeAssistant, entity_id: str, task_uid: str) -> Iterator[None]:
    """A tick or reopen of ours in progress: left to us for as long as it
    runs - a slow provider write can outlast OWN_CHANGE_WINDOW - and for
    OWN_CHANGE_WINDOW after."""
    key = (entity_id, str(task_uid))
    pending = hass.data.setdefault(DATA_OWN_PENDING, {})
    pending[key] = pending.get(key, 0) + 1
    try:
        yield
    finally:
        pending[key] -= 1
        if not pending[key]:
            del pending[key]
        note_own_change(hass, entity_id, task_uid)


def _recently_ours(hass: HomeAssistant, entity_id: str, task_uid: str) -> bool:
    key = (entity_id, str(task_uid))
    if hass.data.get(DATA_OWN_PENDING, {}).get(key):
        return True
    t = hass.data.get(DATA_OWN_CHANGES, {}).get(key)
    return t is not None and _now() - t < OWN_CHANGE_WINDOW


def provider_readable(hass: HomeAssistant, entity_id: str) -> bool:
    """Whether the provider's item list can be taken as what it holds: the
    entity is available and has loaded its items. An empty read otherwise
    says nothing about what is gone."""
    state = hass.states.get(entity_id)
    if state is None or state.state in ("unavailable", "unknown"):
        return False
    comp = hass.data.get("todo")
    entity = comp.get_entity(entity_id) if comp and hasattr(comp, "get_entity") else None
    return entity is not None and getattr(entity, "todo_items", None) is not None


class _ExternalWatch:
    """The last look at one linked list, and what changed since."""

    def __init__(self, hass: HomeAssistant, entry_id: str, entity_id: str) -> None:
        self.hass = hass
        self.entry_id = entry_id
        self.entity_id = entity_id
        self.snapshot: dict[str, dict] | None = None  # uid -> provider item
        self.missing_since: dict[str, float] = {}
        self._later: Callable[[], None] | None = None
        self._due = 0.0  # when _later fires
        self._running = False

    @callback
    def schedule(self, delay: float = SETTLE_DELAY) -> None:
        """Look again in *delay* seconds - or sooner, if a look is already
        planned for earlier (the first look, a confirmation, a change)."""
        due = _now() + delay
        if self._later is not None:
            if self._due <= due:
                return
            self._later()
        self._due = due
        self._later = async_call_later(
            self.hass, delay, HassJob(self._fire, "home_tasks_external_watch", cancel_on_shutdown=True)
        )

    @callback
    def _fire(self, _now) -> None:
        self._later = None
        self.hass.async_create_task(self.async_check())

    @callback
    def cancel(self) -> None:
        if self._later is not None:
            self._later()
            self._later = None

    async def async_check(self) -> None:
        if self._running:  # one look at a time; the next one follows
            self.schedule()
            return
        self._running = True
        try:
            await self._async_check()
        except Exception:  # noqa: BLE001 - a look that fails must not stop the next
            _LOGGER.exception("Could not look at %s", self.entity_id)
        finally:
            self._running = False

    async def _async_check(self) -> None:
        from . import (
            _cancel_recurrence,
            _external_owns_recurrence,
            _handle_external_recurrence_completion,
            _recreate_snapshot,
        )
        from .provider_adapters import _get_external_todo_items
        from .websocket_api import (
            _fire_external_task_event,
            _get_overlay_store,
            _merge_tasks_with_overlays,
            _undo_count_off,
        )

        hass, entity_id = self.hass, self.entity_id
        if _external_owns_recurrence(hass, entity_id):
            return
        if not provider_readable(hass, entity_id):
            return  # keep the last look; nothing can be told from here
        try:
            items = _get_external_todo_items(hass, entity_id)
            store = _get_overlay_store(hass, entity_id)
        except Exception:  # noqa: BLE001
            return
        overlays = store.get_all_overlays()
        current = {str(i["uid"]): i for i in items}
        merged = {str(t["id"]): t for t in _merge_tasks_with_overlays(items, store)}
        prev, self.snapshot = self.snapshot, dict(current)
        now = _now()

        for uid, item in current.items():
            self.missing_since.pop(uid, None)
            overlay = overlays.get(uid)
            if not overlay or _recently_ours(hass, entity_id, uid):
                continue
            done = item.get("status") == "completed"
            if done and overlay.get("recurrence_enabled") and not overlay.get("completed_at"):
                # Ticked off in the provider's app (also while Home Assistant
                # was down): the same as a tick in the card.
                _LOGGER.info("Recurring task '%s' was completed in %s's app", item.get("summary"), entity_id)
                await _handle_external_recurrence_completion(hass, self.entry_id, entity_id, uid)
                task = _merge_tasks_with_overlays([item], store)[0]
                _fire_external_task_event(hass, "task_completed", entity_id, uid, {}, task=task)
            elif not done and overlay.get("completed_at"):
                # Open again, but not by us (a reopen of ours is own_change):
                # reopened in the provider's app - also while Home Assistant
                # was down, or ticked and unticked between two looks. The
                # same as an untick in the card: the reopen timer goes, the
                # occurrence comes back.
                _LOGGER.info("Recurring task '%s' was reopened in %s's app", item.get("summary"), entity_id)
                _cancel_recurrence(hass, uid)
                await store.async_set_overlay(
                    uid, completed_at=None, recreate=None, **_undo_count_off(merged[uid]))
                task = _merge_tasks_with_overlays([item], store)[0]
                _fire_external_task_event(hass, "task_reopened", entity_id, uid, {}, task=task)
            elif done and overlay.get("completed_at") and overlay.get("recreate"):
                # Waiting to reopen: keep what would be put back in step with
                # edits made meanwhile (in the card or elsewhere).
                snap = _recreate_snapshot(merged[uid])
                if snap != overlay["recreate"]:
                    await store.async_set_overlay(uid, recreate=snap)

        if prev is None:
            return  # the first look: nothing to compare with
        for uid, last in prev.items():
            if uid in current:
                continue
            overlay = overlays.get(uid)
            if not overlay or not overlay.get("recurrence_enabled") or overlay.get("completed_at"):
                # Not recurring, deleted in the card (overlay gone), or a
                # completed one - put back at its reopen.
                self.missing_since.pop(uid, None)
                continue
            since = self.missing_since.setdefault(uid, now)
            if now - since < VANISH_CONFIRM:
                self.snapshot[uid] = last  # still missing at the next look: confirmed
                self.schedule(VANISH_CONFIRM + SETTLE_DELAY)
                continue
            self.missing_since.pop(uid, None)
            _LOGGER.info(
                "Recurring task '%s' disappeared from %s - counted as done, back at its next occurrence",
                last.get("summary"), entity_id,
            )
            await _handle_external_recurrence_completion(hass, self.entry_id, entity_id, uid, last_item=last)


def async_watch_external(hass: HomeAssistant, entry_id: str, entity_id: str) -> Callable[[], None]:
    """Watch one linked list; returns the unsubscribe for async_on_unload."""
    watch = _ExternalWatch(hass, entry_id, entity_id)

    @callback
    def _on_provider_event(_event) -> None:
        watch.schedule()

    # A todo entity's state is its open-item count, so a tick in the app
    # changes it, but a deletion of a completed item or an edit may only be
    # reported - both events are needed (as in external_view).
    unsubs = [
        async_track_state_change_event(hass, [entity_id], _on_provider_event),
        async_track_state_report_event(hass, [entity_id], _on_provider_event),
    ]
    watch.schedule(FIRST_LOOK_DELAY)

    @callback
    def _unsub() -> None:
        for unsub in unsubs:
            unsub()
        watch.cancel()

    return _unsub
