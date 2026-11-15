"""The WebSocket commands the card reads and writes a day plan with."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry

from tests.integration.test_plan import (
    MON, NEXT_TUE, SAT, TUE, WEEK, _add_list, _add_plan, _at, _call, _task, _today, titles,
)

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


@pytest.fixture
async def monday(freezer):
    freezer.move_to(_at(MON))


@pytest.fixture
async def plan(hass: HomeAssistant, mock_config_entry, store, monday) -> MockConfigEntry:
    return await _add_plan(hass)


@pytest.fixture
async def saturday_week(hass: HomeAssistant, plan, freezer):
    """The plan of the fixtures, limited to weekdays, on a Saturday."""
    hass.config_entries.async_update_entry(plan, options={"workdays": WEEK})
    freezer.move_to(_at(SAT))
    await hass.async_block_till_done()


@pytest.fixture
async def saturday(hass: HomeAssistant, plan, freezer):
    """The plan of the fixtures, with every day of the week, on a Saturday."""
    freezer.move_to(_at(SAT))
    await hass.async_block_till_done()


@pytest.fixture
async def ws(hass: HomeAssistant, hass_ws_client):
    """Send a command, get its result - or the error, for a refused one.

    Ask for this fixture last: the connection and its access token are made
    at the clock's time, and a jump of days afterwards ends both.
    """
    client = await hass_ws_client(hass)
    counter = iter(range(1, 1000))

    async def send(command: str, **data):
        await client.send_json({"id": next(counter), "type": f"home_tasks/{command}", **data})
        reply = await client.receive_json()
        await hass.async_block_till_done()
        return reply["result"] if reply["success"] else reply["error"]

    return send


async def test_get_plan_has_what_the_card_needs(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    await _task(store, "Due today", due_date=MON)
    await _task(store, "Due tomorrow", due_date=TUE)

    result = await ws("get_plan", days=2)
    assert (result["id"], result["name"]) == (plan.entry_id, "Today")
    assert (result["today"], result["current"]) == (MON, MON)
    assert result["sensor_entity_id"] == "sensor.today_open_items"
    assert result["carry_over"] == "suggest"
    (source,) = result["sources"]
    stamp = source.pop("stamp")
    assert source == {
        "entry_id": mock_config_entry.entry_id, "name": "Test List",
        "kind": "native", "entity_id": None,
    }
    assert result["source_lists"] == []          # nothing chosen: all lists
    # The stamp of a list moves with its tasks, and only with them.
    assert (await ws("get_plan"))["sources"][0]["stamp"] == stamp
    await _task(store, "One more")
    assert (await ws("get_plan"))["sources"][0]["stamp"] != stamp
    assert len(result["horizon"]) == 7 and result["horizon"][0] == MON
    assert [(day["date"], titles(day)) for day in result["days"]] == [
        (MON, ["Due today"]), (TUE, ["Due tomorrow"]),
    ]


@pytest.fixture
async def saturday(freezer):
    freezer.move_to(_at(SAT))


async def test_get_plan_starts_at_the_plans_current_day(
    hass: HomeAssistant, mock_config_entry, store, saturday, ws
) -> None:
    await _add_plan(hass, workdays=WEEK)
    result = await ws("get_plan")
    assert (result["today"], result["current"]) == (SAT, "2026-11-23")
    assert [day["date"] for day in result["days"]] == ["2026-11-23"]


async def test_a_linked_list_is_named_by_its_entity(hass: HomeAssistant, plan, ws) -> None:
    from tests.integration.linked_list_helpers import setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    sources = (await ws("get_plan"))["sources"]
    stamp = sources[1].pop("stamp")
    assert sources[1] == {
        "entry_id": linked.entry_id, "name": "all tasks",
        "kind": "external", "entity_id": "todo.all_tasks",
    }
    # A provider reporting the same tasks again does not move the stamp.
    hass.states.async_set("todo.all_tasks", "1")
    await hass.async_block_till_done()
    assert (await ws("get_plan"))["sources"][1]["stamp"] == stamp


async def test_get_plans_lists_every_plan(hass: HomeAssistant, plan, mock_config_entry, ws) -> None:
    await _add_list(hass, "Private")
    work = await _add_plan(hass, "Work", source_lists=[mock_config_entry.entry_id])

    plans = (await ws("get_plans"))["plans"]
    assert [(p["id"], p["name"]) for p in plans] == [(plan.entry_id, "Today"), (work.entry_id, "Work")]
    assert [src["name"] for src in plans[0]["sources"]] == ["Test List", "Private"]
    assert [src["name"] for src in plans[1]["sources"]] == ["Test List"]
    assert plans[0]["horizon"][0] == MON and len(plans[0]["horizon"]) == 7
    assert plans[0]["today"] == MON        # "Plan for…" labels its days from this
    assert "days" not in plans[0]


async def test_get_plans_reads_no_list(hass: HomeAssistant, plan, saturday_week, monkeypatch, ws) -> None:
    """Which plans there are, with their days: that needs no task of any list."""
    from custom_components.home_tasks import plan_ws

    def no_view(*_args, **_kwargs):
        raise AssertionError("get_plans resolved a plan")

    monkeypatch.setattr(plan_ws, "PlanView", no_view)
    (info,) = (await ws("get_plans"))["plans"]
    # A plan without weekends on a Saturday: its days start on Monday.
    assert info["today"] == SAT
    assert info["horizon"][0] == "2026-11-23" and len(info["horizon"]) == 7


async def test_no_plan_is_said_plainly(hass: HomeAssistant, mock_config_entry, ws) -> None:
    assert (await ws("get_plans"))["plans"] == []
    error = await ws("get_plan")
    assert error["code"] == "invalid_request" and "no plan yet" in error["message"]


async def test_plan_task_and_unplan_task(hass: HomeAssistant, plan, store, ws) -> None:
    task_id = await _task(store, "Write report")
    assert await ws("plan_task", task_id=task_id) == {}
    assert await ws("plan_task", task_id=await _task(store, "First"), position="top") == {}
    assert titles(await _today(hass)) == ["First", "Write report"]
    assert (await _today(hass))["updated_by"] == "user"

    await ws("plan_task", plan=plan.entry_id, task_id=task_id, date=TUE)
    assert titles(await _today(hass, date=TUE)) == ["Write report"]

    assert await ws("unplan_task", task_id=task_id) == {}
    assert titles(await _today(hass, date=TUE)) == []


async def test_set_plan_day_takes_the_order_of_a_drag(hass: HomeAssistant, plan, store, ws) -> None:
    a, b, c = [await _task(store, name) for name in "ABC"]
    for task_id in (a, b, c):
        await _call(hass, "plan_task", task_id=task_id)

    await ws("set_plan_day", date=MON, items=[{"task_id": c, "entry_id": plan.entry_id}, a, b])
    assert titles(await _today(hass)) == ["C", "A", "B"]


@pytest.mark.parametrize("transport", ["service", "websocket"])
async def test_large_due_day_can_be_sorted_without_bypassing_the_planned_limit(
    hass: HomeAssistant, plan, store, mock_config_entry, monkeypatch, transport, ws
) -> None:
    monkeypatch.setattr("custom_components.home_tasks.plan.MAX_PLAN_ITEMS_PER_DAY", 2)
    due = [await _task(store, f"Due {n}", due_date=MON) for n in range(101)]
    planned = [await _task(store, f"Planned {n}") for n in range(3)]
    order = [planned[0], *reversed(due), planned[1]]
    refs = [{"task_id": task_id, "entry_id": mock_config_entry.entry_id} for task_id in order]
    if transport == "service":
        await _call(hass, "set_day_plan", items=refs)
    else:
        assert await ws("set_plan_day", items=refs) == {}
    assert [row["task_id"] for row in (await _today(hass))["items"]] == order

    if transport == "service":
        with pytest.raises(ServiceValidationError, match="at most 2 planned tasks"):
            await _call(hass, "set_day_plan", items=[*refs, planned[2]])
    else:
        error = await ws("set_plan_day", items=[*refs, planned[2]])
        assert "at most 2 planned tasks" in error["message"]
    assert [row["task_id"] for row in (await _today(hass))["items"]] == order


async def test_a_done_row_keeps_its_place_in_a_reorder(hass: HomeAssistant, plan, store, ws) -> None:
    """The card sends the day's rows as they stand, the done ones included."""
    a, b, c = [await _task(store, name) for name in "ABC"]
    for task_id in (a, b, c):
        await _call(hass, "plan_task", task_id=task_id)
    await store.async_update_task(b, completed=True)
    await hass.async_block_till_done()

    assert await ws("set_plan_day", date=MON, items=[c, b, a]) == {}
    day = await _today(hass)
    assert [(row["title"], row["completed"]) for row in day["items"]] == [
        ("C", False), ("B", True), ("A", False),
    ]
    # Onto another day it does not go: it is done.
    error = await ws("set_plan_day", date=TUE, items=[b])
    assert "completed" in error["message"]


