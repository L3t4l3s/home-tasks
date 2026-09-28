"""Who completed a task, on home_tasks_task_completed (issue #65)."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


@pytest.fixture
async def kevin(hass: HomeAssistant, hass_admin_user) -> str:
    """The admin user (the one the WS client logs in as), linked to person.kevin."""
    assert await async_setup_component(hass, "person", {"person": [
        {"id": "kevin", "name": "Kevin", "user_id": hass_admin_user.id},
    ]})
    await hass.async_block_till_done()
    return hass_admin_user.id


@pytest.fixture
def completed_events(hass: HomeAssistant) -> list:
    events: list = []
    hass.bus.async_listen(f"{DOMAIN}_task_completed", events.append)
    return events


async def test_completing_in_the_card_names_the_user_and_person(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, kevin, completed_events
) -> None:
    task = await store.async_add_task("Take out the bins")
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({
        "type": "home_tasks/update_task", "list_id": mock_config_entry.entry_id,
        "task_id": task["id"], "completed": True,
    })
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()

    (event,) = completed_events
    assert event.data["completed_by"] == hass_admin_user.name
    assert event.data["completed_by_user_id"] == kevin
    assert event.data["completed_by_person"] == "person.kevin"
    # In the user's context, so the logbook attributes it to them.
    assert event.context.user_id == kevin
    # And the history keeps saying the same thing.
    assert store.get_task(task["id"])["history"][-1] == {
        **store.get_task(task["id"])["history"][-1], "action": "completed", "by": hass_admin_user.name,
    }


async def test_complete_task_service_called_by_a_user(
    hass: HomeAssistant, hass_admin_user, mock_config_entry, store, kevin, completed_events
) -> None:
    await store.async_add_task("Water the plants")
    await hass.services.async_call(
        DOMAIN, "complete_task", {"list_name": "Test List", "task_title": "Water the plants"},
        blocking=True, context=Context(user_id=kevin),
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert (event.data["completed_by"], event.data["completed_by_person"]) == (hass_admin_user.name, "person.kevin")


async def test_a_user_without_a_person_still_gets_name_and_id(
    hass: HomeAssistant, hass_admin_user, mock_config_entry, store, completed_events
) -> None:
    await store.async_add_task("Water the plants")
    await hass.services.async_call(
        DOMAIN, "complete_task", {"list_name": "Test List", "task_title": "Water the plants"},
        blocking=True, context=Context(user_id=hass_admin_user.id),
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert event.data["completed_by_user_id"] == hass_admin_user.id
    assert "completed_by_person" not in event.data


async def test_an_automation_completing_names_nobody(
    hass: HomeAssistant, mock_config_entry, store, completed_events
) -> None:
    await store.async_add_task("Water the plants")
    await hass.services.async_call(
        DOMAIN, "complete_task", {"list_name": "Test List", "task_title": "Water the plants"},
        blocking=True,
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert not {"completed_by", "completed_by_user_id", "completed_by_person"} & set(event.data)


async def test_todo_entity_companion_app_and_assist(
    hass: HomeAssistant, hass_admin_user, mock_config_entry, store, kevin, completed_events
) -> None:
    """todo.update_item (what the companion app and Assist use) now knows the user too."""
    task = await store.async_add_task("Feed the cat")
    todo_entity = er.async_get(hass).async_get_entity_id("todo", DOMAIN, mock_config_entry.entry_id)
    await hass.services.async_call(
        "todo", "update_item", {"item": "Feed the cat", "status": "completed"},
        target={"entity_id": todo_entity}, blocking=True, context=Context(user_id=kevin),
    )
    await hass.async_block_till_done()

    (event,) = completed_events
    assert event.data["completed_by_person"] == "person.kevin"
    assert store.get_task(task["id"])["history"][-1]["by"] == hass_admin_user.name


async def test_an_assist_completion_right_after_someones_todo_action_names_nobody(
    hass: HomeAssistant, mock_config_entry, store, kevin, completed_events
) -> None:
    """Assist's todo intents call the entity without a context — a context left
    by the previous todo action must not credit them to that user."""
    from homeassistant.components.todo import DOMAIN as TODO_DOMAIN
    from homeassistant.helpers import intent

    await store.async_add_task("Feed the cat")
    await store.async_add_task("Buy milk")
    todo_entity = er.async_get(hass).async_get_entity_id("todo", DOMAIN, mock_config_entry.entry_id)
    # Kevin adds something through a todo action (sets the entity's context) …
    await hass.services.async_call(
        "todo", "add_item", {"item": "Water plants"},
        target={"entity_id": todo_entity}, blocking=True, context=Context(user_id=kevin),
    )
    # … and a moment later someone says "mark buy milk as complete".
    entity = hass.data[TODO_DOMAIN].get_entity(todo_entity)
    await entity.async_update_todo_item(
        TodoItem(uid=next(t["id"] for t in store.tasks if t["title"] == "Buy milk"),
                 summary="Buy milk", status=TodoItemStatus.COMPLETED)
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert "completed_by" not in event.data


async def test_todo_entity_without_a_user(
    hass: HomeAssistant, mock_config_entry, store, completed_events
) -> None:
    await store.async_add_task("Feed the cat")
    todo_entity = er.async_get(hass).async_get_entity_id("todo", DOMAIN, mock_config_entry.entry_id)
    await hass.services.async_call(
        "todo", "update_item", {"item": "Feed the cat", "status": "completed"},
        target={"entity_id": todo_entity}, blocking=True,
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert "completed_by" not in event.data


# ---------------------------------------------------------------------------
# Linked (external) lists
# ---------------------------------------------------------------------------

EXT = "todo.ext_done"


@pytest.fixture
async def ext_entry(hass: HomeAssistant, patch_add_extra_js_url) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN, data={"type": "external", "entity_id": EXT, "name": "Ext"}, title="Ext (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    # The provider's todo entity, as the existing external tests model it.
    mock_entity = MagicMock()
    mock_entity.todo_items = [TodoItem(uid="t1", summary="Mow the lawn", status=TodoItemStatus.NEEDS_ACTION)]
    comp = MagicMock()
    comp.get_entity.return_value = mock_entity
    hass.data["todo"] = comp
    hass.states.async_set(EXT, "1")

    async def _update_item(call):
        pass

    hass.services.async_register("todo", "update_item", _update_item)
    return entry


async def test_linked_list_completion_in_the_card(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, ext_entry, kevin, completed_events
) -> None:
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({
        "type": "home_tasks/update_external_task", "entity_id": EXT, "task_uid": "t1", "completed": True,
    })
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()

    (event,) = completed_events
    assert event.data["entity_id"] == EXT
    assert (event.data["completed_by"], event.data["completed_by_person"]) == (hass_admin_user.name, "person.kevin")
    assert event.context.user_id == kevin


async def test_linked_list_complete_task_service(
    hass: HomeAssistant, hass_admin_user, ext_entry, kevin, completed_events
) -> None:
    await hass.services.async_call(
        DOMAIN, "complete_task", {"entity_id": EXT, "task_title": "Mow the lawn"},
        blocking=True, context=Context(user_id=kevin),
    )
    await hass.async_block_till_done()
    (event,) = completed_events
    assert event.data["completed_by_person"] == "person.kevin"
