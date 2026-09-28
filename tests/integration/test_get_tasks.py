"""home_tasks.get_tasks — a list's tasks with assignee and tags (issue #67)."""
from __future__ import annotations

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


async def _get(hass: HomeAssistant, **data) -> dict:
    return await hass.services.async_call(DOMAIN, "get_tasks", data, blocking=True, return_response=True)


@pytest.fixture
async def household(hass: HomeAssistant, mock_config_entry, store, freezer) -> dict:
    freezer.move_to(datetime(2026, 9, 28, 10, 0, tzinfo=dt_util.DEFAULT_TIME_ZONE))
    ids = {}
    for title, fields in (
        ("Bins", {"due_date": "2026-09-28", "assigned_person": "person.kevin", "tags": ["weekly"]}),
        ("Dishes", {"due_date": "2026-09-28", "assigned_person": "person.anna"}),
        ("Taxes", {"due_date": "2026-09-20", "assigned_person": "person.kevin", "priority": 3}),
        ("Plants", {"due_date": "2026-10-01", "tags": ["Weekly"]}),
        ("Someday", {}),
    ):
        task = await store.async_add_task(title)
        if fields:
            await store.async_update_task(task["id"], **fields)
        ids[title] = task["id"]
    await store.async_update_task(ids["Someday"], completed=True)
    return ids


def titles(result: dict) -> list[str]:
    return [t["title"] for t in result["tasks"]]


async def test_open_tasks_with_every_field(hass: HomeAssistant, household) -> None:
    result = await _get(hass, list_name="Test List")
    assert result["list_name"] == "Test List"
    assert titles(result) == ["Bins", "Dishes", "Taxes", "Plants"]   # card order, open only
    bins = result["tasks"][0]
    assert bins["assigned_person"] == "person.kevin"
    assert bins["tags"] == ["weekly"]
    assert bins["due_date"] == "2026-09-28"
    assert set(bins) >= {
        "id", "title", "completed", "completed_at", "due_date", "due_time", "assigned_person",
        "tags", "priority", "notes", "section_id", "sub_items", "recurrence_enabled",
    }


async def test_status_filter(hass: HomeAssistant, household) -> None:
    assert titles(await _get(hass, list_name="Test List", status="completed")) == ["Someday"]
    assert len((await _get(hass, list_name="Test List", status="all"))["tasks"]) == 5


async def test_the_use_case_from_the_issue(hass: HomeAssistant, household) -> None:
    """Due today and assigned to me."""
    result = await _get(hass, list_name="Test List", due="today", assigned_person="person.kevin")
    assert titles(result) == ["Bins"]


async def test_due_filters(hass: HomeAssistant, household) -> None:
    assert titles(await _get(hass, list_name="Test List", due="today")) == ["Bins", "Dishes"]
    assert titles(await _get(hass, list_name="Test List", due="overdue")) == ["Taxes"]
    assert titles(await _get(hass, list_name="Test List", due="today_or_overdue")) == ["Bins", "Dishes", "Taxes"]


async def test_tag_filter_ignores_case(hass: HomeAssistant, household) -> None:
    assert titles(await _get(hass, list_name="Test List", tag="WEEKLY")) == ["Bins", "Plants"]


async def test_sub_items_and_priority(hass: HomeAssistant, household, store) -> None:
    await store.async_add_sub_task(household["Taxes"], "Find receipts")
    (taxes,) = (await _get(hass, list_name="Test List", due="overdue"))["tasks"]
    assert taxes["priority"] == 3
    assert taxes["sub_items"] == [{"title": "Find receipts", "completed": False}]


async def test_needs_a_response_variable(hass: HomeAssistant, household) -> None:
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "get_tasks", {"list_name": "Test List"}, blocking=True)


async def test_unknown_filter_value_is_rejected(hass: HomeAssistant, household) -> None:
    import voluptuous as vol
    with pytest.raises(vol.Invalid):
        await _get(hass, list_name="Test List", due="tomorrow")


# ---------------------------------------------------------------------------
# Linked list
# ---------------------------------------------------------------------------

EXT = "todo.ext_read"


async def test_linked_list_carries_overlay_fields(hass: HomeAssistant, patch_add_extra_js_url) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN, data={"type": "external", "entity_id": EXT, "name": "Ext"}, title="Ext (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    mock_entity = MagicMock()
    mock_entity.todo_items = [
        TodoItem(uid="a", summary="Mow the lawn", status=TodoItemStatus.NEEDS_ACTION),
        TodoItem(uid="b", summary="Done already", status=TodoItemStatus.COMPLETED),
    ]
    comp = MagicMock()
    comp.get_entity.return_value = mock_entity
    hass.data["todo"] = comp
    hass.states.async_set(EXT, "1", {"friendly_name": "Garden"})
    await hass.data[DOMAIN][entry.entry_id].async_set_overlay(
        "a", assigned_person="person.anna", tags=["garden"],
    )

    result = await _get(hass, entity_id=EXT, assigned_person="person.anna")
    assert result["list_name"] == "Garden"
    assert [(t["title"], t["tags"]) for t in result["tasks"]] == [("Mow the lawn", ["garden"])]


async def test_linked_list_in_the_cards_order(hass: HomeAssistant, patch_add_extra_js_url) -> None:
    """A reorder in the card lives in the overlay when the provider can't reorder."""
    entry = MockConfigEntry(
        domain=DOMAIN, data={"type": "external", "entity_id": EXT, "name": "Ext"}, title="Ext (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    mock_entity = MagicMock()
    mock_entity.todo_items = [
        TodoItem(uid="a", summary="First at the provider", status=TodoItemStatus.NEEDS_ACTION),
        TodoItem(uid="b", summary="Moved up in the card", status=TodoItemStatus.NEEDS_ACTION),
    ]
    comp = MagicMock()
    comp.get_entity.return_value = mock_entity
    hass.data["todo"] = comp
    hass.states.async_set(EXT, "2")
    overlay = hass.data[DOMAIN][entry.entry_id]
    await overlay.async_set_overlay("a", sort_order=1)
    await overlay.async_set_overlay("b", sort_order=0)

    result = await _get(hass, entity_id=EXT)
    assert [t["title"] for t in result["tasks"]] == ["Moved up in the card", "First at the provider"]
