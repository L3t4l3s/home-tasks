"""Turn a spoken task sentence into Home Tasks fields.

"pay the bill for Anna with high priority due Friday at 5 pm" becomes
title "Pay the bill", Anna's person entity, priority 3, next Friday, 17:00.

The parser peels clauses off the END of the text, one at a time, and only
when a clause really is one: the person must exist, the priority word must
be known, the date must resolve.  Whatever does not parse stays part of the
title, so "look for the keys" is a title and not a task for "the keys", and
the clauses may come in any order.

Pure functions, no Home Assistant objects — the service in __init__.py feeds
in the persons and the current local time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
import re

__all__ = ["ParsedTask", "parse_task_text", "describe_task", "supported_language"]


@dataclass
class ParsedTask:
    title: str
    person: str | None = None          # person entity_id
    person_name: str | None = None     # the person's name, for the spoken answer
    priority: int | None = None        # 1 low, 2 medium, 3 high
    due_date: date | None = None
    due_time: str | None = None        # "HH:MM"
    matched: list[str] = field(default_factory=list)  # clause kinds, in the order found


# ---------------------------------------------------------------------------
# Words per language.  Everything is matched case-insensitively.
# ---------------------------------------------------------------------------

_NUMBERS_EN = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
               "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
_NUMBERS_DE = {"einem": 1, "einer": 1, "ein": 1, "eine": 1, "eins": 1, "zwei": 2, "drei": 3,
               "vier": 4, "fünf": 5, "sechs": 6, "sieben": 7, "acht": 8, "neun": 9, "zehn": 10}

_LANG = {
    "en": {
        "person": r"for|assigned to",
        "priority": [
            r"(?:with\s+(?:a\s+)?)?(?P<p>\w+)\s+priority",
            r"priority\s+(?P<p>\w+)",
        ],
        "priority_words": {
            1: ("low",), 2: ("medium", "normal"), 3: ("high", "urgent", "top"),
        },
        "today": ("today",), "tomorrow": ("tomorrow",),
        "day_after": ("the day after tomorrow", "day after tomorrow"),
        # Weekdays and calendar dates need a lead-in word; bare "today"
        # and "tomorrow" don't ("pay the bill tomorrow").
        "date_lead": r"due(?:\s+on)?|by|on|until",
        "next": r"next",
        "this": r"this|coming",
        "in": r"in",
        "days": r"days?", "weeks": r"weeks?",
        "numbers": _NUMBERS_EN,
        "weekdays": ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"),
        "months": ("january", "february", "march", "april", "may", "june", "july",
                   "august", "september", "october", "november", "december"),
        "time_lead": r"at",
        "time_suffix": r"o'?clock",
        "noon": ("noon", "midday"), "midnight": ("midnight",),
    },
    "de": {
        "person": r"für",
        "priority": [
            r"(?:mit\s+)?(?P<p>\w+)\s+priorität",
            r"priorität\s+(?P<p>\w+)",
        ],
        "priority_words": {
            1: ("niedrig", "niedrige", "niedriger", "geringe", "geringer"),
            2: ("mittel", "mittlere", "mittlerer", "normal", "normale", "normaler"),
            3: ("hoch", "hohe", "hoher", "höchste", "höchster", "dringend"),
        },
        "today": ("heute",), "tomorrow": ("morgen",), "day_after": ("übermorgen",),
        "date_lead": r"fällig(?:\s+am)?|bis(?:\s+zum|\s+zur)?|am",
        "next": r"nächsten|nächster|nächste|kommenden|kommender|kommende",
        "this": r"diesen|dieser|diese",
        "in": r"in",
        "days": r"tag(?:en)?", "weeks": r"wochen?",
        "numbers": _NUMBERS_DE,
        "weekdays": ("montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag"),
        "months": ("januar", "februar", "märz", "april", "mai", "juni", "juli",
                   "august", "september", "oktober", "november", "dezember"),
        "time_lead": r"um",
        "time_suffix": r"uhr",
        "noon": ("mittag",), "midnight": ("mitternacht",),
    },
}
_MONTH_ALIASES = {"de": {"maerz": 3, "jänner": 1}}

_SPOKEN = {
    "en": {
        "for": "for {name}", "priority": {1: "low priority", 2: "medium priority", 3: "high priority"},
        "due": "due {date}", "at": "at {time}", "today": "today", "tomorrow": "tomorrow",
        "date": "{weekday} {day} {month}",
    },
    "de": {
        "for": "für {name}", "priority": {1: "niedrige Priorität", 2: "mittlere Priorität", 3: "hohe Priorität"},
        "due": "fällig {date}", "at": "um {time}", "today": "heute", "tomorrow": "morgen",
        "date": "{weekday}, {day}. {month}",
    },
}


def supported_language(language: str | None) -> str:
    """"de-DE" → "de"; anything without its own word list falls back to English."""
    code = (language or "en").split("-")[0].split("_")[0].lower()
    return code if code in _LANG else "en"


def _alts(words) -> str:
    return "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True))


# ---------------------------------------------------------------------------
# Clause matchers.  Each returns (start index of the clause, parsed value)
# for a clause at the very end of *text*, or None.
# ---------------------------------------------------------------------------

_END = r"\s*[,.;!?]*\s*$"


def _at_end(pattern: str, text: str):
    return re.search(r"(?:^|(?<=[\s,]))(?:" + pattern + r")" + _END, text, re.IGNORECASE)


def _match_person(text: str, words: dict, persons: list[tuple[str, str]]):
    """"… for Anna" — only for a person that exists (full name or unique first name)."""
    names: dict[str, str] = {
        name.lower(): entity_id for entity_id, name in persons if name
    }
    # A first name works too, unless it is someone's full name or shared by
    # two people — then it would be a guess.
    firsts: dict[str, set[str]] = {}
    for entity_id, name in persons:
        if name:
            firsts.setdefault(name.split()[0].lower(), set()).add(entity_id)
    for first, owners in firsts.items():
        if first not in names and len(owners) == 1:
            names[first] = next(iter(owners))
    if not names:
        return None
    m = _at_end(r"(?:" + words["person"] + r")\s+(?P<name>" + _alts(names) + r")", text)
    if not m:
        return None
    spoken = m.group("name").lower()
    entity_id = names[spoken]
    display = next((n for e, n in persons if e == entity_id), m.group("name"))
    return m.start(), (entity_id, display)


def _match_priority(text: str, words: dict):
    for pattern in words["priority"]:
        m = _at_end(pattern, text)
        if not m:
            continue
        spoken = m.group("p").lower()
        for level, alts in words["priority_words"].items():
            if spoken in alts:
                return m.start(), level
    return None


def _number(token: str, words: dict) -> int | None:
    if token.isdigit():
        return int(token)
    return words["numbers"].get(token.lower())


def _month_number(token: str, words: dict, lang: str) -> int | None:
    token = token.lower().rstrip(".")
    for i, name in enumerate(words["months"], start=1):
        if token == name or (len(token) >= 3 and name.startswith(token)):
            return i
    return _MONTH_ALIASES.get(lang, {}).get(token)


def _calendar_date(day: int, month: int, today: date, year: int | None = None) -> date | None:
    """Day/month to a date; without a year, the next one that isn't past.

    The search runs a few years ahead so 29 February finds its leap year.
    """
    if year is not None:
        try:
            return date(year, month, day)
        except ValueError:
            return None
    for candidate_year in range(today.year, today.year + 9):
        try:
            candidate = date(candidate_year, month, day)
        except ValueError:
            continue
        if candidate >= today:
            return candidate
    return None


def _match_date(text: str, words: dict, lang: str, today: date):
    lead = r"(?:(?:" + words["date_lead"] + r")\s+)"
    wd_alts = _alts(words["weekdays"])

    def weekday_after(idx: int, strictly: bool) -> date:
        delta = (idx - today.weekday()) % 7
        if delta == 0 and strictly:
            delta = 7
        return today + timedelta(days=delta)

    # "today" / "tomorrow" / "the day after tomorrow", with or without a lead-in
    for key, offset in (("day_after", 2), ("tomorrow", 1), ("today", 0)):
        m = _at_end(lead + "?(?:" + _alts(words[key]) + ")", text)
        if m:
            return m.start(), today + timedelta(days=offset)

    # "next Friday" (never today), "this/coming Friday" and "due Friday" (today counts)
    m = _at_end(lead + r"?(?P<next>" + words["next"] + r")\s+(?P<wd>" + wd_alts + ")", text)
    if m:
        return m.start(), weekday_after(words["weekdays"].index(m.group("wd").lower()), True)
    m = _at_end(lead + r"?(?:" + words["this"] + r")\s+(?P<wd>" + wd_alts + ")", text)
    if m:
        return m.start(), weekday_after(words["weekdays"].index(m.group("wd").lower()), False)
    m = _at_end(lead + r"(?P<wd>" + wd_alts + ")", text)
    if m:
        return m.start(), weekday_after(words["weekdays"].index(m.group("wd").lower()), False)

    # "in 3 days" / "in a week" / "in zwei Wochen"
    num = r"(?P<n>\d+|" + _alts(words["numbers"]) + r")"
    m = _at_end(lead + r"?(?:" + words["in"] + r")\s+" + num + r"\s+(?P<unit>" + words["days"] + "|" + words["weeks"] + ")", text)
    if m:
        n = _number(m.group("n"), words)
        if n is not None:
            weeks = re.fullmatch(words["weeks"], m.group("unit"), re.IGNORECASE)
            return m.start(), today + timedelta(days=n * (7 if weeks else 1))

    # Calendar dates — always behind a lead-in, so a number in a title stays put.
    month_word = r"(?P<month>[^\W\d_]{3,}\.?)"
    day = r"(?P<day>\d{1,2})(?:st|nd|rd|th|\.)?"
    year = r"(?:,?\s+(?P<year>\d{4}))?"
    for pattern in (
        r"(?P<iso>\d{4}-\d{2}-\d{2})",
        r"(?:the\s+)?" + day + r"\s+(?:of\s+)?" + month_word + year,   # 5th of October, 5. Oktober
        month_word + r"\s+(?:the\s+)?" + day + year,                   # October 5th
        r"(?:dem\s+|den\s+)?(?P<nday>\d{1,2})\.(?P<nmonth>\d{1,2})\.(?P<nyear>\d{4}|\d{2})?",  # 5.10.
    ):
        m = _at_end(lead + r"(?:the\s+|dem\s+|den\s+)?" + pattern, text)
        if not m:
            continue
        g = m.groupdict()
        if g.get("iso"):
            try:
                return m.start(), date.fromisoformat(g["iso"])
            except ValueError:
                continue
        if g.get("nday"):
            y = g.get("nyear")
            y = (2000 + int(y) if len(y) == 2 else int(y)) if y else None
            d = _calendar_date(int(g["nday"]), int(g["nmonth"]), today, y)
        else:
            month = _month_number(g["month"], words, lang)
            if month is None:
                continue
            d = _calendar_date(int(g["day"]), month, today, int(g["year"]) if g.get("year") else None)
        if d is not None:
            return m.start(), d
    return None


def _match_time(text: str, words: dict):
    lead = r"(?:" + words["time_lead"] + r")\s+"
    m = _at_end(lead + r"(?P<word>" + _alts(words["noon"] + words["midnight"]) + ")", text)
    if m:
        return m.start(), "12:00" if m.group("word").lower() in words["noon"] else "00:00"
    m = _at_end(
        lead + r"(?P<h>\d{1,2})(?:[:.](?P<m>\d{2}))?\s*(?P<ampm>a\.?\s?m\.?|p\.?\s?m\.?)?"
        r"(?:\s*(?:" + words["time_suffix"] + r"))?",
        text,
    )
    if not m:
        return None
    hour, minute = int(m.group("h")), int(m.group("m") or 0)
    ampm = (m.group("ampm") or "").replace(".", "").replace(" ", "").lower()
    if ampm:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if ampm == "pm" else 0)
    if hour > 23 or minute > 59:
        return None
    return m.start(), f"{hour:02d}:{minute:02d}"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_task_text(
    text: str,
    language: str | None,
    persons: list[tuple[str, str]],
    now: datetime,
) -> ParsedTask:
    """Split *text* into a title and the fields spoken after it.

    *persons* is ``[(entity_id, name), …]``; *now* is the local time (used
    for relative dates, and to put a bare "at 5 pm" on today or tomorrow).
    Raises ValueError when no title is left.
    """
    lang = supported_language(language)
    words = _LANG[lang]
    today = now.date()
    rest = text.strip()
    result = ParsedTask(title="")

    matchers = {
        "person": lambda t: _match_person(t, words, persons),
        "priority": lambda t: _match_priority(t, words),
        "date": lambda t: _match_date(t, words, lang, today),
        "time": lambda t: _match_time(t, words),
    }
    found = True
    while found:
        found = False
        for kind, matcher in matchers.items():
            if kind in result.matched:
                continue
            hit = matcher(rest)
            # A clause needs a title in front of it.
            if not hit or not rest[: hit[0]].strip(" ,.;"):
                continue
            start, value = hit
            if kind == "person":
                result.person, result.person_name = value
            elif kind == "priority":
                result.priority = value
            elif kind == "date":
                result.due_date = value
            else:
                result.due_time = value
            result.matched.append(kind)
            rest = rest[:start].rstrip(" ,.;")
            found = True
            break

    if result.due_time and result.due_date is None:
        h, m = (int(x) for x in result.due_time.split(":"))
        result.due_date = today if (h, m) > (now.hour, now.minute) else today + timedelta(days=1)

    title = rest.strip(" ,.;!?")
    if not title:
        raise ValueError("no task title in the text")
    result.title = title[0].upper() + title[1:]
    return result


def describe_task(parsed: ParsedTask, language: str | None, today: date) -> str:
    """The fields that were understood, as a short phrase for the spoken answer.

    "for Anna, high priority, due Friday 3 October at 17:00" — empty when
    only a title was given.
    """
    lang = supported_language(language)
    spoken, words = _SPOKEN[lang], _LANG[lang]
    parts = []
    if parsed.person_name:
        parts.append(spoken["for"].format(name=parsed.person_name))
    if parsed.priority:
        parts.append(spoken["priority"][parsed.priority])
    if parsed.due_date:
        if parsed.due_date == today:
            when = spoken["today"]
        elif parsed.due_date == today + timedelta(days=1):
            when = spoken["tomorrow"]
        else:
            when = spoken["date"].format(
                weekday=words["weekdays"][parsed.due_date.weekday()].capitalize(),
                day=parsed.due_date.day,
                month=words["months"][parsed.due_date.month - 1].capitalize(),
            )
            if parsed.due_date.year != today.year:
                when += f" {parsed.due_date.year}"
        due = spoken["due"].format(date=when)
        if parsed.due_time:
            due += " " + spoken["at"].format(time=parsed.due_time)
        parts.append(due)
    return ", ".join(parts)
