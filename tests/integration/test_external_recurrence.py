"""External-list recurrence (issue #27): overlay-driven reopen for providers
that don't own recurrence, deferring to providers that do (e.g. Todoist)."""
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.components.todo import TodoItem, TodoItemStatus
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks import (
    DOMAIN,
    DATA_RECURRENCE_TIMERS,
    DATA_REMINDER_TIMERS,
    _async_reopen_external_task,
    _async_reopen_task,
    _external_owns_recurrence,
    _handle_external_recurrence_completion,
    _recover_external_recurrence_timers,
)
from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore
from custom_components.home_tasks.provider_adapters import ProviderCapabilities

ENTITY = "todo.ext_rec"


@pytest.fixture
async def ext_entry(hass: HomeAssistant, patch_add_extra_js_url) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": ENTITY, "name": "Ext Rec"},
        title="Ext Rec (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def _register_todo_items(hass: HomeAssistant, items: list[TodoItem]) -> MagicMock:
    """Register a mock todo entity so _get_external_todo_items can read it."""
    mock_entity = MagicMock()
    mock_entity.todo_items = items
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set(ENTITY, str(len(items)))
    return mock_entity


def _overlay(hass: HomeAssistant, entry: MockConfigEntry) -> ExternalTaskOverlayStore:
    store = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(store, ExternalTaskOverlayStore)
    return store


def _set_adapter_owns_recurrence(hass: HomeAssistant, owns: bool) -> None:
    adapter = MagicMock()
    adapter.capabilities = ProviderCapabilities(can_sync_recurrence=owns)
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[ENTITY] = adapter


# ---------------------------------------------------------------------------
# _external_owns_recurrence
# ---------------------------------------------------------------------------

async def test_owns_recurrence_false_without_adapter(hass: HomeAssistant, ext_entry) -> None:
    """No adapter registered (generic provider) → we own recurrence."""
    assert _external_owns_recurrence(hass, ENTITY) is False


async def test_owns_recurrence_true_for_capable_adapter(hass: HomeAssistant, ext_entry) -> None:
    """An adapter declaring can_sync_recurrence → provider owns it."""
    _set_adapter_owns_recurrence(hass, True)
    assert _external_owns_recurrence(hass, ENTITY) is True


async def test_owns_recurrence_false_for_incapable_adapter(hass: HomeAssistant, ext_entry) -> None:
    _set_adapter_owns_recurrence(hass, False)
    assert _external_owns_recurrence(hass, ENTITY) is False


# ---------------------------------------------------------------------------
# _handle_external_recurrence_completion
# ---------------------------------------------------------------------------

async def test_completion_schedules_reopen(hass: HomeAssistant, ext_entry) -> None:
    """Completing a recurring external task schedules a reopen timer + stamps completed_at."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_type="interval",
        recurrence_unit="days", recurrence_value=1,
    )

    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")

    # completed_at stamped into overlay
    ov = _overlay(hass, ext_entry).get_all_overlays()["t1"]
    assert ov["completed_at"] is not None
    # reopen timer scheduled
    assert "t1" in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_completion_skipped_when_provider_owns_recurrence(hass: HomeAssistant, ext_entry) -> None:
    """Provider owns recurrence (Todoist) → we do NOT schedule or stamp anything."""
    _set_adapter_owns_recurrence(hass, True)
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
    )

    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")

    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})
    assert _overlay(hass, ext_entry).get_all_overlays()["t1"].get("completed_at") is None


async def test_completion_non_recurring_does_nothing(hass: HomeAssistant, ext_entry) -> None:
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="One-off", status=TodoItemStatus.COMPLETED),
    ])
    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")
    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_completion_count_exhaustion_disables(hass: HomeAssistant, ext_entry) -> None:
    """Last occurrence of a count-limited series disables recurrence, no reopen."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Last one", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        recurrence_end_type="count", recurrence_remaining_count=1,
    )

    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")

    ov = _overlay(hass, ext_entry).get_all_overlays()["t1"]
    assert ov["recurrence_enabled"] is False
    assert ov["recurrence_remaining_count"] == 0
    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_completion_count_decrements_and_schedules(hass: HomeAssistant, ext_entry) -> None:
    """A count-limited series with >1 remaining decrements and still reopens."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Series", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        recurrence_end_type="count", recurrence_remaining_count=3,
    )

    await _handle_external_recurrence_completion(hass, ext_entry.entry_id, ENTITY, "t1")

    ov = _overlay(hass, ext_entry).get_all_overlays()["t1"]
    assert ov["recurrence_enabled"] is True
    assert ov["recurrence_remaining_count"] == 2
    assert "t1" in hass.data.get(DATA_RECURRENCE_TIMERS, {})


# ---------------------------------------------------------------------------
# _async_reopen_external_task
# ---------------------------------------------------------------------------

async def test_reopen_flips_item_clears_completed_at_and_fires(hass: HomeAssistant, ext_entry) -> None:
    """Reopen calls the provider to flip the item, clears completed_at, fires reopened."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        completed_at=datetime.now(timezone.utc).isoformat(),
        sub_items=[{"id": "s1", "title": "step", "completed": True}],
    )

    calls = []

    async def _fake_update(call):
        calls.append(dict(call.data))

    hass.services.async_register("todo", "update_item", _fake_update)

    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_reopened", lambda e: events.append(e))

    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")
    await hass.async_block_till_done()

    # provider was asked to reopen the item
    assert any(c.get("status") == "needs_action" for c in calls)
    # overlay completed_at cleared + sub-items reset
    ov = _overlay(hass, ext_entry).get_all_overlays()["t1"]
    assert ov["completed_at"] is None
    assert ov["sub_items"][0]["completed"] is False
    # event fired
    assert len(events) == 1
    assert events[0].data["task_title"] == "Recurring"


