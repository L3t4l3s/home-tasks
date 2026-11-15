"""Day plans: a view across lists, per date an ordered set of references.

The tasks stay in their lists. What these tests pin down is what a day
shows: what was put there on purpose, what is there through its due date,
and what happens to both when tasks are completed, moved or deleted.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"

MON, TUE, WED, THU, FRI, SAT = (f"2026-11-{day}" for day in (16, 17, 18, 19, 20, 21))
NEXT_MON, NEXT_TUE = "2026-11-23", "2026-11-24"
WEEK = ["mon", "tue", "wed", "thu", "fri"]


def _at(day: str, hour: int = 10) -> datetime:
    return datetime.fromisoformat(f"{day}T{hour:02d}:00:00").replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)


async def _add_plan(hass: HomeAssistant, name: str = "Today", **options) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data={"type": "plan", "name": name}, title=name, options=options)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _add_list(hass: HomeAssistant, name: str):
    entry = MockConfigEntry(domain=DOMAIN, data={"name": name}, title=name)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry, hass.data[DOMAIN][entry.entry_id]


async def _days(hass: HomeAssistant, **data) -> list[dict]:
    result = await hass.services.async_call(DOMAIN, "get_day_plan", data, blocking=True, return_response=True)
    return result["days"]


async def _today(hass: HomeAssistant, **data) -> dict:
    return (await _days(hass, **data))[0]


async def _call(hass: HomeAssistant, service: str, **data) -> None:
    await hass.services.async_call(DOMAIN, service, data, blocking=True)
    await hass.async_block_till_done()


def titles(day: dict) -> list[str]:
    return [row["title"] for row in day["items"]]


def kinds(day: dict) -> list[tuple[str, str]]:
    return [(row["title"], row["kind"]) for row in day["items"]]


@pytest.fixture
async def monday(freezer):
    freezer.move_to(_at(MON))


@pytest.fixture
async def plan(hass: HomeAssistant, mock_config_entry, store, monday) -> MockConfigEntry:
    """A plan over all lists, next to the "Test List" of the shared fixtures."""
    return await _add_plan(hass)


async def _task(store, title: str, **fields) -> str:
    return (await store.async_add_task(title, **fields))["id"]


# ---------------------------------------------------------------------------
# Planning a task
# ---------------------------------------------------------------------------

async def test_an_empty_plan_reads_as_today_with_nothing_on_it(hass: HomeAssistant, plan) -> None:
    day = await _today(hass)
    assert (day["date"], day["items"], day["note"]) == (MON, [], "")


async def test_a_planned_task_shows_with_its_list_and_stays_in_it(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    task_id = await _task(store, "Write report", priority=3, tags=["p:x"], assigned_person="person.kevin")
    await _call(hass, "plan_task", task_id=task_id)

    (row,) = (await _today(hass))["items"]
    assert row == {
        "task_id": task_id, "entry_id": mock_config_entry.entry_id, "list_name": "Test List",
        "title": "Write report", "priority": 3, "tags": ["p:x"],
        "assigned_person": "person.kevin", "assigned_persons": ["person.kevin"],
        "due_date": None, "due_time": None, "completed": False, "kind": "planned",
    }
    assert store.get_task(task_id)["title"] == "Write report"   # untouched, still in its list


async def test_position_and_order(hass: HomeAssistant, plan, store) -> None:
    a, b, c = [await _task(store, title) for title in ("A", "B", "C")]
    await _call(hass, "plan_task", task_id=a)
    await _call(hass, "plan_task", task_id=b)
    await _call(hass, "plan_task", task_id=c, position="top")
    assert titles(await _today(hass)) == ["C", "A", "B"]


async def test_a_task_sits_on_one_day_only(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Move me")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "plan_task", task_id=task_id, date=WED)
    today, _tue, wed = await _days(hass, days=3)
    assert (titles(today), titles(wed)) == ([], ["Move me"])


async def test_unplan_removes_the_reference_not_the_task(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Maybe later")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "unplan_task", task_id=task_id)
    assert titles(await _today(hass)) == []
    assert store.get_task(task_id)["completed"] is False


async def test_what_cannot_be_planned(hass: HomeAssistant, plan, store) -> None:
    done = await _task(store, "Done")
    await store.async_update_task(done, completed=True)
    with pytest.raises(ServiceValidationError, match="completed"):
        await _call(hass, "plan_task", task_id=done)
    with pytest.raises(ServiceValidationError, match="No task"):
        await _call(hass, "plan_task", task_id="nope")
    with pytest.raises(ServiceValidationError, match="No task"):
        await _call(hass, "unplan_task", task_id="nope")


async def test_a_deleted_task_just_goes(hass: HomeAssistant, plan, store) -> None:
    keep, gone = await _task(store, "Keep"), await _task(store, "Gone")
    await _call(hass, "set_day_plan", items=[gone, keep])
    await store.async_delete_task(gone)
    assert titles(await _today(hass)) == ["Keep"]


async def test_a_task_moved_to_another_list_stays_on_the_plan(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    other, _other_store = await _add_list(hass, "Other")
    task_id = await _task(store, "Travels")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(
        hass, "move_task", entry_id=mock_config_entry.entry_id, task_id=task_id,
        target_entry_id=other.entry_id,
    )
    (row,) = (await _today(hass))["items"]
    assert (row["title"], row["list_name"]) == ("Travels", "Other")


# ---------------------------------------------------------------------------
# set_day_plan
# ---------------------------------------------------------------------------

async def test_set_day_plan_sets_order_and_note(hass: HomeAssistant, plan, store) -> None:
    a, b = await _task(store, "A"), await _task(store, "B")
    await _call(hass, "set_day_plan", items=[b, {"task_id": a}], note="Focus: release")
    day = await _today(hass)
    assert (titles(day), day["note"], day["updated_by"]) == (["B", "A"], "Focus: release", "service")
    assert day["updated"]


async def test_merge_keeps_what_was_planned_before(hass: HomeAssistant, plan, store) -> None:
    """A briefing sorts the day without wiping what was planned the evening before."""
    mine, new = await _task(store, "Mine"), await _task(store, "From the briefing")
    await _call(hass, "plan_task", task_id=mine)
    await _call(hass, "set_day_plan", items=[new])
    assert titles(await _today(hass)) == ["From the briefing", "Mine"]


async def test_replace_takes_the_rest_off_but_not_what_is_due(hass: HomeAssistant, plan, store) -> None:
    mine, new = await _task(store, "Mine"), await _task(store, "New")
    await _task(store, "Due today", due_date=MON)
    await _call(hass, "plan_task", task_id=mine)
    await _call(hass, "set_day_plan", items=[new], mode="replace")
    assert titles(await _today(hass)) == ["New", "Due today"]


async def test_a_note_alone_and_clearing_it(hass: HomeAssistant, plan) -> None:
    await _call(hass, "set_day_plan", items=[], note="Only a note")
    assert (await _today(hass))["note"] == "Only a note"
    await _call(hass, "set_day_plan", items=[], note="")
    assert (await _today(hass))["note"] == ""


# ---------------------------------------------------------------------------
# Tasks with a due date
# ---------------------------------------------------------------------------

async def test_due_tasks_are_on_their_day_by_themselves(hass: HomeAssistant, plan, store) -> None:
    await _task(store, "Deliver Wed", due_date=WED)
    await _task(store, "No date")
    today, tue, wed = await _days(hass, days=3)
    assert (titles(today), titles(tue), kinds(wed)) == ([], [], [("Deliver Wed", "due")])


async def test_overdue_tasks_are_on_today(hass: HomeAssistant, plan, store) -> None:
    await _task(store, "Late", due_date="2026-11-10")
    await _task(store, "Today", due_date=MON)
    # oldest due first
    assert kinds(await _today(hass)) == [("Late", "overdue"), ("Today", "due")]


async def test_due_tasks_come_first_then_by_time_and_priority(hass: HomeAssistant, plan, store) -> None:
    planned = await _task(store, "Planned")
    await _call(hass, "plan_task", task_id=planned)
    await _task(store, "Low", due_date=MON, priority=1)
    await _task(store, "High", due_date=MON, priority=3)
    await _task(store, "At nine", due_date=MON, due_time="09:00")
    assert titles(await _today(hass)) == ["At nine", "High", "Low", "Planned"]


async def test_planning_a_due_task_earlier_wins(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Deliver Wed", due_date=WED)
    await _call(hass, "plan_task", task_id=task_id, date=TUE)
    _today_, tue, wed = await _days(hass, days=3)
    assert kinds(tue) == [("Deliver Wed", "planned")]
    assert tue["items"][0]["due_date"] == WED   # the due date stays visible on the row
    assert titles(wed) == []


async def test_a_due_task_cannot_be_removed_only_moved(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Deliver today", due_date=MON)
    with pytest.raises(ServiceValidationError, match="due date"):
        await _call(hass, "unplan_task", task_id=task_id)
    await _call(hass, "plan_task", task_id=task_id, date=TUE)
    await _call(hass, "unplan_task", task_id=task_id)      # back to where its due date puts it
    assert titles(await _today(hass)) == ["Deliver today"]


async def test_a_sorted_due_task_follows_its_due_date(hass: HomeAssistant, plan, store) -> None:
    """Sorting a day stores the due task's place; a new due date still moves it."""
    planned = await _task(store, "Planned")
    due = await _task(store, "Deliver", due_date=MON)
    await _call(hass, "set_day_plan", items=[planned, due])
    assert kinds(await _today(hass)) == [("Planned", "planned"), ("Deliver", "due")]

    await store.async_update_task(due, due_date=WED)
    today, _tue, wed = await _days(hass, days=3)
    assert (titles(today), kinds(wed)) == (["Planned"], [("Deliver", "due")])


