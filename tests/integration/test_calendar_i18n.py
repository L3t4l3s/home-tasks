"""Calendar descriptions use the instance language and person display names."""
from datetime import date, datetime, timezone

import json
from pathlib import Path

import pytest
from homeassistant.core import HomeAssistant

from custom_components.home_tasks.calendar import (
    HomeTasksCalendarEntity,
    _expand_task_events,
)

from custom_components.home_tasks.ui_translations import load_ui_translations

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
async def preload_translations(hass):
    await hass.async_add_executor_job(load_ui_translations)



@pytest.mark.parametrize("language", ["pt-BR", "pt", "pt-PT"])
async def test_portuguese_calendar_metadata(hass: HomeAssistant, language: str):
    """Translate every description field while preserving user-entered content."""
    hass.config.language = language
    hass.states.async_set("person.julia", "home", {"friendly_name": "Júlia"})
    task = {
        "title": "Comprar beterraba 🫜", "notes": "Fresh vegetables",
        "priority": 3, "assigned_person": "person.julia", "tags": ["compras"],
        "sub_items": [{"completed": True}, {"completed": False}],
        "reminders": [0, 15, 60, 120, 1440],
    }
    assert HomeTasksCalendarEntity._build_description(task, hass) == (
        "Fresh vegetables\n\n⚡ Prioridade: Alta\n👤 Júlia\n#compras\n"
        f"☑ Subtarefas: 1/2\n⏰ {'No horário de vencimento' if language == 'pt-BR' else 'No prazo'}, 15 min antes, "
        "1h antes, 2h antes, 1d antes"
    )


@pytest.mark.parametrize("priority,label", [(1, "Baixa"), (2, "Média"), (3, "Alta"), (9, "9")])
async def test_priority_labels(hass: HomeAssistant, priority: int, label: str):
    hass.config.language = "pt-BR"
    assert HomeTasksCalendarEntity._build_description({"priority": priority}, hass) == f"⚡ Prioridade: {label}"


@pytest.mark.parametrize("language", ["en", "zz", ""])
async def test_english_fallback(hass: HomeAssistant, language: str):
    hass.config.language = language
    task = {"priority": 3, "assigned_person": "person.missing", "reminders": [0, 5, 60, 120, 2880]}
    assert HomeTasksCalendarEntity._build_description(task, hass) == (
        "⚡ Priority: High\n👤 person.missing\n"
        "⏰ At due time, 5 min before, 1h before, 2h before, 2d before"
    )


async def test_missing_person_name_and_empty_description(hass: HomeAssistant):
    hass.states.async_set("person.julia", "unavailable")
    assert HomeTasksCalendarEntity._build_description({"assigned_person": "person.julia"}, hass) == "👤 person.julia"
    assert HomeTasksCalendarEntity._build_description({}, hass) is None
    assert HomeTasksCalendarEntity._build_description({"notes": "My notes"}, hass) == "My notes"


async def test_recurring_descriptions_and_event_dates(hass: HomeAssistant):
    """The expansion shared by native and external calendars preserves dates/IDs."""
    hass.config.language = "pt-BR"
    hass.states.async_set("person.julia", "home", {"friendly_name": "Júlia"})
    task = {
        "id": "task-1", "title": "Comprar beterraba 🫜", "due_date": "2027-06-01",
        "priority": 3, "assigned_person": "person.julia", "recurrence_enabled": True,
        "recurrence_unit": "days", "recurrence_value": 1,
    }
    events = _expand_task_events(
        task, datetime(2027, 6, 1, tzinfo=timezone.utc),
        datetime(2027, 6, 3, tzinfo=timezone.utc), hass,
    )
    assert events
    assert events[0].start == date(2027, 6, 1)
    for event in events:
        assert event.description == "⚡ Prioridade: Alta\n👤 Júlia"
        assert event.summary == task["title"]
        assert event.uid == "task-1"
        assert event.rrule == "FREQ=DAILY"
        assert event.recurrence_id == event.start.isoformat()


async def test_registered_native_calendar_uses_instance_language(
    hass: HomeAssistant, mock_config_entry, store,
):
    """Both state-event and calendar API paths use the localized description."""
    from homeassistant.helpers import entity_registry as er

    hass.config.language = "pt-BR"
    hass.states.async_set("person.julia", "home", {"friendly_name": "Júlia"})
    task = await store.async_add_task("Comprar beterraba 🫜")
    await store.async_update_task(
        task["id"], due_date="2099-06-15", priority=3, assigned_person="person.julia",
    )
    await hass.async_block_till_done()
    entity_id = er.async_get(hass).async_get_entity_id(
        "calendar", "home_tasks", f"{mock_config_entry.entry_id}_calendar",
    )
    entity = hass.data["calendar"].get_entity(entity_id)
    assert entity is not None
    assert entity.event.description == "⚡ Prioridade: Alta\n👤 Júlia"
    events = await entity.async_get_events(
        hass, datetime(2099, 6, 1, tzinfo=timezone.utc),
        datetime(2099, 7, 1, tzinfo=timezone.utc),
    )
    assert len(events) == 1
    assert events[0].description == entity.event.description


_TRANSLATIONS_PATH = Path(__file__).parents[2] / "custom_components/home_tasks/ui_translations.json"
_SHARED_TEXT = json.loads(_TRANSLATIONS_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("language", list(_SHARED_TEXT))
async def test_calendar_reuses_frontend_strings_in_every_language(hass, language):
    hass.config.language = language
    text = _SHARED_TEXT[language]
    task = {"priority": 2, "sub_items": [{"completed": True}], "reminders": [0, 15, 120, 2880]}
    description = HomeTasksCalendarEntity._build_description(task, hass)
    assert f"{text['priority']}: {text['pri_medium']}" in description
    assert f"{text['sub_items']}: 1/1" in description
    assert text["rem_at_due"] in description
    for key, value in [("calendar_minutes_before", 15), ("calendar_hours_before", 2), ("calendar_days_before", 2)]:
        assert text[key].format(value=value) in description


@pytest.mark.parametrize("language,target", [("pt-br", "pt-BR"), ("pt_BR", "pt-BR"), ("en-GB", "en"), ("nb", "no"), ("nn-NO", "no")])
async def test_calendar_locale_aliases(hass, language, target):
    hass.config.language = language
    text = _SHARED_TEXT[target]
    assert HomeTasksCalendarEntity._build_description({"priority": 1}, hass) == f"⚡ {text['priority']}: {text['pri_low']}"
