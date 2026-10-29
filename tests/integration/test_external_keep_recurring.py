"""Issue #88 on linked lists: a recurring task deleted, ticked or reopened in
the provider's own app (phone, Thunderbird, HA's to-do view)."""
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks import (
    DATA_RECURRENCE_TIMERS,
    DOMAIN,
    _async_reopen_external_task,
    _cancel_recurrence,
    _handle_external_recurrence_completion,
)
from custom_components.home_tasks import external_watch
from custom_components.home_tasks.external_watch import _ExternalWatch, note_own_change
from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

ENTITY = "todo.ext_keep"
RECURRING = dict(recurrence_enabled=True, recurrence_unit="weeks", recurrence_value=1,
                 recurrence_end_type="count", recurrence_max_count=5)


@pytest.fixture
async def ext_entry(hass: HomeAssistant, patch_add_extra_js_url) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": ENTITY, "name": "Ext Keep"},
        title="Ext Keep (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def _provider(hass: HomeAssistant, items: list[TodoItem]) -> MagicMock:
    """A mock todo entity whose add_item appends a new open item."""
    entity = MagicMock()
    entity.todo_items = items
    comp = MagicMock()
    comp.get_entity.return_value = entity
    hass.data["todo"] = comp
    hass.states.async_set(ENTITY, str(len(items)))

    async def _add_item(call):
        entity.todo_items = [*entity.todo_items, TodoItem(
            uid=f"new{len(entity.todo_items) + 1}", summary=call.data["item"],
            status=TodoItemStatus.NEEDS_ACTION,
        )]
        hass.states.async_set(ENTITY, str(len(entity.todo_items)))

    hass.services.async_register("todo", "add_item", _add_item)
    return entity


def _overlay(hass: HomeAssistant, entry: MockConfigEntry) -> ExternalTaskOverlayStore:
    return hass.data[DOMAIN][entry.entry_id]


def _cleanup(hass: HomeAssistant, *uids: str) -> None:
    for uid in uids:
        _cancel_recurrence(hass, uid)


async def test_completion_keeps_what_the_provider_holds(hass: HomeAssistant, ext_entry) -> None:
    _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED,
                              description="Blue one")])
    await _overlay(hass, ext_entry).async_set_overlay("t1", due_date="2026-10-24", **RECURRING)

    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    overlay = _overlay(hass, ext_entry).get_all_overlays()["t1"]
    assert overlay["recreate"] == {"title": "Bins", "notes": "Blue one", "due_date": "2026-10-24", "due_time": None}
    assert overlay["recurrence_remaining_count"] == 4

    # Reported twice (card and watcher): counted once.
    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    assert _overlay(hass, ext_entry).get_all_overlays()["t1"]["recurrence_remaining_count"] == 4
    _cleanup(hass, "t1")


async def test_cleared_at_the_provider_it_is_put_back_at_its_reopen(hass: HomeAssistant, ext_entry) -> None:
    """Completed, then "clear completed" in another app: at its reopen the
    task is created again, open, with everything the overlay kept."""
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", due_date="2026-10-24", tags=["home"], section_id=None, **RECURRING)
    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    _cleanup(hass, "t1")

    entity.todo_items = []  # cleared in the phone app
    reopened = []
    hass.bus.async_listen(f"{DOMAIN}_task_reopened", lambda e: reopened.append(e.data))

    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")
    await hass.async_block_till_done()

    assert [i.summary for i in entity.todo_items] == ["Bins"]
    new_uid = entity.todo_items[0].uid
    overlays = store.get_all_overlays()
    assert "t1" not in overlays, "the old id's overlay moved"
    moved = overlays[new_uid]
    assert moved["tags"] == ["home"]
    assert moved["recurrence_enabled"] is True
    assert moved["recurrence_remaining_count"] == 4
    assert moved["completed_at"] is None and moved["recreate"] is None
    # Anchored on completion, a reopen leaves the due date as it is - the
    # put-back task too (a provider without due dates keeps it here).
    assert moved["due_date"] == "2026-10-24"
    assert reopened and reopened[0]["task_id"] == new_uid


