"""add_task / update_task with what the card's task editor sets: recurrence,
section, picture and position — against the real integration.

The rules for how the recurrence fields go together live in service_fields.py
and are covered offline; these tests check that a real service call ends up
as the stored task the card would have saved, on a native list and on the
two kinds of linked list (CalDAV through the overlay, Todoist running the
recurrence itself).

Nothing here draws a picture: generate_image would reach the real AI
provider, so only image_url is exercised.

Setup:  HT_NATIVE_LIST_NAME, and optionally HT_CALDAV_TEST_ENTITY /
        HT_TODOIST_TEST_ENTITY for the linked halves.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest

from .config import CONFIG
from .conftest import ensure_caldav_available
from .ws_client import HAWebSocketClient, WSError

pytestmark = [pytest.mark.live]

SETTLE = 1.5
# A public path shaped like ours, so it is stored as given (nothing is
# downloaded). The file itself need not exist.
PICTURE = "/local/home_tasks/zz_live_service_probe.png"


async def _service(ws: HAWebSocketClient, name: str, **data) -> None:
    await ws.call_service("home_tasks", name, data)


async def _native_tasks(ws: HAWebSocketClient, list_id: str) -> list[dict]:
    tasks = (await ws.send_command("home_tasks/get_tasks", list_id=list_id))["tasks"]
    return sorted(tasks, key=lambda t: t.get("sort_order", 0))


async def _native(ws: HAWebSocketClient, list_id: str, title: str) -> dict:
    match = [t for t in await _native_tasks(ws, list_id) if t["title"] == title]
    assert match, f"{title} is not on the native list"
    return match[0]


async def _external_tasks(ws: HAWebSocketClient, entity_id: str) -> list[dict]:
    tasks = (await ws.send_command(
        "home_tasks/get_external_tasks", entity_id=entity_id
    ))["tasks"]
    return sorted(tasks, key=lambda t: t.get("sort_order", 0))


async def _external(ws: HAWebSocketClient, entity_id: str, title: str) -> dict:
    match = [t for t in await _external_tasks(ws, entity_id) if t["title"] == title]
    assert match, f"{title} is not on {entity_id}"
    return match[0]


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


@asynccontextmanager
async def reopen_lead(ws: HAWebSocketClient, list_id: str, minutes: int):
    """Set the list's reopen lead and put the old one back afterwards."""
    before = (await ws.send_command("home_tasks/get_tasks", list_id=list_id))["reopen_lead"]
    await ws.send_command(
        "home_tasks/set_defaults", list_id=list_id, recurrence_reopen_lead=minutes
    )
    try:
        yield
    finally:
        try:
            await ws.send_command(
                "home_tasks/set_defaults", list_id=list_id,
                recurrence_reopen_lead=before or 0,
            )
        except Exception as err:  # noqa: BLE001
            print(f"[reopen lead teardown] could not restore {list_id}: {err}")


# ---------------------------------------------------------------------------
# Native
# ---------------------------------------------------------------------------

@pytest.mark.live_websocket
async def test_add_task_with_everything_the_editor_sets(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """One call: recurring Mon/Thu at 7, in a section, with a picture, on top."""
    list_id = clean_native_list
    await _service(ws_client, "add_task", entry_id=list_id, title="ZZ first")
    async with section(ws_client, "ZZ Kitchen", list_id=list_id) as section_id:
        async with reopen_lead(ws_client, list_id, 2 * 1440):
            await _service(
                ws_client, "add_task", entry_id=list_id, title="ZZ bins",
                section="zz kitchen", image_url=PICTURE, position="top",
                recurrence_unit="weeks", recurrence_weekdays=["mon", "thu"],
                recurrence_time="07:00:00",
            )
            tasks = await _native_tasks(ws_client, list_id)
            task = tasks[0]
            assert task["title"] == "ZZ bins", "position: top"
            assert task["section_id"] == section_id
            assert task["image_url"] == PICTURE
            assert task["recurrence_enabled"] is True
            assert (task["recurrence_unit"], task["recurrence_value"]) == ("weeks", 1)
            assert task["recurrence_weekdays"] == [0, 3]
            assert task["recurrence_time"] == "07:00"
            # created recurring: it takes the list's lead, which fits Mon/Thu
            assert task["recurrence_reopen_lead"] == 2 * 1440
            assert [h["action"] for h in task.get("history", [])] == ["created"]


@pytest.mark.live_websocket
async def test_switching_recurrence_on_takes_the_list_s_lead_only_where_it_fits(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    async with reopen_lead(ws_client, list_id, 2 * 1440):
        await _service(ws_client, "add_task", entry_id=list_id, title="ZZ weekly")
        await _service(ws_client, "add_task", entry_id=list_id, title="ZZ daily")
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ weekly",
            recurrence_unit="weeks",
        )
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ daily",
            recurrence_unit="days",
        )
        assert (await _native(ws_client, list_id, "ZZ weekly"))["recurrence_reopen_lead"] == 2 * 1440
        assert (await _native(ws_client, list_id, "ZZ daily"))["recurrence_reopen_lead"] == 0

        # A shorter interval drops a lead that no longer fits, as in the card.
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ weekly",
            recurrence_unit="days",
        )
        assert (await _native(ws_client, list_id, "ZZ weekly"))["recurrence_reopen_lead"] == 0


