"""The "Home Tasks" set of tools: every list and every plan.

And the tools both kinds of set have beyond reading and writing tasks:
the lists, copies, order, sections and defaults. The plan's own set is
tested in test_plan_llm.py.
"""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm

from tests.integration.test_plan import MON, TUE, _add_list, _add_plan, _at, _task
from tests.integration.test_plan_llm import LIST_TOOLS, TOOLS, _context

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"


@pytest.fixture
async def monday(freezer):
    freezer.move_to(_at(MON))


async def _api(hass: HomeAssistant, api_id: str = DOMAIN) -> llm.APIInstance:
    return await llm.async_get_api(hass, api_id, _context())


async def _tool(hass: HomeAssistant, tool: str, /, api_id: str = DOMAIN, **args) -> dict:
    api = await _api(hass, api_id)
    result = await api.async_call_tool(llm.ToolInput(tool_name=f"{DOMAIN}__{tool}", tool_args=args))
    await hass.async_block_till_done()
    assert isinstance(result, llm.ToolResult) and result.error is False
    return result.data


def _order(store) -> list[str]:
    return [task["title"] for task in store.tasks]


# ---------------------------------------------------------------------------
# The set
# ---------------------------------------------------------------------------

async def test_home_tasks_offers_one_set_for_everything(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    offered = {api.id: api.name for api in llm.async_get_apis(hass)}
    assert offered[DOMAIN] == "Home Tasks"
    api = await _api(hass)
    # Without a plan there are no plan tools, and nothing about plans is said.
    assert [tool.name for tool in api.tools] == LIST_TOOLS
    assert 'the task lists "Test List"' in api.api_prompt
    assert f"Today is Monday, {MON}." in api.api_prompt
    assert "home_tasks__get_lists shows the lists" in api.api_prompt
    assert "day plan" not in api.api_prompt
    assert "plan_task" not in " ".join(tool.description for tool in api.tools)


async def test_with_a_plan_the_set_has_the_plan_tools(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_list(hass, "Work")
    await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    api = await _api(hass)
    assert [tool.name for tool in api.tools] == TOOLS
    assert 'the day plans "Today" (lists: "Test List")' in api.api_prompt
    assert 'home_tasks__set_plan and mode "merge"' in api.api_prompt
    tools = {tool.name.removeprefix("home_tasks__"): tool for tool in api.tools}
    assert "home_tasks__plan_task" in tools["add_task"].description
    # In a set of every list a plan tool names its plan; in a plan's own set it does not.
    assert "plan" in tools["get_plan"].parameters.schema
    plan_api = await _api(hass, f"{DOMAIN}-{(await _plans(hass))[0].entry_id}")
    plan_tools = {tool.name.removeprefix("home_tasks__"): tool for tool in plan_api.tools}
    assert "plan" not in plan_tools["get_plan"].parameters.schema


async def _plans(hass: HomeAssistant):
    return [entry for entry in hass.config_entries.async_entries(DOMAIN) if entry.data.get("type") == "plan"]


async def test_the_set_reaches_every_list(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    private, private_store = await _add_list(hass, "Private")
    await _add_plan(hass, source_lists=[mock_config_entry.entry_id])     # does not limit this set
    secret = await _task(private_store, "Outside every plan")

    tasks = (await _tool(hass, "get_tasks"))["tasks"]
    assert "Outside every plan" in [task["title"] for task in tasks]
    await _tool(hass, "update_task", task_id=secret, priority=3)
    assert private_store.get_task(secret)["priority"] == 3
    with pytest.raises(HomeAssistantError, match=r"No list 'Nope' \(lists: Test List, Private\)"):
        await _tool(hass, "add_task", list="Nope", title="x")


async def test_the_plan_tools_name_the_plan_when_there_are_several(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    await _add_plan(hass)
    await _add_plan(hass, "Work week")
    task_id = await _task(store, "Plan me")
    assert 'the plan tools take the plan\'s name as "plan"' in (await _api(hass)).api_prompt

    with pytest.raises(HomeAssistantError, match="several plans"):
        await _tool(hass, "plan_task", task_id=task_id)
    await _tool(hass, "plan_task", task_id=task_id, plan="work week", date=TUE)
    read = await _tool(hass, "get_plan", plan="Work week", date=TUE)
    assert read["plan"] == "Work week"
    assert [row["title"] for row in read["days"][0]["items"]] == ["Plan me"]
    assert (await _tool(hass, "get_plan", plan="Today", date=TUE))["days"][0]["items"] == []
    with pytest.raises(HomeAssistantError, match="No plan found"):
        await _tool(hass, "get_plan", plan="Holidays")


# ---------------------------------------------------------------------------
# The lists
# ---------------------------------------------------------------------------

async def test_get_lists_says_what_a_list_has(hass: HomeAssistant, mock_config_entry, store, monday) -> None:
    from tests.integration.linked_list_helpers import setup_linked_list

    shop = await store.async_add_section("Shop")
    await store.async_add_section("Home")
    await store.async_set_defaults(
        assignees=["person.anna"], priority=2, section_id=shop["id"], tag_catalog=["errand"],
        recurrence_reopen_lead=60,
    )
    await _task(store, "Open one")
    done = await _task(store, "Done one")
    await store.async_update_task(done, completed=True)
    linked, _adapter = await setup_linked_list(hass)
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])

    result = await _tool(hass, "get_lists")
    native, ext = result["lists"]
    assert native == {
        "entry_id": mock_config_entry.entry_id, "name": "Test List", "kind": "native",
        "open_tasks": 1, "sections": ["Shop", "Home"], "fixed_tags": ["errand"],
        "defaults": {
            "assigned_persons": ["person.anna"], "reminders": [], "tags": [], "priority": 2,
            "section": "Shop", "reopen_early_minutes": 60,
        },
    }
    assert (ext["entry_id"], ext["kind"], ext["entity_id"], ext["open_tasks"]) == (
        linked.entry_id, "linked", "todo.all_tasks", 1,
    )
    assert "reopen_early_minutes" not in ext["defaults"]
    assert result["plans"] == [{"entry_id": plan.entry_id, "name": "Today", "lists": ["Test List"]}]

    # A plan's own set sees its lists only.
    (only,) = (await _tool(hass, "get_lists", api_id=f"{DOMAIN}-{plan.entry_id}"))["lists"]
    assert only["name"] == "Test List"


# ---------------------------------------------------------------------------
# Copies and order
# ---------------------------------------------------------------------------

async def test_duplicate_task_keeps_what_the_task_has(hass: HomeAssistant, mock_config_entry, store) -> None:
    source = await store.async_add_task(
        "Water plants", assigned_persons=["person.anna", "person.ben"], priority=3, tags=["home"],
    )
    await store.async_add_sub_task(source["id"], "Balcony")

    result = await _tool(hass, "duplicate_task", task_id=source["id"])
    copy = store.get_task(result["task_id"])
    assert result["entry_id"] == mock_config_entry.entry_id and copy["id"] != source["id"]
    assert (copy["title"], copy["priority"], copy["tags"]) == ("Water plants", 3, ["home"])
    assert copy["assigned_persons"] == ["person.anna", "person.ben"]
    assert [sub["title"] for sub in copy["sub_items"]] == ["Balcony"]

    for_ben = await _tool(hass, "duplicate_task", task_id=source["id"], assigned_person="person.ben")
    assert store.get_task(for_ben["task_id"])["assigned_persons"] == ["person.ben"]


async def test_duplicate_task_on_a_linked_list(hass: HomeAssistant, mock_config_entry, store) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, adapter = await setup_linked_list(hass)
    kept = overlay(hass, linked)
    garage = await kept.async_add_section("Garage")
    await kept.async_set_overlay("uid-1", section_id=garage["id"])
    result = await _tool(hass, "duplicate_task", task_id="uid-1")
    assert (result["task_id"], result["entry_id"]) == ("uid-new", linked.entry_id)
    assert adapter.created[-1]["title"] == "Wipe bench"
    # What only Home Tasks keeps for the task comes along.
    assert kept.get_overlay("uid-new")["section_id"] == garage["id"]


async def test_reorder_tasks_puts_the_named_ones_first(hass: HomeAssistant, mock_config_entry, store) -> None:
    ids = {title: await _task(store, title) for title in ("A", "B", "C", "D")}
    await _tool(hass, "reorder_tasks", task_ids=[ids["C"], ids["A"]])
    assert _order(store) == ["C", "A", "B", "D"]

    with pytest.raises(HomeAssistantError, match="Not in Test List: nope"):
        await _tool(hass, "reorder_tasks", task_ids=["nope"])
    assert _order(store) == ["C", "A", "B", "D"]


async def test_reorder_tasks_on_a_linked_list(hass: HomeAssistant, mock_config_entry, store) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await _tool(hass, "reorder_tasks", list="All Tasks", task_ids=["uid-2"])
    stored = overlay(hass, linked)
    assert (stored.get_overlay("uid-2")["sort_order"], stored.get_overlay("uid-1")["sort_order"]) == (0, 1)


# ---------------------------------------------------------------------------
# Sections and defaults
# ---------------------------------------------------------------------------

async def test_sections_can_be_added_changed_moved_and_deleted(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    result = await _tool(hass, "add_section", name="Fruit", icon="mdi:food-apple")
    assert result["sections"] == ["Fruit"]
    await _tool(hass, "add_section", name="Dairy")
    assert (await _tool(hass, "add_section", name="Bakery", position=1))["sections"] == [
        "Bakery", "Fruit", "Dairy",
    ]

    result = await _tool(hass, "update_section", section="fruit", name="Fruit & veg", position=3)
    assert result["sections"] == ["Bakery", "Dairy", "Fruit & veg"]
    await _tool(hass, "update_section", section="Fruit & veg", icon=None)
    fruit = next(s for s in store.sections if s["name"] == "Fruit & veg")
    assert fruit["icon"] is None

    task_id = (await _tool(hass, "add_task", title="Milk", section="Dairy"))["task_id"]
    assert (await _tool(hass, "delete_section", section="Dairy"))["sections"] == ["Bakery", "Fruit & veg"]
    assert store.get_task(task_id)["section_id"] is None

    with pytest.raises(HomeAssistantError, match=r"No section 'Dairy' in Test List \(sections: Bakery, Fruit & veg\)"):
        await _tool(hass, "update_section", section="Dairy", name="x")
    with pytest.raises(HomeAssistantError, match="Nothing to change"):
        await _tool(hass, "update_section", section="Bakery")
    # What the store turns down comes back as a tool error.
    with pytest.raises(HomeAssistantError, match="Section name"):
        await _tool(hass, "add_section", name="x" * 101)


async def test_sections_on_a_linked_list(hass: HomeAssistant, mock_config_entry, store) -> None:
    from tests.integration.linked_list_helpers import overlay, setup_linked_list

    linked, _adapter = await setup_linked_list(hass)
    await _tool(hass, "add_section", list="All Tasks", name="Garage")
    assert [s["name"] for s in overlay(hass, linked).sections] == ["Garage"]


async def test_set_list_defaults(hass: HomeAssistant, mock_config_entry, store) -> None:
    await store.async_add_section("Inbox")
    result = await _tool(
        hass, "set_list_defaults", assigned_persons=["person.anna"], priority=3, section="inbox",
        fixed_tags=["work", "home"], reminders=[30], reopen_early_minutes=120,
    )
    assert result["defaults"] == {
        "assigned_persons": ["person.anna"], "reminders": [30], "tags": [], "priority": 3,
        "section": "Inbox", "reopen_early_minutes": 120,
    }
    assert result["fixed_tags"] == ["work", "home"]

    # A new task gets them, however it is added.
    task = store.get_task((await _tool(hass, "add_task", title="New"))["task_id"])
    assert (task["assigned_persons"], task["priority"]) == (["person.anna"], 3)

    # Only what is given changes; null and [] clear.
    result = await _tool(hass, "set_list_defaults", priority=None, section=None, assigned_persons=[])
    assert result["defaults"]["priority"] is None and result["defaults"]["section"] is None
    assert result["defaults"]["assigned_persons"] == [] and result["defaults"]["reminders"] == [30]
    with pytest.raises(HomeAssistantError, match="Nothing to change"):
        await _tool(hass, "set_list_defaults")


async def test_reopening_early_is_for_native_lists(hass: HomeAssistant, mock_config_entry, store) -> None:
    from tests.integration.linked_list_helpers import setup_linked_list

    await setup_linked_list(hass)
    with pytest.raises(HomeAssistantError, match="native lists only"):
        await _tool(hass, "set_list_defaults", list="All Tasks", reopen_early_minutes=60)
    result = await _tool(hass, "set_list_defaults", list="All Tasks", tags=["shop"])
    assert result["defaults"]["tags"] == ["shop"]


async def test_a_plans_set_keeps_its_new_tools_inside_the_plan(
    hass: HomeAssistant, mock_config_entry, store, monday
) -> None:
    private, private_store = await _add_list(hass, "Private")
    secret = await _task(private_store, "Secret")
    plan = await _add_plan(hass, source_lists=[mock_config_entry.entry_id])
    api_id = f"{DOMAIN}-{plan.entry_id}"
    with pytest.raises(HomeAssistantError, match="No task with id .* in the lists of this plan"):
        await _tool(hass, "duplicate_task", api_id=api_id, task_id=secret)
    for name, args in (
        ("reorder_tasks", {"task_ids": [secret]}),
        ("add_section", {"name": "Sneak"}),
        ("set_list_defaults", {"priority": 3}),
    ):
        with pytest.raises(HomeAssistantError, match="No list 'Private' in this plan"):
            await _tool(hass, name, api_id=api_id, list="Private", **args)
    assert private_store.sections == [] and len(private_store.tasks) == 1
