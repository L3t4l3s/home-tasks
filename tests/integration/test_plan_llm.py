"""A plan's set of tools for an LLM.

What matters here is the boundary - the tools reach the plan's lists and
nothing else - and that a tool call does what the matching service call
does, with arguments an LLM can give: real lists, numbers and nulls.
"""
from __future__ import annotations

import probatio
import pytest
import voluptuous as vol
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import MockConfigEntry

from tests.integration.test_plan import (
    FRI, MON, NEXT_TUE, SAT, TUE, WEEK, _add_list, _add_plan, _at, _task, _today, titles,
)

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
TOOLS = [f"home_tasks__{name}" for name in (
    "get_tasks", "get_task", "add_task", "update_task", "complete_task", "reopen_task",
    "delete_task", "move_task", "add_sub_task", "update_sub_task", "remove_sub_task",
    "get_plan", "set_plan", "plan_task", "unplan_task",
)]


@pytest.fixture
async def monday(freezer):
    freezer.move_to(_at(MON))


@pytest.fixture
async def plan(hass: HomeAssistant, mock_config_entry, store, monday) -> MockConfigEntry:
    """A plan over all lists, next to the "Test List" of the shared fixtures."""
    return await _add_plan(hass)


def _api_id(entry) -> str:
    return f"{DOMAIN}-{entry.entry_id}"


def _context() -> llm.LLMContext:
    return llm.LLMContext(
        platform="test", context=Context(), language="en", assistant="conversation", device_id=None,
    )


async def _api(hass: HomeAssistant, entry) -> llm.APIInstance:
    return await llm.async_get_api(hass, _api_id(entry), _context())


async def _tool(hass: HomeAssistant, entry, name: str, **args) -> dict:
    """Call a tool by its short name; the result's data."""
    api = await _api(hass, entry)
    result = await api.async_call_tool(
        llm.ToolInput(tool_name=f"{DOMAIN}__{name}", tool_args=args)
    )
    await hass.async_block_till_done()
    assert isinstance(result, llm.ToolResult) and result.error is False
    return result.data


# ---------------------------------------------------------------------------
# The set
# ---------------------------------------------------------------------------

async def test_every_plan_offers_its_own_set(hass: HomeAssistant, plan) -> None:
    private = await _add_plan(hass, "Private")
    offered = {api.id: api.name for api in llm.async_get_apis(hass)}
    assert offered[_api_id(plan)] == "Today"
    assert offered[_api_id(private)] == "Private"
    tools = (await _api(hass, plan)).tools
    assert [tool.name for tool in tools] == TOOLS
    # What Home Assistant asks of a tool: its integration, and a title.
    assert {tool.integration for tool in tools} == {DOMAIN}
    assert all(tool.title for tool in tools)


async def test_the_set_goes_with_the_plan(hass: HomeAssistant, plan) -> None:
    assert await hass.config_entries.async_unload(plan.entry_id)
    assert _api_id(plan) not in {api.id for api in llm.async_get_apis(hass)}

    assert await hass.config_entries.async_setup(plan.entry_id)   # and comes back with it
    await hass.async_block_till_done()
    assert _api_id(plan) in {api.id for api in llm.async_get_apis(hass)}


async def test_the_tools_translate_for_mcp(hass: HomeAssistant, plan) -> None:
    """Home Assistant's MCP Server sends each tool's arguments as JSON schema."""
    schemas = {
        tool.name.removeprefix("home_tasks__"): probatio.to_openapi(
            tool.parameters, openapi_version="3.1.0"
        )
        for tool in (await _api(hass, plan)).tools
    }
    update = schemas["update_task"]["properties"]
    assert update["priority"] == {
        "anyOf": [{"type": "null"}, {"type": "integer", "minimum": 1, "maximum": 3}],
        "description": "1 (low), 2 (medium), 3 (high), or null for none",
    }
    assert update["tags"]["items"] == {"type": "string"}
    assert update["due_date"]["anyOf"] == [{"type": "null"}, {"type": "string"}]
    assert schemas["update_task"]["required"] == ["task_id"]

    set_plan = schemas["set_plan"]["properties"]
    assert set_plan["task_ids"]["type"] == "array"
    id_schema, ref_schema = set_plan["task_ids"]["items"]["anyOf"]
    assert id_schema == {"type": "string"}
    assert ref_schema["type"] == "object"
    assert ref_schema["properties"] == {
        "task_id": {"type": "string"}, "entry_id": {"type": "string"},
    }
    assert set(ref_schema["required"]) == {"task_id", "entry_id"}
    assert set_plan["mode"]["enum"] == ["merge", "replace"]
    assert set_plan["date"]["type"] == "string"
    assert schemas["get_plan"]["properties"]["days"]["maximum"] == 7
    assert schemas["complete_task"]["properties"]["task_id"] == {"type": "string"}
    assert schemas["complete_task"]["required"] == ["task_id"]      # the list is optional
    # Nothing is left untyped - a client would have to guess.
    for name, schema in schemas.items():
        for key, prop in schema["properties"].items():
            assert "type" in prop or "anyOf" in prop, (name, key)