async def test_due_tasks_can_be_switched_off(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    await _add_plan(hass, include_due=False)
    await _task(store, "Due today", due_date=MON)
    assert titles(await _today(hass)) == []


@pytest.mark.parametrize("how", ["plan_task", "set_day_plan", "set_day_plan replace"])
async def test_without_due_tasks_a_task_planned_on_its_due_day_stays(
    hass: HomeAssistant, mock_config_entry, store, monday, how
) -> None:
    """Nothing is on such a plan through its due date - so the task is there on purpose."""
    await _add_plan(hass, include_due=False)
    task_id = await _task(store, "Due and planned", due_date=MON)
    if how == "plan_task":
        await _call(hass, "plan_task", task_id=task_id)
    else:
        await _call(hass, "set_day_plan", items=[task_id], mode="replace" if "replace" in how else "merge")
    assert kinds(await _today(hass)) == [("Due and planned", "planned")]

    # Planned, so it can be taken off again - and moved like any other.
    await _call(hass, "plan_task", task_id=task_id, date=TUE)
    today, tue = await _days(hass, days=2)
    assert (titles(today), kinds(tue)) == ([], [("Due and planned", "planned")])
    await _call(hass, "unplan_task", task_id=task_id)
    assert titles((await _days(hass, days=2))[1]) == []


# ---------------------------------------------------------------------------
# Workdays and the horizon
# ---------------------------------------------------------------------------

async def test_days_off_are_skipped(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    await _add_plan(hass, workdays=WEEK)
    days = await _days(hass, days=7)
    assert [day["date"] for day in days] == [MON, TUE, WED, THU, FRI, NEXT_MON, NEXT_TUE]


async def test_a_due_date_on_a_day_off_is_on_the_workday_before(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_plan(hass, workdays=WEEK)
    await _task(store, "Deliver Saturday", due_date=SAT)
    days = {day["date"]: titles(day) for day in await _days(hass, days=7)}
    assert days[FRI] == ["Deliver Saturday"]
    assert days[NEXT_MON] == []


async def test_on_a_day_off_the_plan_reads_the_next_workday(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    freezer.move_to(_at(SAT))
    await _add_plan(hass, workdays=WEEK)
    await _task(store, "Was due Friday", due_date=FRI)
    day = await _today(hass)
    assert (day["date"], kinds(day)) == (NEXT_MON, [("Was due Friday", "overdue")])


async def test_only_the_next_seven_plan_days_can_be_written(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_plan(hass, workdays=WEEK)
    task_id = await _task(store, "Somewhen")
    for day in (SAT, "2026-11-25", "2026-11-13"):    # a day off, beyond the week, the past
        with pytest.raises(ServiceValidationError, match="can't be planned"):
            await _call(hass, "plan_task", task_id=task_id, date=day)
    await _call(hass, "plan_task", task_id=task_id, date=NEXT_TUE)   # the seventh plan day


# ---------------------------------------------------------------------------
# Which lists a plan draws from
# ---------------------------------------------------------------------------

async def test_a_plan_only_sees_its_lists(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    private, private_store = await _add_list(hass, "Private")
    await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    await _task(store, "Work, due", due_date=MON)
    secret = await _task(private_store, "Private, due", due_date=MON)

    assert titles(await _today(hass)) == ["Work, due"]
    with pytest.raises(ServiceValidationError, match="No task"):
        await _call(hass, "plan_task", task_id=secret)
    with pytest.raises(ServiceValidationError, match="No task"):
        await _call(hass, "set_day_plan", items=[{"task_id": secret, "entry_id": private.entry_id}])


async def test_a_list_added_later_is_part_of_an_all_lists_plan(hass: HomeAssistant, plan) -> None:
    _entry, late_store = await _add_list(hass, "Added later")
    await _task(late_store, "From the new list", due_date=MON)
    (row,) = (await _today(hass))["items"]
    assert row["list_name"] == "Added later"


async def test_a_linked_list_is_a_source_too(hass: HomeAssistant, plan) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    (row,) = (await _today(hass))["items"]
    assert (row["title"], row["entry_id"], row["kind"]) == ("Wipe bench", linked.entry_id, "due")


async def test_naming_the_plan(hass: HomeAssistant, plan, store) -> None:
    await _task(store, "Due", due_date=MON)
    assert titles(await _today(hass, plan="today")) == ["Due"]           # by name
    assert titles(await _today(hass, plan=plan.entry_id)) == ["Due"]     # by id
    with pytest.raises(ServiceValidationError, match="No plan"):
        await _today(hass, plan="Nope")
    await _add_plan(hass, "Private")
    with pytest.raises(ServiceValidationError, match="several plans"):
        await _today(hass)


# ---------------------------------------------------------------------------
# Completing
# ---------------------------------------------------------------------------

async def test_a_completed_task_stays_on_the_day_as_done(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    task_id = await _task(store, "Do it")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    (row,) = (await _today(hass))["items"]
    assert row["completed"] is True


async def test_a_recurring_task_that_reopens_is_still_done_that_day(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """The follow-up case: ticked off today, open again for its next round."""
    task_id = await _task(store, "Follow up")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    await store.async_reopen_task(task_id, scheduled=True)    # what the recurrence timer does
    await hass.async_block_till_done()

    assert store.get_task(task_id)["completed"] is False
    (row,) = (await _today(hass))["items"]
    assert row["completed"] is True


async def test_a_due_task_ticked_off_keeps_its_place_among_the_due(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """Rows that are there through their due date stand in their own order
    and are not stored. One of them ticked off must not drop behind the
    others - and must not move when the tick is taken back either."""
    first = await _task(store, "First", due_date=MON, due_time="08:00")
    second = await _task(store, "Second", due_date=MON, due_time="09:00")
    await _task(store, "Third", due_date=MON, due_time="10:00")
    planned = await _task(store, "Planned")
    await _call(hass, "plan_task", task_id=planned)
    assert titles(await _today(hass)) == ["First", "Second", "Third", "Planned"]

    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=second)
    day = await _today(hass)
    assert [(r["title"], r["completed"]) for r in day["items"]] == [
        ("First", False), ("Second", True), ("Third", False), ("Planned", False),
    ]
    await store.async_update_task(second, completed=False)
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == ["First", "Second", "Third", "Planned"]

    # The first of them, and the last.
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=first)
    assert titles(await _today(hass)) == ["First", "Second", "Third", "Planned"]
    # One that turns up later still comes first, as a due row does.
    await _task(store, "Later", due_date=MON, due_time="07:00")
    assert titles(await _today(hass)) == ["Later", "First", "Second", "Third", "Planned"]


async def test_a_recurring_due_task_ticked_off_keeps_its_place(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """Its due date has moved on by the time the plan looks."""
    await _task(store, "Before", due_date=MON, due_time="08:00")
    daily = await _task(store, "Daily", due_date=MON, due_time="09:00")
    await store.async_update_task(daily, recurrence_enabled=True, recurrence_unit="days", recurrence_value=1)
    await _task(store, "After", due_date=MON, due_time="10:00")
    assert titles(await _today(hass)) == ["Before", "Daily", "After"]

    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=daily)
    day = await _today(hass)
    assert [(r["title"], r["completed"]) for r in day["items"]] == [
        ("Before", False), ("Daily", True), ("After", False),
    ]


async def test_a_task_that_recurs_within_the_day_is_on_it_once(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """Ticked off, and open and due again today by the time the plan looks:
    the day keeps one reference for it, the done one."""
    from custom_components.home_tasks.plan import async_mark_completed, plan_store

    await _task(store, "Before", due_date=MON, due_time="08:00")
    hourly = await _task(store, "Hourly", due_date=MON, due_time="09:00")
    await _task(store, "After", due_date=MON, due_time="12:00")
    # As the event reports it: completed while due at 09:00 - and the task is
    # already open again, due at 10:00.
    await store.async_update_task(hourly, due_time="10:00")
    plan_days = plan_store(hass, plan.entry_id)
    await async_mark_completed(
        hass, plan, plan_days, hourly, mock_config_entry.entry_id, due_before=MON,
    )
    stored = [item["task_id"] for item in plan_days.days[MON]["items"]]
    assert stored.count(hourly) == 1
    day = await _today(hass)
    assert [(r["title"], r["completed"]) for r in day["items"]] == [
        ("Before", False), ("Hourly", True), ("After", False),
    ]


async def test_unticking_takes_the_done_back(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    task_id = await _task(store, "Oops")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    await store.async_update_task(task_id, completed=False)
    await hass.async_block_till_done()
    (row,) = (await _today(hass))["items"]
    assert row["completed"] is False


async def test_a_completed_due_task_stays_on_the_day_as_done(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    task_id = await _task(store, "Deliver", due_date=MON)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    assert [(row["title"], row["completed"]) for row in (await _today(hass))["items"]] == [("Deliver", True)]


@pytest.mark.parametrize("change", ["move_due", "remove_due", "exclude_due"])
async def test_completion_does_not_restore_a_stale_auto_reference(
    hass: HomeAssistant, plan, store, mock_config_entry, change
) -> None:
    from custom_components.home_tasks.plan import plan_store

    task_id = await _task(store, "Deliver", due_date=MON)
    await _call(hass, "set_day_plan", items=[task_id])
    if change == "exclude_due":
        hass.config_entries.async_update_entry(plan, options={"include_due": False})
    else:
        await store.async_update_task(task_id, due_date=TUE if change == "move_due" else None)
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == []

    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    assert titles(await _today(hass)) == []
    assert plan_store(hass, plan.entry_id).days[MON]["items"][0]["done_on"] is None


async def test_sorted_recurring_due_task_still_counts_as_done_today(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    task_id = await _task(store, "Daily delivery", due_date=MON)
    await store.async_update_task(
        task_id, recurrence_enabled=True,
        recurrence_unit="days", recurrence_value=1,
    )
    await _call(hass, "set_day_plan", items=[task_id])
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    assert store.get_task(task_id)["due_date"] == TUE
    assert [(row["task_id"], row["completed"]) for row in (await _today(hass))["items"]] == [
        (task_id, True),
    ]


async def test_done_rows_survive_replace(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    done, new = await _task(store, "Done"), await _task(store, "New")
    await _call(hass, "plan_task", task_id=done)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=done)
    await _call(hass, "set_day_plan", items=[new], mode="replace")
    assert [(row["title"], row["completed"]) for row in (await _today(hass))["items"]] == [
        ("New", False), ("Done", True),
    ]


# ---------------------------------------------------------------------------
# Carry-over
# ---------------------------------------------------------------------------

async def _friday_plan(hass, store, freezer, **options):
    """Two tasks planned on Friday, one of them done; then it is Monday."""
    freezer.move_to(_at(FRI))
    plan_entry = await _add_plan(hass, workdays=WEEK, **options)
    done, open_ = await _task(store, "Done Friday"), await _task(store, "Left over")
    await _call(hass, "set_day_plan", items=[done, open_])
    await store.async_update_task(done, completed=True)
    await hass.async_block_till_done()
    freezer.move_to(_at(NEXT_MON))
    return plan_entry, open_


async def test_carry_over_is_offered_while_the_day_is_empty(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    _plan, left_over = await _friday_plan(hass, store, freezer)
    day = await _today(hass)
    assert titles(day) == []
    assert day["carry_over"]["date"] == FRI
    assert [row["title"] for row in day["carry_over"]["items"]] == ["Left over"]

    await _call(hass, "plan_task", task_id=left_over)      # taking the offer
    day = await _today(hass)
    assert titles(day) == ["Left over"] and "carry_over" not in day


async def test_carry_over_auto_puts_them_on_the_day(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    await _friday_plan(hass, store, freezer, carry_over="auto")
    day = await _today(hass)
    assert kinds(day) == [("Left over", "planned")]
    assert day["items"][0]["carried_from"] == FRI


async def test_carry_over_off(hass: HomeAssistant, mock_config_entry, store, freezer) -> None:
    await _friday_plan(hass, store, freezer, carry_over="off")
    day = await _today(hass)
    assert titles(day) == [] and "carry_over" not in day


async def test_a_carried_task_completed_today_counts_for_today(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    _plan, left_over = await _friday_plan(hass, store, freezer, carry_over="auto")
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=left_over)
    assert [(row["title"], row["completed"]) for row in (await _today(hass))["items"]] == [("Left over", True)]


# ---------------------------------------------------------------------------
# The past
# ---------------------------------------------------------------------------

async def test_a_past_day_reads_as_it_was_left(hass: HomeAssistant, mock_config_entry, store, freezer) -> None:
    await _friday_plan(hass, store, freezer)
    (friday,) = await _days(hass, date=FRI)
    assert [(row["title"], row["completed"]) for row in friday["items"]] == [
        ("Done Friday", True), ("Left over", False),
    ]


async def test_days_older_than_two_weeks_are_dropped(hass: HomeAssistant, plan, store, freezer) -> None:
    from custom_components.home_tasks.plan import plan_store

    old = await _task(store, "Old")
    await _call(hass, "plan_task", task_id=old)
    freezer.move_to(_at("2026-12-07"))
    new = await _task(store, "New")
    await _call(hass, "plan_task", task_id=new)
    assert list(plan_store(hass, plan.entry_id).days) == ["2026-12-07"]


# ---------------------------------------------------------------------------
# Sensor
# ---------------------------------------------------------------------------

def _sensor(hass: HomeAssistant, plan_entry):
    entity_id = er.async_get(hass).async_get_entity_id(
        "sensor", DOMAIN, f"{plan_entry.entry_id}_plan_open_items"
    )
    return hass.states.get(entity_id)


async def test_the_sensor_counts_what_is_open_today(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    assert _sensor(hass, plan).state == "0"

    planned = await _task(store, "Planned")
    await _task(store, "Due", due_date=MON)
    await _call(hass, "set_day_plan", items=[planned], note="Focus")
    state = _sensor(hass, plan)
    assert state.state == "2"
    assert (state.attributes["date"], state.attributes["done"], state.attributes["total"]) == (MON, 0, 2)
    assert state.attributes["note"] == "Focus"

    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=planned)
    state = _sensor(hass, plan)
    assert (state.state, state.attributes["done"], state.attributes["total"]) == ("1", 1, 2)


async def test_the_sensor_follows_a_list_added_later(hass: HomeAssistant, plan) -> None:
    _entry, late_store = await _add_list(hass, "Added later")
    await _task(late_store, "Due", due_date=MON)
    await hass.async_block_till_done()
    assert _sensor(hass, plan).state == "1"


# ---------------------------------------------------------------------------
# A plan is not a list
# ---------------------------------------------------------------------------

async def test_a_plan_is_not_offered_as_a_list(hass: HomeAssistant, plan, hass_ws_client) -> None:
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "home_tasks/get_lists"})
    lists = (await ws.receive_json())["result"]["lists"]
    assert [entry["name"] for entry in lists] == ["Test List"]


async def test_a_plan_does_not_shadow_a_list_of_the_same_name(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_plan(hass, "Test List")
    await _task(store, "In the list")
    result = await hass.services.async_call(
        DOMAIN, "get_tasks", {"list_name": "Test List"}, blocking=True, return_response=True,
    )
    assert [task["title"] for task in result["tasks"]] == ["In the list"]


async def test_unloading_and_removing_a_plan(hass: HomeAssistant, plan, store) -> None:
    from custom_components.home_tasks.plan import plan_store

    await _call(hass, "plan_task", task_id=await _task(store, "Planned"))
    assert await hass.config_entries.async_remove(plan.entry_id)
    await hass.async_block_till_done()
    assert plan_store(hass, plan.entry_id) is None
    with pytest.raises(ServiceValidationError, match="no plan"):
        await _today(hass)


# ---------------------------------------------------------------------------
# Config flow
# ---------------------------------------------------------------------------

async def test_creating_a_plan(hass: HomeAssistant, mock_config_entry) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert "plan" in result["menu_options"]
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "plan"})
    assert (result["type"], result["step_id"]) == (FlowResultType.FORM, "plan")
    # A list may have the name already; another plan may not.
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "Test List"})
    await hass.async_block_till_done()
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert result["data"] == {"type": "plan", "name": "Test List"}

    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"next_step_id": "plan"})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"name": "test list"})
    assert result["errors"] == {"name": "duplicate_plan_name"}


async def test_plan_settings(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    await _task(store, "Due Saturday", due_date=SAT)
    assert _sensor(hass, plan).state == "0"

    result = await hass.config_entries.options.async_init(plan.entry_id)
    assert (result["type"], result["step_id"]) == (FlowResultType.FORM, "init")
    result = await hass.config_entries.options.async_configure(result["flow_id"], {
        "source_lists": [mock_config_entry.entry_id],
        "workdays": ["sun", "mon"],
        "include_due": True,
        "carry_over": "auto",
    })
    await hass.async_block_till_done()
    assert result["type"] == FlowResultType.CREATE_ENTRY
    assert plan.options["workdays"] == ["sun", "mon"]
    # Read on the next look, no reload: Saturday is a day off now, and the
    # workday before it is today.
    assert titles(await _today(hass)) == ["Due Saturday"]
    assert _sensor(hass, plan).state == "1"


async def test_only_a_plan_has_settings(hass: HomeAssistant, plan, mock_config_entry) -> None:
    assert plan.supports_options is True
    assert mock_config_entry.supports_options is False


# ---------------------------------------------------------------------------
# Refusals, shared ids and other corners
# ---------------------------------------------------------------------------

async def test_a_refused_write_leaves_the_plan_as_it_was(hass: HomeAssistant, plan, store) -> None:
    """Naming a task moves it off its old day - but only if the call goes through."""
    task_id = await _task(store, "On Wednesday")
    await _call(hass, "plan_task", task_id=task_id, date=WED)

    with pytest.raises(ServiceValidationError, match="note is too long"):
        await _call(hass, "set_day_plan", items=[task_id], note="x" * 300)
    assert titles(await _today(hass)) == []
    assert titles(await _today(hass, date=WED)) == ["On Wednesday"]
    # ...and it is not just the reading: the next write does not lose it either.
    await _call(hass, "plan_task", task_id=await _task(store, "Other"))
    assert titles(await _today(hass, date=WED)) == ["On Wednesday"]


async def test_a_full_day_refuses_without_taking_the_task_off_its_day(
    hass: HomeAssistant, plan, store, monkeypatch
) -> None:
    monkeypatch.setattr("custom_components.home_tasks.plan.MAX_PLAN_ITEMS_PER_DAY", 1)
    await _call(hass, "plan_task", task_id=await _task(store, "Fills today"))
    task_id = await _task(store, "On Tuesday")
    await _call(hass, "plan_task", task_id=task_id, date=TUE)

    with pytest.raises(ServiceValidationError, match="at most 1 planned tasks"):
        await _call(hass, "plan_task", task_id=task_id)
    assert titles(await _today(hass, date=TUE)) == ["On Tuesday"]


async def test_the_days_limit_does_not_count_what_is_due(
    hass: HomeAssistant, plan, store, mock_config_entry, monkeypatch
) -> None:
    """Overdue tasks pile up on the current day by themselves. They must not
    use up the room for what somebody puts there - or keep the day from
    being reordered at all."""
    monkeypatch.setattr("custom_components.home_tasks.plan.MAX_PLAN_ITEMS_PER_DAY", 1)
    due = [await _task(store, f"Due {n}", due_date=MON, due_time=f"0{n}:00") for n in range(1, 4)]
    planned = await _task(store, "Planned")
    await _call(hass, "plan_task", task_id=planned)
    assert titles(await _today(hass)) == ["Due 1", "Due 2", "Due 3", "Planned"]
    # Reordering the day writes all four: three of them are there anyway.
    await _call(hass, "set_day_plan", items=[due[2], planned, due[0], due[1]])
    assert titles(await _today(hass)) == ["Due 3", "Planned", "Due 1", "Due 2"]
    # Ticking a due one off writes the day too.
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=due[0])
    await _call(hass, "set_day_plan", items=[planned])
    assert titles(await _today(hass))[0] == "Planned"
    # One more put there on purpose is one too many.
    with pytest.raises(ServiceValidationError, match="at most 1 planned tasks"):
        await _call(hass, "plan_task", task_id=await _task(store, "Second"))


async def test_the_reopened_event_says_when_it_was_the_recurrence(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    events = []
    hass.bus.async_listen(f"{DOMAIN}_task_reopened", lambda event: events.append(dict(event.data)))
    task_id = await _task(store, "Follow up")

    await store.async_update_task(task_id, completed=True)
    await store.async_reopen_task(task_id, scheduled=True)     # the recurrence timer
    await hass.async_block_till_done()
    assert events[-1]["reopened_by"] == "recurrence"

    await store.async_update_task(task_id, completed=True)
    await store.async_update_task(task_id, completed=False)    # an un-tick
    await hass.async_block_till_done()
    assert "reopened_by" not in events[-1]

    # A reopen without a user - an automation, an assistant - is no
    # recurrence either, though the history records it under that name.
    await store.async_update_task(task_id, completed=True)
    await store.async_reopen_task(task_id)
    await hass.async_block_till_done()
    assert "reopened_by" not in events[-1]
    assert store.get_task(task_id)["history"][-1]["by"] == "recurrence"


async def test_a_recurrence_reopen_on_a_linked_list_keeps_the_day_done(hass: HomeAssistant, plan) -> None:
    """A linked list writes no history to tell by: the event has to say it."""
    from custom_components.home_tasks.plan import async_mark_completed, plan_store
    from tests.integration.linked_list_helpers import setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await _call(hass, "plan_task", task_id="uid-1")
    await async_mark_completed(hass, plan, plan_store(hass, plan.entry_id), "uid-1", linked.entry_id)

    def done(day: dict) -> list:
        return [(row["title"], row["completed"]) for row in day["items"]]

    assert done(await _today(hass)) == [("Wipe bench", True)]

    reopened = {"entry_id": linked.entry_id, "task_id": "uid-1"}
    hass.bus.async_fire(f"{DOMAIN}_task_reopened", {**reopened, "reopened_by": "recurrence"})
    await hass.async_block_till_done()
    assert done(await _today(hass)) == [("Wipe bench", True)]

    hass.bus.async_fire(f"{DOMAIN}_task_reopened", reopened)   # un-ticked in the provider app
    await hass.async_block_till_done()
    assert done(await _today(hass)) == [("Wipe bench", False)]


@pytest.mark.parametrize("materialize", [None, "note", "reorder"])
async def test_a_carried_task_can_be_taken_off_the_plan(
    hass: HomeAssistant, mock_config_entry, store, freezer, materialize
) -> None:
    """Unplanning suppresses carry-over before and after today's first write."""
    _plan, left_over = await _friday_plan(hass, store, freezer, carry_over="auto")
    assert titles(await _today(hass)) == ["Left over"]

    if materialize == "note":
        await _call(hass, "set_day_plan", items=[], note="Today's focus")
    elif materialize == "reorder":
        await _call(hass, "set_day_plan", items=[left_over])
    await _call(hass, "unplan_task", task_id=left_over)
    assert titles(await _today(hass)) == []
    # Friday still reads as it was left; it just stops handing the task on.
    assert "Left over" in titles(await _today(hass, date=FRI))
    freezer.move_to(_at(NEXT_TUE))
    assert titles(await _today(hass)) == []
    # Planned again on purpose, it is back.
    await _call(hass, "plan_task", task_id=left_over)
    assert titles(await _today(hass)) == ["Left over"]


@pytest.mark.parametrize("event_source", ["excluded", "missing_task"])
@pytest.mark.parametrize("event_name", ["completed", "reopened"])
async def test_plan_events_do_not_fall_back_to_another_list(
    hass: HomeAssistant, mock_config_entry, store, monday, event_source, event_name
) -> None:
    from custom_components.home_tasks.plan import plan_store

    other, other_store = await _add_list(hass, "Other")
    sources = [mock_config_entry.entry_id]
    if event_source == "missing_task":
        sources.append(other.entry_id)
    plan = await _add_plan(hass, source_lists=sources)
    task_id = await _task(store, "Planned task")
    if event_source == "excluded":
        twin = await other_store.async_add_task("Excluded twin")
        twin["id"] = task_id
    await _call(hass, "plan_task", task_id=task_id, entry_id=mock_config_entry.entry_id)

    if event_name == "reopened":
        await store.async_update_task(task_id, completed=True)
        await hass.async_block_till_done()
    event = {"entry_id": other.entry_id, "task_id": task_id}
    hass.bus.async_fire(f"{DOMAIN}_task_{event_name}", event)
    await hass.async_block_till_done()
    expected_done = event_name == "reopened"
    assert (await _today(hass))["items"][0]["completed"] is expected_done
    # The task's own completion timestamp can mask a lost done_on in the
    # rendered day, so verify the plan's persisted completion marker too.
    item = plan_store(hass, plan.entry_id).days[MON]["items"][0]
    assert item["done_on"] == (MON if expected_done else None)


async def test_a_deleted_list_still_limits_the_plan(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    """Limited to one list, and that list goes: the plan must not widen to all lists."""
    work, _work_store = await _add_list(hass, "Work")
    await _task(store, "Private thing", due_date=MON)
    plan = await _add_plan(hass, source_lists=[work.entry_id])
    await hass.config_entries.async_remove(work.entry_id)
    await hass.async_block_till_done()

    assert titles(await _today(hass)) == []          # not the other list
    # The settings say so: the list is still chosen, shown as deleted.
    result = await hass.config_entries.options.async_init(plan.entry_id)
    schema = result["data_schema"].schema
    key = next(k for k in schema if k == "source_lists")
    assert key.default() == [work.entry_id]
    assert {"value": work.entry_id, "label": "Deleted list"} in schema[key].config["options"]

    # Taken out by the user, the plan covers all lists again.
    await hass.config_entries.options.async_configure(result["flow_id"], {
        "source_lists": [], "workdays": [], "include_due": True, "carry_over": "suggest",
    })
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == ["Private thing"]


async def test_two_lists_may_hold_a_task_with_the_same_id(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """Providers hand out their own ids; a plan tells tasks apart by list and id."""
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    twin = await store.async_add_task("Native twin")
    twin["id"] = "uid-1"                              # the same id as the linked task

    await _call(hass, "plan_task", task_id="uid-1", entry_id=mock_config_entry.entry_id)
    day = await _today(hass)
    assert sorted((row["title"], row["kind"]) for row in day["items"]) == [
        ("Native twin", "planned"), ("Wipe bench", "due"),
    ]

    # Taking one off the plan leaves the other.
    with pytest.raises(ServiceValidationError, match="through its due date"):
        await _call(hass, "unplan_task", task_id="uid-1", entry_id=linked.entry_id)
    await _call(hass, "unplan_task", task_id="uid-1", entry_id=mock_config_entry.entry_id)
    assert kinds(await _today(hass)) == [("Wipe bench", "due")]


async def test_a_deleted_task_is_not_replaced_by_another_list_s_task_with_its_id(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    """A reference follows its task to another list, not to a stranger with the same id."""
    from custom_components.home_tasks.plan import plan_store
    from tests.integration.linked_list_helpers import setup_linked_list

    linked, _adapter = await setup_linked_list(hass)      # holds "Wipe bench" as uid-1
    twin = await store.async_add_task("Native twin")
    twin["id"] = "uid-1"
    await _call(hass, "plan_task", task_id="uid-1", entry_id=mock_config_entry.entry_id)
    assert titles(await _today(hass)) == ["Native twin"]

    await store.async_delete_task("uid-1")
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == []
    # Planning the linked task itself is still possible, and is its own row.
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    assert titles(await _today(hass)) == ["Wipe bench"]
    refs = [(i["list"], i["task_id"]) for i in plan_store(hass, plan.entry_id).days[MON]["items"]]
    assert (linked.entry_id, "uid-1") in refs


async def test_a_linked_task_that_is_gone_is_not_replaced_by_a_native_one(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    from tests.integration.linked_list_helpers import EXT_ENTITY, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await _call(hass, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    assert titles(await _today(hass)) == ["Wipe bench"]
    twin = await store.async_add_task("Native twin")
    twin["id"] = "uid-1"

    # The provider no longer has the task.
    entity = hass.data["todo"].get_entity.return_value
    entity.todo_items = [item for item in entity.todo_items if item.uid != "uid-1"]
    hass.states.async_set(EXT_ENTITY, "0")
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == []


@pytest.mark.parametrize("written_before", [False, True])
async def test_replace_takes_a_carried_task_off_for_good(
    hass: HomeAssistant, mock_config_entry, store, freezer, written_before
) -> None:
    """With carry-over auto, what replace leaves out must not walk back in."""
    _plan, left_over = await _friday_plan(hass, store, freezer, carry_over="auto")
    other = await _task(store, "Something else")
    if written_before:
        await _call(hass, "set_day_plan", items=[left_over])     # today's order was written once
    assert titles(await _today(hass)) == ["Left over"]

    await _call(hass, "set_day_plan", items=[other], mode="replace")
    assert titles(await _today(hass)) == ["Something else"]
    # Friday still reads as it was left; it just stops handing the task on.
    assert "Left over" in titles(await _today(hass, date=FRI))
    freezer.move_to(_at(NEXT_TUE))
    assert titles(await _today(hass)) == ["Something else"]      # Monday's own left-over
    # Planned again on purpose, it is back.
    await _call(hass, "plan_task", task_id=left_over)
    assert titles(await _today(hass)) == ["Something else", "Left over"]


async def test_replace_keeps_a_carried_task_that_is_named(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    _plan, left_over = await _friday_plan(hass, store, freezer, carry_over="auto")
    other = await _task(store, "Something else")
    await _call(hass, "set_day_plan", items=[other, left_over], mode="replace")
    assert titles(await _today(hass)) == ["Something else", "Left over"]


@pytest.mark.parametrize("write", ["plan_task", "set_day_plan", "set_day_plan replace"])
async def test_a_day_written_while_a_linked_list_is_away_keeps_its_tasks(
    hass: HomeAssistant, plan, store, write
) -> None:
    """A provider that is away reads as an empty list. That is not the same
    as its tasks being gone: a reorder in that moment must not take them off
    the plan for good."""
    from tests.integration.linked_list_helpers import EXT_ENTITY, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    mine, other = await _task(store, "Mine"), await _task(store, "Other")
    await _call(hass, "set_day_plan", items=[
        {"task_id": "uid-1", "entry_id": linked.entry_id}, mine,
    ])
    assert titles(await _today(hass)) == ["Wipe bench", "Mine"]

    entity = hass.data["todo"].get_entity.return_value
    there = entity.todo_items
    entity.todo_items = []                              # the provider is away
    hass.states.async_set(EXT_ENTITY, "unavailable")
    await hass.async_block_till_done()
    assert titles(await _today(hass)) == ["Mine"]

    if write == "plan_task":
        await _call(hass, "plan_task", task_id=other)
    else:
        await _call(
            hass, "set_day_plan", items=[other, mine], mode="replace" if "replace" in write else "merge",
        )
    assert sorted(titles(await _today(hass))) == ["Mine", "Other"]

    entity.todo_items = there                           # and back
    hass.states.async_set(EXT_ENTITY, "1")
    await hass.async_block_till_done()
    assert sorted(titles(await _today(hass))) == ["Mine", "Other", "Wipe bench"]


async def test_a_linked_list_that_answers_with_no_tasks_is_empty_not_away(
    hass: HomeAssistant, plan, store
) -> None:
    """The last tasks of a list were deleted at the provider. Its entity is
    there and says so: their references go with the next write, they are not
    carried along as if the provider were away."""
    from custom_components.home_tasks.plan import plan_store
    from tests.integration.linked_list_helpers import EXT_ENTITY, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    mine = await _task(store, "Mine")
    await _call(hass, "set_day_plan", items=[{"task_id": "uid-1", "entry_id": linked.entry_id}, mine])
    hass.data["todo"].get_entity.return_value.todo_items = []
    hass.states.async_set(EXT_ENTITY, "0")
    await hass.async_block_till_done()

    await _call(hass, "set_day_plan", items=[mine])
    stored = plan_store(hass, plan.entry_id).days[MON]["items"]
    assert [item["task_id"] for item in stored] == [mine]


async def test_a_task_gone_from_a_linked_list_that_reads_is_not_carried_along(
    hass: HomeAssistant, plan, store
) -> None:
    from custom_components.home_tasks.plan import plan_store
    from tests.integration.linked_list_helpers import EXT_ENTITY, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    mine = await _task(store, "Mine")
    await _call(hass, "set_day_plan", items=[{"task_id": "uid-1", "entry_id": linked.entry_id}, mine])
    entity = hass.data["todo"].get_entity.return_value
    entity.todo_items = [item for item in entity.todo_items if item.uid != "uid-1"]   # deleted there
    hass.states.async_set(EXT_ENTITY, "0")
    await hass.async_block_till_done()

    await _call(hass, "set_day_plan", items=[mine])
    stored = plan_store(hass, plan.entry_id).days[MON]["items"]
    assert [item["task_id"] for item in stored] == [mine]


async def test_a_day_that_becomes_a_day_off_hands_its_tasks_on(
    hass: HomeAssistant, plan, store
) -> None:
    """Planned for Saturday, then the plan loses its weekend: on Friday, as a
    due date on a day off - not on a day nobody sees."""
    saturday = await _task(store, "Planned for Saturday", due_date=WED)
    friday = await _task(store, "Planned for Friday")
    await _call(hass, "plan_task", task_id=friday, date=FRI)
    await _call(hass, "plan_task", task_id=saturday, date=SAT)
    assert titles((await _days(hass, days=6))[5]) == ["Planned for Saturday"]

    hass.config_entries.async_update_entry(plan, options={"workdays": WEEK})
    await hass.async_block_till_done()
    days = {day["date"]: titles(day) for day in await _days(hass, days=5)}
    assert days[FRI] == ["Planned for Friday", "Planned for Saturday"]
    assert days[WED] == []                              # planned: not on its due day as well

    # With the weekend back, it stays where it was moved to.
    hass.config_entries.async_update_entry(plan, options={"workdays": []})
    await hass.async_block_till_done()
    days = {day["date"]: titles(day) for day in await _days(hass, days=6)}
    assert (days[FRI], days[SAT]) == (["Planned for Friday", "Planned for Saturday"], [])


async def test_a_day_that_becomes_a_day_off_hands_its_focus_on_too(
    hass: HomeAssistant, plan, store
) -> None:
    from custom_components.home_tasks.plan import plan_store

    task_id = await _task(store, "Planned for Saturday")
    await _call(hass, "set_day_plan", date=SAT, items=[task_id], note="Garden")
    await _call(hass, "set_day_plan", date="2026-11-22", items=[], note="Rest")   # Sunday: a note alone
    hass.config_entries.async_update_entry(plan, options={"workdays": WEEK})
    await hass.async_block_till_done()

    friday = (await _days(hass, days=5))[4]
    assert (friday["date"], titles(friday), friday["note"]) == (FRI, ["Planned for Saturday"], "Garden")
    # Friday has its focus now: Sunday's is dropped with its day, not left where nobody sees it.
    days = plan_store(hass, plan.entry_id).days
    assert [(days.get(key) or {}).get("note") or "" for key in (SAT, "2026-11-22")] == ["", ""]


async def test_a_focus_the_other_day_has_already_stays(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Planned for Saturday")
    await _call(hass, "set_day_plan", date=FRI, items=[], note="Friday's own")
    await _call(hass, "set_day_plan", date=SAT, items=[task_id], note="Garden")
    hass.config_entries.async_update_entry(plan, options={"workdays": WEEK})
    await hass.async_block_till_done()
    friday = (await _days(hass, days=5))[4]
    assert (titles(friday), friday["note"]) == (["Planned for Saturday"], "Friday's own")


async def test_a_day_off_that_is_already_reached_hands_its_tasks_to_the_current_day(
    hass: HomeAssistant, plan, store, freezer
) -> None:
    task_id = await _task(store, "Planned for Sunday")
    freezer.move_to(_at(SAT))
    await _call(hass, "plan_task", task_id=task_id, date="2026-11-22")
    hass.config_entries.async_update_entry(plan, options={"workdays": WEEK})
    await hass.async_block_till_done()
    day = await _today(hass)
    assert (day["date"], titles(day)) == (NEXT_MON, ["Planned for Sunday"])


# ---------------------------------------------------------------------------
# No more work than a change needs
# ---------------------------------------------------------------------------

async def test_the_sensor_reads_the_plan_once_per_change(
    hass: HomeAssistant, plan, store, monkeypatch
) -> None:
    """State and attributes are both read for a state write; the day is resolved once."""
    from custom_components.home_tasks import sensor as sensor_module

    built = []

    class CountingView(sensor_module.PlanView):
        def __init__(self, *args, **kwargs) -> None:
            built.append(1)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(sensor_module, "PlanView", CountingView)
    await _task(store, "Due", due_date=MON)
    await hass.async_block_till_done()

    assert len(built) == 1
    assert _sensor(hass, plan).state == "1"
    assert _sensor(hass, plan).attributes["total"] == 1


async def test_the_sensor_keeps_its_listeners_while_the_lists_stay(
    hass: HomeAssistant, plan, store, monkeypatch
) -> None:
    from custom_components.home_tasks.sensor import PlanOpenItemsSensor

    dropped = []
    original = PlanOpenItemsSensor._unsubscribe_sources

    def counting(self) -> None:
        dropped.append(1)
        original(self)

    monkeypatch.setattr(PlanOpenItemsSensor, "_unsubscribe_sources", counting)
    task_id = await _task(store, "Planned")
    await _call(hass, "plan_task", task_id=task_id)          # a save of the plan
    await _call(hass, "set_day_plan", items=[task_id], note="Focus")
    assert dropped == []
    assert _sensor(hass, plan).attributes["note"] == "Focus"   # and it still follows the plan

    _late, late_store = await _add_list(hass, "Added later")  # the lists changed
    assert len(dropped) == 1
    await _task(late_store, "From the new list", due_date=MON)
    await hass.async_block_till_done()
    assert _sensor(hass, plan).state == "2"


async def test_a_provider_reporting_nothing_new_is_no_change(hass: HomeAssistant, plan, freezer) -> None:
    """Linked lists report in every few minutes. The card reloads on every
    change of this sensor - so a report with the same tasks must not be one."""
    from tests.integration.linked_list_helpers import EXT_ENTITY, overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    await hass.async_block_till_done()
    before = _sensor(hass, plan)
    assert before.state == "1"

    for _ in range(3):
        freezer.tick(60)
        hass.states.async_set(EXT_ENTITY, "1")              # the same state, reported again
        await hass.async_block_till_done()
    after = _sensor(hass, plan)
    assert after.attributes["last_modified"] == before.attributes["last_modified"]
    assert after.last_updated == before.last_updated

    freezer.tick(60)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=TUE)   # a real change
    await hass.async_block_till_done()
    changed = _sensor(hass, plan)
    assert changed.state == "0"
    assert changed.attributes["last_modified"] != before.attributes["last_modified"]