@pytest.mark.live_websocket
async def test_update_task_walks_through_the_patterns(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    title = "ZZ rent"
    await _service(ws_client, "add_task", entry_id=list_id, title=title)

    await _service(
        ws_client, "update_task", entry_id=list_id, task_title=title,
        recurrence_unit="months", recurrence_day_of_month="last",
        recurrence_reopen_lead=3 * 1440,
    )
    task = await _native(ws_client, list_id, title)
    assert (task["recurrence_month_pattern"], task["recurrence_day_of_month"]) == ("day_of_month", "last")
    assert task["recurrence_reopen_lead"] == 3 * 1440

    # the 2nd Tuesday replaces the day of month
    await _service(
        ws_client, "update_task", entry_id=list_id, task_title=title,
        recurrence_nth_week=2, recurrence_weekdays="tue",
    )
    task = await _native(ws_client, list_id, title)
    assert task["recurrence_month_pattern"] == "nth_weekday"
    assert (task["recurrence_nth_week"], task["recurrence_weekdays"]) == (2, [1])
    assert task["recurrence_day_of_month"] is None

    # another unit leaves nothing of the monthly pattern behind
    await _service(
        ws_client, "update_task", entry_id=list_id, task_title=title,
        recurrence_unit="years", recurrence_anniversary="03-14",
    )
    task = await _native(ws_client, list_id, title)
    assert task["recurrence_unit"] == "years"
    assert task["recurrence_anniversary"] == "03-14"
    assert task["recurrence_month_pattern"] is None
    assert task["recurrence_nth_week"] is None
    assert task["recurrence_weekdays"] == []

    # an end after some times, then off
    await _service(
        ws_client, "update_task", entry_id=list_id, task_title=title,
        recurrence_max_count=5,
    )
    task = await _native(ws_client, list_id, title)
    assert (task["recurrence_end_type"], task["recurrence_max_count"]) == ("count", 5)

    await _service(
        ws_client, "update_task", entry_id=list_id, task_title=title,
        recurrence_enabled=False,
    )
    task = await _native(ws_client, list_id, title)
    assert task["recurrence_enabled"] is False
    # switching off keeps the settings for switching on again
    assert task["recurrence_anniversary"] == "03-14"


@pytest.mark.live_websocket
async def test_a_bad_combination_changes_nothing(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    await _service(ws_client, "add_task", entry_id=list_id, title="ZZ untouched")
    with pytest.raises(WSError, match="months"):
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ untouched",
            title="ZZ renamed", recurrence_unit="weeks", recurrence_day_of_month=3,
        )
    with pytest.raises(WSError, match="shorter than the interval"):
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ untouched",
            title="ZZ renamed", recurrence_unit="days", recurrence_reopen_lead=1440,
        )
    with pytest.raises(WSError, match="recurrence_unit"):
        await _service(
            ws_client, "add_task", entry_id=list_id, title="ZZ never added",
            recurrence_enabled=True,
        )
    titles = [t["title"] for t in await _native_tasks(ws_client, list_id)]
    assert titles == ["ZZ untouched"]
    assert (await _native(ws_client, list_id, "ZZ untouched"))["recurrence_enabled"] is False


@pytest.mark.live_websocket
async def test_section_picture_and_position_on_update(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    list_id = clean_native_list
    for title in ("ZZ a", "ZZ b", "ZZ c"):
        await _service(ws_client, "add_task", entry_id=list_id, title=title)

    async with section(ws_client, "ZZ Garden", list_id=list_id) as section_id:
        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ a",
            section=section_id, image_url=PICTURE, position="bottom",
        )
        assert [t["title"] for t in await _native_tasks(ws_client, list_id)] == ["ZZ b", "ZZ c", "ZZ a"]
        task = await _native(ws_client, list_id, "ZZ a")
        assert (task["section_id"], task["image_url"]) == (section_id, PICTURE)

        with pytest.raises(WSError, match="ZZ Garden"):
            await _service(
                ws_client, "update_task", entry_id=list_id, task_title="ZZ a",
                section="ZZ Attic",
            )

        await _service(
            ws_client, "update_task", entry_id=list_id, task_title="ZZ a",
            section="", image_url="", position="top",
        )
        assert [t["title"] for t in await _native_tasks(ws_client, list_id)] == ["ZZ a", "ZZ b", "ZZ c"]
        task = await _native(ws_client, list_id, "ZZ a")
        assert (task["section_id"], task["image_url"]) == (None, None)


