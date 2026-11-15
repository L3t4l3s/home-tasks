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
    sub = await store.async_add_sub_task(household["Taxes"], "Find receipts")
    (taxes,) = (await _get(hass, list_name="Test List", due="overdue"))["tasks"]
    assert taxes["priority"] == 3
    # The id is what update_sub_task / remove_sub_task take (issue #70).
    assert taxes["sub_items"] == [{"id": sub["id"], "title": "Find receipts", "completed": False}]


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


# ---------------------------------------------------------------------------
# Several lists in one call
# ---------------------------------------------------------------------------

@pytest.fixture
async def garden(hass: HomeAssistant, household) -> MockConfigEntry:
    """A second native list next to the household one."""
    entry = MockConfigEntry(domain=DOMAIN, data={"name": "Garden"}, title="Garden")
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    task = await hass.data[DOMAIN][entry.entry_id].async_add_task("Mow")
    await hass.data[DOMAIN][entry.entry_id].async_update_task(task["id"], assigned_person="person.kevin")
    return entry


async def test_each_task_names_its_list_and_its_last_change(
    hass: HomeAssistant, household, mock_config_entry
) -> None:
    result = await _get(hass, list_name="Test List")
    bins = result["tasks"][0]
    assert (bins["list_name"], bins["entry_id"]) == ("Test List", mock_config_entry.entry_id)
    assert bins["last_changed"].startswith("2026-09-28")
    assert result["lists"] == [{
        "list_name": "Test List",
        "entry_id": mock_config_entry.entry_id,
        "tag_catalog": result["tag_catalog"],
    }]


async def test_several_lists_come_back_in_the_order_named(
    hass: HomeAssistant, household, garden, mock_config_entry
) -> None:
    result = await _get(hass, list_name=["Garden", "Test List"])
    assert titles(result) == ["Mow", "Bins", "Dishes", "Taxes", "Plants"]
    assert [entry["list_name"] for entry in result["lists"]] == ["Garden", "Test List"]
    assert result["tasks"][0]["entry_id"] == garden.entry_id
    assert result["tasks"][1]["entry_id"] == mock_config_entry.entry_id
    # One list's name and tags at the top would be wrong for the other.
    assert "list_name" not in result and "tag_catalog" not in result


async def test_filters_apply_across_the_lists(
    hass: HomeAssistant, household, garden, mock_config_entry
) -> None:
    result = await _get(
        hass, entry_id=[mock_config_entry.entry_id, garden.entry_id], assigned_person="person.kevin",
    )
    assert titles(result) == ["Bins", "Taxes", "Mow"]


async def test_a_list_named_twice_is_read_once(hass: HomeAssistant, household) -> None:
    result = await _get(hass, list_name=["Test List", "Test List"])
    assert titles(result) == ["Bins", "Dishes", "Taxes", "Plants"]
    assert result["list_name"] == "Test List"


async def test_an_unknown_list_among_several_is_an_error(hass: HomeAssistant, household) -> None:
    import voluptuous as vol
    with pytest.raises(vol.Invalid, match="Nowhere"):
        await _get(hass, list_name=["Test List", "Nowhere"])


async def test_native_and_linked_lists_together(hass: HomeAssistant, household) -> None:
    from tests.integration.linked_list_helpers import LIST_NAME, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    result = await _get(hass, list_name=["Test List", LIST_NAME])
    assert titles(result) == ["Bins", "Dishes", "Taxes", "Plants", "Wipe bench"]
    assert result["tasks"][-1]["entry_id"] == linked.entry_id


async def test_an_unreadable_list_does_not_cost_the_others(
    hass: HomeAssistant, household, mock_config_entry
) -> None:
    """A linked list whose provider is gone: the overview says so and goes on."""
    from tests.integration.linked_list_helpers import EXT_ENTITY, LIST_NAME, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    hass.states.async_remove(EXT_ENTITY)
    await hass.async_block_till_done()

    result = await _get(hass, entry_id=[mock_config_entry.entry_id, linked.entry_id])
    assert titles(result) == ["Bins", "Dishes", "Taxes", "Plants"]
    ok, broken = result["lists"]
    assert "error" not in ok
    assert broken["entry_id"] == linked.entry_id and "Entity not found" in broken["error"]

    # Asked for alone, it is an error as before - there is nothing else to return.
    with pytest.raises(Exception, match="Entity not found"):
        await _get(hass, entry_id=linked.entry_id)
