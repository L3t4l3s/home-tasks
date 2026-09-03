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
        # A provider that creates the item but never says which one it is.
        self.lose_uid = False

    async def async_create_task(self, fields):
        self.created.append(dict(fields))
        if self.lose_uid:
            return None, {k: v for k, v in fields.items() if k != "title"}
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


async def test_the_backfill_reads_only_lists_that_have_a_picture_to_learn(
    hass: HomeAssistant, linked
) -> None:
    """A remote provider read costs a network call; a list whose overlay holds
    no picture has nothing to teach and is not read at all. One that does
    but cannot be read is remembered for another try (review)."""
    _entry, overlay, _adapter = linked
    hass.data["todo"] = None  # every read fails from here on
    library = async_get_image_library(hass)
    await library.async_load()

    await library.async_backfill()
    assert library.unread_lists == set(), "nothing to learn, so nothing was read"

    await overlay.async_set_overlay("uid-1", image_url="/local/home_tasks/bins.png")
    await library.async_backfill()
    assert library.unread_lists == {EXT_ENTITY}


async def test_the_backfill_tries_again_while_a_list_stays_unread(
    hass: HomeAssistant, freezer
) -> None:
    from datetime import timedelta
    from unittest.mock import AsyncMock

    from homeassistant.util import dt as dt_util
    from pytest_homeassistant_custom_component.common import async_fire_time_changed

    from custom_components.home_tasks import (
        BACKFILL_RETRIES,
        BACKFILL_RETRY_DELAY,
        _async_load_image_library,
    )
    from custom_components.home_tasks.image_library import async_register_image_library

    async_register_image_library(hass)
    library = async_get_image_library(hass)
    library.async_load = AsyncMock()
    outcomes = iter([{"todo.slow"}, {"todo.slow"}, set()])

    async def _backfill():
        library.unread_lists = next(outcomes)
        return 0

    library.async_backfill = AsyncMock(side_effect=_backfill)
    await _async_load_image_library(hass)

    async def _tick(seconds):
        target = dt_util.utcnow() + timedelta(seconds=seconds)
        freezer.move_to(target)
        async_fire_time_changed(hass, target)
        await hass.async_block_till_done()

    await _tick(61)
    assert library.async_backfill.await_count == 1
    await _tick(BACKFILL_RETRY_DELAY + 1)
    assert library.async_backfill.await_count == 2, "still unread, so it came back"
    await _tick(BACKFILL_RETRY_DELAY + 1)
    assert library.async_backfill.await_count == 3, "the third read succeeded"
    for _ in range(BACKFILL_RETRIES):
        await _tick(BACKFILL_RETRY_DELAY + 1)
    assert library.async_backfill.await_count == 3, "and then it stopped"


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


async def test_duplicate_is_the_source_again_not_a_new_task_in_defaults(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    """A native duplicate copies verbatim; the linked one must not pick up
    the list's default assignee, tags or section on the way through the
    create path (review)."""
    _entry, overlay, adapter = linked
    section = await overlay.async_add_section("Default corner")
    await overlay.async_set_defaults(
        assignee="person.anna", tags=["chore"], priority=3, reminders=[30],
        section_id=section["id"],
    )
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 904, assigned_person=None)

    assert msg["success"] is True, msg
    sent = adapter.created[0]
    assert sent["assigned_person"] is None, "nobody means nobody"
    assert "tags" not in sent and "priority" not in sent and "reminders" not in sent
    copy = overlay.get_overlay(msg["result"]["uid"])
    assert copy["section_id"] is None, "the source had no section, so neither has the copy"


async def test_duplicate_of_a_plain_task_carries_no_recurrence_clutter(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    """The merged view fills recurrence_type='interval' and friends on every
    task; those defaults are not the source's data and must not end up in
    the copy's overlay (review)."""
    _entry, overlay, adapter = linked
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 905)

    sent = adapter.created[0]
    assert not [k for k in sent if k.startswith("recurrence_")], sent
    raw = overlay._data["overlays"].get(msg["result"]["uid"], {})
    assert not [k for k in raw if k.startswith("recurrence_")], raw


async def test_duplicate_says_so_when_the_provider_keeps_the_id_to_itself(
    hass: HomeAssistant, hass_ws_client, linked
) -> None:
    """The bare copy exists, but section, picture and sub-tasks could not
    follow - that is a failure to report, not a success with uid null."""
    _entry, overlay, adapter = linked
    section = await overlay.async_add_section("Outdoors")
    await overlay.async_set_overlay("uid-1", section_id=section["id"])
    adapter.lose_uid = True
    client = await hass_ws_client(hass)

    msg = await _duplicate(hass, client, 906)

    assert msg["success"] is False, msg
    assert "did not report its id" in msg["error"]["message"]
    assert len(adapter.created) == 1, "the provider was asked exactly once"


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
