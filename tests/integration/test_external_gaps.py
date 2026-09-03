"""Three places where a linked list quietly got less than a native one.

* The image library's backfill only read native lists, so a picture already
  on a linked task was never learned and the same title elsewhere paid again.
* move_task with a linked source insisted on task_id, while every other
  service - and a native source - takes the title.
* Duplicate did not exist for linked lists at all.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks.image_library import async_get_image_library
from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.linked_gaps"
LIST_NAME = "Linked Gaps"


from custom_components.home_tasks.provider_adapters import GenericAdapter


class _Adapter(GenericAdapter):
    """A generic provider (CalDAV, local todo): syncs nothing beyond the base
    fields, so the merged view is built from the overlay - which is where a
    duplicate has to read the source's tags, priority and sub-tasks from."""

    def __init__(self, hass, entity_id: str) -> None:
        from custom_components.home_tasks.provider_adapters import ProviderCapabilities

        super().__init__(hass, entity_id, {})
        self.capabilities = ProviderCapabilities()
        self.created: list[dict] = []
        self.sub_tasks: list[tuple[str, str]] = []
        self._next = 0

    async def async_create_task(self, fields):
        self.created.append(dict(fields))
        self._next += 1
        uid = f"uid-copy-{self._next}"
        # The provider now holds the copy, so later reads must see it.
        entity = self._hass.data["todo"].get_entity(self._entity_id)
        entity.todo_items.append(
            TodoItem(uid=uid, summary=fields.get("title", ""), status=TodoItemStatus.NEEDS_ACTION)
        )
        return uid, {k: v for k, v in fields.items() if k != "title"}

    async def async_update_task(self, task_uid, fields):
        return dict(fields)

    async def async_add_sub_task(self, parent_uid, title):
        self.sub_tasks.append((parent_uid, title))
        return f"sub-{len(self.sub_tasks)}"

    async def async_read_tasks(self):
        from custom_components.home_tasks.provider_adapters import _get_external_todo_items

        return _get_external_todo_items(self._hass, self._entity_id)


@pytest.fixture
async def linked(hass: HomeAssistant, patch_add_extra_js_url):
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
        TodoItem(uid="uid-1", summary="Take out the bins", status=TodoItemStatus.NEEDS_ACTION),
    ]
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set(EXT_ENTITY, "1")

    adapter = _Adapter(hass, EXT_ENTITY)
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[EXT_ENTITY] = adapter
    overlay = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(overlay, ExternalTaskOverlayStore)
    return entry, overlay, adapter


# ---------------------------------------------------------------------------
# 1. Backfill
# ---------------------------------------------------------------------------

async def test_the_backfill_learns_pictures_on_linked_lists(hass: HomeAssistant, linked) -> None:
    _entry, overlay, _adapter = linked
    await overlay.async_set_overlay("uid-1", image_url="/local/home_tasks/bins.png")
    library = async_get_image_library(hass)
    await library.async_load()
    assert library.find("Take out the bins") is None, "nothing known yet"

    learned = await library.async_backfill()

    assert learned == 1
    assert library.find("Take out the bins") == "/local/home_tasks/bins.png"


async def test_a_linked_list_that_keeps_to_itself_stays_out_of_the_backfill(
    hass: HomeAssistant, linked
) -> None:
    _entry, overlay, _adapter = linked
    await overlay.async_set_settings(share_images=False)
    await overlay.async_set_overlay("uid-1", image_url="/local/home_tasks/private.png")
    library = async_get_image_library(hass)
    await library.async_load()

    await library.async_backfill()

    assert library.find("Take out the bins") is None


# ---------------------------------------------------------------------------
# 2. move_task by title from a linked source
# ---------------------------------------------------------------------------

