"""Recurrence and section fields of the add_task / update_task services.

The card never sends a lone recurrence field: it always sends the whole set
for the unit picked, with the patterns of the other units cleared, so the
stored task can't say "every 2 days, on Mondays".  An automation names only
what it wants changed.  This turns that into the same complete set the card
would send, checked against the task as it is.
"""
from __future__ import annotations

from datetime import date

from .store import recurrence_interval_minutes

# Same order as date.weekday(): 0 = Monday.
_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_WEEKDAY_NAMES = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")

RECURRENCE_SERVICE_FIELDS = (
    "recurrence_enabled", "recurrence_value", "recurrence_unit",
    "recurrence_weekdays", "recurrence_day_of_month", "recurrence_nth_week",
    "recurrence_anniversary", "recurrence_anchor", "recurrence_start_date",
    "recurrence_time", "recurrence_end_date", "recurrence_max_count",
    "recurrence_reopen_lead",
)


def parse_weekday(value) -> int:
    """0-6 (Monday first) or a day name, "mon" or "monday"."""
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 6:
        return value
    text = str(value).strip().lower()
    if text.isdigit() and 0 <= int(text) <= 6:
        return int(text)
    if text in _WEEKDAYS:
        return _WEEKDAYS.index(text)
    if text in _WEEKDAY_NAMES:
        return _WEEKDAY_NAMES.index(text)
    raise ValueError(f"Not a weekday: {value!r} (use mon … sun)")


