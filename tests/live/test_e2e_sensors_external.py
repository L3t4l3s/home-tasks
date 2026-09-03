"""The open-tasks and overdue sensors on a real linked list.

A linked list used to have neither, so "notify me when the shared list has
something overdue" could only be automated against a native one. This drives
the pair through a real provider: the task appears in the count, becomes
overdue when the due date says so, and drops out again when it is completed
through the service.

Setup:  HT_CALDAV_TEST_ENTITY.
"""
from __future__ import annotations

import asyncio
from datetime import date, timedelta

import pytest

from .config import CONFIG
from .ws_client import HAWebSocketClient

pytestmark = [pytest.mark.live]

TITLE = "ZZ sensor probe"
POLL_STEP = 0.5
POLL_MAX = 12.0


async def _wait_for(check, what: str):
    """Poll *check* until it returns something truthy; sensors refresh on
    the provider's state change, which trails the write a little."""
    waited = 0.0
    while waited < POLL_MAX:
        result = await check()
        if result:
            return result
        await asyncio.sleep(POLL_STEP)
        waited += POLL_STEP
    raise AssertionError(f"gave up waiting for {what}")


async def _sensor_pair(ws: HAWebSocketClient) -> tuple[dict, dict]:
    """The open-tasks sensor that lists our probe, and its overdue twin.

    Found by content rather than by name: the entity id derives from the name
    the list was linked under, which the test does not know.
    """
    async def _find():
        for state in await ws.get_states():
            eid = state["entity_id"]
            if eid.startswith("sensor.") and eid.endswith("_open_tasks"):
                if TITLE in state["attributes"].get("open_task_titles", []):
                    return state
        return None

    sensor = await _wait_for(_find, f"a sensor listing {TITLE!r}")
    twin_id = "binary_sensor." + sensor["entity_id"][len("sensor."):-len("_open_tasks")] + "_overdue"
    twin = next((s for s in await ws.get_states() if s["entity_id"] == twin_id), None)
    assert twin is not None, f"{sensor['entity_id']} has no overdue twin {twin_id}"
    return sensor, twin


async def _state(ws: HAWebSocketClient, entity_id: str) -> dict:
    return next(s for s in await ws.get_states() if s["entity_id"] == entity_id)


@pytest.mark.live_caldav
async def test_the_sensors_follow_a_task_on_a_linked_list(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    entity_id = CONFIG.caldav_entity
    await clean_external_list_factory(entity_id)
    try:
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        await ws_client.send_command(
            "home_tasks/create_external_task",
            entity_id=entity_id, title=TITLE, due_date=yesterday,
        )

        sensor, twin = await _sensor_pair(ws_client)
        count_before = int(sensor["state"])
        assert count_before >= 1

        async def _overdue():
            state = await _state(ws_client, twin["entity_id"])
            titles = [t["title"] for t in state["attributes"].get("overdue_tasks", [])]
            return state if state["state"] == "on" and TITLE in titles else None

        on = await _wait_for(_overdue, "the overdue sensor to turn on")
        probe = next(t for t in on["attributes"]["overdue_tasks"] if t["title"] == TITLE)
        assert probe["due_date"] == yesterday

        await ws_client.call_service(
            "home_tasks", "complete_task", {"entity_id": entity_id, "task_title": TITLE},
        )

        async def _gone():
            state = await _state(ws_client, sensor["entity_id"])
            return state if TITLE not in state["attributes"].get("open_task_titles", []) else None

        after = await _wait_for(_gone, "the probe to leave the open count")
        assert int(after["state"]) == count_before - 1
        overdue_after = await _state(ws_client, twin["entity_id"])
        assert TITLE not in [t["title"] for t in overdue_after["attributes"].get("overdue_tasks", [])]
    finally:
        await clean_external_list_factory(entity_id)
