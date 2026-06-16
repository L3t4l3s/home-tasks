"""Calendar recurrence projection (#27): map our recurrence to RRULE and expand
occurrences onto the calendar (native + external lists)."""
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.components.todo import TodoItem, TodoItemStatus
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_tasks.calendar import (
    ExternalHomeTasksCalendarEntity,
    _expand_task_events,
    _task_to_rrule,
)

DOMAIN = "home_tasks"
pytestmark = pytest.mark.integration


def _rec_task(**over) -> dict:
    base = {
        "id": "t1", "title": "Task", "due_date": "2026-06-01", "completed": False,
        "recurrence_enabled": True, "recurrence_type": "interval",
        "recurrence_value": 1, "recurrence_unit": "days",
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# _task_to_rrule
# ---------------------------------------------------------------------------

def test_rrule_disabled_returns_none():
    assert _task_to_rrule(_rec_task(recurrence_enabled=False)) is None


def test_rrule_hours_returns_none():
    assert _task_to_rrule(_rec_task(recurrence_unit="hours")) is None


def test_rrule_daily_interval():
    assert _task_to_rrule(_rec_task(recurrence_unit="days", recurrence_value=2)) == "FREQ=DAILY;INTERVAL=2"


def test_rrule_weekly_with_weekdays():
    r = _task_to_rrule(_rec_task(recurrence_unit="weeks", recurrence_weekdays=[0, 2, 4]))
    assert r == "FREQ=WEEKLY;BYDAY=MO,WE,FR"


def test_rrule_monthly_day_of_month():
    assert _task_to_rrule(_rec_task(
        recurrence_unit="months", recurrence_month_pattern="day_of_month",
        recurrence_day_of_month=15,
    )) == "FREQ=MONTHLY;BYMONTHDAY=15"


def test_rrule_monthly_last_day():
    assert _task_to_rrule(_rec_task(
        recurrence_unit="months", recurrence_month_pattern="day_of_month",
        recurrence_day_of_month="last",
    )) == "FREQ=MONTHLY;BYMONTHDAY=-1"


def test_rrule_monthly_nth_weekday():
    assert _task_to_rrule(_rec_task(
        recurrence_unit="months", recurrence_month_pattern="nth_weekday",
        recurrence_nth_week=2, recurrence_weekdays=[1],
    )) == "FREQ=MONTHLY;BYDAY=2TU"


def test_rrule_yearly_anniversary():
    assert _task_to_rrule(_rec_task(
        recurrence_unit="years", recurrence_anniversary="12-25",
    )) == "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25"


def test_rrule_count_end():
    r = _task_to_rrule(_rec_task(recurrence_end_type="count", recurrence_max_count=3))
    assert r == "FREQ=DAILY;COUNT=3"


def test_rrule_until_end():
    r = _task_to_rrule(_rec_task(recurrence_end_type="date", recurrence_end_date="2026-12-31"))
    assert r == "FREQ=DAILY;UNTIL=20261231T235959"


# ---------------------------------------------------------------------------
# _expand_task_events
# ---------------------------------------------------------------------------

def test_expand_non_recurring_single_event():
    task = {"id": "t1", "title": "One", "due_date": "2026-06-15"}
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    assert len(evts) == 1
    assert evts[0].rrule is None
    assert evts[0].start == date(2026, 6, 15)


def test_expand_non_recurring_out_of_range():
    task = {"id": "t1", "title": "One", "due_date": "2099-06-15"}
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    assert evts == []


def test_expand_weekly_all_day_multiple_occurrences():
    # Mondays starting 2026-06-01 (a Monday). June 2026 Mondays: 1,8,15,22,29.
    task = _rec_task(recurrence_unit="weeks", recurrence_weekdays=[0], due_date="2026-06-01")
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    starts = sorted(e.start for e in evts)
    assert starts == [date(2026, 6, 1), date(2026, 6, 8), date(2026, 6, 15),
                      date(2026, 6, 22), date(2026, 6, 29)]
    # every instance carries the rrule + a distinct recurrence_id
    assert all(e.rrule == "FREQ=WEEKLY;BYDAY=MO" for e in evts)
    assert len({e.recurrence_id for e in evts}) == len(evts)


def test_expand_daily_timed_occurrences_have_duration():
    task = _rec_task(recurrence_unit="days", due_date="2026-06-01", due_time="09:30")
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 6, 4, tzinfo=timezone.utc)
    )
    assert len(evts) >= 3
    for e in evts:
        assert isinstance(e.start, datetime)
        assert e.end - e.start == timedelta(hours=1)


def test_expand_hours_is_single_event_no_rrule():
    task = _rec_task(recurrence_unit="hours", due_date="2026-06-15")
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    assert len(evts) == 1
    assert evts[0].rrule is None


def test_expand_count_limits_occurrences():
    task = _rec_task(recurrence_unit="days", due_date="2026-06-01",
                     recurrence_end_type="count", recurrence_max_count=3)
    evts = _expand_task_events(
        task, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    assert len(evts) == 3


# ---------------------------------------------------------------------------
# External calendar entity
# ---------------------------------------------------------------------------

async def test_external_calendar_expands_from_merge(hass: HomeAssistant, patch_add_extra_js_url):
    """The external calendar entity projects recurring tasks from the merge."""
    from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

    entity_id = "todo.cal_ext"
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": entity_id, "name": "Cal Ext"},
        title="Cal Ext (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    # mock source todo entity with one item
    mock_entity = MagicMock()
    mock_entity.todo_items = [
        TodoItem(uid="x1", summary="Weekly chore", status=TodoItemStatus.NEEDS_ACTION,
                 due=date(2026, 6, 1)),
    ]
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set(entity_id, "1")

    store = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(store, ExternalTaskOverlayStore)
    await store.async_set_overlay(
        "x1", recurrence_enabled=True, recurrence_type="interval",
        recurrence_unit="weeks", recurrence_value=1, recurrence_weekdays=[0],
    )

    cal = ExternalHomeTasksCalendarEntity(hass, entry, entity_id)
    events = await cal.async_get_events(
        hass, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    starts = sorted(e.start for e in events)
    assert starts == [date(2026, 6, 1), date(2026, 6, 8), date(2026, 6, 15),
                      date(2026, 6, 22), date(2026, 6, 29)]


async def test_external_calendar_empty_when_entity_missing(hass: HomeAssistant, patch_add_extra_js_url):
    """No source entity → no events, no crash."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": "todo.gone", "name": "Gone"},
        title="Gone (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    cal = ExternalHomeTasksCalendarEntity(hass, entry, "todo.gone")
    events = await cal.async_get_events(
        hass, datetime(2026, 6, 1, tzinfo=timezone.utc), datetime(2026, 7, 1, tzinfo=timezone.utc)
    )
    assert events == []
