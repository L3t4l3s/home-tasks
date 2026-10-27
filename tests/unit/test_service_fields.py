"""How the add_task / update_task recurrence fields become task fields.

An automation names only what it wants changed; the card always sends the
whole set for the unit picked.  service_fields fills in the rest the way the
card would, and refuses what the card would not let you build.
"""
from __future__ import annotations

from datetime import date

import pytest

from custom_components.home_tasks.service_fields import (
    parse_weekday,
    recurrence_fields,
    resolve_section,
)

pytestmark = pytest.mark.unit

WEEKLY_MON_THU = {
    "recurrence_enabled": True, "recurrence_unit": "weeks", "recurrence_value": 1,
    "recurrence_type": "interval", "recurrence_weekdays": [0, 3],
    "recurrence_reopen_lead": 2 * 1440,
}


def test_nothing_named_changes_nothing() -> None:
    assert recurrence_fields({"title": "x"}, None, native=True) == {}


def test_a_unit_alone_makes_a_task_recurring_with_the_card_s_full_set() -> None:
    assert recurrence_fields({"recurrence_unit": "days", "recurrence_value": 2}, None, native=True) == {
        "recurrence_enabled": True, "recurrence_type": "interval",
        "recurrence_unit": "days", "recurrence_value": 2,
        "recurrence_weekdays": [], "recurrence_month_pattern": None,
        "recurrence_day_of_month": None, "recurrence_nth_week": None,
        "recurrence_anniversary": None,
    }


def test_switching_on_a_task_that_never_recurred_needs_a_unit() -> None:
    with pytest.raises(ValueError, match="recurrence_unit"):
        recurrence_fields({"recurrence_enabled": True}, None, native=True)


def test_switching_on_again_keeps_the_stored_settings() -> None:
    off = dict(WEEKLY_MON_THU, recurrence_enabled=False)
    out = recurrence_fields({"recurrence_enabled": True}, off, native=True)
    assert (out["recurrence_unit"], out["recurrence_weekdays"]) == ("weeks", [0, 3])


def test_switching_off_takes_nothing_else() -> None:
    assert recurrence_fields({"recurrence_enabled": False}, WEEKLY_MON_THU, native=True) == {
        "recurrence_enabled": False,
    }
    with pytest.raises(ValueError):
        recurrence_fields({"recurrence_enabled": False, "recurrence_value": 2}, WEEKLY_MON_THU, native=True)


def test_weekdays_by_name_or_number() -> None:
    assert [parse_weekday(d) for d in ("mon", "Thursday", 6, "2")] == [0, 3, 6, 2]
    with pytest.raises(ValueError):
        parse_weekday("someday")
    out = recurrence_fields({"recurrence_unit": "weeks", "recurrence_weekdays": ["thu", "mon", "mon"]}, None, native=True)
    assert out["recurrence_weekdays"] == [0, 3]


def test_a_pattern_stays_while_the_unit_does() -> None:
    out = recurrence_fields({"recurrence_value": 2}, WEEKLY_MON_THU, native=True)
    assert out["recurrence_weekdays"] == [0, 3]


def test_another_unit_drops_the_old_pattern() -> None:
    out = recurrence_fields({"recurrence_unit": "days"}, WEEKLY_MON_THU, native=True)
    assert out["recurrence_weekdays"] == []


def test_monthly_on_a_day_or_on_the_nth_weekday() -> None:
    dom = recurrence_fields({"recurrence_unit": "months", "recurrence_day_of_month": "last"}, None, native=True)
    assert (dom["recurrence_month_pattern"], dom["recurrence_day_of_month"]) == ("day_of_month", "last")
    nth = recurrence_fields(
        {"recurrence_unit": "months", "recurrence_nth_week": 2, "recurrence_weekdays": ["tue"]},
        None, native=True,
    )
    assert nth["recurrence_month_pattern"] == "nth_weekday"
    assert (nth["recurrence_nth_week"], nth["recurrence_weekdays"]) == (2, [1])
    # the day of month replaces the nth weekday, weekday and all
    swapped = recurrence_fields({"recurrence_day_of_month": 15}, dict(nth, recurrence_enabled=True), native=True)
    assert swapped["recurrence_month_pattern"] == "day_of_month"
    assert swapped["recurrence_weekdays"] == []


