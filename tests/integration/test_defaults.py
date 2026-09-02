"""Per-list defaults for new tasks: tags, priority and section on top of the
assignee and reminders that were there before, and the same for external lists.

The point of defaults living in the integration rather than in the card is that
they apply no matter who creates the task, so these tests go through the store
and the WebSocket layer, not through a card.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.ext_defaults"


# ---------------------------------------------------------------------------
# Native lists
# ---------------------------------------------------------------------------

async def test_a_new_task_starts_with_the_lists_defaults(hass: HomeAssistant, store) -> None:
    section = await store.async_add_section("Kitchen")
    await store.async_set_defaults(
        tags=["chore"], priority=2, section_id=section["id"], assignee="person.alice"
    )

    task = await store.async_add_task("Wipe the counter")

    assert task["tags"] == ["chore"]
    assert task["priority"] == 2
    assert task["section_id"] == section["id"]
    assert task["assigned_person"] == "person.alice"


async def test_what_the_caller_says_wins(hass: HomeAssistant, store) -> None:
    section = await store.async_add_section("Kitchen")
    other = await store.async_add_section("Garden")
    await store.async_set_defaults(tags=["chore"], priority=2, section_id=section["id"])

    task = await store.async_add_task(
        "Mow the lawn", tags=["outdoors"], priority=1, section_id=other["id"]
    )

    assert task["tags"] == ["outdoors"]
    assert task["priority"] == 1
    assert task["section_id"] == other["id"]


async def test_an_explicit_empty_list_is_not_a_missing_one(hass: HomeAssistant, store) -> None:
    """[] means "no tags", the same rule reminders already followed."""
    await store.async_set_defaults(tags=["chore"])

    assert (await store.async_add_task("With"))["tags"] == ["chore"]
    assert (await store.async_add_task("Without", tags=[]))["tags"] == []


async def test_setting_one_default_leaves_the_others_alone(hass: HomeAssistant, store) -> None:
    await store.async_set_defaults(tags=["chore"], priority=3, assignee="person.alice")

    after = await store.async_set_defaults(priority=1)

    assert after == {
        "assignee": "person.alice", "reminders": [],
        "tags": ["chore"], "priority": 1, "section_id": None,
    }


async def test_a_default_section_cannot_point_at_a_stranger(hass: HomeAssistant, store) -> None:
    with pytest.raises(ValueError):
        await store.async_set_defaults(section_id="no-such-section")


async def test_deleting_the_section_clears_the_default(hass: HomeAssistant, store) -> None:
    """Otherwise every new task would be filed into a section that is gone."""
    section = await store.async_add_section("Kitchen")
    await store.async_set_defaults(section_id=section["id"])

    await store.async_delete_section(section["id"])

    assert store.get_defaults()["section_id"] is None
    assert (await store.async_add_task("Still works"))["section_id"] is None


async def test_a_stale_default_section_does_not_break_creation(hass: HomeAssistant, store) -> None:
    """Belt and braces: a default left over from an older version, or from a
    section removed behind the store's back, must not make the list unusable.
    """
    section = await store.async_add_section("Kitchen")
    await store.async_set_defaults(section_id=section["id"])
    store._data["sections"] = []

    task = await store.async_add_task("Orphan")

    assert task["section_id"] is None


async def test_defaults_apply_to_every_creation_path(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    await store.async_set_defaults(tags=["chore"], priority=3)
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 1, "type": "home_tasks/add_task",
        "list_id": mock_config_entry.entry_id, "title": "Via WebSocket",
    })
    msg = await client.receive_json()

    assert msg["success"] is True, msg
    assert msg["result"]["tags"] == ["chore"]
    assert msg["result"]["priority"] == 3


async def test_the_websocket_round_trip_carries_the_new_fields(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    section = await store.async_add_section("Kitchen")
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 10, "type": "home_tasks/set_defaults",
        "list_id": mock_config_entry.entry_id,
        "tags": ["chore"], "priority": 2, "section_id": section["id"],
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    await client.send_json({
        "id": 11, "type": "home_tasks/get_defaults", "list_id": mock_config_entry.entry_id,
    })
    msg = await client.receive_json()
    assert msg["result"]["defaults"] == {
        "assignee": None, "reminders": [],
        "tags": ["chore"], "priority": 2, "section_id": section["id"],
    }


# ---------------------------------------------------------------------------
# External lists
# ---------------------------------------------------------------------------

@pytest.fixture
async def ext_entry(hass: HomeAssistant, patch_add_extra_js_url):
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": EXT_ENTITY, "name": "Ext Defaults"},
        title="Ext Defaults (External)",
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


def _overlay(hass: HomeAssistant, entry) -> ExternalTaskOverlayStore:
    store = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(store, ExternalTaskOverlayStore)
    return store


async def test_an_external_list_has_defaults_too(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """The whole point of doing this in the overlay store: most of the lists
    people point this card at are not native ones.
    """
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 20, "type": "home_tasks/add_section", "entity_id": EXT_ENTITY, "name": "Errands",
    })
    section_id = (await client.receive_json())["result"]["id"]

    await client.send_json({
        "id": 21, "type": "home_tasks/set_defaults", "entity_id": EXT_ENTITY,
        "tags": ["shopping"], "priority": 1, "section_id": section_id,
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    await client.send_json({
        "id": 22, "type": "home_tasks/get_defaults", "entity_id": EXT_ENTITY,
    })
    msg = await client.receive_json()
    assert msg["result"]["defaults"]["tags"] == ["shopping"]
    assert msg["result"]["defaults"]["priority"] == 1
    assert msg["result"]["defaults"]["section_id"] == section_id


class _Adapter:
    """A provider that can sync nothing, like a plain CalDAV list: whatever it
    is handed comes straight back as "you keep this one"."""

    def __init__(self) -> None:
        from custom_components.home_tasks.provider_adapters import ProviderCapabilities

        self.capabilities = ProviderCapabilities()
        self.created: list[dict] = []

    async def async_create_task(self, fields):
        self.created.append(dict(fields))
        unsynced = {k: v for k, v in fields.items() if k != "title"}
        return "uid-new", unsynced


async def test_a_task_created_on_an_external_list_gets_them(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    overlay = _overlay(hass, ext_entry)
    section = await overlay.async_add_section("Errands")
    await overlay.async_set_defaults(
        tags=["shopping"], priority=1, section_id=section["id"], assignee="person.alice"
    )
    adapter = _Adapter()
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 30, "type": "home_tasks/create_external_task",
        "entity_id": EXT_ENTITY, "title": "Bread",
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    # The provider is offered them first - one that syncs labels or priority
    # should store them itself rather than leave them to the overlay.
    assert adapter.created[0]["tags"] == ["shopping"]
    assert adapter.created[0]["priority"] == 1
    assert adapter.created[0]["assigned_person"] == "person.alice"

    stored = overlay.get_overlay("uid-new")
    assert stored["tags"] == ["shopping"]
    assert stored["priority"] == 1
    assert stored["assigned_person"] == "person.alice"
    # Sections are ours alone, so that one never goes past the overlay.
    assert stored["section_id"] == section["id"]


async def test_an_external_caller_still_wins(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    overlay = _overlay(hass, ext_entry)
    await overlay.async_set_defaults(tags=["shopping"], priority=1)
    adapter = _Adapter()
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 40, "type": "home_tasks/create_external_task",
        "entity_id": EXT_ENTITY, "title": "Bread", "tags": ["urgent"], "priority": 3,
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    assert adapter.created[0]["tags"] == ["urgent"]
    assert adapter.created[0]["priority"] == 3


async def test_deleting_an_external_section_clears_its_default(
    hass: HomeAssistant, ext_entry
) -> None:
    overlay = _overlay(hass, ext_entry)
    section = await overlay.async_add_section("Errands")
    await overlay.async_set_defaults(section_id=section["id"])

    await overlay.async_delete_section(section["id"])

    assert overlay.get_defaults()["section_id"] is None


# ---------------------------------------------------------------------------
# "Explicit beats default" has to hold at every door (review follow-up).
# ---------------------------------------------------------------------------

async def test_an_explicit_empty_list_wins_on_an_external_list_too(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """[] means "none" here as much as on a native list."""
    overlay = _overlay(hass, ext_entry)
    await overlay.async_set_defaults(tags=["chore"], reminders=[15])
    adapter = _Adapter()
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 50, "type": "home_tasks/create_external_task",
        "entity_id": EXT_ENTITY, "title": "Nothing on this one",
        "tags": [], "reminders": [],
    })
    msg = await client.receive_json()
    assert msg["success"] is True, msg

    assert adapter.created[0]["tags"] == []
    assert adapter.created[0]["reminders"] == []


async def test_the_service_puts_its_tags_in_at_creation(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """As a follow-up update they arrived after task_created had already gone
    out carrying the list's default tags, and left an "updated" entry in the
    history of a task that was one call old.
    """
    await store.async_set_defaults(tags=["chore"])
    events: list[dict] = []
    hass.bus.async_listen(f"{DOMAIN}_task_created", lambda e: events.append(dict(e.data)))

    await hass.services.async_call(
        DOMAIN, "add_task",
        {"entry_id": mock_config_entry.entry_id, "title": "Urgent one", "tags": "urgent"},
        blocking=True,
    )
    await hass.async_block_till_done()

    task = next(t for t in store.tasks if t["title"] == "Urgent one")
    assert task["tags"] == ["urgent"]
    assert [h["action"] for h in task["history"]] == ["created"], "no update on a new task"
    assert events and events[0].get("tags") == ["urgent"], "the event says what was asked for"


async def test_the_service_still_falls_back_to_the_default(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await store.async_set_defaults(tags=["chore"])

    await hass.services.async_call(
        DOMAIN, "add_task",
        {"entry_id": mock_config_entry.entry_id, "title": "Plain one"},
        blocking=True,
    )
    await hass.async_block_till_done()

    assert next(t for t in store.tasks if t["title"] == "Plain one")["tags"] == ["chore"]


async def test_a_websocket_caller_can_say_no_to_the_defaults(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """The card is a WebSocket client: without these fields it could only ever
    create tasks that carry the list's defaults.
    """
    section = await store.async_add_section("Kitchen")
    await store.async_set_defaults(tags=["chore"], priority=3, section_id=section["id"])
    client = await hass_ws_client(hass)

    other = await store.async_add_section("Garden")
    await client.send_json({
        "id": 60, "type": "home_tasks/add_task",
        "list_id": mock_config_entry.entry_id, "title": "On its own terms",
        "tags": [], "priority": 1, "section_id": other["id"],
    })
    msg = await client.receive_json()

    assert msg["success"] is True, msg
    assert msg["result"]["tags"] == [], "an empty list is a decision, not a gap"
    assert msg["result"]["priority"] == 1
    assert msg["result"]["section_id"] == other["id"]


async def test_null_is_not_a_way_to_say_none(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    """For the scalar fields, null has always meant "not provided" - that is
    how the assignee default has worked since it existed. Only the list fields
    can be emptied explicitly.
    """
    await store.async_set_defaults(priority=3, assignee="person.alice")
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 62, "type": "home_tasks/add_task",
        "list_id": mock_config_entry.entry_id, "title": "Null everywhere",
        "priority": None, "assigned_person": None,
    })
    msg = await client.receive_json()

    assert msg["result"]["priority"] == 3
    assert msg["result"]["assigned_person"] == "person.alice"


async def test_and_gets_them_when_it_stays_quiet(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store
) -> None:
    await store.async_set_defaults(tags=["chore"], priority=3)
    client = await hass_ws_client(hass)

    await client.send_json({
        "id": 61, "type": "home_tasks/add_task",
        "list_id": mock_config_entry.entry_id, "title": "Whatever the list says",
    })
    msg = await client.receive_json()

    assert msg["result"]["tags"] == ["chore"]
    assert msg["result"]["priority"] == 3

