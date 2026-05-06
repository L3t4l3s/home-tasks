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
