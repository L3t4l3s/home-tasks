"""Sub-tasks through the services, not only the card (issue #70).

An assistant that drives Home Assistant through service calls could create a
task with notes, due date and tags, but its checklist ended up as markdown in
the notes: add_task took no sub-tasks and nothing else could tick one off.
"""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
import voluptuous as vol

from tests.integration.linked_list_helpers import (
    EXT_ENTITY,
    LIST_NAME,
    LinkedListAdapter,
    call as _call,
    overlay as _overlay,
)

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
NATIVE = "Test List"


def _subs(task: dict) -> list[tuple[str, bool]]:
    return [(s["title"], s["completed"]) for s in task["sub_items"]]


# ---------------------------------------------------------------------------
# Native lists
# ---------------------------------------------------------------------------

async def test_add_task_with_sub_tasks(hass: HomeAssistant, store) -> None:
    await _call(hass, "add_task", list_name=NATIVE, title="Groceries", sub_tasks=["Milk", "Bread"])
    task = store.tasks[0]
    assert _subs(task) == [("Milk", False), ("Bread", False)]
    assert len({s["id"] for s in task["sub_items"]}) == 2


async def test_a_single_sub_task_may_be_a_plain_string(hass: HomeAssistant, store) -> None:
    await _call(hass, "add_task", list_name=NATIVE, title="Groceries", sub_tasks="Milk")
    assert _subs(store.tasks[0]) == [("Milk", False)]


async def test_too_many_sub_tasks_are_refused(hass: HomeAssistant, store) -> None:
    from custom_components.home_tasks.const import MAX_SUB_TASKS_PER_TASK

    with pytest.raises(vol.Invalid):
        await _call(
            hass, "add_task", list_name=NATIVE, title="Groceries",
            sub_tasks=[f"Item {i}" for i in range(MAX_SUB_TASKS_PER_TASK + 1)],
        )
    assert store.tasks == []


