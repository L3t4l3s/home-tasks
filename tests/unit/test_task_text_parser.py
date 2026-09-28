"""Spoken task sentences → Home Tasks fields (issue #18)."""
from datetime import date, datetime

import pytest

from custom_components.home_tasks.task_text_parser import (
    describe_task,
    parse_task_text,
    supported_language,
)

pytestmark = pytest.mark.unit

PERSONS = [("person.anna", "Anna Schmidt"), ("person.ben", "Ben")]
MONDAY_10AM = datetime(2026, 9, 28, 10, 0)  # a Monday


def parse(text, language="en", now=MONDAY_10AM, persons=PERSONS):
    return parse_task_text(text, language, persons, now)


def fields(parsed):
    return (parsed.title, parsed.person, parsed.priority, parsed.due_date, parsed.due_time)


# ---------------------------------------------------------------------------
# English
# ---------------------------------------------------------------------------

def test_the_example_from_issue_18() -> None:
    parsed = parse("pay the bill for Anna with high priority due Friday at 5 pm")
    assert fields(parsed) == ("Pay the bill", "person.anna", 3, date(2026, 10, 2), "17:00")


def test_clauses_in_any_order_with_commas() -> None:
    parsed = parse("pay the bill, due tomorrow at 17:00, with high priority, for Ben")
    assert fields(parsed) == ("Pay the bill", "person.ben", 3, date(2026, 9, 29), "17:00")
    parsed = parse("pay the bill due Friday for Anna")
    assert fields(parsed) == ("Pay the bill", "person.anna", None, date(2026, 10, 2), None)


def test_only_a_title() -> None:
    assert fields(parse("water the plants")) == ("Water the plants", None, None, None, None)


def test_for_someone_who_does_not_exist_stays_in_the_title() -> None:
    """The reason the parsing lives in Python and not in a sentence template."""
    assert parse("look for the keys").title == "Look for the keys"
    assert parse("buy flowers for mum").person is None


def test_first_name_and_full_name_both_match() -> None:
    assert parse("dentist for Anna").person == "person.anna"
    assert parse("dentist for anna schmidt").person == "person.anna"


def test_a_shared_first_name_needs_the_full_name() -> None:
    persons = PERSONS + [("person.anna_b", "Anna Berg")]
    assert parse("dentist for Anna", persons=persons).person is None
    assert parse("dentist for Anna Berg", persons=persons).person == "person.anna_b"


@pytest.mark.parametrize("spoken,level", [
    ("with low priority", 1), ("medium priority", 2), ("with normal priority", 2),
    ("with high priority", 3), ("urgent priority", 3), ("priority high", 3),
])
def test_priority_words(spoken, level) -> None:
    assert parse(f"clean the garage {spoken}").priority == level


def test_unknown_priority_word_stays_in_the_title() -> None:
    assert fields(parse("fix bug with extreme priority"))[:3] == ("Fix bug with extreme priority", None, None)


@pytest.mark.parametrize("spoken,expected", [
    ("today", date(2026, 9, 28)),
    ("tomorrow", date(2026, 9, 29)),
    ("the day after tomorrow", date(2026, 9, 30)),
    ("due Friday", date(2026, 10, 2)),
    ("on Friday", date(2026, 10, 2)),
    ("due Monday", date(2026, 9, 28)),        # today is Monday: "Monday" is today
    ("next Monday", date(2026, 10, 5)),       # ... "next Monday" never is
    ("this Sunday", date(2026, 10, 4)),
    ("in 3 days", date(2026, 10, 1)),
    ("in a week", date(2026, 10, 5)),
    ("in two weeks", date(2026, 10, 12)),
    ("by the 5th of October", date(2026, 10, 5)),
    ("on October 5th", date(2026, 10, 5)),
    ("on 5 October 2027", date(2027, 10, 5)),
    ("due 2026-12-24", date(2026, 12, 24)),
    ("on the 1st of March", date(2027, 3, 1)),  # already past this year → next year
])
def test_due_dates(spoken, expected) -> None:
    parsed = parse(f"renew the passport {spoken}")
    assert (parsed.title, parsed.due_date) == ("Renew the passport", expected)


def test_weekday_and_number_without_a_lead_in_stay_in_the_title() -> None:
    """Only today/tomorrow work bare; a weekday or a date needs "due", "on", …"""
    assert fields(parse("buy black friday deals"))[3] is None
    assert parse("sort 2 boxes").title == "Sort 2 boxes"


def test_a_first_name_that_is_someone_elses_full_name_means_that_person() -> None:
    persons = [("person.anna", "Anna"), ("person.anna_s", "Anna Schmidt")]
    for order in (persons, persons[::-1]):
        assert parse("pay bill for Anna", persons=order).person == "person.anna"
        assert parse("pay bill for Anna Schmidt", persons=order).person == "person.anna_s"