async def test_reopen_noop_when_recurrence_disabled(hass: HomeAssistant, ext_entry) -> None:
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Plain", status=TodoItemStatus.COMPLETED),
    ])
    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_reopened", lambda e: events.append(e))
    await _async_reopen_external_task(hass, ext_entry.entry_id, ENTITY, "t1")
    await hass.async_block_till_done()
    assert events == []


# ---------------------------------------------------------------------------
# _async_reopen_task dispatch to external
# ---------------------------------------------------------------------------

async def test_native_reopen_dispatches_to_external(hass: HomeAssistant, ext_entry, monkeypatch) -> None:
    """The shared reopen entrypoint routes external stores to the external handler."""
    seen = {}

    async def _spy(hass_, entry_id, entity_id, uid):
        seen.update(entry_id=entry_id, entity_id=entity_id, uid=uid)

    monkeypatch.setattr("custom_components.home_tasks._async_reopen_external_task", _spy)
    await _async_reopen_task(hass, ext_entry.entry_id, "t1")
    assert seen == {"entry_id": ext_entry.entry_id, "entity_id": ENTITY, "uid": "t1"}


# ---------------------------------------------------------------------------
# _recover_external_recurrence_timers
# ---------------------------------------------------------------------------

async def test_recover_schedules_future_reopen(hass: HomeAssistant, ext_entry) -> None:
    """Startup recovery reschedules a reopen for a completed recurring task."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        completed_at=datetime.now(timezone.utc).isoformat(),
    )

    _recover_external_recurrence_timers(hass, ext_entry.entry_id, ENTITY)

    assert "t1" in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_recover_skipped_when_provider_owns(hass: HomeAssistant, ext_entry) -> None:
    _set_adapter_owns_recurrence(hass, True)
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        completed_at=datetime.now(timezone.utc).isoformat(),
    )

    _recover_external_recurrence_timers(hass, ext_entry.entry_id, ENTITY)

    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})


async def test_manual_reopen_via_ws_clears_completed_at(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """Manually reopening a recurring external task clears the stale completion stamp."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
        completed_at=datetime.now(timezone.utc).isoformat(),
    )

    async def _fake_update(call):
        return None

    hass.services.async_register("todo", "update_item", _fake_update)

    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 70,
        "type": "home_tasks/update_external_task",
        "entity_id": ENTITY,
        "task_uid": "t1",
        "completed": False,
    })
    msg = await client.receive_json()
    assert msg["success"] is True
    await hass.async_block_till_done()

    assert _overlay(hass, ext_entry).get_all_overlays()["t1"].get("completed_at") is None


async def test_delete_external_overlay_cancels_timers(
    hass: HomeAssistant, hass_ws_client, ext_entry
) -> None:
    """Deleting an external task cancels its pending reminder + recurrence timers."""
    cancelled = []
    hass.data.setdefault(DATA_REMINDER_TIMERS, {})["t1_r0"] = lambda: cancelled.append("rem")
    hass.data.setdefault(DATA_RECURRENCE_TIMERS, {})["t1"] = lambda: cancelled.append("rec")
    # an unrelated task's timer must survive
    hass.data[DATA_RECURRENCE_TIMERS]["other"] = lambda: cancelled.append("other")

    client = await hass_ws_client(hass)
    await client.send_json({
        "id": 71,
        "type": "home_tasks/delete_external_overlay",
        "entity_id": ENTITY,
        "task_uid": "t1",
    })
    msg = await client.receive_json()
    assert msg["success"] is True

    assert "t1_r0" not in hass.data[DATA_REMINDER_TIMERS]
    assert "t1" not in hass.data[DATA_RECURRENCE_TIMERS]
    assert "other" in hass.data[DATA_RECURRENCE_TIMERS]
    assert set(cancelled) == {"rem", "rec"}


async def test_recover_immediate_reopen_for_past_target(hass: HomeAssistant, ext_entry) -> None:
    """A backdated completed_at (target already passed) reopens immediately."""
    _register_todo_items(hass, [
        TodoItem(uid="t1", summary="Recurring", status=TodoItemStatus.COMPLETED),
    ])
    await _overlay(hass, ext_entry).async_set_overlay(
        "t1", recurrence_enabled=True, recurrence_unit="hours", recurrence_value=1,
        completed_at=(datetime.now(timezone.utc) - timedelta(hours=3)).isoformat(),
    )

    calls = []

    async def _fake_update(call):
        calls.append(dict(call.data))

    hass.services.async_register("todo", "update_item", _fake_update)
    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_reopened", lambda e: events.append(e))

    _recover_external_recurrence_timers(hass, ext_entry.entry_id, ENTITY)
    await hass.async_block_till_done()

    # delay <= 0 → reopen ran immediately (no pending timer, item flipped, event fired)
    assert "t1" not in hass.data.get(DATA_RECURRENCE_TIMERS, {})
    assert any(c.get("status") == "needs_action" for c in calls)
    assert len(events) == 1
