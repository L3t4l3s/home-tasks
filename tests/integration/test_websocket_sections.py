"""WebSocket tests for section commands."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

DOMAIN = "home_tasks"

pytestmark = pytest.mark.integration


async def test_ws_get_tasks_returns_sections(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """get_tasks now returns a sections array alongside tasks."""
    await store.async_add_section("Produce")
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1,
        "type": "home_tasks/get_tasks",
        "list_id": mock_config_entry.entry_id,
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    assert "sections" in msg["result"]
    assert msg["result"]["sections"][0]["name"] == "Produce"


async def test_ws_section_crud_roundtrip(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    """Add → list → update → reorder → delete a section via WS."""
    client = await hass_ws_client(hass)
    list_id = mock_config_entry.entry_id

    # add
    await client.send_json({
        "id": 1, "type": "home_tasks/add_section",
        "list_id": list_id, "name": "Frozen",
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    section_id = msg["result"]["id"]

    # add a second section
    await client.send_json({
        "id": 2, "type": "home_tasks/add_section",
        "list_id": list_id, "name": "Bakery", "icon": "mdi:bread-slice",
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    second_id = msg["result"]["id"]

    # update name
    await client.send_json({
        "id": 3, "type": "home_tasks/update_section",
        "list_id": list_id, "section_id": section_id, "name": "Frozen Goods",
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    assert msg["result"]["name"] == "Frozen Goods"

    # reorder (swap)
    await client.send_json({
        "id": 4, "type": "home_tasks/reorder_sections",
        "list_id": list_id, "section_ids": [second_id, section_id],
    })
    msg = await client.receive_json()
    assert msg["success"] is True

    # get_sections reflects new order
    await client.send_json({
        "id": 5, "type": "home_tasks/get_sections", "list_id": list_id,
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    ids = [s["id"] for s in msg["result"]["sections"]]
    assert ids == [second_id, section_id]

    # delete
    await client.send_json({
        "id": 6, "type": "home_tasks/delete_section",
        "list_id": list_id, "section_id": second_id,
    })
    msg = await client.receive_json()
    assert msg["success"] is True

    # confirm only one remains
    await client.send_json({
        "id": 7, "type": "home_tasks/get_sections", "list_id": list_id,
    })
    msg = await client.receive_json()
    assert len(msg["result"]["sections"]) == 1
    assert msg["result"]["sections"][0]["id"] == section_id


async def test_ws_update_task_section_id(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """update_task accepts section_id and rejects unknown ids."""
    section = await store.async_add_section("Drinks")
    task = await store.async_add_task("Water")

    client = await hass_ws_client(hass)
    list_id = mock_config_entry.entry_id

    # set valid section_id
    await client.send_json({
        "id": 1, "type": "home_tasks/update_task",
        "list_id": list_id, "task_id": task["id"],
        "section_id": section["id"],
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    assert msg["result"]["section_id"] == section["id"]

    # clear it
    await client.send_json({
        "id": 2, "type": "home_tasks/update_task",
        "list_id": list_id, "task_id": task["id"],
        "section_id": None,
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    assert msg["result"]["section_id"] is None


# ---------------------------------------------------------------------------
# External lists (issue #60)
#
# Sections work for external lists too, so a task dragged into one has to come
# back in that section on the next read. The overlay stored it; what was
# missing was handing it back with the merged task, so the card put the task
# straight back into the unsorted bucket.
# ---------------------------------------------------------------------------

EXT_ENTITY = "todo.ext_sections"


@pytest.fixture
async def ext_entry(hass: HomeAssistant, patch_add_extra_js_url):
    """A linked external list with one open task."""
    from unittest.mock import MagicMock

    from homeassistant.components.todo import TodoItem, TodoItemStatus
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": EXT_ENTITY, "name": "Ext Sections"},
        title="Ext Sections (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    mock_entity = MagicMock()
    mock_entity.todo_items = [
        TodoItem(uid="uid-1", summary="Buy milk", status=TodoItemStatus.NEEDS_ACTION)
    ]
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set(EXT_ENTITY, "1")
    return entry


async def test_a_task_dragged_into_a_section_stays_there(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """The card reloads after the drop — the section has to survive that."""
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 1, "type": "home_tasks/add_section",
        "entity_id": EXT_ENTITY, "name": "Groceries",
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    section_id = msg["result"]["id"]

    await client.send_json({
        "id": 2, "type": "home_tasks/update_external_overlay",
        "entity_id": EXT_ENTITY, "task_uid": "uid-1",
        "section_id": section_id,
    })
    assert (await client.receive_json())["success"] is True

    await client.send_json({
        "id": 3, "type": "home_tasks/get_external_tasks", "entity_id": EXT_ENTITY,
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    task = msg["result"]["tasks"][0]
    assert task["section_id"] == section_id, "the task snapped back out of its section"


async def test_a_task_dragged_into_a_section_stays_there_with_a_rich_adapter(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """Same for providers we read through an adapter (e.g. Todoist)."""
    from unittest.mock import AsyncMock, MagicMock

    from custom_components.home_tasks.provider_adapters import ProviderCapabilities

    adapter = MagicMock()
    adapter.capabilities = ProviderCapabilities()
    adapter.async_read_tasks = AsyncMock(return_value=[
        {"uid": "uid-1", "summary": "Buy milk", "status": "needs_action"},
    ])
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter

    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1, "type": "home_tasks/add_section",
        "entity_id": EXT_ENTITY, "name": "Groceries",
    })
    section_id = (await client.receive_json())["result"]["id"]

    await client.send_json({
        "id": 2, "type": "home_tasks/update_external_overlay",
        "entity_id": EXT_ENTITY, "task_uid": "uid-1",
        "section_id": section_id,
    })
    assert (await client.receive_json())["success"] is True

    await client.send_json({
        "id": 3, "type": "home_tasks/get_external_tasks", "entity_id": EXT_ENTITY,
    })
    msg = await client.receive_json()
    assert msg["result"]["tasks"][0]["section_id"] == section_id


async def test_a_task_outside_any_section_reports_none(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """A task with no section must not claim one."""
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1, "type": "home_tasks/get_external_tasks", "entity_id": EXT_ENTITY,
    })
    msg = await client.receive_json()
    assert msg["result"]["tasks"][0]["section_id"] is None


async def test_deleting_a_section_frees_its_external_tasks(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """Otherwise the task points at a section that is gone and vanishes."""
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 1, "type": "home_tasks/add_section",
        "entity_id": EXT_ENTITY, "name": "Groceries",
    })
    section_id = (await client.receive_json())["result"]["id"]
    await client.send_json({
        "id": 2, "type": "home_tasks/update_external_overlay",
        "entity_id": EXT_ENTITY, "task_uid": "uid-1", "section_id": section_id,
    })
    await client.receive_json()

    await client.send_json({
        "id": 3, "type": "home_tasks/delete_section",
        "entity_id": EXT_ENTITY, "section_id": section_id,
    })
    assert (await client.receive_json())["success"] is True

    await client.send_json({
        "id": 4, "type": "home_tasks/get_external_tasks", "entity_id": EXT_ENTITY,
    })
    msg = await client.receive_json()
    assert msg["result"]["tasks"][0]["section_id"] is None