@pytest.mark.parametrize("data", [
    {"recurrence_unit": "weeks", "recurrence_day_of_month": 3},
    {"recurrence_unit": "months", "recurrence_day_of_month": 3, "recurrence_nth_week": 1},
    {"recurrence_unit": "months", "recurrence_nth_week": 1},
    {"recurrence_unit": "months", "recurrence_nth_week": 1, "recurrence_weekdays": ["mon", "tue"]},
    {"recurrence_unit": "months", "recurrence_weekdays": ["mon"]},
    {"recurrence_unit": "days", "recurrence_weekdays": ["mon"]},
    {"recurrence_unit": "weeks", "recurrence_anniversary": "03-14"},
    {"recurrence_unit": "days", "recurrence_end_date": date(2027, 1, 1), "recurrence_max_count": 3},
])
def test_what_the_card_would_not_build_is_refused(data) -> None:
    with pytest.raises(ValueError):
        recurrence_fields(data, None, native=True)


def test_yearly_on_a_date() -> None:
    out = recurrence_fields({"recurrence_unit": "years", "recurrence_anniversary": "03-14"}, None, native=True)
    assert out["recurrence_anniversary"] == "03-14"


def test_the_end_follows_from_what_is_named() -> None:
    until = recurrence_fields({"recurrence_end_date": date(2027, 1, 1)}, WEEKLY_MON_THU, native=True)
    assert (until["recurrence_end_type"], until["recurrence_end_date"]) == ("date", "2027-01-01")
    times = recurrence_fields({"recurrence_max_count": 5}, WEEKLY_MON_THU, native=True)
    assert (times["recurrence_end_type"], times["recurrence_max_count"]) == ("count", 5)
    endless = recurrence_fields({"recurrence_end_date": None}, WEEKLY_MON_THU, native=True)
    assert endless["recurrence_end_type"] == "none"


def test_a_lead_must_fit_the_interval() -> None:
    with pytest.raises(ValueError, match="shorter than the interval"):
        recurrence_fields({"recurrence_unit": "days", "recurrence_reopen_lead": 1440}, None, native=True)
    out = recurrence_fields({"recurrence_unit": "days", "recurrence_reopen_lead": 600}, None, native=True)
    assert out["recurrence_reopen_lead"] == 600


def test_a_shorter_interval_drops_a_lead_that_no_longer_fits() -> None:
    # Mon/Thu is 3 days apart at the shortest; daily can't hold 2 days.
    assert recurrence_fields({"recurrence_unit": "days"}, WEEKLY_MON_THU, native=True)["recurrence_reopen_lead"] == 0
    assert "recurrence_reopen_lead" not in recurrence_fields({"recurrence_value": 2}, WEEKLY_MON_THU, native=True)


def test_a_linked_list_has_no_lead() -> None:
    with pytest.raises(ValueError, match="Home Tasks lists"):
        recurrence_fields({"recurrence_unit": "days", "recurrence_reopen_lead": 60}, None, native=False)
    out = recurrence_fields({"recurrence_unit": "days"}, None, native=False)
    assert "recurrence_reopen_lead" not in out


def test_a_provider_running_the_recurrence_gets_what_the_card_offers_it() -> None:
    with pytest.raises(ValueError):
        recurrence_fields({"recurrence_unit": "days", "recurrence_anchor": "due"}, None, native=False, provider_syncs=True)
    with pytest.raises(ValueError):
        recurrence_fields(
            {"recurrence_unit": "months", "recurrence_value": 2, "recurrence_day_of_month": 1},
            None, native=False, provider_syncs=True,
        )
    out = recurrence_fields(
        {"recurrence_unit": "months", "recurrence_day_of_month": 1}, None, native=False, provider_syncs=True,
    )
    assert out["recurrence_month_pattern"] == "day_of_month"


def test_sections_by_name_or_id() -> None:
    sections = [{"id": "s1", "name": "Kitchen"}, {"id": "s2", "name": "Garden"}]
    assert resolve_section(sections, "kitchen") == "s1"
    assert resolve_section(sections, "s2") == "s2"
    assert resolve_section(sections, "") is None
    assert resolve_section(sections, None) is None
    with pytest.raises(ValueError, match="Kitchen, Garden"):
        resolve_section(sections, "Attic")