async def test_the_tools_say_what_they_do(hass: HomeAssistant, plan) -> None:
    """Read-only tools are what a read-only MCP connection still offers."""
    tools = {tool.name.removeprefix("home_tasks__"): tool.annotations for tool in (await _api(hass, plan)).tools}
    assert [name for name, notes in tools.items() if notes.read_only] == ["get_tasks", "get_task", "get_plan"]
    assert [name for name, notes in tools.items() if notes.destructive] == [
        "update_task", "delete_task", "update_sub_task", "remove_sub_task", "set_plan", "unplan_task",
    ]
    # Native lists only: nothing leaves Home Assistant.
    assert not any(notes.open_world for notes in tools.values())


async def test_tools_on_a_linked_list_reach_its_provider(hass: HomeAssistant, plan) -> None:
    from tests.integration.linked_list_helpers import setup_linked_list

    await setup_linked_list(hass)
    tools = {tool.name.removeprefix("home_tasks__"): tool.annotations for tool in (await _api(hass, plan)).tools}
    # Everything that reads or writes tasks; the plan itself stays in Home Assistant.
    assert [name for name, notes in tools.items() if notes.open_world] == [
        "get_tasks", "get_task", "add_task", "update_task", "complete_task", "reopen_task",
        "delete_task", "move_task", "add_sub_task", "update_sub_task", "remove_sub_task",
    ]


async def test_next_to_assist_the_tools_carry_the_plans_name(hass: HomeAssistant, plan) -> None:
    assert await async_setup_component(hass, "llm", {})
    merged = await llm.async_get_api(hass, [llm.LLM_API_ASSIST, _api_id(plan)], _context())
    names = [tool.name for tool in merged.tools]
    assert "today__home_tasks__get_plan" in names and "today__home_tasks__set_plan" in names
    result = await merged.async_call_tool(
        llm.ToolInput(tool_name="today__home_tasks__get_plan", tool_args={})
    )
    assert result.data["days"][0]["date"] == MON


# ---------------------------------------------------------------------------
# What the assistant is told
# ---------------------------------------------------------------------------

async def test_the_prompt_names_the_plan_its_lists_and_today(hass: HomeAssistant, plan) -> None:
    await _add_list(hass, "Work")
    prompt = (await _api(hass, plan)).api_prompt
    assert 'the day plan "Today"' in prompt
    assert '"Test List", "Work"' in prompt
    assert f"Today is Monday, {MON}." in prompt
    assert "day off" not in prompt and "workdays are" not in prompt
    # The briefing rules come along, naming the tools as they are called.
    assert 'home_tasks__set_plan and mode "merge"' in prompt