async def test_still_there_it_is_reopened_not_created(hass: HomeAssistant, ext_entry) -> None:
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])

    async def _update(call):
        return None

    hass.services.async_register("todo", "update_item", _update)
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    _cleanup(hass, "t1")
    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")
    assert [i.uid for i in entity.todo_items] == ["t1"]
    assert store.get_all_overlays()["t1"]["recreate"] is None


async def test_a_list_that_cannot_be_read_loses_nothing(hass: HomeAssistant, ext_entry) -> None:
    """No successful read of the provider, no conclusion that a task is gone."""
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay(
        "t1", completed_at=datetime.now(timezone.utc).isoformat(),
        recreate={"title": "Bins"}, **RECURRING,
    )
    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")  # entity not loaded
    assert store.get_all_overlays()["t1"]["recreate"] == {
        "title": "Bins", "notes": None, "due_date": None, "due_time": None}


# --- the watcher ------------------------------------------------------------------

def _watch(hass: HomeAssistant, entry: MockConfigEntry) -> _ExternalWatch:
    return _ExternalWatch(hass, entry.entry_id, ENTITY)


async def test_ticked_in_the_app_counts_as_completed(hass: HomeAssistant, ext_entry) -> None:
    _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    completed = []
    hass.bus.async_listen(f"{DOMAIN}_task_completed", lambda e: completed.append(e.data))

    watch = _watch(hass, ext_entry)
    await watch.async_check()
    await hass.async_block_till_done()
    overlay = store.get_all_overlays()["t1"]
    assert overlay["completed_at"] and overlay["recurrence_remaining_count"] == 4
    assert "t1" in hass.data[DATA_RECURRENCE_TIMERS]
    assert completed and completed[0]["task_id"] == "t1"
    _cleanup(hass, "t1")


async def test_our_own_tick_is_left_to_our_code(hass: HomeAssistant, ext_entry) -> None:
    _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    note_own_change(hass, ENTITY, "t1")
    await _watch(hass, ext_entry).async_check()
    assert store.get_all_overlays()["t1"]["completed_at"] is None


async def test_reopened_in_the_app_gives_the_occurrence_back(hass: HomeAssistant, ext_entry) -> None:
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    watch = _watch(hass, ext_entry)
    await watch.async_check()  # sees it ticked: 5 -> 4
    assert store.get_all_overlays()["t1"]["recurrence_remaining_count"] == 4

    entity.todo_items = [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.NEEDS_ACTION)]
    await watch.async_check()
    overlay = store.get_all_overlays()["t1"]
    assert overlay["recurrence_remaining_count"] == 5
    assert overlay["completed_at"] is None and overlay["recreate"] is None
    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_an_open_recurring_task_gone_from_the_app_counts_as_done(
    hass: HomeAssistant, ext_entry, monkeypatch
) -> None:
    """Deleted while open (or ticked and cleared between two looks): after it
    stayed gone a while, it counts as done and comes back at its next
    occurrence."""
    clock = [1000.0]
    monkeypatch.setattr(external_watch, "_now", lambda: clock[0])
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.NEEDS_ACTION,
                                       due=datetime(2026, 10, 24).date())])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    watch = _watch(hass, ext_entry)
    await watch.async_check()

    entity.todo_items = []
    await watch.async_check()
    assert store.get_all_overlays()["t1"]["completed_at"] is None, "not after one look"
    clock[0] += 30
    await watch.async_check()
    assert store.get_all_overlays()["t1"]["completed_at"] is None, "not within the wait"
    clock[0] += 40
    await watch.async_check()
    overlay = store.get_all_overlays()["t1"]
    assert overlay["completed_at"]
    assert overlay["recreate"] == {"title": "Bins", "notes": None, "due_date": "2026-10-24", "due_time": None}
    assert overlay["recurrence_remaining_count"] == 4
    watch.cancel()
    _cleanup(hass, "t1")


