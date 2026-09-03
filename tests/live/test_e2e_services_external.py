"""The services against a real linked list (#63).

The report was an automation that tags a task: it worked from the card and
failed from `home_tasks.update_task`, because the services only ever resolved
native lists. These tests call the services the way an automation does, on a
real provider, and read the result back through the merged view.

Setup:  HT_CALDAV_TEST_ENTITY / HT_TODOIST_TEST_ENTITY.
"""
from __future__ import annotations

import asyncio

import pytest

from .config import CONFIG
from .ws_client import HAWebSocketClient

pytestmark = [pytest.mark.live]

SETTLE = 1.5
TITLE = "ZZ service tagged task"


async def _make_task(ws: HAWebSocketClient, entity_id: str, title: str = TITLE) -> dict:
    await ws.send_command(
        "home_tasks/create_external_task", entity_id=entity_id, title=title
    )
    await asyncio.sleep(SETTLE)
    return await _find(ws, entity_id, title)


async def _find(ws: HAWebSocketClient, entity_id: str, title: str) -> dict:
    tasks = (await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    ))["tasks"]
    match = [t for t in tasks if t["title"] == title]
    assert match, f"{title} is not on {entity_id}"
    return match[0]


async def _entry_name(ws: HAWebSocketClient, entity_id: str) -> str:
    """The name the linked list goes by — what an automation would write."""
    lists = (await ws.send_command("home_tasks/get_external_lists"))["external_lists"]
    for entry in lists:
        if entry.get("entity_id") == entity_id:
            return entry.get("name") or entity_id
    raise AssertionError(f"{entity_id} is not linked")


@pytest.mark.live_caldav
async def test_update_task_tags_a_task_on_a_linked_list(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """The reporter's automation, on a real CalDAV list."""
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    try:
        await _make_task(ws_client, entity_id)
        name = await _entry_name(ws_client, entity_id)

        await ws_client.call_service(
            "home_tasks", "update_task",
            {"list_name": name, "task_title": TITLE, "tags": "zz-kitchen"},
        )
        await asyncio.sleep(SETTLE)

        assert (await _find(ws_client, entity_id, TITLE))["tags"] == ["zz-kitchen"]
    finally:
        await clean_external_list_factory(entity_id)


@pytest.mark.live_caldav
async def test_the_whole_family_works_on_a_linked_list(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    try:
        await ws_client.call_service(
            "home_tasks", "add_task",
            {"entity_id": entity_id, "title": TITLE, "priority": 1},
        )
        await asyncio.sleep(SETTLE)
        task = await _find(ws_client, entity_id, TITLE)
        assert task["priority"] == 1, "created with what the call asked for"

        await ws_client.call_service(
            "home_tasks", "assign_task",
            {"entity_id": entity_id, "task_title": TITLE, "person": "person.kevin"},
        )
        await asyncio.sleep(SETTLE)
        assert (await _find(ws_client, entity_id, TITLE))["assigned_person"] == "person.kevin"

        await ws_client.call_service(
            "home_tasks", "complete_task",
            {"entity_id": entity_id, "task_title": TITLE},
        )
        await asyncio.sleep(SETTLE)
        assert (await _find(ws_client, entity_id, TITLE))["completed"] is True

        await ws_client.call_service(
            "home_tasks", "reopen_task",
            {"entity_id": entity_id, "task_title": TITLE},
        )
        await asyncio.sleep(SETTLE)
        assert (await _find(ws_client, entity_id, TITLE))["completed"] is False
    finally:
        await clean_external_list_factory(entity_id)


@pytest.mark.live_todoist
async def test_a_rich_provider_takes_the_change_itself(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """Todoist syncs labels, so the tag must end up on Todoist's own task —
    not only in our overlay."""
    entity_id = CONFIG.todoist_entity
    await clean_external_list_factory(entity_id)
    try:
        await _make_task(ws_client, entity_id)
        name = await _entry_name(ws_client, entity_id)

        await ws_client.call_service(
            "home_tasks", "update_task",
            {"list_name": name, "task_title": TITLE, "tags": "zz-kitchen"},
        )
        await asyncio.sleep(SETTLE)

        assert (await _find(ws_client, entity_id, TITLE))["tags"] == ["zz-kitchen"]
    finally:
        await clean_external_list_factory(entity_id)
