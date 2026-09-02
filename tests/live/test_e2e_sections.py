"""Live tests for sections, native and external.

Sections were the one place a real bug reached a user (#60): dragging a task
into a section on an external list saved fine, but the merged read never
handed the section back, so the card put the task straight back where it came
from. Mocks caught it afterwards; nothing live would have.

The two external providers here are not interchangeable: CalDAV goes through
the GenericAdapter and ``_merge_tasks_with_overlays``, Todoist through its own
adapter and ``_merge_tasks_with_adapter_data``. The field was missing in both,
so both are tested.

Sections are ours alone — no provider knows about them — so these tests also
check that nothing of ours leaks into the item the provider stores.

Setup:  HT_NATIVE_LIST_NAME, and optionally HT_CALDAV_TEST_ENTITY /
        HT_TODOIST_TEST_ENTITY for the external halves.
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
async def section(ws: HAWebSocketClient, name: str, **target):
    """Create a section and take it away again, whatever the test does."""
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


async def _external_task(ws: HAWebSocketClient, entity_id: str, title: str) -> dict:
    """Create an external task and return it as the card sees it."""
    await ws.send_command(
        "home_tasks/create_external_task", entity_id=entity_id, title=title
    )
    await asyncio.sleep(SETTLE)
    tasks = (await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    ))["tasks"]
    match = [t for t in tasks if t["title"] == title]
    assert match, f"{title} did not turn up on {entity_id}"
    return match[0]


async def _reread_external(ws: HAWebSocketClient, entity_id: str, task_id: str) -> dict:
    tasks = (await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    ))["tasks"]
    match = [t for t in tasks if t["id"] == task_id]
    assert match, f"task {task_id} vanished from {entity_id}"
    return match[0]


# ---------------------------------------------------------------------------
# Native
# ---------------------------------------------------------------------------

@pytest.mark.live_websocket
async def test_a_native_task_keeps_its_section(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    async with section(ws_client, "ZZ Live Kitchen", list_id=list_id) as section_id:
        task = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title="ZZ section round trip"
        )

        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=list_id, task_id=task["id"], section_id=section_id,
        )
        again = [
            t for t in (await ws_client.send_command(
                "home_tasks/get_tasks", list_id=list_id
            ))["tasks"] if t["id"] == task["id"]
        ][0]

        assert again["section_id"] == section_id


@pytest.mark.live_websocket
async def test_deleting_a_native_section_frees_its_tasks(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """The task has to survive its section, unsorted rather than invisible."""
    list_id = clean_native_list
    created = await ws_client.send_command(
        "home_tasks/add_section", list_id=list_id, name="ZZ Live Doomed"
    )
    task = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="ZZ outlives its section"
    )
    await ws_client.send_command(
        "home_tasks/update_task",
        list_id=list_id, task_id=task["id"], section_id=created["id"],
    )

    await ws_client.send_command(
        "home_tasks/delete_section", list_id=list_id, section_id=created["id"]
    )

    tasks = (await ws_client.send_command("home_tasks/get_tasks", list_id=list_id))["tasks"]
    survivor = [t for t in tasks if t["id"] == task["id"]]
    assert survivor, "deleting a section must not take its tasks with it"
    assert survivor[0]["section_id"] is None


# ---------------------------------------------------------------------------
# CalDAV — the GenericAdapter path
# ---------------------------------------------------------------------------

@pytest.mark.live_caldav
async def test_a_caldav_task_keeps_its_section(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    async with section(ws_client, "ZZ Live Errands", entity_id=entity_id) as section_id:
        task = await _external_task(ws_client, entity_id, "ZZ caldav section")
        try:
            await ws_client.send_command(
                "home_tasks/update_external_overlay",
                entity_id=entity_id, task_uid=task["id"], section_id=section_id,
            )

            again = await _reread_external(ws_client, entity_id, task["id"])
            assert again["section_id"] == section_id, (
                "the overlay stored it; the merged read has to hand it back"
            )

            # Nothing of ours may end up in what Nextcloud stores.
            items = await ws_client.get_provider_items(entity_id)
            theirs = [i for i in items if i.get("uid") == task["id"]]
            assert theirs, "the item is still on the provider"
            blob = str(theirs[0])
            assert section_id not in blob, "a section id has no business on the provider"
        finally:
            await clean_external_list_factory(entity_id)


@pytest.mark.live_caldav
async def test_deleting_a_caldav_section_frees_its_tasks(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    created = await ws_client.send_command(
        "home_tasks/add_section", entity_id=entity_id, name="ZZ Live Doomed"
    )
    task = await _external_task(ws_client, entity_id, "ZZ caldav outlives section")
    try:
        await ws_client.send_command(
            "home_tasks/update_external_overlay",
            entity_id=entity_id, task_uid=task["id"], section_id=created["id"],
        )

        await ws_client.send_command(
            "home_tasks/delete_section", entity_id=entity_id, section_id=created["id"]
        )

        again = await _reread_external(ws_client, entity_id, task["id"])
        assert again["section_id"] is None
    finally:
        await clean_external_list_factory(entity_id)


# ---------------------------------------------------------------------------
# Todoist — its own adapter, its own merge
# ---------------------------------------------------------------------------

@pytest.mark.live_todoist
async def test_a_todoist_task_keeps_its_section(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """Todoist has sections of its own; ours stay ours and must still survive
    a read through the rich adapter."""
    entity_id = CONFIG.todoist_entity
    await clean_external_list_factory(entity_id)
    async with section(ws_client, "ZZ Live Errands", entity_id=entity_id) as section_id:
        task = await _external_task(ws_client, entity_id, "ZZ todoist section")
        try:
            await ws_client.send_command(
                "home_tasks/update_external_overlay",
                entity_id=entity_id, task_uid=task["id"], section_id=section_id,
            )

            again = await _reread_external(ws_client, entity_id, task["id"])
            assert again["section_id"] == section_id
        finally:
            await clean_external_list_factory(entity_id)
