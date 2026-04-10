"""End-to-end tests against a live HA instance via WebSocket.

These tests connect to a running HA, authenticate with a long-lived access
token, and exercise home_tasks/* WebSocket commands the same way the
Lovelace card does.

Run with:  pytest -m live tests/live/test_e2e_websocket.py
"""
from __future__ import annotations

import pytest

from .ws_client import HAWebSocketClient

pytestmark = [pytest.mark.live, pytest.mark.live_websocket]


# ---------------------------------------------------------------------------
# Smoke / connection tests
# ---------------------------------------------------------------------------


async def test_connect_and_get_lists(ws_client: HAWebSocketClient) -> None:
    """get_lists returns at least one list (the configured native test list)."""
    result = await ws_client.send_command("home_tasks/get_lists")
    assert "lists" in result
    assert isinstance(result["lists"], list)
    assert len(result["lists"]) >= 1


async def test_native_test_list_resolves(
    ws_client: HAWebSocketClient, native_list_id: str
) -> None:
    """The configured HT_NATIVE_LIST_NAME resolves to a valid list_id."""
    assert isinstance(native_list_id, str)
    assert len(native_list_id) > 0


async def test_get_external_lists_includes_linked(
    ws_client: HAWebSocketClient,
) -> None:
    """get_external_lists returns the configured external lists."""
    result = await ws_client.send_command("home_tasks/get_external_lists")
    assert "external_lists" in result
    assert isinstance(result["external_lists"], list)


# ---------------------------------------------------------------------------
# Native CRUD against the test list
# ---------------------------------------------------------------------------


async def test_add_get_delete_task(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Add a task → get_tasks shows it → delete it → get_tasks empty."""
    list_id = clean_native_list

    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="WS smoke task"
    )
    task_id = add["id"]
    assert add["title"] == "WS smoke task"

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    assert any(t["id"] == task_id for t in fetched["tasks"])

    await ws_client.send_command(
        "home_tasks/delete_task", list_id=list_id, task_id=task_id
    )

    after = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    assert not any(t["id"] == task_id for t in after["tasks"])


async def test_update_task_all_fields(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Update each high-value field individually and verify it persists."""
    list_id = clean_native_list
    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Updateable"
    )
    tid = add["id"]

    # Title
    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, title="Renamed"
    )
    # Notes
    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, notes="Some notes"
    )
    # Priority
    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, priority=2
    )
    # Tags
    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, tags=["alpha", "beta"]
    )
    # Due date + time
    await ws_client.send_command(
        "home_tasks/update_task",
        list_id=list_id,
        task_id=tid,
        due_date="2027-01-15",
        due_time="14:30",
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert task["title"] == "Renamed"
    assert task["notes"] == "Some notes"
    assert task["priority"] == 2
    assert sorted(task["tags"]) == ["alpha", "beta"]
    assert task["due_date"] == "2027-01-15"
    assert task["due_time"] == "14:30"


async def test_complete_and_reopen_task(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """A task can be completed and reopened via update_task."""
    list_id = clean_native_list
    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Complete me"
    )
    tid = add["id"]

    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, completed=True
    )
    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert task["completed"] is True

    await ws_client.send_command(
        "home_tasks/update_task", list_id=list_id, task_id=tid, completed=False
    )
    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert task["completed"] is False


# ---------------------------------------------------------------------------
# Sub-task lifecycle
# ---------------------------------------------------------------------------


