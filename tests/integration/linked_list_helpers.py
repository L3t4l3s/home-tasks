"""A linked external list for integration tests: "All Tasks" on todo.all_tasks.

Shared by the service tests for linked lists; the ``linked_list`` fixture
that sets it up lives in conftest.py next to this file.
"""
from __future__ import annotations

from unittest.mock import MagicMock

from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.all_tasks"
LIST_NAME = "All Tasks"


class LinkedListAdapter:
    """A provider that syncs nothing: everything comes back for the overlay."""

    def __init__(self, hass, entity_id: str) -> None:
        from custom_components.home_tasks.provider_adapters import ProviderCapabilities

        self._hass = hass
        self._entity_id = entity_id
        self.capabilities = ProviderCapabilities()
        self.created: list[dict] = []
        self.updated: list[tuple[str, dict]] = []
        # What the provider itself reports per task, the way Todoist reports
        # its labels - a rich adapter's own fields come from the provider,
        # not from the overlay.
        self.labels: dict[str, list[str]] = {}
        self.reads = 0  # provider round trips - each one is slow for real

    async def async_create_task(self, fields):
        self.created.append(dict(fields))
        return "uid-new", {k: v for k, v in fields.items() if k != "title"}

    async def async_update_task(self, task_uid, fields):
        self.updated.append((task_uid, dict(fields)))
        return dict(fields)

    async def async_read_tasks(self):
        # A rich adapter is asked for the list itself; ours mirrors the todo
        # entity the fixture set up.
        from custom_components.home_tasks.provider_adapters import _get_external_todo_items

        self.reads += 1
        items = _get_external_todo_items(self._hass, self._entity_id)
        for item in items:
            if item["uid"] in self.labels:
                item["labels"] = list(self.labels[item["uid"]])
        return items


async def setup_linked_list(hass: HomeAssistant):
    """A linked external list called "All Tasks" with one open task."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": EXT_ENTITY, "name": LIST_NAME},
        title=f"{LIST_NAME} (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    mock_entity = MagicMock()
    mock_entity.todo_items = [
        TodoItem(uid="uid-1", summary="Wipe bench", status=TodoItemStatus.NEEDS_ACTION),
        TodoItem(uid="uid-2", summary="Old thing", status=TodoItemStatus.COMPLETED),
    ]
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set(EXT_ENTITY, "1")

    adapter = LinkedListAdapter(hass, EXT_ENTITY)
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    return entry, adapter


def overlay(hass: HomeAssistant, entry) -> ExternalTaskOverlayStore:
    store = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(store, ExternalTaskOverlayStore)
    return store


async def call(hass: HomeAssistant, service: str, **data):
    await hass.services.async_call(DOMAIN, service, data, blocking=True)
    await hass.async_block_till_done()
