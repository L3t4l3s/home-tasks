"""The merged view of a linked list, for entities that read it synchronously.

A linked list has two halves: the provider's items (read live off its todo
entity) and our overlay (assignee, tags, section, recurrence, and the due
date when the provider cannot hold one).  An entity property cannot await, so
the calendar and the sensors read the halves through the generic merge here
and refresh when either half changes - the overlay tells its listeners, the
provider's entity announces itself through a state change.
"""

from __future__ import annotations

from collections.abc import Callable
import logging

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

_LOGGER = logging.getLogger(__name__)


def get_external_tasks_snapshot(hass: HomeAssistant, entity_id: str) -> list[dict]:
    """Provider items merged with the overlay, or [] while the provider is not there.

    Deliberately the generic merge, whatever the adapter: it needs no I/O.
    A rich provider (Todoist) syncs a few more fields on the async path the
    card uses, but title, done, due and assignee - what the sensors and the
    calendar look at - are all here.
    """
    try:
        from .provider_adapters import _get_external_todo_items
        from .websocket_api import _get_overlay_store, _merge_tasks_with_overlays

        overlay_store = _get_overlay_store(hass, entity_id)
        items = _get_external_todo_items(hass, entity_id)
        return _merge_tasks_with_overlays(items, overlay_store)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("No merged view for %s yet: %s", entity_id, err)
        return []


def async_subscribe_external(
    hass: HomeAssistant, entity_id: str, refresh: Callable[[], None]
) -> list[Callable[[], None]]:
    """Call *refresh* whenever either half of the linked list changes.

    Returns the unsubscribe callables, for async_on_remove.
    """
    unsubs: list[Callable[[], None]] = []
    try:
        from .websocket_api import _get_overlay_store

        unsubs.append(_get_overlay_store(hass, entity_id).async_add_listener(refresh))
    except Exception:  # noqa: BLE001
        pass  # no overlay yet - the provider's state changes still get through

    @callback
    def _on_state_change(_event) -> None:
        refresh()

    unsubs.append(async_track_state_change_event(hass, [entity_id], _on_state_change))
    return unsubs
