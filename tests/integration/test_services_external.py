"""The services work on linked external lists, not only on native ones (#63).

A user could tag a task on a linked list from the card but not from an
automation: every service resolved the list through a native-only lookup and
reported a list that plainly exists as missing. These tests go through the
service layer the way an automation does.
"""
from __future__ import annotations

import pytest
import voluptuous as vol
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from tests.integration.linked_list_helpers import (
    DOMAIN,
    EXT_ENTITY,
    LIST_NAME,
    call,
    overlay,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# The report: tagging a task on a linked list from an automation
# ---------------------------------------------------------------------------

async def test_update_task_tags_a_task_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    entry, _adapter = linked_list

    await call(
        hass, "update_task",
        list_name=LIST_NAME, task_title="Wipe bench", tags="#kitchen",
    )

    assert overlay(hass, entry).get_overlay("uid-1")["tags"] == ["#kitchen"]


async def test_the_entity_can_be_named_directly(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list

    await call(
        hass, "update_task",
        entity_id=EXT_ENTITY, task_title="Wipe bench", priority=1, notes="from an automation",
    )

    stored = overlay(hass, entry).get_overlay("uid-1")
    assert stored["priority"] == 1
    assert stored["notes"] == "from an automation"


async def test_the_provider_is_offered_the_change_first(
    hass: HomeAssistant, linked_list
) -> None:
    """Same route as the card: a provider that syncs labels stores them itself."""
    _entry, adapter = linked_list

    await call(hass, "update_task", list_name=LIST_NAME, task_title="Wipe bench", tags="kitchen")

    assert adapter.updated, "the adapter was asked before the overlay"
    uid, fields = adapter.updated[0]
    assert uid == "uid-1"
    assert fields["tags"] == ["kitchen"]


# ---------------------------------------------------------------------------
# The rest of the family
# ---------------------------------------------------------------------------

async def test_add_task_creates_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await call(hass, "add_task", list_name=LIST_NAME, title="Buy bread", tags="shopping")

    assert adapter.created, "the task went to the provider"
    assert adapter.created[0]["title"] == "Buy bread"
    assert adapter.created[0]["tags"] == ["shopping"]


async def test_complete_task_completes_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    _entry, adapter = linked_list

    await call(hass, "complete_task", list_name=LIST_NAME, task_title="Wipe bench")

    assert ("uid-1", {"completed": True}) in adapter.updated


async def test_complete_task_by_tag_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    _entry, adapter = linked_list
    adapter.labels["uid-1"] = ["kitchen"]

    await call(hass, "complete_task", list_name=LIST_NAME, tag="kitchen")

    assert ("uid-1", {"completed": True}) in adapter.updated


async def test_assign_task_assigns_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list

    await call(
        hass, "assign_task",
        list_name=LIST_NAME, task_title="Wipe bench", person="person.alice",
    )

    assert overlay(hass, entry).get_overlay("uid-1")["assigned_person"] == "person.alice"


async def test_reopen_task_reopens_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await call(hass, "reopen_task", list_name=LIST_NAME, task_title="Old thing")

    assert ("uid-2", {"completed": False}) in adapter.updated


async def test_reopening_an_open_task_does_nothing(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list

    await call(hass, "reopen_task", list_name=LIST_NAME, task_title="Wipe bench")

    assert adapter.updated == []


# ---------------------------------------------------------------------------
# Saying what is actually wrong
# ---------------------------------------------------------------------------

async def test_an_unknown_list_is_still_an_unknown_list(
    hass: HomeAssistant, linked_list
) -> None:
    with pytest.raises((vol.Invalid, Exception)) as err:
        await call(hass, "update_task", list_name="Nowhere", task_title="x", tags="y")
    assert "Nowhere" in str(err.value)


async def test_a_task_that_is_not_there_says_so(hass: HomeAssistant, linked_list) -> None:
    with pytest.raises(Exception) as err:
        await call(
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
        await call(
            hass, "update_task",
            entity_id="todo.never_linked", task_title="Wipe bench", tags="y",
        )
    assert "not a linked list" in str(err.value)

# ---------------------------------------------------------------------------
# Review follow-ups
# ---------------------------------------------------------------------------

async def test_a_native_list_wins_a_shared_name(
    hass: HomeAssistant, linked_list, patch_add_extra_js_url
) -> None:
    """One name must mean one list, whichever service reads it. A native list
    has always won a name it shares with a linked one, so the linked-aware
    resolver follows the same rule as the native-only one."""
    from custom_components.home_tasks import _resolve_store, _resolve_target
    from custom_components.home_tasks.store import HomeTasksStore

    native = MockConfigEntry(domain=DOMAIN, data={"name": LIST_NAME}, title=LIST_NAME)
    native.add_to_hass(hass)
    await hass.config_entries.async_setup(native.entry_id)
    await hass.async_block_till_done()

    kind, ident, store = _resolve_target(hass, {"list_name": LIST_NAME})
    old_ident, old_store = _resolve_store(hass, {"list_name": LIST_NAME})

    assert kind == "native"
    assert ident == old_ident == native.entry_id, "both resolvers agree"
    assert isinstance(store, HomeTasksStore) and store is old_store


async def test_naming_the_list_twice_is_refused(hass: HomeAssistant, linked_list) -> None:
    """A leftover entity_id must not quietly outrank the list_name next to it."""
    with pytest.raises(Exception) as err:
        await call(
            hass, "update_task",
            list_name=LIST_NAME, entity_id=EXT_ENTITY, task_title="Wipe bench", tags="y",
        )
    assert "exactly one" in str(err.value)


async def test_bulk_complete_reads_the_list_once(hass: HomeAssistant, linked_list) -> None:
    """Every task completed used to cost another full read of the provider."""
    entry, adapter = linked_list
    adapter.labels["uid-1"] = ["kitchen"]
    adapter.reads = 0

    await call(hass, "complete_task", list_name=LIST_NAME, tag="kitchen")

    assert ("uid-1", {"completed": True}) in adapter.updated
    assert adapter.reads == 1, f"one read to find them, none per task; got {adapter.reads}"


async def test_reopen_by_title_reads_the_list_once(hass: HomeAssistant, linked_list) -> None:
    _entry, adapter = linked_list
    adapter.reads = 0

    await call(hass, "reopen_task", list_name=LIST_NAME, task_title="Old thing")

    assert ("uid-2", {"completed": False}) in adapter.updated
    assert adapter.reads == 1, f"resolved once, then acted on; got {adapter.reads}"

