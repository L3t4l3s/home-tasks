"""Live tests for the CalDAV/Nextcloud provider via the GenericAdapter.

CalDAV uses the GenericAdapter (HA's standard todo entity interface).
Tests exercise the create/update/delete round-trip and overlay routing for
fields the provider can't sync natively.

Setup:  HT_CALDAV_TEST_ENTITY=todo.<your_test_collection>
"""
from __future__ import annotations

import asyncio

import pytest

from .config import CONFIG
from .ws_client import HAWebSocketClient

pytestmark = [pytest.mark.live, pytest.mark.live_caldav]

# CalDAV is also eventually-consistent
SETTLE = 0.6


async def _wipe(ws: HAWebSocketClient, entity_id: str) -> None:
    result = await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    )
    tasks = result.get("tasks", [])
    if len(tasks) > CONFIG.max_existing_items:
        raise RuntimeError(
            f"Refusing to wipe {entity_id}: {len(tasks)} tasks > max"
        )
    for t in tasks:
        try:
            await ws.call_service(
                "todo", "remove_item",
                {"entity_id": entity_id, "item": t["id"]},
            )
        except Exception as err:  # noqa: BLE001
            print(f"[caldav cleanup] failed to remove {t.get('id')}: {err}")
    if tasks:
        await asyncio.sleep(SETTLE)


async def _refetch(ws: HAWebSocketClient, entity_id: str) -> list[dict]:
    result = await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    )
    return result.get("tasks", [])


async def _ensure_caldav_available(ws: HAWebSocketClient, entity_id: str) -> None:
    """Reload the CalDAV integration if the entity is unavailable.

    The CalDAV server (e.g. Nextcloud on SQLite) is often slow to respond
    after an HA restart.  Instead of skipping the tests, reload the config
    entry once and wait for the entity to come back.
    """
    states = await ws.get_states()
    state = next((s for s in states if s["entity_id"] == entity_id), None)
    if state and state.get("state") != "unavailable":
        return  # already available

    # Find the caldav config entry and reload it
    entries = await ws.send_command("config_entries/get")
    caldav_entry = next(
        (e for e in entries if e["domain"] == "caldav"),
        None,
    )
    if caldav_entry:
        print(f"[caldav] Entity {entity_id} unavailable — reloading config entry '{caldav_entry.get('title')}'")
        try:
            await ws.send_command(
                "config_entries/reload",
                entry_id=caldav_entry["entry_id"],
            )
        except Exception as err:
            print(f"[caldav] Reload failed: {err}")

    # Wait for the entity to become available (up to 15s)
    for attempt in range(15):
        await asyncio.sleep(1)
        states = await ws.get_states()
        state = next((s for s in states if s["entity_id"] == entity_id), None)
        if state and state.get("state") != "unavailable":
            print(f"[caldav] Entity available after {attempt + 1}s")
            return

    pytest.skip(f"{entity_id} still unavailable after CalDAV reload + 15s wait")


@pytest.fixture
async def caldav_entity(ws_client: HAWebSocketClient) -> str:
    entity_id = CONFIG.caldav_entity
    assert entity_id
    await _ensure_caldav_available(ws_client, entity_id)
    await _wipe(ws_client, entity_id)
    return entity_id


# ---------------------------------------------------------------------------
# Basic CRUD via the create/update_external_task commands
# ---------------------------------------------------------------------------


async def test_create_basic_task(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """create_external_task creates a CalDAV item visible in get_external_tasks."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="CalDAV smoke",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    assert any(t["title"] == "CalDAV smoke" for t in tasks)


async def test_create_with_notes(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """notes (description) round-trips through CalDAV."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="With notes",
        notes="A CalDAV description",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "With notes")
    assert task["notes"] == "A CalDAV description"


async def test_create_with_due_date(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """due_date round-trips through CalDAV."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="Due CalDAV",
        due_date="2027-11-20",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "Due CalDAV")
    assert task["due_date"] == "2027-11-20"


async def test_update_title_and_notes(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """update_external_task changes title + notes."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="Original",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "Original")

    await ws_client.send_command(
        "home_tasks/update_external_task",
        entity_id=caldav_entity, task_uid=task["id"],
        title="Renamed CalDAV",
        notes="Updated notes",
    )
    await asyncio.sleep(SETTLE)

    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "Renamed CalDAV")
    assert task["notes"] == "Updated notes"


async def test_complete_via_update(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """update_external_task with completed=True marks the item done."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="To complete CalDAV",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "To complete CalDAV")

    await ws_client.send_command(
        "home_tasks/update_external_task",
        entity_id=caldav_entity, task_uid=task["id"],
        completed=True,
    )
    await asyncio.sleep(SETTLE)

    tasks = await _refetch(ws_client, caldav_entity)
    task = next((t for t in tasks if t["id"] == task["id"]), None)
    if task is not None:
        assert task["completed"] is True


# ---------------------------------------------------------------------------
# Overlay routing — fields CalDAV can't sync go to overlay
# ---------------------------------------------------------------------------


async def test_priority_persists_via_overlay(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """priority is overlay-only for CalDAV (generic adapter)."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="With priority",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "With priority")

    await ws_client.send_command(
        "home_tasks/update_external_task",
        entity_id=caldav_entity, task_uid=task["id"],
        priority=3,
    )
    await asyncio.sleep(SETTLE)

    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "With priority")
    assert task["priority"] == 3


async def test_tags_persist_via_overlay(
    ws_client: HAWebSocketClient, caldav_entity: str
) -> None:
    """tags are overlay-only for CalDAV."""
    await ws_client.send_command(
        "home_tasks/create_external_task",
        entity_id=caldav_entity,
        title="With tags",
    )
    await asyncio.sleep(SETTLE)
    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "With tags")

    await ws_client.send_command(
        "home_tasks/update_external_task",
        entity_id=caldav_entity, task_uid=task["id"],
        tags=["caldav-tag", "live-test"],
    )
    await asyncio.sleep(SETTLE)

    tasks = await _refetch(ws_client, caldav_entity)
    task = next(t for t in tasks if t["title"] == "With tags")
    assert sorted(task["tags"]) == ["caldav-tag", "live-test"]
