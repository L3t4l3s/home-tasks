"""Calendar platform for Home Tasks integration.

Creates a calendar entity per list (native and external) that shows tasks with a
due date as calendar events.  Tasks with due_time become timed events; tasks
with only due_date become all-day events.

Recurring tasks are projected onto every occurrence in the requested range
(RFC-5545 RRULE), so a weekly task shows up on each week.  HA does not expand
RRULEs on the read path, so we expand them ourselves (via dateutil) and stamp
the rrule string + a per-occurrence recurrence_id on each instance, mirroring
how local_calendar works.  "hours" recurrence has no daily-or-coarser RRULE
equivalent (HA rejects sub-daily), so those show a single event.

A calendar needs an absolute date anchor; our recurrence is completion-driven,
so tasks WITHOUT a due_date are not shown.
"""

from datetime import date, datetime, timedelta, timezone

from dateutil.rrule import rrulestr

from homeassistant.components.calendar import CalendarEntity, CalendarEvent
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from homeassistant.util import dt as dt_util

from .const import DOMAIN

# RFC-5545 weekday codes indexed by Python weekday() (Mon=0 .. Sun=6)
_WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up calendar entity from a config entry (native or external)."""
    if entry.data.get("type") == "external":
        entity_id = entry.data.get("entity_id")
        if entity_id:
            async_add_entities([ExternalHomeTasksCalendarEntity(hass, entry, entity_id)])
        return
    store = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HomeTasksCalendarEntity(entry, store)])


# ---------------------------------------------------------------------------
#  Recurrence helpers (shared)
# ---------------------------------------------------------------------------

def _task_to_rrule(task: dict) -> str | None:
    """Map a task's recurrence config to an RFC-5545 RRULE string.

    Returns *None* when the task isn't recurring or the pattern has no
    daily-or-coarser calendar equivalent (e.g. "hours").
    """
    if not task.get("recurrence_enabled"):
        return None
    unit = task.get("recurrence_unit")
    value = task.get("recurrence_value") or 1
    parts: list[str] = []

    if unit == "days":
        parts.append("FREQ=DAILY")
    elif unit == "weeks":
        parts.append("FREQ=WEEKLY")
        weekdays = sorted({w for w in (task.get("recurrence_weekdays") or []) if 0 <= w <= 6})
        if weekdays:
            parts.append("BYDAY=" + ",".join(_WEEKDAY_CODES[w] for w in weekdays))
    elif unit == "months":
        parts.append("FREQ=MONTHLY")
        pattern = task.get("recurrence_month_pattern")
        if pattern == "day_of_month":
            dom = task.get("recurrence_day_of_month")
            if dom == "last":
                parts.append("BYMONTHDAY=-1")
            elif isinstance(dom, int):
                parts.append(f"BYMONTHDAY={dom}")
        elif pattern == "nth_weekday":
            nth = task.get("recurrence_nth_week")
            weekdays = sorted({w for w in (task.get("recurrence_weekdays") or []) if 0 <= w <= 6})
            if weekdays and nth is not None:
                n = -1 if nth == "last" else int(nth)
                parts.append(f"BYDAY={n}{_WEEKDAY_CODES[weekdays[0]]}")
    elif unit == "years":
        parts.append("FREQ=YEARLY")
        anniversary = task.get("recurrence_anniversary")  # "MM-DD"
        if anniversary:
            try:
                mm, dd = (int(x) for x in anniversary.split("-"))
                parts.append(f"BYMONTH={mm}")
                parts.append(f"BYMONTHDAY={dd}")
            except (ValueError, AttributeError):
                pass
    else:
        return None  # "hours" or unknown — no calendar RRULE equivalent

    if value > 1:
        parts.append(f"INTERVAL={value}")

    end_type = task.get("recurrence_end_type")
    if end_type == "count":
        count = task.get("recurrence_max_count")
        if isinstance(count, int) and count > 0:
            parts.append(f"COUNT={count}")
    elif end_type == "date":
        end_date = task.get("recurrence_end_date")
        if end_date:
            try:
                d = date.fromisoformat(end_date)
                parts.append(f"UNTIL={d.strftime('%Y%m%dT235959')}")
            except (ValueError, TypeError):
                pass

    return ";".join(parts)


def _expand_task_events(
    task: dict, range_start: datetime, range_end: datetime
) -> list[CalendarEvent]:
    """Return the task's calendar event(s) overlapping [range_start, range_end].

    Non-recurring tasks (or "hours" recurrence) yield at most one event; a
    recurring task yields one event per occurrence in the range, each carrying
    the rrule string and a per-occurrence recurrence_id.
    """
    base = HomeTasksCalendarEntity._task_to_event(task)
    if base is None:
        return []

    rrule = _task_to_rrule(task)
    if not rrule:
        # Single event — include only if it overlaps the requested range.
        if _event_overlaps(base, range_start, range_end):
            return [base]
        return []

    timed = isinstance(base.start, datetime)
    duration = base.end - base.start
    # dateutil needs a datetime dtstart; for all-day tasks anchor at midnight.
    if timed:
        dtstart = base.start
    else:
        dtstart = datetime.combine(base.start, datetime.min.time())

    try:
        rule = rrulestr(rrule, dtstart=dtstart)
    except (ValueError, TypeError):
        return [base] if _event_overlaps(base, range_start, range_end) else []

    # Window for dateutil: use naive/aware consistently with dtstart.
    if timed:
        win_start = range_start.astimezone(dtstart.tzinfo) if dtstart.tzinfo else range_start.replace(tzinfo=None)
        win_end = range_end.astimezone(dtstart.tzinfo) if dtstart.tzinfo else range_end.replace(tzinfo=None)
    else:
        win_start = range_start.replace(tzinfo=None)
        win_end = range_end.replace(tzinfo=None)
    # Pull occurrences slightly before the window so an event that started just
    # before range_start but still runs into it is included.
    occurrences = rule.between(win_start - duration, win_end, inc=True)

    events: list[CalendarEvent] = []
    for occ in occurrences:
        if timed:
            start: date | datetime = occ
            end: date | datetime = occ + duration
            rec_id = occ.isoformat()
        else:
            start = occ.date()
            end = start + duration
            rec_id = start.isoformat()
        events.append(CalendarEvent(
            start=start, end=end,
            summary=base.summary, description=base.description,
            uid=base.uid, rrule=rrule, recurrence_id=rec_id,
        ))
    return events


def _event_overlaps(evt: CalendarEvent, range_start: datetime, range_end: datetime) -> bool:
    """True if a single CalendarEvent overlaps the [range_start, range_end] window."""
    if isinstance(evt.start, datetime):
        evt_start, evt_end = evt.start, evt.end
    else:
        evt_start = datetime.combine(evt.start, datetime.min.time(), tzinfo=range_start.tzinfo)
        evt_end = datetime.combine(evt.end, datetime.min.time(), tzinfo=range_start.tzinfo)
    return evt_end > range_start and evt_start < range_end


def _included_in_state(task: dict) -> bool:
    """Whether a task should contribute events at all.

    Needs a due_date (calendar anchor).  Non-recurring completed tasks are
    excluded; recurring tasks stay (the series continues past the current
    completed instance).
    """
    if not task.get("due_date"):
        return False
    if task.get("completed") and not task.get("recurrence_enabled"):
        return False
    return True


# ---------------------------------------------------------------------------
#  Entities
# ---------------------------------------------------------------------------

class _BaseHomeTasksCalendar(CalendarEntity):
    """Shared calendar logic; subclasses provide the task list."""

    _attr_has_entity_name = True

    def _get_tasks(self) -> list[dict]:
        raise NotImplementedError

    @property
    def event(self) -> CalendarEvent | None:
        """Return the next upcoming event (used for the entity state)."""
        now = dt_util.now()
        # A recurring task's next occurrence is at most one period away, so a
        # ~1y horizon always catches it; a non-recurring task may sit far in the
        # future (e.g. due 2099), so it must be considered without a horizon.
        horizon = now + timedelta(days=366)
        best: CalendarEvent | None = None
        best_key: datetime | None = None
        for task in self._get_tasks():
            if not _included_in_state(task):
                continue
            if _task_to_rrule(task):
                candidates = _expand_task_events(task, now, horizon)
            else:
                base = HomeTasksCalendarEntity._task_to_event(task)
                candidates = [base] if base is not None else []
            for evt in candidates:
                if isinstance(evt.end, datetime):
                    if evt.end < now:
                        continue
                    key = evt.start
                elif evt.end <= now.date():
                    continue
                else:
                    key = datetime.combine(evt.start, datetime.min.time(), tzinfo=now.tzinfo)
                if best_key is None or key < best_key:
                    best, best_key = evt, key
        return best

    async def async_get_events(
        self, hass: HomeAssistant, start_date: datetime, end_date: datetime
    ) -> list[CalendarEvent]:
        """Return all task events in the given time range (recurrence expanded)."""
        events: list[CalendarEvent] = []
        for task in self._get_tasks():
            if not _included_in_state(task):
                continue
            events.extend(_expand_task_events(task, start_date, end_date))
        return events


class HomeTasksCalendarEntity(_BaseHomeTasksCalendar):
    """Calendar view of tasks with due dates in a native Home Tasks list."""

    def __init__(self, entry: ConfigEntry, store) -> None:
        self._entry = entry
        self._store = store
        self._attr_name = f"{entry.data.get('name', entry.title)} Calendar"
        self._attr_unique_id = f"{entry.entry_id}_calendar"

    async def async_added_to_hass(self) -> None:
        """Register store listener so calendar updates on any data change."""
        self.async_on_remove(
            self._store.async_add_listener(self._handle_store_update)
        )

    @callback
    def _handle_store_update(self) -> None:
        self.async_write_ha_state()

    def _get_tasks(self) -> list[dict]:
        return list(self._store.tasks)

    @staticmethod
    def _task_to_event(task: dict) -> CalendarEvent | None:
        """Convert a task dict to a single (base) CalendarEvent."""
        due_date_str = task.get("due_date")
        if not due_date_str:
            return None
        try:
            due_date = date.fromisoformat(due_date_str)
        except (ValueError, TypeError):
            return None

        due_time_str = task.get("due_time")
        summary = task.get("title", "")
        description = HomeTasksCalendarEntity._build_description(task)
        uid = task.get("id")

        if due_time_str:
            try:
                h, m = int(due_time_str[:2]), int(due_time_str[3:5])
                local_tz = dt_util.DEFAULT_TIME_ZONE
                start = datetime(due_date.year, due_date.month, due_date.day,
                                 h, m, tzinfo=local_tz)
                end = start + timedelta(hours=1)
                return CalendarEvent(
                    start=start, end=end,
                    summary=summary, description=description, uid=uid,
                )
            except (ValueError, TypeError, IndexError):
                pass

        # All-day event
        return CalendarEvent(
            start=due_date,
            end=due_date + timedelta(days=1),
            summary=summary, description=description, uid=uid,
        )

    @staticmethod
    def _build_description(task: dict) -> str | None:
        """Build a rich description from notes + task metadata."""
        parts: list[str] = []

        # Notes first (the primary content)
        if task.get("notes"):
            parts.append(task["notes"])

        # Metadata lines
        meta: list[str] = []
        pri = task.get("priority")
        if pri:
            label = {1: "Low", 2: "Medium", 3: "High"}.get(pri, str(pri))
            meta.append(f"⚡ Priority: {label}")

        person = task.get("assigned_person")
        if person:
            meta.append(f"👤 {person}")

        tags = task.get("tags")
        if tags:
            meta.append(" ".join(f"#{t}" for t in tags))

        subs = task.get("sub_items") or []
        if subs:
            done = sum(1 for s in subs if s.get("completed"))
            meta.append(f"☑ Sub-tasks: {done}/{len(subs)}")

        reminders = task.get("reminders") or []
        if reminders:
            labels = []
            for r in reminders:
                if r == 0:
                    labels.append("at due time")
                elif r < 60:
                    labels.append(f"{r} min before")
                elif r == 60:
                    labels.append("1h before")
                elif r < 1440:
                    labels.append(f"{r // 60}h before")
                else:
                    labels.append(f"{r // 1440}d before")
            meta.append(f"⏰ {', '.join(labels)}")

        if not parts and not meta:
            return None
        if meta:
            parts.append("\n".join(meta))
        return "\n\n".join(parts)


class ExternalHomeTasksCalendarEntity(_BaseHomeTasksCalendar):
    """Calendar view of tasks with due dates in an external (provider) list."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, entity_id: str) -> None:
        self.hass = hass
        self._entry = entry
        self._source_entity_id = entity_id
        self._attr_name = f"{entry.data.get('name', entry.title)} Calendar"
        self._attr_unique_id = f"{entry.entry_id}_calendar"

    async def async_added_to_hass(self) -> None:
        """Refresh when the overlay changes or the source entity updates."""
        try:
            from .websocket_api import _get_overlay_store
            overlay_store = _get_overlay_store(self.hass, self._source_entity_id)
            self.async_on_remove(overlay_store.async_add_listener(self._refresh))
        except Exception:  # noqa: BLE001
            pass
        self.async_on_remove(
            async_track_state_change_event(
                self.hass, [self._source_entity_id], self._refresh_event
            )
        )

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()

    @callback
    def _refresh_event(self, _event) -> None:
        self.async_write_ha_state()

    def _get_tasks(self) -> list[dict]:
        try:
            from .provider_adapters import _get_external_todo_items
            from .websocket_api import _get_overlay_store, _merge_tasks_with_overlays
            overlay_store = _get_overlay_store(self.hass, self._source_entity_id)
            items = _get_external_todo_items(self.hass, self._source_entity_id)
            return _merge_tasks_with_overlays(items, overlay_store)
        except Exception:  # noqa: BLE001
            return []