async def test_set_plan_day_sets_only_the_note(hass: HomeAssistant, plan, store, ws) -> None:
    task_id = await _task(store, "Stays")
    await _call(hass, "plan_task", task_id=task_id)

    await ws("set_plan_day", note="Focus: release")
    day = await _today(hass)
    assert (day["note"], titles(day)) == ("Focus: release", ["Stays"])
    await ws("set_plan_day", note=None)
    assert (await _today(hass))["note"] == ""


@pytest.fixture
async def left_over_from_monday(hass: HomeAssistant, mock_config_entry, store, freezer):
    """Tuesday, with a task planned on Monday still open."""
    freezer.move_to(_at(MON))
    await _add_plan(hass)
    await _call(hass, "plan_task", task_id=await _task(store, "Left over"))
    freezer.move_to(_at(TUE))


async def test_carrying_over_is_a_merge(hass: HomeAssistant, left_over_from_monday, ws) -> None:
    offer = (await ws("get_plan"))["days"][0]["carry_over"]
    assert (offer["date"], titles(offer)) == (MON, ["Left over"])
    await ws("set_plan_day", items=[row["task_id"] for row in offer["items"]])
    day = (await ws("get_plan"))["days"][0]
    assert titles(day) == ["Left over"] and "carry_over" not in day


