"""External completions, provider ordering and bounded reads of day plans."""
from __future__ import annotations

import asyncio

import pytest
from homeassistant.components.todo import TodoItemStatus
from homeassistant.util import dt as dt_util

from custom_components.home_tasks import plan as plan_module
from tests.integration.linked_list_helpers import EXT_ENTITY, overlay, setup_linked_list
from tests.integration.test_plan import (
    MON, TUE, _add_plan, _at, _call, _days, _task, _today, monday, plan, titles,
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("placement", ["planned", "due", "sorted_due"])
async def test_external_completion_is_saved_and_survives_restart(hass, plan, freezer, placement):
    linked, _adapter = await setup_linked_list(hass)
    if placement == "planned":
        await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    else:
        await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
        if placement == "sorted_due":
            await _call(hass, "set_day_plan", items=[{"task_id": "uid-1", "entry_id": linked.entry_id}])
    assert titles(await _today(hass)) == ["Wipe bench"]

    hass.data["todo"].get_entity.return_value.todo_items[0].status = TodoItemStatus.COMPLETED
    hass.states.async_set(EXT_ENTITY, "0")
    await hass.async_block_till_done()
    # No dashboard read is needed to record the completion.
    stored = plan_module.plan_store(hass, plan.entry_id).days[MON]["items"]
    assert next(item for item in stored if item["task_id"] == "uid-1")["done_on"] == MON
    assert [(row["title"], row["completed"]) for row in (await _today(hass))["items"]] == [("Wipe bench", True)]

    assert await hass.config_entries.async_unload(plan.entry_id)
    freezer.move_to(_at(TUE))
    assert await hass.config_entries.async_setup(plan.entry_id)
    await hass.async_block_till_done()
    assert (await _days(hass, date=MON))[0]["items"][0]["completed"] is True


async def test_external_completion_seen_on_read_is_persisted(hass, plan, freezer):
    linked, _adapter = await setup_linked_list(hass)
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    # Even a provider that does not report its state is caught on a read.
    hass.data["todo"].get_entity.return_value.todo_items[0].status = TodoItemStatus.COMPLETED
    assert (await _today(hass))["items"][0]["completed"] is True
    freezer.move_to(_at(TUE))
    assert (await _days(hass, date=MON))[0]["items"][0]["completed"] is True


async def test_old_completed_provider_tasks_do_not_become_done_today(hass, plan):
    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-2", due_date=MON)
    assert (await _today(hass))["items"] == []
    assert MON not in plan_module.plan_store(hass, plan.entry_id).days


async def test_external_untick_takes_back_only_todays_completion(hass, plan):
    linked, _adapter = await setup_linked_list(hass)
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    item = hass.data["todo"].get_entity.return_value.todo_items[0]
    item.status = TodoItemStatus.COMPLETED
    assert (await _today(hass))["items"][0]["completed"] is True
    item.status = TodoItemStatus.NEEDS_ACTION
    assert (await _today(hass))["items"][0]["completed"] is False


async def test_provider_recurrence_reopen_keeps_todays_done(hass, plan):
    from custom_components.home_tasks.external_watch import own_change

    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay(
        "uid-1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
    )
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    item = hass.data["todo"].get_entity.return_value.todo_items[0]
    item.status = TodoItemStatus.COMPLETED
    assert (await _today(hass))["items"][0]["completed"] is True
    with own_change(hass, EXT_ENTITY, "uid-1"):
        item.status = TodoItemStatus.NEEDS_ACTION
        assert (await _today(hass))["items"][0]["completed"] is True


async def test_manual_recurring_untick_in_provider_takes_back_done(hass, plan):
    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay(
        "uid-1", recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
    )
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    item = hass.data["todo"].get_entity.return_value.todo_items[0]
    item.status = TodoItemStatus.COMPLETED
    assert (await _today(hass))["items"][0]["completed"] is True
    item.status = TodoItemStatus.NEEDS_ACTION
    assert (await _today(hass))["items"][0]["completed"] is False


async def test_provider_temporarily_without_items_keeps_completion_baseline(hass, plan):
    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    assert titles(await _today(hass)) == ["Wipe bench"]
    provider = hass.data["todo"].get_entity.return_value
    items = provider.todo_items
    provider.todo_items = None
    await _today(hass)
    items[0].status = TodoItemStatus.COMPLETED
    provider.todo_items = items
    assert (await _today(hass))["items"][0]["completed"] is True


@pytest.mark.parametrize("change", ["note", "add_task", "complete_task"])
async def test_writes_keep_the_provider_priority_order(hass, plan, store, monkeypatch, mock_config_entry, change):
    linked, adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    adapter.capabilities.can_sync_priority = True
    read = adapter.async_read_tasks

    async def read_priorities():
        items = await read()
        for item in items:
            if item["uid"] == "uid-1":
                item["priority"] = 3
        return items

    monkeypatch.setattr(adapter, "async_read_tasks", read_priorities)
    low = await _task(store, "Low priority", due_date=MON, priority=1)
    assert titles(await _today(hass)) == ["Wipe bench", "Low priority"]
    if change == "note":
        await _call(hass, "set_day_plan", items=[], note="Focus")
    elif change == "add_task":
        extra = await _task(store, "Extra")
        await _call(hass, "plan_task", task_id=extra)
    else:
        await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=low)
    assert titles(await _today(hass))[:2] == ["Wipe bench", "Low priority"]


