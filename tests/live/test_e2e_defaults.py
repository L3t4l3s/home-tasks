"""Live tests for per-list defaults for new tasks.

Defaults live in the integration precisely so that they apply however a task
is created, which makes them worth checking against the real thing: on an
external list the provider is offered them first, and what it cannot take
falls back to the overlay. No mock can say which of the two really happened
for Todoist or CalDAV.

Every test restores the list's own defaults afterwards — these are real
settings on a real list, not scratch data.

Setup:  HT_NATIVE_LIST_NAME, and optionally HT_CALDAV_TEST_ENTITY /
        HT_TODOIST_TEST_ENTITY.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from .config import CONFIG
from .ws_client import HAWebSocketClient

pytestmark = [pytest.mark.live]

SETTLE = 1.5


@asynccontextmanager
async def defaults(ws: HAWebSocketClient, **target):
    """Hand back a setter, and put the list's own defaults back afterwards."""
    before = (await ws.send_command("home_tasks/get_defaults", **target))["defaults"]

    async def _set(**fields):
        return (await ws.send_command(
            "home_tasks/set_defaults", **target, **fields
        ))["defaults"]

    try:
        yield _set
    finally:
        try:
            await ws.send_command(
                "home_tasks/set_defaults", **target,
                assignee=before["assignee"], reminders=before["reminders"],
                tags=before["tags"], priority=before["priority"],
                section_id=before["section_id"],
            )
        except Exception as err:  # noqa: BLE001
            print(f"[defaults teardown] could not restore {target}: {err}")


@asynccontextmanager
async def section(ws: HAWebSocketClient, name: str, **target):
    created = await ws.send_command("home_tasks/add_section", name=name, **target)
    try:
        yield created["id"]
    finally:
        try:
            await ws.send_command(
                "home_tasks/delete_section", section_id=created["id"], **target
            )
        except Exception as err:  # noqa: BLE001
            print(f"[sections teardown] could not delete {created['id']}: {err}")


# ---------------------------------------------------------------------------
# Native
# ---------------------------------------------------------------------------

@pytest.mark.live_websocket
async def test_a_new_native_task_starts_with_the_lists_defaults(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    async with section(ws_client, "ZZ Live Kitchen", list_id=list_id) as section_id:
        async with defaults(ws_client, list_id=list_id) as set_defaults:
            await set_defaults(tags=["zz-chore"], priority=2, section_id=section_id)

            task = await ws_client.send_command(
                "home_tasks/add_task", list_id=list_id, title="ZZ defaulted task"
            )

            assert task["tags"] == ["zz-chore"]
            assert task["priority"] == 2
            assert task["section_id"] == section_id


@pytest.mark.live_websocket
async def test_what_the_caller_asks_for_beats_the_default(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    async with defaults(ws_client, list_id=list_id) as set_defaults:
        await set_defaults(tags=["zz-chore"], priority=3)

        explicit = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ explicit task",
            tags=["zz-urgent"], priority=1,
        )
        emptied = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ bare task", tags=[],
        )

        assert explicit["tags"] == ["zz-urgent"]
        assert explicit["priority"] == 1
        assert emptied["tags"] == [], "an empty list is a decision, not a gap"


@pytest.mark.live_websocket
async def test_setting_one_default_leaves_the_others_where_they_were(
    ws_client: HAWebSocketClient, native_list_id: str
) -> None:
    """A card that changes one field must not wipe the rest of the list's
    settings on the way through."""
    async with defaults(ws_client, list_id=native_list_id) as set_defaults:
        await set_defaults(tags=["zz-chore"], priority=3, reminders=[15])

        after = await set_defaults(priority=1)

        assert after["tags"] == ["zz-chore"]
        assert after["reminders"] == [15]
        assert after["priority"] == 1


@pytest.mark.live_websocket
async def test_a_default_section_goes_when_the_section_does(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Otherwise every later task is filed into something that is not there."""
    list_id = clean_native_list
    async with defaults(ws_client, list_id=list_id) as set_defaults:
        created = await ws_client.send_command(
            "home_tasks/add_section", list_id=list_id, name="ZZ Live Doomed"
        )
        await set_defaults(section_id=created["id"])

        await ws_client.send_command(
            "home_tasks/delete_section", list_id=list_id, section_id=created["id"]
        )

        now = (await ws_client.send_command(
            "home_tasks/get_defaults", list_id=list_id
        ))["defaults"]
        assert now["section_id"] is None
        # And the list still takes new tasks.
        task = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ after the section went"
        )
        assert task["section_id"] is None


# ---------------------------------------------------------------------------
# External
# ---------------------------------------------------------------------------

async def _external_task(ws: HAWebSocketClient, entity_id: str, title: str, **fields) -> dict:
    await ws.send_command(
        "home_tasks/create_external_task", entity_id=entity_id, title=title, **fields
    )
    await asyncio.sleep(SETTLE)
    tasks = (await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    ))["tasks"]
    match = [t for t in tasks if t["title"] == title]
    assert match, f"{title} did not turn up on {entity_id}"
    return match[0]


@pytest.mark.live_caldav
async def test_a_caldav_task_starts_with_the_lists_defaults(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """CalDAV syncs none of this, so all of it has to survive in the overlay."""
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    async with section(ws_client, "ZZ Live Errands", entity_id=entity_id) as section_id:
        async with defaults(ws_client, entity_id=entity_id) as set_defaults:
            await set_defaults(tags=["zz-shopping"], priority=1, section_id=section_id)
            try:
                task = await _external_task(ws_client, entity_id, "ZZ caldav defaulted")

                assert task["tags"] == ["zz-shopping"]
                assert task["priority"] == 1
                assert task["section_id"] == section_id

                # None of it may end up in what Nextcloud stores.
                items = await ws_client.get_provider_items(entity_id)
                theirs = [i for i in items if i.get("uid") == task["id"]]
                assert theirs
                assert "zz-shopping" not in str(theirs[0])
            finally:
                await clean_external_list_factory(entity_id)


@pytest.mark.live_caldav
async def test_an_external_caller_still_wins(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    async with defaults(ws_client, entity_id=entity_id) as set_defaults:
        await set_defaults(tags=["zz-shopping"], priority=1)
        try:
            task = await _external_task(
                ws_client, entity_id, "ZZ caldav explicit",
                tags=["zz-urgent"], priority=3,
            )

            assert task["tags"] == ["zz-urgent"]
            assert task["priority"] == 3
        finally:
            await clean_external_list_factory(entity_id)


@pytest.mark.live_todoist
async def test_a_todoist_task_starts_with_the_lists_defaults(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """Todoist takes labels and priority itself; the merged view has to show
    them either way, and the section stays ours."""
    entity_id = CONFIG.todoist_entity
    await clean_external_list_factory(entity_id)
    async with section(ws_client, "ZZ Live Errands", entity_id=entity_id) as section_id:
        async with defaults(ws_client, entity_id=entity_id) as set_defaults:
            await set_defaults(tags=["zz-shopping"], priority=2, section_id=section_id)
            try:
                task = await _external_task(ws_client, entity_id, "ZZ todoist defaulted")

                assert task["tags"] == ["zz-shopping"]
                assert task["priority"] == 2
                assert task["section_id"] == section_id
            finally:
                await clean_external_list_factory(entity_id)