async def test_add_sub_task_returns_its_id(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Groceries")
    result = await hass.services.async_call(
        DOMAIN, "add_sub_task",
        {"list_name": NATIVE, "task_title": "groceries", "title": "Eggs"},
        blocking=True, return_response=True,
    )
    sub = store.get_task(task["id"])["sub_items"][0]
    assert result == {"task_id": task["id"], "sub_task_id": sub["id"]}
    assert sub["title"] == "Eggs"


async def test_check_off_and_rename_by_title(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Groceries", sub_tasks=["Milk", "Bread"])
    await _call(
        hass, "update_sub_task",
        list_name=NATIVE, task_title="Groceries", sub_task_title="MILK", completed=True,
    )
    await _call(
        hass, "update_sub_task",
        list_name=NATIVE, task_id=task["id"], sub_task_title="Bread", title="Rye bread",
    )
    assert _subs(store.get_task(task["id"])) == [("Milk", True), ("Rye bread", False)]


async def test_a_shared_title_ticks_the_next_open_one(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Groceries", sub_tasks=["Milk", "Milk"])
    for _ in range(2):
        await _call(
            hass, "update_sub_task",
            list_name=NATIVE, task_title="Groceries", sub_task_title="Milk", completed=True,
        )
    assert _subs(store.get_task(task["id"])) == [("Milk", True), ("Milk", True)]
    await _call(
        hass, "update_sub_task",
        list_name=NATIVE, task_title="Groceries", sub_task_title="Milk", completed=False,
    )
    assert _subs(store.get_task(task["id"])) == [("Milk", False), ("Milk", True)]


async def test_remove_sub_task_by_id(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Groceries", sub_tasks=["Milk", "Bread"])
    milk = task["sub_items"][0]["id"]
    await _call(hass, "remove_sub_task", list_name=NATIVE, task_title="Groceries", sub_task_id=milk)
    assert _subs(store.get_task(task["id"])) == [("Bread", False)]


async def test_a_sub_task_that_is_not_there_says_so(hass: HomeAssistant, store) -> None:
    await store.async_add_task("Groceries", sub_tasks=["Milk"])
    with pytest.raises(ServiceValidationError, match="no sub-task with title: Cheese"):
        await _call(
            hass, "update_sub_task",
            list_name=NATIVE, task_title="Groceries", sub_task_title="Cheese", completed=True,
        )
    with pytest.raises(ServiceValidationError, match="sub_task_id or sub_task_title"):
        await _call(hass, "remove_sub_task", list_name=NATIVE, task_title="Groceries")


async def test_get_tasks_returns_sub_task_ids(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Groceries", sub_tasks=["Milk"])
    result = await hass.services.async_call(
        DOMAIN, "get_tasks", {"list_name": NATIVE}, blocking=True, return_response=True,
    )
    assert result["tasks"][0]["sub_items"] == [
        {"id": task["sub_items"][0]["id"], "title": "Milk", "completed": False}
    ]


# ---------------------------------------------------------------------------
# Linked lists — the overlay keeps sub-tasks for a provider without them
# ---------------------------------------------------------------------------

async def test_overlay_sub_tasks_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list
    # A plain todo entity (shopping list, CalDAV, …): no adapter of its own,
    # the overlay is where its sub-tasks live and where they are read from.
    hass.data[f"{DOMAIN}_adapters"].pop(EXT_ENTITY)
    await _call(hass, "add_sub_task", list_name=LIST_NAME, task_title="Wipe bench", title="Spray")
    await _call(hass, "add_sub_task", entity_id=EXT_ENTITY, task_id="uid-1", title="Dry")
    await _call(
        hass, "update_sub_task",
        list_name=LIST_NAME, task_title="Wipe bench", sub_task_title="spray", completed=True,
    )
    await _call(hass, "remove_sub_task", list_name=LIST_NAME, task_title="Wipe bench", sub_task_title="Dry")
    subs = _overlay(hass, entry).get_overlay("uid-1")["sub_items"]
    assert [(s["title"], s["completed"]) for s in subs] == [("Spray", True)]


async def test_add_task_with_sub_tasks_on_a_linked_list(hass: HomeAssistant, linked_list) -> None:
    entry, _adapter = linked_list
    await _call(hass, "add_task", list_name=LIST_NAME, title="Groceries", sub_tasks=["Milk", "Bread"])
    subs = _overlay(hass, entry).get_overlay("uid-new")["sub_items"]
    assert [s["title"] for s in subs] == ["Milk", "Bread"]


# ---------------------------------------------------------------------------
# Linked lists whose provider has sub-tasks of its own (Todoist)
# ---------------------------------------------------------------------------

class _SubTaskAdapter(LinkedListAdapter):
    def __init__(self, hass, entity_id: str) -> None:
        super().__init__(hass, entity_id)
        self.capabilities.can_sync_sub_items = True
        self.sub_items: dict[str, list[dict]] = {"uid-1": [{"id": "s-1", "title": "Spray", "completed": False}]}
        self.sub_calls: list[tuple] = []

    async def async_read_tasks(self):
        items = await super().async_read_tasks()
        for item in items:
            item["sub_items"] = list(self.sub_items.get(item["uid"], []))
        return items

    async def async_add_sub_task(self, task_uid, title):
        self.sub_calls.append(("add", task_uid, title))
        return "s-new"

    async def async_update_sub_task(self, sub_task_id, **kwargs):
        self.sub_calls.append(("update", sub_task_id, kwargs))

    async def async_delete_sub_task(self, sub_task_id):
        self.sub_calls.append(("delete", sub_task_id))


async def test_a_provider_with_sub_tasks_gets_them(hass: HomeAssistant, linked_list) -> None:
    entry, _ = linked_list
    adapter = _SubTaskAdapter(hass, EXT_ENTITY)
    hass.data[f"{DOMAIN}_adapters"][EXT_ENTITY] = adapter

    result = await hass.services.async_call(
        DOMAIN, "add_sub_task",
        {"list_name": LIST_NAME, "task_title": "Wipe bench", "title": "Dry"},
        blocking=True, return_response=True,
    )
    await _call(
        hass, "update_sub_task",
        list_name=LIST_NAME, task_title="Wipe bench", sub_task_title="Spray", completed=True,
    )
    await _call(hass, "remove_sub_task", list_name=LIST_NAME, task_title="Wipe bench", sub_task_id="s-1")
    await _call(hass, "add_task", list_name=LIST_NAME, title="Groceries", sub_tasks=["Milk"])

    assert result == {"task_id": "uid-1", "sub_task_id": "s-new"}
    assert adapter.sub_calls == [
        ("add", "uid-1", "Dry"),
        ("update", "s-1", {"completed": True}),
        ("delete", "s-1"),
        ("add", "uid-new", "Milk"),
    ]
    assert not _overlay(hass, entry).get_overlay("uid-1").get("sub_items")


# ---------------------------------------------------------------------------
# Mistakes in the call (review of #70)
# ---------------------------------------------------------------------------

async def test_a_bad_sub_task_title_creates_nothing_on_a_linked_list(
    hass: HomeAssistant, linked_list
) -> None:
    _entry, adapter = linked_list
    with pytest.raises(ServiceValidationError, match="Sub-task title"):
        await _call(hass, "add_task", list_name=LIST_NAME, title="Groceries", sub_tasks=["Milk", "x" * 300])
    assert adapter.created == []


async def test_a_provider_failing_halfway_says_what_exists(hass: HomeAssistant, linked_list) -> None:
    from homeassistant.exceptions import HomeAssistantError

    adapter = _SubTaskAdapter(hass, EXT_ENTITY)
    hass.data[f"{DOMAIN}_adapters"][EXT_ENTITY] = adapter

    async def flaky(task_uid, title):
        if title == "Bread":
            raise RuntimeError("quota exceeded")
        adapter.sub_calls.append(("add", task_uid, title))
        return "s-x"

    adapter.async_add_sub_task = flaky
    with pytest.raises(HomeAssistantError, match="only 1 of 2 sub-tasks: quota exceeded"):
        await _call(hass, "add_task", list_name=LIST_NAME, title="Groceries", sub_tasks=["Milk", "Bread"])
    assert adapter.sub_calls == [("add", "uid-new", "Milk")]


async def test_update_sub_task_needs_something_to_change(hass: HomeAssistant, store) -> None:
    await store.async_add_task("Groceries", sub_tasks=["Milk"])
    with pytest.raises(ServiceValidationError, match="title and/or completed"):
        await _call(hass, "update_sub_task", list_name=NATIVE, task_title="Grocries", sub_task_title="Milk")


@pytest.mark.parametrize("service,extra", [
    ("add_sub_task", {"title": "Eggs"}),
    ("update_sub_task", {"sub_task_title": "Milk", "completed": True}),
    ("remove_sub_task", {"sub_task_title": "Milk"}),
])
async def test_a_task_that_is_not_there_is_a_validation_error(
    hass: HomeAssistant, store, service, extra
) -> None:
    with pytest.raises(ServiceValidationError, match="No task found with title: Nowhere"):
        await _call(hass, service, list_name=NATIVE, task_title="Nowhere", **extra)