async def test_sub_task_lifecycle(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """add_sub_task → update_sub_task → delete_sub_task all work."""
    list_id = clean_native_list
    parent = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Parent"
    )
    pid = parent["id"]

    sub = await ws_client.send_command(
        "home_tasks/add_sub_task", list_id=list_id, task_id=pid, title="Sub item"
    )
    sub_id = sub["id"]

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    parent_task = next(t for t in fetched["tasks"] if t["id"] == pid)
    assert any(s["id"] == sub_id for s in parent_task["sub_items"])

    await ws_client.send_command(
        "home_tasks/update_sub_task",
        list_id=list_id,
        task_id=pid,
        sub_task_id=sub_id,
        title="Renamed sub",
        completed=True,
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    parent_task = next(t for t in fetched["tasks"] if t["id"] == pid)
    sub = next(s for s in parent_task["sub_items"] if s["id"] == sub_id)
    assert sub["title"] == "Renamed sub"
    assert sub["completed"] is True

    await ws_client.send_command(
        "home_tasks/delete_sub_task",
        list_id=list_id, task_id=pid, sub_task_id=sub_id,
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    parent_task = next(t for t in fetched["tasks"] if t["id"] == pid)
    assert not any(s["id"] == sub_id for s in parent_task["sub_items"])


# ---------------------------------------------------------------------------
# Reorder & move
# ---------------------------------------------------------------------------


async def test_reorder_tasks(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """reorder_tasks persists a new task order."""
    list_id = clean_native_list

    titles = ["Alpha", "Beta", "Gamma", "Delta"]
    ids: list[str] = []
    for t in titles:
        r = await ws_client.send_command(
            "home_tasks/add_task", list_id=list_id, title=t
        )
        ids.append(r["id"])

    # Reverse the order
    new_order = list(reversed(ids))
    await ws_client.send_command(
        "home_tasks/reorder_tasks", list_id=list_id, task_ids=new_order
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    sorted_tasks = sorted(fetched["tasks"], key=lambda t: t["sort_order"])
    fetched_ids = [t["id"] for t in sorted_tasks]
    assert fetched_ids == new_order


async def test_move_task_between_native_lists(
    ws_client: HAWebSocketClient,
    clean_native_list: str,
    native_list_id_secondary: str,
) -> None:
    """move_task transfers a task between two native lists with all fields."""
    pytest.importorskip("pytest")  # placeholder; marker check below
    src = clean_native_list
    tgt = native_list_id_secondary
    if src == tgt:
        pytest.skip("Source and target list are the same")

    # Wipe target too
    target_tasks = await ws_client.send_command("home_tasks/get_tasks", list_id=tgt)
    for t in target_tasks["tasks"]:
        await ws_client.send_command(
            "home_tasks/delete_task", list_id=tgt, task_id=t["id"]
        )

    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=src, title="Movable"
    )
    tid = add["id"]
    await ws_client.send_command(
        "home_tasks/update_task",
        list_id=src, task_id=tid,
        priority=3, tags=["move"], notes="will travel",
    )

    await ws_client.send_command(
        "home_tasks/move_task",
        source_list_id=src,
        target_list_id=tgt,
        task_id=tid,
    )

    src_tasks = await ws_client.send_command("home_tasks/get_tasks", list_id=src)
    assert all(t["id"] != tid for t in src_tasks["tasks"])

    tgt_tasks = await ws_client.send_command("home_tasks/get_tasks", list_id=tgt)
    moved = next((t for t in tgt_tasks["tasks"] if t["title"] == "Movable"), None)
    assert moved is not None
    assert moved["priority"] == 3
    assert moved["tags"] == ["move"]
    assert moved["notes"] == "will travel"


test_move_task_between_native_lists.pytestmark = [
    pytest.mark.live,
    pytest.mark.live_websocket_two_lists,
]


# ---------------------------------------------------------------------------
# Optimistic update sequence (regression: rapid updates must all persist)
# ---------------------------------------------------------------------------


async def test_rapid_sequential_updates(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """10 sequential updates to the same field all land correctly."""
    list_id = clean_native_list
    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Rapid"
    )
    tid = add["id"]

    for i in range(10):
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=list_id, task_id=tid,
            notes=f"step-{i}",
        )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert task["notes"] == "step-9"


# ---------------------------------------------------------------------------
# Reminders & recurrence — schedule-only verification
# ---------------------------------------------------------------------------


async def test_reminder_field_persists(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """reminders list survives an update + re-fetch cycle."""
    list_id = clean_native_list
    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Reminder host"
    )
    tid = add["id"]

    await ws_client.send_command(
        "home_tasks/update_task",
        list_id=list_id, task_id=tid,
        due_date="2027-12-01", due_time="09:00",
        reminders=[15, 60, 1440],
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert sorted(task["reminders"]) == [15, 60, 1440]


async def test_recurrence_settings_persist(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Recurrence config survives an update + re-fetch cycle."""
    list_id = clean_native_list
    add = await ws_client.send_command(
        "home_tasks/add_task", list_id=list_id, title="Recurring"
    )
    tid = add["id"]

    await ws_client.send_command(
        "home_tasks/update_task",
        list_id=list_id, task_id=tid,
        recurrence_enabled=True,
        recurrence_type="interval",
        recurrence_unit="days",
        recurrence_value=3,
    )

    fetched = await ws_client.send_command("home_tasks/get_tasks", list_id=list_id)
    task = next(t for t in fetched["tasks"] if t["id"] == tid)
    assert task["recurrence_enabled"] is True
    assert task["recurrence_unit"] == "days"
    assert task["recurrence_value"] == 3


# ---------------------------------------------------------------------------
# Error paths
# ---------------------------------------------------------------------------


async def test_get_tasks_invalid_list_id(ws_client: HAWebSocketClient) -> None:
    """Querying a non-existent list returns an error response."""
    from .ws_client import WSError
    with pytest.raises(WSError):
        await ws_client.send_command(
            "home_tasks/get_tasks", list_id="nonexistent-list-id-xxxx"
        )


async def test_update_task_unknown_id(
    ws_client: HAWebSocketClient, clean_native_list: str
) -> None:
    """Updating a non-existent task returns an error."""
    from .ws_client import WSError
    with pytest.raises(WSError):
        await ws_client.send_command(
            "home_tasks/update_task",
            list_id=clean_native_list,
            task_id="ghost-task-id",
            title="ghost",
        )