def recurrence_fields(
    data: dict, task: dict | None, *, native: bool, provider_syncs: bool = False,
) -> dict:
    """The task fields to store for the recurrence fields a service call names.

    *task* is the task as it is now (None when creating one).  *native* is
    False on a linked list, where the reopen lead isn't offered;
    *provider_syncs* when the provider runs the recurrence itself (Todoist),
    which has no "count from the due date" and no calendar pattern on an
    every-2-months series — the card offers neither there.

    Raises ValueError for a combination the card would not let you build.
    """
    given = {k: data[k] for k in RECURRENCE_SERVICE_FIELDS if k in data}
    if not given:
        return {}
    cur = task or {}
    was_on = bool(cur.get("recurrence_enabled"))

    # Naming any recurrence setting means recurring; recurrence_enabled is
    # needed only to switch it off.
    if given.get("recurrence_enabled", True) is False:
        if len(given) > 1:
            raise ValueError("Recurrence settings can't be set while switching recurrence off")
        return {"recurrence_enabled": False}

    if "recurrence_reopen_lead" in given and not native:
        raise ValueError("recurrence_reopen_lead is only available on Home Tasks lists")
    if provider_syncs and given.get("recurrence_anchor") == "due":
        raise ValueError("This list's provider repeats a task from its completion only")

    # Unmigrated weekdays mode is weekly on its days.
    legacy = cur.get("recurrence_type") == "weekdays"
    cur_unit = "weeks" if legacy else cur.get("recurrence_unit")
    unit = given.get("recurrence_unit") or cur_unit
    if not unit:
        raise ValueError("recurrence_unit is needed to make a task recurring")
    same_unit = unit == cur_unit
    value = given.get("recurrence_value") or (1 if legacy else cur.get("recurrence_value")) or 1

    # What the current pattern is, kept only while the unit stays.
    kept_days = list(cur.get("recurrence_weekdays") or []) if same_unit else []
    kept_pattern = cur.get("recurrence_month_pattern") if same_unit else None
    kept_dom = cur.get("recurrence_day_of_month") if same_unit else None
    kept_nth = cur.get("recurrence_nth_week") if same_unit else None
    kept_ann = cur.get("recurrence_anniversary") if same_unit else None

    days = given.get("recurrence_weekdays")
    if days is not None:
        days = sorted({parse_weekday(d) for d in days})
    dom = given.get("recurrence_day_of_month")
    nth = given.get("recurrence_nth_week")
    ann = given.get("recurrence_anniversary") or None

    if (dom or nth) and unit != "months":
        raise ValueError("recurrence_day_of_month and recurrence_nth_week need recurrence_unit: months")
    if dom and nth:
        raise ValueError("Use either recurrence_day_of_month or recurrence_nth_week, not both")
    if ann and unit != "years":
        raise ValueError("recurrence_anniversary needs recurrence_unit: years")
    if days and unit not in ("weeks", "months"):
        raise ValueError("recurrence_weekdays needs recurrence_unit: weeks (or months with recurrence_nth_week)")

    out = {"recurrence_enabled": True, "recurrence_type": "interval",
           "recurrence_unit": unit, "recurrence_value": value,
           "recurrence_weekdays": [], "recurrence_month_pattern": None,
           "recurrence_day_of_month": None, "recurrence_nth_week": None,
           "recurrence_anniversary": None}

    if unit == "weeks":
        out["recurrence_weekdays"] = days if days is not None else kept_days
    elif unit == "months":
        if "recurrence_day_of_month" in given or "recurrence_nth_week" in given:
            pattern = "day_of_month" if dom else "nth_weekday" if nth else None
        else:
            pattern = kept_pattern
            dom, nth = kept_dom, kept_nth
        if days and pattern != "nth_weekday":
            raise ValueError("On a monthly task recurrence_weekdays goes with recurrence_nth_week")
        if pattern == "day_of_month":
            out.update(recurrence_month_pattern=pattern, recurrence_day_of_month=dom)
        elif pattern == "nth_weekday":
            wd = days if days is not None else (kept_days if kept_pattern == "nth_weekday" else [])
            if len(wd) != 1:
                raise ValueError("recurrence_nth_week needs exactly one weekday in recurrence_weekdays")
            out.update(recurrence_month_pattern=pattern, recurrence_nth_week=nth, recurrence_weekdays=wd)
    elif unit == "years":
        out["recurrence_anniversary"] = ann if "recurrence_anniversary" in given else kept_ann

    if provider_syncs and value > 1 and unit in ("months", "years") and (
        out["recurrence_month_pattern"] or out["recurrence_anniversary"]
    ):
        raise ValueError(f"This list's provider can't repeat every {value} {unit} on a fixed day")

    for key in ("recurrence_anchor", "recurrence_time"):
        if key in given:
            out[key] = given[key]
    if "recurrence_start_date" in given:
        start = given["recurrence_start_date"]
        out["recurrence_start_date"] = start.isoformat() if isinstance(start, date) else start

    if "recurrence_end_date" in given or "recurrence_max_count" in given:
        end = given.get("recurrence_end_date")
        count = given.get("recurrence_max_count")
        if end and count:
            raise ValueError("Use either recurrence_end_date or recurrence_max_count, not both")
        out["recurrence_end_type"] = "date" if end else "count" if count else "none"
        out["recurrence_end_date"] = (end.isoformat() if isinstance(end, date) else end) or None
        out["recurrence_max_count"] = count or None

    if native:
        interval = recurrence_interval_minutes(out)
        if "recurrence_reopen_lead" in given:
            lead = given["recurrence_reopen_lead"]
            if lead and interval is not None and lead >= interval:
                raise ValueError(
                    f"recurrence_reopen_lead ({lead} min) must be shorter than the interval ({interval} min)"
                )
            out["recurrence_reopen_lead"] = lead
        elif was_on:
            # A shorter interval drops a lead that no longer fits, as in the
            # card.  (Switching on takes the list's lead in the store.)
            lead = cur.get("recurrence_reopen_lead") or 0
            if lead and interval is not None and lead >= interval:
                out["recurrence_reopen_lead"] = 0
    return out


def resolve_section(sections: list[dict], value: str | None) -> str | None:
    """A section's id from its name or id; empty = no section."""
    if value is None or not str(value).strip():
        return None
    text = str(value).strip()
    for section in sections:
        if section.get("id") == text:
            return section["id"]
    for section in sections:
        if (section.get("name") or "").strip().lower() == text.lower():
            return section["id"]
    names = ", ".join(s.get("name") or s["id"] for s in sections) or "none"
    raise ValueError(f"No section {text!r} in this list (sections: {names})")