async def test_the_prompt_says_which_day_counts_on_a_day_off(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    freezer.move_to(_at(SAT))
    plan = await _add_plan(hass, workdays=WEEK)
    prompt = (await _api(hass, plan)).api_prompt
    assert f"Today is Saturday, {SAT}." in prompt
    assert "Today is a day off in this plan" in prompt and "Monday, 2026-11-23" in prompt
    assert "workdays are Monday, Tuesday, Wednesday, Thursday, Friday." in prompt


async def test_the_prompt_lists_only_the_plans_lists(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_list(hass, "Private")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    prompt = (await _api(hass, plan)).api_prompt
    assert '"Test List"' in prompt and "Private" not in prompt


# ---------------------------------------------------------------------------
# Reading tasks
# ---------------------------------------------------------------------------

async def test_get_tasks_reads_all_lists_of_the_plan(hass: HomeAssistant, plan, store) -> None:
    _work, work_store = await _add_list(hass, "Work")
    await _task(store, "Home thing", priority=3, tags=["a"])
    await _task(work_store, "Work thing")

    result = await _tool(hass, plan, "get_tasks")
    assert [entry["list_name"] for entry in result["lists"]] == ["Test List", "Work"]
    assert [(t["list_name"], t["title"]) for t in result["tasks"]] == [
        ("Test List", "Home thing"), ("Work", "Work thing"),
    ]
    assert (result["tasks"][0]["priority"], result["tasks"][0]["tags"]) == (3, ["a"])

    result = await _tool(hass, plan, "get_tasks", lists=["work"])
    assert [t["title"] for t in result["tasks"]] == ["Work thing"]
    assert set(result) == {"lists", "tasks"}        # one shape, however many lists


async def test_get_tasks_filters(hass: HomeAssistant, plan, store) -> None:
    done = await _task(store, "Done")
    await store.async_update_task(done, completed=True)
    await _task(store, "Late", due_date="2026-11-10", tags=["x"])
    await _task(store, "Open")

    read = lambda **args: _tool(hass, plan, "get_tasks", **args)  # noqa: E731
    assert [t["title"] for t in (await read())["tasks"]] == ["Late", "Open"]
    assert len((await read(status="all"))["tasks"]) == 3
    assert [t["title"] for t in (await read(due="overdue"))["tasks"]] == ["Late"]
    assert [t["title"] for t in (await read(tag="x"))["tasks"]] == ["Late"]


async def test_get_tasks_stays_inside_the_plan(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    private, private_store = await _add_list(hass, "Private")
    await _task(private_store, "Secret")
    await _task(store, "Visible")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])

    assert [t["title"] for t in (await _tool(hass, plan, "get_tasks"))["tasks"]] == ["Visible"]
    for name in ("Private", private.entry_id):
        with pytest.raises(HomeAssistantError, match="No list .* in this plan"):
            await _tool(hass, plan, "get_tasks", lists=[name])


async def test_a_plan_without_lists_reads_empty(hass: HomeAssistant, monday) -> None:
    plan = await _add_plan(hass)
    assert await _tool(hass, plan, "get_tasks") == {"lists": [], "tasks": []}


# ---------------------------------------------------------------------------
# Writing tasks
# ---------------------------------------------------------------------------

async def test_add_task_with_typed_fields(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    result = await _tool(
        hass, plan, "add_task", title="Send offer", priority=3, tags=["p:x", "client"],
        due_date=TUE, due_time="14:00", notes="Draft is in the folder",
        assigned_persons=["person.kevin"], sub_tasks=["Check prices"],
    )
    assert result == {
        "success": True, "task_id": result["task_id"], "list_name": "Test List",
        "entry_id": mock_config_entry.entry_id,
    }
    task = store.get_task(result["task_id"])
    assert (task["title"], task["priority"], task["tags"]) == ("Send offer", 3, ["p:x", "client"])
    assert (task["due_date"], task["due_time"], task["notes"]) == (TUE, "14:00", "Draft is in the folder")
    assert task["assigned_person"] == "person.kevin"
    assert [sub["title"] for sub in task["sub_items"]] == ["Check prices"]


async def test_add_task_needs_the_list_when_there_are_several(hass: HomeAssistant, plan, store) -> None:
    _work, work_store = await _add_list(hass, "Work")
    with pytest.raises(HomeAssistantError, match="Name the list .*Test List, Work"):
        await _tool(hass, plan, "add_task", title="Where to?")

    result = await _tool(hass, plan, "add_task", title="There", list="Work")
    assert work_store.get_task(result["task_id"])["title"] == "There"


async def test_add_task_stays_inside_the_plan(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    _private, private_store = await _add_list(hass, "Private")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    with pytest.raises(HomeAssistantError, match="No list 'Private' in this plan"):
        await _tool(hass, plan, "add_task", title="Sneak in", list="Private")
    assert private_store.tasks == []


async def test_update_task_changes_only_what_is_given(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Report", priority=1, tags=["a"], due_date=TUE, notes="Keep me")
    await _tool(hass, plan, "update_task", task_id=task_id, priority=3, tags=["a", "b"], title="Report v2")

    task = store.get_task(task_id)
    assert (task["title"], task["priority"], task["tags"]) == ("Report v2", 3, ["a", "b"])
    assert (task["due_date"], task["notes"]) == (TUE, "Keep me")


async def test_update_task_clears_with_null_and_empty_lists(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(
        store, "Report", priority=2, tags=["a"], due_date=TUE, due_time="09:00",
        notes="Old", assigned_person="person.kevin",
    )
    await _tool(
        hass, plan, "update_task", task_id=task_id,
        due_date=None, priority=None, notes=None, tags=[], assigned_persons=[],
    )
    task = store.get_task(task_id)
    assert (task["due_date"], task["due_time"], task["priority"]) == (None, None, None)
    assert (task["notes"], task["tags"], task["assigned_person"]) == ("", [], None)


async def test_update_task_needs_something_to_change(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Report")
    with pytest.raises(HomeAssistantError, match="Nothing to change"):
        await _tool(hass, plan, "update_task", task_id=task_id)


async def test_a_wrong_value_is_turned_down(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Report")
    with pytest.raises(vol.Invalid):
        await _tool(hass, plan, "update_task", task_id=task_id, priority=5)
    with pytest.raises((HomeAssistantError, vol.Invalid)):
        await _tool(hass, plan, "update_task", task_id=task_id, due_date="next week")
    assert store.get_task(task_id)["due_date"] is None
    with pytest.raises(HomeAssistantError, match="Not a date: 'tomorrow'"):
        await _tool(hass, plan, "plan_task", task_id=task_id, date="tomorrow")
    with pytest.raises(vol.Invalid):
        await _tool(hass, plan, "get_plan", days=8)
    with pytest.raises(vol.Invalid):                     # an argument the tool does not have
        await _tool(hass, plan, "get_plan", plan="Other")


async def test_complete_task_shows_as_done_on_the_plan(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Call back")
    await _tool(hass, plan, "plan_task", task_id=task_id)
    result = await _tool(hass, plan, "complete_task", task_id=task_id)

    assert result == {"success": True, "task_id": task_id, "title": "Call back"}
    assert store.get_task(task_id)["completed"] is True
    (row,) = (await _tool(hass, plan, "get_plan"))["days"][0]["items"]
    assert (row["title"], row["completed"]) == ("Call back", True)


async def test_tasks_outside_the_plan_cannot_be_touched(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    _private, private_store = await _add_list(hass, "Private")
    secret = await _task(private_store, "Secret")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])

    for name, args in (
        ("update_task", {"title": "Changed"}), ("complete_task", {}),
        ("plan_task", {}), ("set_plan", None),
    ):
        call = {"task_ids": [secret]} if args is None else {"task_id": secret, **args}
        with pytest.raises(HomeAssistantError, match="No task with id"):
            await _tool(hass, plan, name, **call)
    task = private_store.get_task(secret)
    assert (task["title"], task["completed"]) == ("Secret", False)


# ---------------------------------------------------------------------------
# The plan
# ---------------------------------------------------------------------------

async def test_get_plan_reads_days(hass: HomeAssistant, plan, store) -> None:
    await _task(store, "Due today", due_date=MON)
    await _task(store, "Due tomorrow", due_date=TUE)

    result = await _tool(hass, plan, "get_plan", days=2)
    assert (result["plan"], result["today"]) == ("Today", MON)
    assert [(day["date"], titles(day)) for day in result["days"]] == [
        (MON, ["Due today"]), (TUE, ["Due tomorrow"]),
    ]
    result = await _tool(hass, plan, "get_plan", date=TUE)
    assert [day["date"] for day in result["days"]] == [TUE]


async def test_set_plan_merges_and_says_who_wrote_it(hass: HomeAssistant, plan, store) -> None:
    evening = await _task(store, "Planned last night")
    first = await _task(store, "First")
    second = await _task(store, "Second")
    await hass.services.async_call(DOMAIN, "plan_task", {"task_id": evening}, blocking=True)

    result = await _tool(hass, plan, "set_plan", task_ids=[first, second], note="Focus: offer")
    assert result["success"] is True
    assert titles(result["day"]) == ["First", "Second", "Planned last night"]
    assert (result["day"]["note"], result["day"]["updated_by"]) == ("Focus: offer", "llm")
    assert await _today(hass) == result["day"]      # the same day a service reads

    result = await _tool(hass, plan, "set_plan", task_ids=[second], mode="replace", note=None)
    assert (titles(result["day"]), result["day"]["note"]) == (["Second"], "")


async def test_set_plan_keeps_list_scoped_task_references(
    hass: HomeAssistant, plan, store, mock_config_entry
) -> None:
    other, other_store = await _add_list(hass, "Other")
    task_id = await _task(store, "First list")
    twin = await other_store.async_add_task("Second list")
    twin["id"] = task_id
    first = {"task_id": task_id, "entry_id": mock_config_entry.entry_id}
    second = {"task_id": task_id, "entry_id": other.entry_id}

    result = await _tool(hass, plan, "set_plan", task_ids=[second])
    assert titles(result["day"]) == ["Second list"]
    result = await _tool(hass, plan, "set_plan", task_ids=[first, second])
    assert titles(result["day"]) == ["First list", "Second list"]
    result = await _tool(hass, plan, "set_plan", task_ids=[second, first], mode="replace")
    assert titles(result["day"]) == ["Second list", "First list"]


async def test_plan_task_and_unplan_task(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Move me")
    top = await _task(store, "On top")
    assert await _tool(hass, plan, "plan_task", task_id=task_id) == {"success": True, "date": MON}
    await _tool(hass, plan, "plan_task", task_id=top, position="top")
    assert titles(await _today(hass)) == ["On top", "Move me"]

    assert (await _tool(hass, plan, "plan_task", task_id=task_id, date=TUE))["date"] == TUE
    assert titles(await _today(hass)) == ["On top"]

    assert await _tool(hass, plan, "unplan_task", task_id=task_id) == {"success": True}
    assert titles(await _today(hass, date=TUE)) == []
    assert store.get_task(task_id)["title"] == "Move me"    # only the reference went


async def test_the_plans_rules_reach_the_assistant_as_errors(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Too far out")
    due = await _task(store, "Fixed point", due_date=MON)
    with pytest.raises(HomeAssistantError, match="can't be planned"):
        await _tool(hass, plan, "plan_task", task_id=task_id, date=NEXT_TUE)
    with pytest.raises(HomeAssistantError, match="through its due date"):
        await _tool(hass, plan, "unplan_task", task_id=due)


async def test_the_tools_mean_the_plans_current_day(
    hass: HomeAssistant, mock_config_entry, store, freezer
) -> None:
    freezer.move_to(_at(SAT))
    plan = await _add_plan(hass, workdays=WEEK)
    task_id = await _task(store, "After the weekend")
    assert (await _tool(hass, plan, "plan_task", task_id=task_id))["date"] == "2026-11-23"
    result = await _tool(hass, plan, "get_plan")
    assert (result["today"], result["days"][0]["date"]) == (SAT, "2026-11-23")
    assert FRI not in [day["date"] for day in result["days"]]


# ---------------------------------------------------------------------------
# Linked lists
# ---------------------------------------------------------------------------

async def test_the_tools_work_on_a_linked_list(hass: HomeAssistant, plan) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, adapter = await setup_linked_list(hass)

    await _tool(hass, plan, "update_task", task_id="uid-1", priority=3, tags=["shop"], due_date=MON)
    stored = overlay(hass, linked).get_overlay("uid-1")
    assert (stored["priority"], stored["tags"], stored["due_date"]) == (3, ["shop"], MON)

    tasks = (await _tool(hass, plan, "get_tasks", lists=["All Tasks"]))["tasks"]
    assert [(t["id"], t["title"], t["due_date"]) for t in tasks] == [("uid-1", "Wipe bench", MON)]
    (row,) = (await _tool(hass, plan, "get_plan"))["days"][0]["items"]
    assert (row["title"], row["kind"], row["entry_id"]) == ("Wipe bench", "due", linked.entry_id)

    await _tool(hass, plan, "complete_task", task_id="uid-1")
    assert adapter.updated[-1] == ("uid-1", {"completed": True})

    await _tool(hass, plan, "update_task", task_id="uid-1", due_date=None)
    assert overlay(hass, linked).get_overlay("uid-1")["due_date"] is None


async def test_a_tool_can_say_which_list_a_task_is_in(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    """Two lists can hold a task with the same id; entry_id tells them apart."""
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    twin = await store.async_add_task("Native twin")
    twin["id"] = "uid-1"

    await _tool(hass, plan, "update_task", task_id="uid-1", entry_id=mock_config_entry.entry_id, priority=3)
    assert store.get_task("uid-1")["priority"] == 3
    assert (overlay(hass, linked).get_overlay("uid-1") or {}).get("priority") is None

    await _tool(hass, plan, "plan_task", task_id="uid-1", entry_id=linked.entry_id)
    (row,) = (await _tool(hass, plan, "get_plan"))["days"][0]["items"]
    assert (row["title"], row["entry_id"]) == ("Wipe bench", linked.entry_id)
    await _tool(hass, plan, "unplan_task", task_id="uid-1", entry_id=linked.entry_id)
    assert (await _tool(hass, plan, "get_plan"))["days"][0]["items"] == []


async def test_a_list_outside_the_plan_is_no_way_in(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    private, private_store = await _add_list(hass, "Private")
    secret = await _task(private_store, "Secret")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    with pytest.raises(HomeAssistantError, match="No task with id"):
        await _tool(hass, plan, "update_task", task_id=secret, entry_id=private.entry_id, title="Changed")
    assert private_store.get_task(secret)["title"] == "Secret"


async def test_get_tasks_survives_a_list_that_cannot_be_read(hass: HomeAssistant, plan, store) -> None:
    """One dead linked list in the plan must not blind the assistant to all others."""
    from tests.integration.linked_list_helpers import EXT_ENTITY, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await _task(store, "Still readable")
    hass.states.async_remove(EXT_ENTITY)
    await hass.async_block_till_done()

    result = await _tool(hass, plan, "get_tasks")
    assert [t["title"] for t in result["tasks"]] == ["Still readable"]
    broken = next(entry for entry in result["lists"] if entry["entry_id"] == linked.entry_id)
    assert "Entity not found" in broken["error"]


# ---------------------------------------------------------------------------
# The rest of what a task can have and what can be done with it
# ---------------------------------------------------------------------------

async def test_reopen_task_takes_a_tick_back(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Ticked by mistake")
    await _tool(hass, plan, "plan_task", task_id=task_id)
    await _tool(hass, plan, "complete_task", task_id=task_id)
    assert store.get_task(task_id)["completed"] is True

    result = await _tool(hass, plan, "reopen_task", task_id=task_id)
    assert result == {"success": True, "task_id": task_id, "title": "Ticked by mistake"}
    assert store.get_task(task_id)["completed"] is False
    (row,) = (await _tool(hass, plan, "get_plan"))["days"][0]["items"]
    assert row["completed"] is False


async def test_sub_tasks_can_be_added_changed_and_removed(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Trip")
    added = await _tool(hass, plan, "add_sub_task", task_id=task_id, title="Book hotel")
    sub_id = added["sub_task_id"]
    assert [s["title"] for s in store.get_task(task_id)["sub_items"]] == ["Book hotel"]

    await _tool(hass, plan, "update_sub_task", task_id=task_id, sub_task_id=sub_id, completed=True, title="Book the hotel")
    (sub,) = store.get_task(task_id)["sub_items"]
    assert (sub["title"], sub["completed"]) == ("Book the hotel", True)
    # The id an assistant needs is in the task list.
    listed = (await _tool(hass, plan, "get_tasks"))["tasks"][0]["sub_items"]
    assert listed == [{"id": sub_id, "title": "Book the hotel", "completed": True}]

    with pytest.raises(HomeAssistantError, match="Nothing to change"):
        await _tool(hass, plan, "update_sub_task", task_id=task_id, sub_task_id=sub_id)
    with pytest.raises(HomeAssistantError, match="No sub-task found"):
        await _tool(hass, plan, "remove_sub_task", task_id=task_id, sub_task_id="nope")
    await _tool(hass, plan, "remove_sub_task", task_id=task_id, sub_task_id=sub_id)
    assert store.get_task(task_id)["sub_items"] == []


async def test_move_task_to_another_list_of_the_plan(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    work, work_store = await _add_list(hass, "Work")
    task_id = await _task(store, "Belongs to work")

    result = await _tool(hass, plan, "move_task", task_id=task_id, to_list="Work")
    assert result == {"success": True, "entry_id": work.entry_id, "list_name": "Work"}
    assert [t["title"] for t in work_store.tasks] == ["Belongs to work"]
    assert store.tasks == []

    with pytest.raises(HomeAssistantError, match="in that list already"):
        await _tool(hass, plan, "move_task", task_id=work_store.tasks[0]["id"], to_list="work")


async def test_move_task_stays_inside_the_plan(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    await _add_list(hass, "Private")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    task_id = await _task(store, "Stays")
    with pytest.raises(HomeAssistantError, match="No list 'Private' in this plan"):
        await _tool(hass, plan, "move_task", task_id=task_id, to_list="Private")
    assert store.get_task(task_id)["title"] == "Stays"


async def test_delete_task_removes_it_for_good(hass: HomeAssistant, plan, store) -> None:
    keep = await _task(store, "Keep")
    task_id = await _task(store, "Delete me")
    await _tool(hass, plan, "plan_task", task_id=task_id)

    result = await _tool(hass, plan, "delete_task", task_id=task_id)
    assert result == {"success": True, "task_id": task_id, "title": "Delete me"}
    assert [t["id"] for t in store.tasks] == [keep]
    assert (await _tool(hass, plan, "get_plan"))["days"][0]["items"] == []   # the reference goes with it
    with pytest.raises(HomeAssistantError, match="No task with id"):
        await _tool(hass, plan, "delete_task", task_id=task_id)


async def test_delete_task_on_a_linked_list_goes_through_the_provider(hass: HomeAssistant, plan) -> None:
    from pytest_homeassistant_custom_component.common import async_mock_service

    from tests.integration.linked_list_helpers import EXT_ENTITY, overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", priority=3)
    removed = async_mock_service(hass, "todo", "remove_item")

    await _tool(hass, plan, "delete_task", task_id="uid-1")
    (call,) = removed
    assert call.data == {"item": "uid-1", "entity_id": EXT_ENTITY}
    # What Home Tasks kept for the task is gone too.
    assert (overlay(hass, linked).get_overlay("uid-1") or {}).get("priority") is None


async def test_delete_task_stays_inside_the_plan(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    _private, private_store = await _add_list(hass, "Private")
    secret = await _task(private_store, "Secret")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    for name in ("delete_task", "reopen_task", "get_task"):
        with pytest.raises(HomeAssistantError, match="No task with id"):
            await _tool(hass, plan, name, task_id=secret)
    with pytest.raises(HomeAssistantError, match="No task with id"):
        await _tool(hass, plan, "add_sub_task", task_id=secret, title="Sneak in")
    assert [t["title"] for t in private_store.tasks] == ["Secret"]


async def test_a_recurring_follow_up_can_be_set_up(hass: HomeAssistant, plan, store) -> None:
    """The delegated-task case: comes back every week on Mondays, with a reminder."""
    result = await _tool(
        hass, plan, "add_task", title="Ask about the offer", due_date=MON, due_time="09:00",
        reminders=[60, 0], recurrence={"unit": "weeks", "every": 1, "weekdays": ["mon"]},
    )
    task = store.get_task(result["task_id"])
    assert task["recurrence_enabled"] is True
    assert (task["recurrence_unit"], task["recurrence_value"], task["recurrence_weekdays"]) == ("weeks", 1, [0])
    assert task["reminders"] == [0, 60]

    await _tool(hass, plan, "update_task", task_id=task["id"], recurrence={"unit": "months", "day_of_month": 15})
    task = store.get_task(task["id"])
    assert (task["recurrence_unit"], task["recurrence_day_of_month"], task["recurrence_weekdays"]) == ("months", 15, [])

    await _tool(hass, plan, "update_task", task_id=task["id"], recurrence=None, reminders=[])
    task = store.get_task(task["id"])
    assert task["recurrence_enabled"] is False and task["reminders"] == []


async def test_a_recurrence_that_does_not_fit_is_turned_down(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Report")
    with pytest.raises(HomeAssistantError, match="recurrence_unit is needed"):
        await _tool(hass, plan, "update_task", task_id=task_id, recurrence={"every": 2})
    with pytest.raises(vol.Invalid):
        await _tool(hass, plan, "update_task", task_id=task_id, recurrence={"unit": "fortnights"})
    assert store.get_task(task_id).get("recurrence_enabled") in (None, False)


async def test_section_and_position(hass: HomeAssistant, plan, store) -> None:
    section = await store.async_add_section("Waiting")
    await _task(store, "First")
    result = await _tool(hass, plan, "add_task", title="On top", section="Waiting", position="top")
    task = store.get_task(result["task_id"])
    assert task["section_id"] == section["id"]
    assert sorted(store.tasks, key=lambda t: t["sort_order"])[0]["title"] == "On top"

    await _tool(hass, plan, "update_task", task_id=task["id"], section=None)
    assert store.get_task(task["id"])["section_id"] is None
    with pytest.raises(HomeAssistantError, match="No section"):
        await _tool(hass, plan, "update_task", task_id=task["id"], section="Nope")


async def test_get_task_shows_all_of_one_task(hass: HomeAssistant, plan, store, mock_config_entry) -> None:
    result = await _tool(
        hass, plan, "add_task", title="Follow up", due_date=MON, due_time="09:00", reminders=[30],
        recurrence={"unit": "days", "every": 2}, sub_tasks=["Step one"], notes="Call first",
    )
    detail = await _tool(hass, plan, "get_task", task_id=result["task_id"])
    assert (detail["entry_id"], detail["list_name"]) == (mock_config_entry.entry_id, "Test List")
    task = detail["task"]
    assert (task["title"], task["notes"], task["reminders"]) == ("Follow up", "Call first", [30])
    assert (task["recurrence_enabled"], task["recurrence_unit"], task["recurrence_value"]) == (True, "days", 2)
    assert [sub["title"] for sub in task["sub_items"]] == ["Step one"]
    assert task["history"][0]["action"] == "created"


async def test_get_task_keeps_the_history_short(hass: HomeAssistant, plan, store) -> None:
    task_id = await _task(store, "Often changed")
    for n in range(30):
        await store.async_update_task(task_id, notes=f"note {n}")
    history = (await _tool(hass, plan, "get_task", task_id=task_id))["task"]["history"]
    assert len(history) == 20
    assert (history[-1]["action"], history[-1]["field"]) == ("updated", "notes")


async def test_get_task_on_a_linked_list(hass: HomeAssistant, plan) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, adapter = await setup_linked_list(hass)
    await overlay(hass, linked).async_set_overlay("uid-1", due_date=MON)
    adapter.labels["uid-1"] = ["shop"]          # what only the provider itself knows
    detail = await _tool(hass, plan, "get_task", task_id="uid-1")
    assert (detail["entry_id"], detail["task"]["title"], detail["task"]["tags"]) == (
        linked.entry_id, "Wipe bench", ["shop"],
    )
    assert not any(key.startswith("_") for key in detail["task"])


async def test_the_new_arguments_translate_for_mcp(hass: HomeAssistant, plan) -> None:
    schemas = {
        tool.name.removeprefix("home_tasks__"): probatio.to_openapi(tool.parameters, openapi_version="3.1.0")
        for tool in (await _api(hass, plan)).tools
    }
    recurrence = schemas["add_task"]["properties"]["recurrence"]
    assert recurrence["type"] == "object"
    assert recurrence["properties"]["unit"]["enum"] == ["hours", "days", "weeks", "months", "years"]
    assert recurrence["properties"]["weekdays"]["items"]["enum"][0] == "mon"
    # In update_task the same, or null to switch it off.
    assert {"type": "null"} in schemas["update_task"]["properties"]["recurrence"]["anyOf"]
    assert schemas["add_task"]["properties"]["reminders"] == {
        "type": "array", "items": {"type": "integer", "minimum": 0},
        "description": schemas["add_task"]["properties"]["reminders"]["description"],
    }
    assert schemas["move_task"]["required"] == ["task_id", "to_list"]
    assert schemas["update_sub_task"]["properties"]["completed"] == {"type": "boolean"}
    for name, schema in schemas.items():
        for key, prop in schema["properties"].items():
            assert "type" in prop or "anyOf" in prop, (name, key)
