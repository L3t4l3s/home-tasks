"""Tests for provider_adapters module."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.home_tasks.provider_adapters import (
    GenericAdapter,
    ProviderCapabilities,
    TodoistAdapter,
    detect_provider_type,
    get_adapter,
    get_todoist_token,
    priority_from_todoist,
    priority_to_todoist,
)


# ---------------------------------------------------------------------------
#  Priority mapping
# ---------------------------------------------------------------------------


class TestPriorityMapping:
    """Priority mapping between Home Tasks (None/1-3) and Todoist (1-4)."""

    def test_to_todoist_none(self):
        assert priority_to_todoist(None) == 1

    def test_to_todoist_low(self):
        assert priority_to_todoist(1) == 2

    def test_to_todoist_medium(self):
        assert priority_to_todoist(2) == 3

    def test_to_todoist_high(self):
        assert priority_to_todoist(3) == 4

    def test_from_todoist_normal(self):
        assert priority_from_todoist(1) is None

    def test_from_todoist_low(self):
        assert priority_from_todoist(2) == 1

    def test_from_todoist_medium(self):
        assert priority_from_todoist(3) == 2

    def test_from_todoist_urgent(self):
        assert priority_from_todoist(4) == 3

    def test_roundtrip_none(self):
        assert priority_from_todoist(priority_to_todoist(None)) is None

    def test_roundtrip_1(self):
        assert priority_from_todoist(priority_to_todoist(1)) == 1

    def test_roundtrip_2(self):
        assert priority_from_todoist(priority_to_todoist(2)) == 2

    def test_roundtrip_3(self):
        assert priority_from_todoist(priority_to_todoist(3)) == 3


# ---------------------------------------------------------------------------
#  Provider detection
# ---------------------------------------------------------------------------


class TestDetectProviderType:
    """detect_provider_type resolves entity_id -> integration domain."""

    def test_todoist_entity(self):
        hass = MagicMock()
        entity_entry = MagicMock()
        entity_entry.config_entry_id = "cfg_todoist"
        config_entry = MagicMock()
        config_entry.domain = "todoist"

        entity_reg = MagicMock()
        entity_reg.async_get.return_value = entity_entry
        hass.config_entries.async_get_entry.return_value = config_entry

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert detect_provider_type(hass, "todo.todoist_shopping") == "todoist"

    def test_caldav_entity(self):
        hass = MagicMock()
        entity_entry = MagicMock()
        entity_entry.config_entry_id = "cfg_caldav"
        config_entry = MagicMock()
        config_entry.domain = "caldav"

        entity_reg = MagicMock()
        entity_reg.async_get.return_value = entity_entry
        hass.config_entries.async_get_entry.return_value = config_entry

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert detect_provider_type(hass, "todo.nextcloud_tasks") == "caldav"

    def test_unknown_entity(self):
        hass = MagicMock()
        entity_reg = MagicMock()
        entity_reg.async_get.return_value = None

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert detect_provider_type(hass, "todo.nonexistent") == "generic"


# ---------------------------------------------------------------------------
#  Token access
# ---------------------------------------------------------------------------


class TestGetTodoistToken:
    """get_todoist_token reads the API token from the Todoist config entry."""

    def test_token_found(self):
        hass = MagicMock()
        entity_entry = MagicMock()
        entity_entry.config_entry_id = "cfg_todoist"
        config_entry = MagicMock()
        config_entry.domain = "todoist"
        config_entry.data = {"token": "abc123"}

        entity_reg = MagicMock()
        entity_reg.async_get.return_value = entity_entry
        hass.config_entries.async_get_entry.return_value = config_entry

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert get_todoist_token(hass, "todo.todoist_shopping") == "abc123"

    def test_no_entity(self):
        hass = MagicMock()
        entity_reg = MagicMock()
        entity_reg.async_get.return_value = None

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert get_todoist_token(hass, "todo.nonexistent") is None

    def test_wrong_domain(self):
        hass = MagicMock()
        entity_entry = MagicMock()
        entity_entry.config_entry_id = "cfg_caldav"
        config_entry = MagicMock()
        config_entry.domain = "caldav"
        config_entry.data = {}

        entity_reg = MagicMock()
        entity_reg.async_get.return_value = entity_entry
        hass.config_entries.async_get_entry.return_value = config_entry

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            assert get_todoist_token(hass, "todo.nextcloud_tasks") is None


# ---------------------------------------------------------------------------
#  Adapter factory
# ---------------------------------------------------------------------------


class TestGetAdapter:
    """get_adapter returns the correct adapter class."""

    def test_generic_config(self):
        hass = MagicMock()
        adapter = get_adapter(hass, "todo.nextcloud", {"provider_type": "generic"})
        assert isinstance(adapter, GenericAdapter)
        assert adapter.provider_type == "generic"

    def test_todoist_with_token(self):
        hass = MagicMock()
        entity_entry = MagicMock()
        entity_entry.config_entry_id = "cfg_todoist"
        config_entry = MagicMock()
        config_entry.domain = "todoist"
        config_entry.data = {"token": "test_token"}

        entity_reg = MagicMock()
        entity_reg.async_get.return_value = entity_entry
        hass.config_entries.async_get_entry.return_value = config_entry

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            adapter = get_adapter(
                hass,
                "todo.todoist_shopping",
                {"provider_type": "todoist"},
            )
            assert isinstance(adapter, TodoistAdapter)
            assert adapter.provider_type == "todoist"

    def test_todoist_without_token_falls_back(self):
        hass = MagicMock()
        entity_reg = MagicMock()
        entity_reg.async_get.return_value = None

        with patch(
            "custom_components.home_tasks.provider_adapters.er.async_get",
            return_value=entity_reg,
        ):
            adapter = get_adapter(
                hass,
                "todo.todoist_shopping",
                {"provider_type": "todoist"},
            )
            assert isinstance(adapter, GenericAdapter)

    def test_missing_provider_type_defaults_generic(self):
        hass = MagicMock()
        adapter = get_adapter(hass, "todo.something", {})
        assert isinstance(adapter, GenericAdapter)


# ---------------------------------------------------------------------------
#  Capabilities
# ---------------------------------------------------------------------------


class TestProviderCapabilities:
    """ProviderCapabilities dataclass."""

    def test_default_all_false(self):
        caps = ProviderCapabilities()
        d = caps.to_dict()
        assert all(v is False for v in d.values())

    def test_todoist_capabilities(self):
        hass = MagicMock()
        adapter = TodoistAdapter(hass, "todo.todoist_test", {}, "fake_token")
        caps = adapter.capabilities
        assert caps.can_sync_priority is True
        assert caps.can_sync_labels is True
        assert caps.can_sync_order is True
        assert caps.can_sync_sub_items is True
        assert caps.can_sync_assignee is True
        assert caps.can_sync_recurrence is True
        assert caps.can_sync_reminders is True

    def test_generic_capabilities(self):
        caps = GenericAdapter.capabilities
        assert caps.can_sync_priority is False
        assert caps.can_sync_labels is False


# ---------------------------------------------------------------------------
#  Recurrence mapping
# ---------------------------------------------------------------------------


class TestRecurrenceMapping:
    """TodoistAdapter recurrence string ↔ structured fields."""

    def test_build_daily(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "interval",
            "recurrence_value": 1,
            "recurrence_unit": "days",
        }
        assert TodoistAdapter._build_recurrence_string(fields) == "every day"

    def test_build_every_3_days(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "interval",
            "recurrence_value": 3,
            "recurrence_unit": "days",
        }
        assert TodoistAdapter._build_recurrence_string(fields) == "every 3 days"

    def test_build_weekly(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "interval",
            "recurrence_value": 1,
            "recurrence_unit": "weeks",
        }
        assert TodoistAdapter._build_recurrence_string(fields) == "every week"

    def test_build_weekdays(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "weekdays",
            "recurrence_weekdays": [0, 2, 4],
        }
        result = TodoistAdapter._build_recurrence_string(fields)
        assert result == "every mon, wed, fri"

    def test_build_with_time(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "interval",
            "recurrence_value": 1,
            "recurrence_unit": "days",
            "recurrence_time": "14:30",
        }
        assert TodoistAdapter._build_recurrence_string(fields) == "every day at 14:30"

    def test_build_with_start_and_end(self):
        fields = {
            "recurrence_enabled": True,
            "recurrence_type": "interval",
            "recurrence_value": 1,
            "recurrence_unit": "days",
            "recurrence_start_date": "2026-04-10",
            "recurrence_end_date": "2026-12-31",
        }
        result = TodoistAdapter._build_recurrence_string(fields)
        assert "starting 2026-04-10" in result
        assert "ending 2026-12-31" in result

    def test_build_disabled_returns_none(self):
        fields = {"recurrence_enabled": False}
        assert TodoistAdapter._build_recurrence_string(fields) is None

    def test_parse_every_day(self):
        due = MagicMock()
        due.is_recurring = True
        due.string = "every day"
        result = TodoistAdapter._parse_recurrence_from_due(due)
        assert result["recurrence_enabled"] is True
        assert result["recurrence_type"] == "interval"
        assert result["recurrence_value"] == 1
        assert result["recurrence_unit"] == "days"

    def test_parse_every_3_weeks(self):
        due = MagicMock()
        due.is_recurring = True
        due.string = "every 3 weeks"
        result = TodoistAdapter._parse_recurrence_from_due(due)
        assert result["recurrence_value"] == 3
        assert result["recurrence_unit"] == "weeks"

    def test_parse_weekdays(self):
        due = MagicMock()
        due.is_recurring = True
        due.string = "every mon, wed, fri"
        result = TodoistAdapter._parse_recurrence_from_due(due)
        assert result["recurrence_type"] == "weekdays"
        assert result["recurrence_weekdays"] == [0, 2, 4]

    def test_parse_with_time(self):
        due = MagicMock()
        due.is_recurring = True
        due.string = "every day at 14:30"
        result = TodoistAdapter._parse_recurrence_from_due(due)
        assert result["recurrence_time"] == "14:30"

    def test_parse_non_recurring(self):
        due = MagicMock()
        due.is_recurring = False
        result = TodoistAdapter._parse_recurrence_from_due(due)
        assert result["recurrence_enabled"] is False

    def test_parse_none(self):
        result = TodoistAdapter._parse_recurrence_from_due(None)
        assert result["recurrence_enabled"] is False


# ---------------------------------------------------------------------------
#  TodoistAdapter CRUD (with mocked _api)
# ---------------------------------------------------------------------------


def _make_todoist_adapter_with_mock_api():
    """Create a TodoistAdapter with a fully mocked _api so we don't hit Todoist."""
    hass = MagicMock()
    hass.states = MagicMock()
    adapter = TodoistAdapter(hass, "todo.todoist_test", {}, "fake_token")
    api = MagicMock()
    api.get_tasks = AsyncMock(return_value=[])
    api.add_task = AsyncMock()
    api.update_task = AsyncMock()
    api.delete_task = AsyncMock()
    api.complete_task = AsyncMock()
    api.uncomplete_task = AsyncMock()
    api.get_reminders = AsyncMock(return_value=[])
    api.add_reminder = AsyncMock()
    api.delete_reminder = AsyncMock()
    api.get_task = AsyncMock()
    adapter._api = api
    adapter._project_id = "PROJ-1"  # skip _resolve_project_id in _ensure_api
    return adapter, api