async def test_the_plans_rules_come_back_as_errors(hass: HomeAssistant, plan, store, ws) -> None:
    task_id = await _task(store, "Too far out")
    due = await _task(store, "Fixed point", due_date=MON)

    error = await ws("plan_task", task_id=task_id, date=NEXT_TUE)
    assert error["code"] == "invalid_request" and "can't be planned" in error["message"]
    error = await ws("unplan_task", task_id=due)
    assert "through its due date" in error["message"]
    error = await ws("plan_task", task_id="nope")
    assert "No task with id" in error["message"]
    error = await ws("plan_task", task_id=task_id, date="tomorrow")
    assert error["code"] == "invalid_format"
    error = await ws("get_plan", plan="nope")
    assert "No plan found" in error["message"]


async def test_get_plans_names_every_list_to_choose_from(
    hass: HomeAssistant, mock_config_entry, store, monday, ws
) -> None:
    other, _other_store = await _add_list(hass, "Other")
    plan = await _add_plan(hass, source_lists=[other.entry_id])

    result = await ws("get_plans")
    assert result["lists"] == [
        {"entry_id": mock_config_entry.entry_id, "name": "Test List", "kind": "native"},
        {"entry_id": other.entry_id, "name": "Other", "kind": "native"},
    ]
    (info,) = result["plans"]
    assert info["id"] == plan.entry_id and info["source_lists"] == [other.entry_id]