# ---------------------------------------------------------------------------
# Linked lists
# ---------------------------------------------------------------------------

@pytest.mark.live_caldav
async def test_caldav_add_task_with_recurrence_section_and_position(
    ws_client: HAWebSocketClient, clean_external_list_factory
) -> None:
    """CalDAV goes through the overlay: recurrence, section and order are ours."""
    entity_id = CONFIG.caldav_entity
    await ensure_caldav_available(ws_client, entity_id)
    await clean_external_list_factory(entity_id)
    try:
        await _service(ws_client, "add_task", entity_id=entity_id, title="ZZ first")
        await asyncio.sleep(SETTLE)
        async with section(ws_client, "ZZ Today", entity_id=entity_id) as section_id:
            await _service(
                ws_client, "add_task", entity_id=entity_id, title="ZZ water plants",
                recurrence_unit="days", recurrence_value=3, section="ZZ Today",
                image_url=PICTURE, position="top",
            )
            await asyncio.sleep(SETTLE)
            tasks = await _external_tasks(ws_client, entity_id)
            assert tasks[0]["title"] == "ZZ water plants", "position: top"
            task = tasks[0]
            assert task["recurrence_enabled"] is True
            assert (task["recurrence_unit"], task["recurrence_value"]) == ("days", 3)
            assert task["section_id"] == section_id
            assert task["image_url"] == PICTURE

            await _service(
                ws_client, "update_task", entity_id=entity_id, task_title="ZZ water plants",
                recurrence_unit="weeks", recurrence_weekdays="fri", position="bottom",
            )
            await asyncio.sleep(SETTLE)
            tasks = await _external_tasks(ws_client, entity_id)
            assert tasks[-1]["title"] == "ZZ water plants", "position: bottom"
            assert (tasks[-1]["recurrence_unit"], tasks[-1]["recurrence_weekdays"]) == ("weeks", [4])

            with pytest.raises(WSError, match="Home Tasks lists"):
                await _service(
                    ws_client, "update_task", entity_id=entity_id,
                    task_title="ZZ water plants", recurrence_reopen_lead=60,
                )
    finally:
        await clean_external_list_factory(entity_id)


@pytest.mark.live_todoist
async def test_todoist_runs_the_recurrence_a_service_sets(
    ws_client: HAWebSocketClient, clean_external_list_factory, todoist_verifier
) -> None:
    """Todoist keeps the recurrence itself — it must land on Todoist's task."""
    entity_id = CONFIG.todoist_entity
    await clean_external_list_factory(entity_id)
    try:
        await _service(
            ws_client, "add_task", entity_id=entity_id, title="ZZ todoist weekly",
            due_date="2027-09-03", recurrence_unit="weeks", recurrence_weekdays=["fri"],
        )
        await asyncio.sleep(SETTLE)
        task = await _external(ws_client, entity_id, "ZZ todoist weekly")
        assert task["recurrence_enabled"] is True
        assert task["recurrence_unit"] == "weeks"

        remote = await todoist_verifier.get_task(task["id"])
        assert remote.due is not None and remote.due.is_recurring is True, (
            f"Todoist task isn't recurring: due={remote.due!r}"
        )
        assert "fri" in (remote.due.string or "").lower()

        # What the card doesn't offer for Todoist, the service refuses.
        with pytest.raises(WSError):
            await _service(
                ws_client, "update_task", entity_id=entity_id,
                task_title="ZZ todoist weekly", recurrence_anchor="due",
            )
        with pytest.raises(WSError):
            await _service(
                ws_client, "update_task", entity_id=entity_id,
                task_title="ZZ todoist weekly", recurrence_unit="months",
                recurrence_value=2, recurrence_day_of_month=1,
            )

        await _service(
            ws_client, "update_task", entity_id=entity_id,
            task_title="ZZ todoist weekly", recurrence_enabled=False,
        )
        await asyncio.sleep(SETTLE)
        assert (await _external(ws_client, entity_id, "ZZ todoist weekly"))["recurrence_enabled"] is False
        remote = await todoist_verifier.get_task(task["id"])
        assert remote.due is None or remote.due.is_recurring is False
    finally:
        await clean_external_list_factory(entity_id)