async def test_back_within_the_wait_nothing_happens(hass: HomeAssistant, ext_entry, monkeypatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(external_watch, "_now", lambda: clock[0])
    items = [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.NEEDS_ACTION)]
    entity = _provider(hass, items)
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    watch = _watch(hass, ext_entry)
    await watch.async_check()
    entity.todo_items = []  # a provider briefly listing nothing
    await watch.async_check()
    entity.todo_items = items
    clock[0] += 120
    await watch.async_check()
    assert store.get_all_overlays()["t1"]["completed_at"] is None
    watch.cancel()


async def test_deleted_in_the_card_stays_deleted(hass: HomeAssistant, ext_entry, monkeypatch) -> None:
    """The card drops the overlay with the item: nothing to keep."""
    clock = [1000.0]
    monkeypatch.setattr(external_watch, "_now", lambda: clock[0])
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.NEEDS_ACTION)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    watch = _watch(hass, ext_entry)
    await watch.async_check()
    entity.todo_items = []
    await store.async_delete_overlay("t1")
    clock[0] += 120
    await watch.async_check()
    await watch.async_check()
    assert "t1" not in store.get_all_overlays()
    watch.cancel()


async def test_an_unavailable_list_changes_nothing(hass: HomeAssistant, ext_entry, monkeypatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(external_watch, "_now", lambda: clock[0])
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.NEEDS_ACTION)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", **RECURRING)
    watch = _watch(hass, ext_entry)
    await watch.async_check()
    entity.todo_items = []
    hass.states.async_set(ENTITY, "unavailable")
    for _ in range(3):
        clock[0] += 120
        await watch.async_check()
    assert store.get_all_overlays()["t1"]["completed_at"] is None
    assert watch.snapshot and "t1" in watch.snapshot, "the last good look is kept"
    watch.cancel()


async def test_put_back_on_a_due_anchored_series_moves_the_due_on(hass: HomeAssistant, ext_entry) -> None:
    entity = _provider(hass, [TodoItem(uid="t1", summary="Bins", status=TodoItemStatus.COMPLETED)])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay("t1", due_date="2026-10-24", recurrence_anchor="due", **RECURRING)
    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    _cleanup(hass, "t1")
    entity.todo_items = []
    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")
    new_uid = entity.todo_items[0].uid
    assert store.get_all_overlays()[new_uid]["due_date"] == "2026-10-31"


async def test_after_a_restart_a_task_gone_at_the_provider_still_reopens(hass: HomeAssistant, ext_entry) -> None:
    """The recovery looks at what the overlay kept, not only at what the
    provider still lists."""
    from custom_components.home_tasks import _recover_external_recurrence_timers

    _provider(hass, [])
    store = _overlay(hass, ext_entry)
    await store.async_set_overlay(
        "t1", completed_at=datetime.now(timezone.utc).isoformat(),
        recreate={"title": "Bins"}, **RECURRING,
    )
    _recover_external_recurrence_timers(hass, ext_entry.entry_id, ENTITY)
    assert "t1" in hass.data.get(DATA_RECURRENCE_TIMERS, {})
    _cleanup(hass, "t1")


async def test_a_change_is_looked_at_soon_also_while_the_first_look_waits(hass: HomeAssistant, ext_entry) -> None:
    """Right after a restart the first look waits for the providers; a change
    in the meantime must not wait with it."""
    watch = _watch(hass, ext_entry)
    watch.schedule(external_watch.FIRST_LOOK_DELAY)
    first = watch._due
    watch.schedule()
    assert watch._due < first
    later = watch._due
    watch.schedule(external_watch.FIRST_LOOK_DELAY)
    assert watch._due == later, "a later request does not push a planned look back"
    watch.cancel()