async def test_slow_provider_falls_back_without_blocking_native_tasks(hass, mock_config_entry, store, monkeypatch):
    await _add_plan(hass)
    linked, adapter = await setup_linked_list(hass)
    await _task(store, "Native due", due_date=dt_util.now().date().isoformat())
    adapter.capabilities.can_sync_labels = True
    adapter.labels["uid-1"] = ["shop"]
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    assert (await _today(hass))["items"][1]["tags"] == ["shop"]
    cancelled = asyncio.Event()

    async def slow_read():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(adapter, "async_read_tasks", slow_read)
    monkeypatch.setattr(plan_module, "PLAN_PROVIDER_TIMEOUT", 0.02)
    day = await asyncio.wait_for(_today(hass), timeout=1)
    assert titles(day) == ["Native due", "Wipe bench"]
    assert day["items"][1]["tags"] == ["shop"]
    assert cancelled.is_set()


async def test_slow_providers_share_one_time_budget(hass, mock_config_entry, store, monkeypatch):
    await _add_plan(hass)
    linked, adapter = await setup_linked_list(hass)
    # Two sources share this provider in the read helper: neither may wait
    # for the other's timeout before it is even asked.
    started = 0
    both_started = asyncio.Event()

    async def slow_read():
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await both_started.wait()
        return []

    sources = plan_module.read_lists(hass)
    sources = [src for src in sources if src.entry_id == linked.entry_id]
    monkeypatch.setattr(plan_module, "read_lists", lambda *_args: sources + sources)
    monkeypatch.setattr(adapter, "async_read_tasks", slow_read)
    monkeypatch.setattr(plan_module, "PLAN_PROVIDER_TIMEOUT", 0.1)
    await asyncio.wait_for(plan_module.async_read_lists(hass), timeout=1)
    assert both_started.is_set()


async def test_a_late_seen_recurrence_reopen_keeps_todays_done(hass, plan):
    """The provider shows our reopen only after the own-change window: the
    due date moved on, so it is the next occurrence, not an untick."""
    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay(
        "uid-1", due_date=MON, recurrence_enabled=True, recurrence_unit="days", recurrence_value=1,
    )
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    item = hass.data["todo"].get_entity.return_value.todo_items[0]
    item.status = TodoItemStatus.COMPLETED
    assert (await _today(hass))["items"][0]["completed"] is True

    item.status = TodoItemStatus.NEEDS_ACTION                      # reopened, no own change on record
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=TUE)
    stored = plan_module.plan_store(hass, plan.entry_id).days[MON]["items"]
    await _today(hass)
    assert next(i for i in stored if i["task_id"] == "uid-1")["done_on"] == MON


async def test_a_tick_asks_no_provider(hass, plan, store, mock_config_entry):
    """Remembering a tick needs no round trip to a provider like Todoist."""
    linked, adapter = await setup_linked_list(hass)
    task_id = await _task(store, "Native", due_date=MON)
    await _today(hass)
    reads = adapter.reads
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    assert adapter.reads == reads
    stored = plan_module.plan_store(hass, plan.entry_id).days[MON]["items"]
    assert next(i for i in stored if i["task_id"] == task_id)["done_on"] == MON
