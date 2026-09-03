"""The services work on linked external lists, not only on native ones (#63).

A user could tag a task on a linked list from the card but not from an
automation: every service resolved the list through a native-only lookup and
reported a list that plainly exists as missing. These tests go through the
service layer the way an automation does.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
import voluptuous as vol
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.all_tasks"
LIST_NAME = "All Tasks"


class _Adapter:
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

        items = _get_external_todo_items(self._hass, self._entity_id)
        for item in items:
            if item["uid"] in self.labels:
                item["labels"] = list(self.labels[item["uid"]])
        return items


@pytest.fixture
async def linked_list(hass: HomeAssistant, patch_add_extra_js_url):
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

    adapter = _Adapter(hass, EXT_ENTITY)
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    return entry, adapter


def _overlay(hass: HomeAssistant, entry) -> ExternalTaskOverlayStore:
    store = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(store, ExternalTaskOverlayStore)
    return store


async def _call(hass: HomeAssistant, service: str, **data):
    await hass.services.async_call(DOMAIN, service, data, blocking=True)
    await hass.async_block_till_done()


# ---------------------------------------------------------------------------
# The report: tagging a task on a linked list from an automation
# ---------------------------------------------------------------------------

async def test_update_task_tags_a_task_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    entry, _adapter = linked_list

    await _call(
        hass, "update_task",
        list_name=LIST_NAME, task_title="Wipe bench", tags="#kitchen",
    )

    assert _overlay(hass, entry).get_overlay("uid-1")["tags"] == ["#kitchen"]


async def test_the_entity_can_be_named_directly(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list

    await _call(
        hass, "update_task",
        entity_id=EXT_ENTITY, task_title="Wipe bench", priority=1, notes="from an automation",
    )

    stored = _overlay(hass, entry).get_overlay("uid-1")
    assert stored["priority"] == 1
    assert stored["notes"] == "from an automation"


async def test_the_provider_is_offered_the_change_first(
    hass: HomeAssistant, linked_list
) -> None:
    """Same route as the card: a provider that syncs labels stores them itself."""
    _entry, adapter = linked_list

    await _call(hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench", tags="kitchen")

    assert adapter.updated, "the adapter was asked before the overlay"
    uid, fields = adapter.updated[0]
    assert uid == "uid-1"
    assert fields["tags"] == ["kitchen"]


# ---------------------------------------------------------------------------
# The rest of the family
# ---------------------------------------------------------------------------

async def test_add_task_creates_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await _call(hass, "add_task", list_name=LIST_NAME, title="Buy bread", tags="shopping")

    assert adapter.created, "the task went to the provider"
    assert adapter.created[0]["title"] == "Buy bread"
    assert adapter.created[0]["tags"] == ["shopping"]


async def test_complete_task_completes_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    _entry, adapter = linked_list

    await _call(hass, "complete_task", list_name=LIST_NAME, task_title="Wipe bench")

    assert ("uid-1", {"completed": True}) in adapter.updated


async def test_complete_task_by_tag_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    _entry, adapter = linked_list
    adapter.labels["uid-1"] = ["kitchen"]

    await _call(hass, "complete_task", list_name=LIST_NAME, tag="kitchen")

    assert ("uid-1", {"completed": True}) in adapter.updated


async def test_assign_task_assigns_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list

    await _call(
        hass, "assign_task",
        list_name=LIST_NAME, task_title="Wipe bench", person="person.alice",
    )

    assert _overlay(hass, entry).get_overlay("uid-1")["assigned_person"] == "person.alice"


async def test_reopen_task_reopens_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await _call(hass, "reopen_task", list_name=LIST_NAME, task_title="Old thing")

    assert ("uid-2", {"completed": False}) in adapter.updated


async def test_reopening_an_open_task_does_nothing(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await _call(hass, "reopen_task", list_name=LIST_NAME, task_title="Wipe bench")

    assert adapter.updated == []


# ---------------------------------------------------------------------------
# Saying what is actually wrong
# ---------------------------------------------------------------------------

async def test_an_unknown_list_is_still_an_unknown_list(
    hass: HomeAssistant, linked_list
) -> None:
    with pytest.raises((vol.Invalid, Exception)) as err:
        await _call(hass, "update_task", list_name="Nowhere", task_title="x", tags="y")
    assert "Nowhere" in str(err.value)


async def test_a_task_that_is_not_there_says_so(hass: HomeAssistant, linked_list) -> None:
    with pytest.raises(Exception) as err:
        await _call(
            hass, "update_task",
            list_name=LIST_NAME, task_title="No such task", tags="y",
        )
    assert "No such task" in str(err.value)


async def test_an_entity_that_is_not_linked_says_so(
    hass: HomeAssistant, linked_list
) -> None:
    """Pointing at a todo entity nobody linked is a different mistake from a
    missing list, and used to read the same."""
    with pytest.raises(Exception) as err:
        await _call(
            hass, "update_task",
            entity_id="todo.never_linked", task_title="Wipe bench", tags="y",
        )
    assert "not a linked list" in str(err.value)