async def test_set_plan_lists_changes_the_plans_setting(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    other, other_store = await _add_list(hass, "Other")
    await _task(store, "In the first list", due_date=MON)
    await _task(other_store, "In the other list", due_date=MON)
    assert len((await ws("get_plan"))["days"][0]["items"]) == 2

    info = await ws("set_plan_lists", plan=plan.entry_id, source_lists=[other.entry_id])
    assert info["source_lists"] == [other.entry_id]
    assert plan.options["source_lists"] == [other.entry_id]
    assert titles((await ws("get_plan"))["days"][0]) == ["In the other list"]
    # The sensor follows without a reload of the plan.
    assert hass.states.get("sensor.today_open_items").state == "1"

    info = await ws("set_plan_lists", source_lists=[])        # nothing chosen: all lists again
    assert info["source_lists"] == [] and len(info["sources"]) == 2

    error = await ws("set_plan_lists", source_lists=["no-such-list"])
    assert error["code"] == "invalid_request" and "No list with entry id" in error["message"]
    error = await ws("set_plan_lists", source_lists=[plan.entry_id])   # a plan is not a list
    assert "No list with entry id" in error["message"]
    assert plan.options["source_lists"] == []


async def test_untick_takes_back_the_days_done_of_a_task_that_is_open_again(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    """Ticked off and opened by the recurrence for its next round: in its list
    there is no tick to take back, on the plan it still reads as done."""
    task_id = await _task(store, "Weekly", due_date=MON)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    await store.async_reopen_task(task_id, scheduled=True)    # what the recurrence timer does
    await hass.async_block_till_done()
    (row,) = (await ws("get_plan"))["days"][0]["items"]
    assert row["completed"] is True and store.get_task(task_id)["completed"] is False

    assert await ws("untick_plan_task", task_id=task_id, entry_id=mock_config_entry.entry_id) == {}
    (row,) = (await ws("get_plan"))["days"][0]["items"]
    assert (row["completed"], row["kind"]) == (False, "due")   # still due today
    task = store.get_task(task_id)
    assert (task["completed"], task["due_date"]) == (False, MON)   # the task is not touched
    assert hass.states.get("sensor.today_open_items").state == "1"

    error = await ws("untick_plan_task", task_id=task_id)
    assert error["code"] == "invalid_request" and "not done on today's plan" in error["message"]


async def test_untick_keeps_the_row_on_the_day_when_the_due_date_has_moved_on(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    task_id = await _task(store, "Daily", due_date=MON)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    await store.async_reopen_task(task_id, scheduled=True, new_due_date=TUE)   # the next round
    await hass.async_block_till_done()
    today, tue = (await ws("get_plan", days=2))["days"]
    assert [(r["title"], r["completed"]) for r in today["items"]] == [("Daily", True)]
    assert titles(tue) == ["Daily"]                       # and due again tomorrow

    await ws("untick_plan_task", task_id=task_id)
    today, tue = (await ws("get_plan", days=2))["days"]
    # Open on today again, there on purpose now - and on one day only.
    assert [(r["title"], r["completed"], r["kind"]) for r in today["items"]] == [("Daily", False, "planned")]
    assert titles(tue) == []
    assert store.get_task(task_id)["due_date"] == TUE     # nothing of the recurrence is rolled back


async def test_untick_leaves_the_task_on_today_only(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    """Its next round was planned for Wednesday in the meantime."""
    task_id = await _task(store, "Daily", due_date=MON)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    await store.async_reopen_task(task_id, scheduled=True, new_due_date=TUE)
    await hass.async_block_till_done()
    await _call(hass, "plan_task", task_id=task_id, date="2026-11-18")
    days = (await ws("get_plan", days=3))["days"]
    assert [titles(day) for day in days] == [["Daily"], [], ["Daily"]]

    await ws("untick_plan_task", task_id=task_id)
    days = (await ws("get_plan", days=3))["days"]
    assert [titles(day) for day in days] == [["Daily"], [], []]
    assert days[0]["items"][0]["completed"] is False


async def test_untick_is_not_for_a_task_that_is_still_completed(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    task_id = await _task(store, "Done")
    await _call(hass, "plan_task", task_id=task_id)
    await _call(hass, "complete_task", entry_id=mock_config_entry.entry_id, task_id=task_id)
    error = await ws("untick_plan_task", task_id=task_id)
    assert "reopen the task itself" in error["message"]
    assert (await ws("get_plan"))["days"][0]["items"][0]["completed"] is True
    error = await ws("untick_plan_task", task_id="no-such-task")
    assert "No task with id" in error["message"]


async def test_set_plan_workdays_changes_the_plans_days(
    hass: HomeAssistant, plan, store, saturday, ws
) -> None:
    """The weekend switch of the card editor: the plan's own setting."""
    await _task(store, "Due next Monday", due_date="2026-11-23")
    await hass.async_block_till_done()

    (info,) = (await ws("get_plans"))["plans"]
    assert info["workdays"] == []                       # none chosen: every day
    assert (await ws("get_plan"))["days"][0]["date"] == SAT
    assert hass.states.get("sensor.today_open_items").state == "0"

    info = await ws("set_plan_workdays", plan=plan.entry_id, workdays=["fri", "mon", "tue", "wed", "thu"])
    assert info["workdays"] == WEEK                     # in the order of the week
    assert plan.options["workdays"] == WEEK
    # Saturday is no plan day any more: the plan reads the Monday after.
    result = await ws("get_plan")
    assert (result["today"], result["current"], result["days"][0]["date"]) == (SAT, "2026-11-23", "2026-11-23")
    # The sensor follows without a reload of the plan.
    assert titles(result["days"][0]) == ["Due next Monday"]
    assert hass.states.get("sensor.today_open_items").state == "1"

    # All seven is what "none chosen" means.
    info = await ws("set_plan_workdays", workdays=[*WEEK, "sat", "sun"])
    assert info["workdays"] == [] and plan.options["workdays"] == []
    assert (await ws("get_plan"))["days"][0]["date"] == SAT

    error = await ws("set_plan_workdays", workdays=["someday"])
    assert error["code"] == "invalid_format"
    assert plan.options["workdays"] == []


async def test_set_plan_workdays_is_for_administrators(
    hass: HomeAssistant, plan, hass_ws_client, hass_read_only_access_token
) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json({"id": 1, "type": "home_tasks/set_plan_workdays", "workdays": []})
    reply = await client.receive_json()
    assert reply["success"] is False and reply["error"]["code"] == "unauthorized"


async def test_set_plan_lists_keeps_a_chosen_list_that_is_gone(
    hass: HomeAssistant, plan, store, mock_config_entry, ws
) -> None:
    """The card editor saves the whole choice. A list that was deleted is
    part of it until somebody takes it out - it must not make every save fail,
    and it cannot be put in anew."""
    other, _other_store = await _add_list(hass, "Other")
    await ws("set_plan_lists", source_lists=[other.entry_id, mock_config_entry.entry_id])
    await hass.config_entries.async_remove(other.entry_id)
    await hass.async_block_till_done()

    info = await ws("set_plan_lists", source_lists=[other.entry_id])   # the other one taken out
    assert info["source_lists"] == [other.entry_id]
    assert info["sources"] == []                        # limited to a list that is gone: nothing
    info = await ws("set_plan_lists", source_lists=[mock_config_entry.entry_id])
    assert info["source_lists"] == [mock_config_entry.entry_id]
    error = await ws("set_plan_lists", source_lists=[other.entry_id])  # gone and no longer chosen
    assert "No list with entry id" in error["message"]


async def test_set_plan_lists_is_for_administrators(
    hass: HomeAssistant, plan, hass_ws_client, hass_read_only_access_token
) -> None:
    """A plan's lists are also what its tools for assistants reach."""
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json({"id": 1, "type": "home_tasks/set_plan_lists", "source_lists": []})
    reply = await client.receive_json()
    assert reply["success"] is False and reply["error"]["code"] == "unauthorized"