class TestTodoistAdapterReadTasks:
    """async_read_tasks fetches main tasks + sub-tasks and parses fields."""

    async def test_read_tasks_empty(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        result = await adapter.async_read_tasks()
        assert result == []
        api.get_tasks.assert_awaited_once()

    async def test_read_tasks_main_and_sub(self):
        adapter, api = _make_todoist_adapter_with_mock_api()

        # Main task
        main = MagicMock()
        main.id = "task-1"
        main.parent_id = None
        main.content = "Buy groceries"
        main.is_completed = False
        main.priority = 3  # Todoist medium → home_tasks 2
        main.labels = ["shopping", "urgent"]
        main.order = 0
        main.description = "Weekly grocery run"
        main.due = None

        # Sub-task
        sub = MagicMock()
        sub.id = "sub-1"
        sub.parent_id = "task-1"
        sub.content = "Apples"
        sub.is_completed = False
        sub.order = 1

        api.get_tasks = AsyncMock(return_value=[main, sub])

        result = await adapter.async_read_tasks()
        assert len(result) == 1
        t = result[0]
        assert t["uid"] == "task-1"
        assert t["summary"] == "Buy groceries"
        assert t["status"] == "needs_action"
        assert t["priority"] == 2
        assert t["labels"] == ["shopping", "urgent"]
        assert t["description"] == "Weekly grocery run"
        assert len(t["sub_items"]) == 1
        assert t["sub_items"][0]["title"] == "Apples"

    async def test_read_tasks_completed(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        main = MagicMock()
        main.id = "t1"
        main.parent_id = None
        main.content = "Done"
        main.is_completed = True
        main.priority = 1
        main.labels = []
        main.order = 0
        main.description = ""
        main.due = None
        api.get_tasks = AsyncMock(return_value=[main])

        result = await adapter.async_read_tasks()
        assert result[0]["status"] == "completed"


class TestTodoistAdapterCreateTask:
    """async_create_task forwards to api.add_task with mapped fields."""

    async def test_create_basic(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        new_task = MagicMock()
        new_task.id = "new-1"
        api.add_task = AsyncMock(return_value=new_task)

        uid = await adapter.async_create_task({"title": "Test create"})
        assert uid == "new-1"
        api.add_task.assert_awaited_once()
        kwargs = api.add_task.await_args.kwargs
        assert kwargs["content"] == "Test create"
        assert kwargs["project_id"] == "PROJ-1"

    async def test_create_with_priority_and_labels(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        new_task = MagicMock()
        new_task.id = "new-2"
        api.add_task = AsyncMock(return_value=new_task)

        await adapter.async_create_task({
            "title": "With fields",
            "priority": 3,  # high → Todoist 4
            "tags": ["a", "b"],
            "notes": "Some notes",
        })
        kwargs = api.add_task.await_args.kwargs
        assert kwargs["priority"] == 4
        assert kwargs["labels"] == ["a", "b"]
        assert kwargs["description"] == "Some notes"

    async def test_create_with_reminders(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        new_task = MagicMock()
        new_task.id = "new-3"
        api.add_task = AsyncMock(return_value=new_task)

        await adapter.async_create_task({"title": "Reminder", "reminders": [15, 60]})
        # Each reminder triggers an add_reminder call
        assert api.add_reminder.await_count == 2


class TestTodoistAdapterUpdateTask:
    """async_update_task routes fields to api vs overlay."""

    async def test_update_title_and_priority(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        unsynced = await adapter.async_update_task("t1", {"title": "Renamed", "priority": 1})
        api.update_task.assert_awaited_once()
        kwargs = api.update_task.await_args.kwargs
        assert kwargs["content"] == "Renamed"
        assert kwargs["priority"] == 2  # home_tasks 1 → Todoist 2
        # Neither field is unsynced
        assert "title" not in unsynced
        assert "priority" not in unsynced

    async def test_update_completed_calls_complete(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        await adapter.async_update_task("t1", {"completed": True})
        api.complete_task.assert_awaited_once_with("t1")

    async def test_update_uncompleted_calls_uncomplete(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        await adapter.async_update_task("t1", {"completed": False})
        api.uncomplete_task.assert_awaited_once_with("t1")

    async def test_update_unsynced_field_returned(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        # recurrence_end_type is always overlay-only
        unsynced = await adapter.async_update_task(
            "t1", {"recurrence_end_type": "date"}
        )
        assert unsynced.get("recurrence_end_type") == "date"

    async def test_update_clear_due_date(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        await adapter.async_update_task("t1", {"due_date": None})
        kwargs = api.update_task.await_args.kwargs
        assert kwargs.get("due_string") == "no date"


class TestTodoistAdapterDeleteAndReorder:
    """async_delete_task and async_reorder_tasks forward to api."""

    async def test_delete(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        await adapter.async_delete_task("t1")
        api.delete_task.assert_awaited_once_with("t1")

    async def test_reorder_success(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        result = await adapter.async_reorder_tasks(["a", "b", "c"])
        assert result is True
        # Three update_task calls with child_order 0, 1, 2
        assert api.update_task.await_count == 3

    async def test_reorder_failure(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        api.update_task = AsyncMock(side_effect=Exception("boom"))
        result = await adapter.async_reorder_tasks(["a", "b"])
        assert result is False


class TestTodoistAdapterSubTasks:
    """Sub-task CRUD via the Todoist API."""

    async def test_add_sub_task(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        new_sub = MagicMock()
        new_sub.id = "sub-99"
        api.add_task = AsyncMock(return_value=new_sub)

        sub_id = await adapter.async_add_sub_task("parent-1", "Sub title")
        assert sub_id == "sub-99"
        kwargs = api.add_task.await_args.kwargs
        assert kwargs["content"] == "Sub title"
        assert kwargs["parent_id"] == "parent-1"

    async def test_update_sub_task_title(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        ok = await adapter.async_update_sub_task("sub-1", title="Renamed sub")
        assert ok is True
        kwargs = api.update_task.await_args.kwargs
        assert kwargs["content"] == "Renamed sub"

    async def test_update_sub_task_complete(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        await adapter.async_update_sub_task("sub-1", completed=True)
        api.complete_task.assert_awaited_once_with("sub-1")

    async def test_delete_sub_task(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        ok = await adapter.async_delete_sub_task("sub-1")
        assert ok is True
        api.delete_task.assert_awaited_once_with("sub-1")

    async def test_reorder_sub_tasks(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        ok = await adapter.async_reorder_sub_tasks("parent", ["s1", "s2"])
        assert ok is True
        assert api.update_task.await_count == 2


class TestTodoistAdapterReminderSync:
    """_sync_reminders performs delta sync against the Todoist API."""

    async def test_sync_creates_new(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        api.get_reminders = AsyncMock(return_value=[])
        await adapter._sync_reminders("t1", [30, 60])
        assert api.add_reminder.await_count == 2

    async def test_sync_deletes_removed(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        api.get_reminders = AsyncMock(return_value=[
            {"id": "r1", "minute_offset": 30},
            {"id": "r2", "minute_offset": 60},
        ])
        await adapter._sync_reminders("t1", [30])
        # r2 (60 min) should be deleted; r1 unchanged
        api.delete_reminder.assert_awaited_once_with("r2")
        api.add_reminder.assert_not_called()

    async def test_sync_no_change(self):
        adapter, api = _make_todoist_adapter_with_mock_api()
        api.get_reminders = AsyncMock(return_value=[{"id": "r1", "minute_offset": 15}])
        await adapter._sync_reminders("t1", [15])
        api.delete_reminder.assert_not_called()
        api.add_reminder.assert_not_called()