def test_29_february_finds_the_next_leap_year() -> None:
    assert parse("celebrate on 29 February").due_date == date(2028, 2, 29)


def test_a_three_digit_year_is_not_a_date() -> None:
    parsed = parse("clean on 3.4.202", "de")
    assert parsed.due_date is None and parsed.title == "Clean on 3.4.202"
    assert parse("putzen am 3.4.27", "de").due_date == date(2027, 4, 3)


def test_impossible_date_stays_in_the_title() -> None:
    parsed = parse("book flight on the 30th of February")
    assert parsed.due_date is None and parsed.title == "Book flight on the 30th of February"


@pytest.mark.parametrize("spoken,expected", [
    ("at 5 pm", "17:00"), ("at 5pm", "17:00"), ("at 5 p.m.", "17:00"), ("at 12 am", "00:00"),
    ("at 17:30", "17:30"), ("at 9", "09:00"), ("at 9 o'clock", "09:00"), ("at noon", "12:00"),
])
def test_times(spoken, expected) -> None:
    assert parse(f"call the plumber tomorrow {spoken}").due_time == expected


def test_invalid_time_stays_in_the_title() -> None:
    parsed = parse("call the plumber at 25")
    assert parsed.due_time is None and parsed.title == "Call the plumber at 25"


def test_a_time_alone_means_today_or_tomorrow() -> None:
    assert parse("call the plumber at 11").due_date == date(2026, 9, 28)   # still ahead
    assert parse("call the plumber at 8").due_date == date(2026, 9, 29)    # already past


def test_nothing_but_clauses_is_not_a_task() -> None:
    with pytest.raises(ValueError):
        parse("   ")
    # A clause needs a title in front of it — alone it IS the title.
    assert parse("tomorrow").title == "Tomorrow"


# ---------------------------------------------------------------------------
# German
# ---------------------------------------------------------------------------

def test_german_example() -> None:
    parsed = parse("Rechnung bezahlen für Anna mit hoher Priorität fällig am Freitag um 17 Uhr", "de")
    assert fields(parsed) == ("Rechnung bezahlen", "person.anna", 3, date(2026, 10, 2), "17:00")


@pytest.mark.parametrize("spoken,expected", [
    ("heute", date(2026, 9, 28)), ("morgen", date(2026, 9, 29)), ("übermorgen", date(2026, 9, 30)),
    ("am Freitag", date(2026, 10, 2)), ("bis Freitag", date(2026, 10, 2)),
    ("nächsten Montag", date(2026, 10, 5)), ("in drei Tagen", date(2026, 10, 1)),
    ("in einer Woche", date(2026, 10, 5)), ("bis zum 5.10.", date(2026, 10, 5)),
    ("am 24. Dezember", date(2026, 12, 24)), ("am 5. März", date(2027, 3, 5)),
])
def test_german_dates(spoken, expected) -> None:
    assert parse(f"Rasen mähen {spoken}", "de-DE").due_date == expected


@pytest.mark.parametrize("spoken,level", [
    ("mit niedriger Priorität", 1), ("mit normaler Priorität", 2), ("hohe Priorität", 3), ("Priorität hoch", 3),
])
def test_german_priority(spoken, level) -> None:
    assert parse(f"Steuer machen {spoken}", "de").priority == level


def test_german_time() -> None:
    assert parse("Arzt anrufen morgen um 9:30", "de").due_time == "09:30"
    assert parse("Arzt anrufen morgen um 9.30 Uhr", "de").due_time == "09:30"


# ---------------------------------------------------------------------------
# Language and the spoken summary
# ---------------------------------------------------------------------------

def test_language_codes() -> None:
    assert supported_language("de-DE") == "de"
    assert supported_language("en_GB") == "en"
    assert supported_language("nl") == "en"   # no Dutch word list yet
    assert supported_language(None) == "en"


def test_summary_english() -> None:
    parsed = parse("pay the bill for Anna with high priority due Friday at 5 pm")
    assert describe_task(parsed, "en", MONDAY_10AM.date()) == (
        "for Anna Schmidt, high priority, due Friday 2 October at 17:00"
    )
    assert describe_task(parse("pay the bill tomorrow"), "en", MONDAY_10AM.date()) == "due tomorrow"
    assert describe_task(parse("water the plants"), "en", MONDAY_10AM.date()) == ""


def test_summary_german_and_next_year() -> None:
    parsed = parse("Geschenk kaufen für Ben am 5. März", "de")
    assert describe_task(parsed, "de", MONDAY_10AM.date()) == "für Ben, fällig Freitag, 5. März 2027"
