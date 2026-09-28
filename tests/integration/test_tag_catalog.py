"""Fixed tags per list — always offered when tagging (issue #61)."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


async def test_catalog_is_normalised_like_task_tags(hass: HomeAssistant, store) -> None:
    result = await store.async_set_defaults(tag_catalog=["Kitchen", "#garden", " kitchen ", "", "Bath room"])
    assert result["tag_catalog"] == ["kitchen", "garden", "bath room"]
    assert store.get_defaults()["tag_catalog"] == ["kitchen", "garden", "bath room"]


async def test_catalog_is_separate_from_the_default_tags(hass: HomeAssistant, store) -> None:
    """Default tags go onto new tasks; fixed tags are only offered."""
    await store.async_set_defaults(tag_catalog=["kitchen"])
    task = await store.async_add_task("Wipe the counter")
    assert task["tags"] == []
    # And setting one leaves the other alone.
    await store.async_set_defaults(tags=["chore"])
    assert store.get_defaults()["tag_catalog"] == ["kitchen"]


async def test_catalog_limits(hass: HomeAssistant, store) -> None:
    with pytest.raises(ValueError):
        await store.async_set_defaults(tag_catalog=[f"t{i}" for i in range(101)])
    with pytest.raises(ValueError):
        await store.async_set_defaults(tag_catalog=["x" * 51])
    assert (await store.async_set_defaults(tag_catalog=[]))["tag_catalog"] == []


async def test_changing_the_catalog_tells_the_cards(hass: HomeAssistant, store) -> None:
    """Cards reload on the list's sensor update — which a catalog change must trigger,
    while other defaults (not shown anywhere) still skip it."""
    calls = []
    store.async_add_listener(lambda: calls.append(1))
    await store.async_set_defaults(priority=2)
    assert calls == []
    await store.async_set_defaults(tag_catalog=["kitchen"])
    assert calls == [1]
    await store.async_set_defaults(tag_catalog=["kitchen"])   # unchanged
    assert calls == [1]


async def test_websocket_round_trip_and_task_load(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({
        "type": "home_tasks/set_defaults", "list_id": mock_config_entry.entry_id,
        "tag_catalog": ["Kitchen", "garden"],
    })
    msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"]["defaults"]["tag_catalog"] == ["kitchen", "garden"]

    # The card gets it with the tasks, next to the sections.
    await client.send_json_auto_id({"type": "home_tasks/get_tasks", "list_id": mock_config_entry.entry_id})
    msg = await client.receive_json()
    assert msg["result"]["tag_catalog"] == ["kitchen", "garden"]


async def test_get_tasks_service_includes_the_catalog(hass: HomeAssistant, mock_config_entry, store) -> None:
    await store.async_set_defaults(tag_catalog=["kitchen"])
    result = await hass.services.async_call(
        DOMAIN, "get_tasks", {"list_name": "Test List"}, blocking=True, return_response=True,
    )
    assert result["tag_catalog"] == ["kitchen"]


async def test_linked_list_catalog(hass: HomeAssistant, hass_ws_client, patch_add_extra_js_url) -> None:
    ext = "todo.ext_tags"
    entry = MockConfigEntry(
        domain=DOMAIN, data={"type": "external", "entity_id": ext, "name": "Ext"}, title="Ext (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    mock_entity = MagicMock()
    mock_entity.todo_items = [TodoItem(uid="a", summary="Mow", status=TodoItemStatus.NEEDS_ACTION)]
    comp = MagicMock()
    comp.get_entity.return_value = mock_entity
    hass.data["todo"] = comp
    hass.states.async_set(ext, "1")

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "home_tasks/set_defaults", "entity_id": ext, "tag_catalog": ["Garden"]})
    assert (await client.receive_json())["success"]
    await client.send_json_auto_id({"type": "home_tasks/get_external_tasks", "entity_id": ext})
    msg = await client.receive_json()
    assert msg["result"]["tag_catalog"] == ["garden"]