async def test_move_task_takes_a_title_for_a_linked_source(
    hass: HomeAssistant, linked, mock_config_entry, store
) -> None:
    from unittest.mock import AsyncMock, patch

    with patch(
        "custom_components.home_tasks.async_move_task_any", new=AsyncMock()
    ) as move:
        await hass.services.async_call(
            DOMAIN, "move_task",
            {
                "source_entity_id": EXT_ENTITY, "task_title": "Take out the bins",
                "target_entry_id": mock_config_entry.entry_id,
            },
            blocking=True,
        )
        await hass.async_block_till_done()

    assert move.await_count == 1
    assert move.await_args.kwargs["task_id"] == "uid-1", "the title was resolved to the uid"
    assert move.await_args.kwargs["src_entity_id"] == EXT_ENTITY


async def test_move_task_still_wants_some_way_to_name_the_task(
    hass: HomeAssistant, linked, mock_config_entry
) -> None:
    with pytest.raises(Exception) as err:
        await hass.services.async_call(
            DOMAIN, "move_task",
            {"source_entity_id": EXT_ENTITY, "target_entry_id": mock_config_entry.entry_id},
            blocking=True,
        )
    assert "task_id or task_title" in str(err.value)


# ---------------------------------------------------------------------------
# 3. Duplicate on a linked list
# ---------------------------------------------------------------------------

async def _duplicate(hass, client, msg_id, **extra):
    await client.send_json({
        "id": msg_id, "type": "home_tasks/duplicate_external_task",
        "entity_id": EXT_ENTITY, "task_uid": "uid-1", **extra,
    })
    return await client.receive_json()


async def test_duplicate_copies_everything_the_source_has(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    _entry, overlay, adapter = linked
    section = await overlay.async_add_section("Outdoors")
    await overlay.async_set_overlay(
        "uid-1",
        tags=["chore"], priority=2, reminders=[15], notes="every week",
        section_id=section["id"], image_url="/local/home_tasks/bins.png",
        recurrence_enabled=True, recurrence_type="interval",
        recurrence_value=1, recurrence_unit="weeks",
    )
    await overlay.async_add_sub_task("uid-1", "Bring the bin back")
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 900, assigned_person="person.alice")

    assert msg["success"] is True, msg
    new_uid = msg["result"]["uid"]
    assert new_uid and new_uid != "uid-1"

    sent = adapter.created[0]
    assert sent["title"] == "Take out the bins"
    assert sent["tags"] == ["chore"] and sent["priority"] == 2
    assert sent["reminders"] == [15] and sent["notes"] == "every week"
    assert sent["recurrence_enabled"] is True and sent["recurrence_unit"] == "weeks"
    assert sent["assigned_person"] == "person.alice", "duplicate-for-someone-else"

    copy = overlay.get_overlay(new_uid)
    assert copy["section_id"] == section["id"], "the section is ours, so it is copied here"
    assert copy["image_url"] == "/local/home_tasks/bins.png"
    assert [s["title"] for s in copy["sub_items"]] == ["Bring the bin back"]
    assert all(not s["completed"] for s in copy["sub_items"]), "fresh, open copies"


async def test_duplicate_can_drop_the_assignee(hass: HomeAssistant, hass_ws_client, linked) -> None:
    _entry, overlay, adapter = linked
    await overlay.async_set_overlay("uid-1", assigned_person="person.alice")
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 901, assigned_person=None)

    assert msg["success"] is True, msg
    assert adapter.created[0]["assigned_person"] is None


async def test_duplicate_hands_sub_tasks_to_a_provider_that_syncs_them(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    from custom_components.home_tasks.provider_adapters import ProviderCapabilities

    _entry, overlay, adapter = linked
    adapter.capabilities = ProviderCapabilities(can_sync_sub_items=True)
    await overlay.async_add_sub_task("uid-1", "Bring the bin back")
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 902)

    new_uid = msg["result"]["uid"]
    assert adapter.sub_tasks == [(new_uid, "Bring the bin back")]
    assert overlay.get_overlay(new_uid)["sub_items"] == [], "not kept locally as well"


async def test_duplicating_a_task_that_is_not_there_says_so(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 903, "type": "home_tasks/duplicate_external_task",
        "entity_id": EXT_ENTITY, "task_uid": "uid-nope",
    })
    msg = await client.receive_json()
    assert msg["success"] is False
    assert "not found" in msg["error"]["message"]
