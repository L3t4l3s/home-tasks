"""home_tasks.add_task_from_text and the add-by-voice blueprint (issue #18)."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from homeassistant.util.yaml import parse_yaml

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
BLUEPRINT = Path(__file__).resolve().parents[2] / "docs" / "view-assist" / "blueprint-hometasks-add.yaml"


@pytest.fixture
async def persons(hass: HomeAssistant) -> None:
    assert await async_setup_component(hass, "person", {"person": [
        {"id": "anna", "name": "Anna"},
        {"id": "ben", "name": "Ben Berg"},
    ]})
    await hass.async_block_till_done()


@pytest.fixture
def monday_10am(freezer) -> None:
    freezer.move_to(datetime(2026, 9, 28, 10, 0, tzinfo=dt_util.DEFAULT_TIME_ZONE))


async def _call(hass: HomeAssistant, **data) -> dict:
    return await hass.services.async_call(
        DOMAIN, "add_task_from_text", data, blocking=True, return_response=True,
    )


async def test_creates_the_task_with_every_field(
    hass: HomeAssistant, mock_config_entry, store, persons, monday_10am
) -> None:
    result = await _call(
        hass, list_name="Test List",
        text="pay the bill for Anna with high priority due Friday at 5 pm",
    )
    task = store.get_task(result["task_id"])
    assert (task["title"], task["assigned_person"], task["priority"], task["due_date"], task["due_time"]) == (
        "Pay the bill", "person.anna", 3, "2026-10-02", "17:00",
    )
    assert result["list_name"] == "Test List"
    assert result["details"] == "for Anna, high priority, due Friday 2 October at 17:00"


async def test_uses_the_home_assistant_language_by_default(
    hass: HomeAssistant, mock_config_entry, store, persons, monday_10am
) -> None:
    hass.config.language = "de"
    result = await _call(
        hass, entry_id=mock_config_entry.entry_id,
        text="Rasen mähen für Ben morgen um 9 Uhr",
    )
    task = store.get_task(result["task_id"])
    assert (task["title"], task["assigned_person"], task["due_date"], task["due_time"]) == (
        "Rasen mähen", "person.ben_berg", "2026-09-29", "09:00",
    )
    assert result["details"] == "für Ben Berg, fällig morgen um 09:00"


async def test_explicit_language_wins(
    hass: HomeAssistant, mock_config_entry, store, monday_10am
) -> None:
    hass.config.language = "de"
    result = await _call(hass, list_name="Test List", text="call mum tomorrow", language="en")
    assert store.get_task(result["task_id"])["due_date"] == "2026-09-29"


async def test_a_title_only_sentence_has_no_details(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    result = await _call(hass, list_name="Test List", text="look for the keys")
    assert store.get_task(result["task_id"])["title"] == "Look for the keys"
    assert result["details"] == ""


async def test_no_title_is_a_validation_error(hass: HomeAssistant, mock_config_entry, store) -> None:
    with pytest.raises(ServiceValidationError):
        await _call(hass, list_name="Test List", text=" , ")
    assert store.tasks == []


async def test_list_defaults_still_apply(hass: HomeAssistant, mock_config_entry, store) -> None:
    """The text path creates through the same code as add_task."""
    await store.async_set_defaults(tags=["voice"])
    result = await _call(hass, list_name="Test List", text="water the plants")
    assert store.get_task(result["task_id"])["tags"] == ["voice"]


# ---------------------------------------------------------------------------
# The blueprint, end to end through Assist
# ---------------------------------------------------------------------------

async def _automation_from_blueprint(hass: HomeAssistant, todo_entity: str, **inputs) -> None:
    from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA
    from homeassistant.components.blueprint import models

    blueprint = models.Blueprint(
        parse_yaml(BLUEPRINT.read_text(encoding="utf-8")),
        expected_domain="automation", path=BLUEPRINT.name, schema=AUTOMATION_BLUEPRINT_SCHEMA,
    )
    config = models.BlueprintInputs(blueprint, {
        "use_blueprint": {"path": BLUEPRINT.name, "input": {"todo_entity": todo_entity, **inputs}},
        "alias": "Add task by voice",
    }).async_substitute()
    assert await async_setup_component(hass, "homeassistant", {})
    assert await async_setup_component(hass, "conversation", {})
    assert await async_setup_component(hass, "automation", {"automation": [config]})
    await hass.async_block_till_done()


async def _say(hass: HomeAssistant, text: str, language: str = "en") -> str:
    result = await hass.services.async_call(
        "conversation", "process", {"text": text, "language": language},
        blocking=True, return_response=True,
    )
    return result["response"]["speech"]["plain"]["speech"]


def _todo_entity(hass: HomeAssistant, entry) -> str:
    from homeassistant.helpers import entity_registry as er
    return er.async_get(hass).async_get_entity_id("todo", DOMAIN, entry.entry_id)


def test_blueprint_declares_exactly_the_inputs_it_uses() -> None:
    from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA
    from homeassistant.components.blueprint import models
    from homeassistant.util import yaml as yaml_util

    blueprint = models.Blueprint(
        parse_yaml(BLUEPRINT.read_text(encoding="utf-8")),
        expected_domain="automation", path=BLUEPRINT.name, schema=AUTOMATION_BLUEPRINT_SCHEMA,
    )
    assert set(blueprint.inputs) == yaml_util.extract_inputs(blueprint.data)


async def test_blueprint_adds_the_task_and_says_so(
    hass: HomeAssistant, mock_config_entry, store, persons, monday_10am
) -> None:
    await _automation_from_blueprint(hass, _todo_entity(hass, mock_config_entry))

    speech = await _say(hass, "add task pay the bill for Anna with high priority due Friday at 5 pm")

    assert speech == "Added Pay the bill to your Test List, for Anna, high priority, due Friday 2 October at 17:00"
    (task,) = store.tasks
    assert (task["title"], task["assigned_person"], task["priority"], task["due_date"], task["due_time"]) == (
        "Pay the bill", "person.anna", 3, "2026-10-02", "17:00",
    )


async def test_blueprint_title_only_and_second_command(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    await _automation_from_blueprint(hass, _todo_entity(hass, mock_config_entry))
    assert await _say(hass, "new task water the plants") == "Added Water the plants to your Test List"
    assert [t["title"] for t in store.tasks] == ["Water the plants"]


async def test_blueprint_leaves_shopping_list_sentences_alone(
    hass: HomeAssistant, mock_config_entry, store
) -> None:
    """The default commands need the word "task", so "add milk to …" is not ours."""
    await _automation_from_blueprint(hass, _todo_entity(hass, mock_config_entry))
    await _say(hass, "add milk to my shopping list")
    assert store.tasks == []


async def test_blueprint_german(
    hass: HomeAssistant, mock_config_entry, store, persons, monday_10am
) -> None:
    await _automation_from_blueprint(
        hass, _todo_entity(hass, mock_config_entry),
        command_add1="[neue] aufgabe {task}",
        command_add2="füge [die] aufgabe {task} hinzu",
        language="de",
        response_added="{title} zu {list_name} hinzugefügt",
        response_added_details="{title} zu {list_name} hinzugefügt, {details}",
    )
    speech = await _say(hass, "neue Aufgabe Rechnung bezahlen für Anna fällig übermorgen", "de")
    assert speech == "Rechnung bezahlen zu Test List hinzugefügt, für Anna, fällig Mittwoch, 30. September"
    speech = await _say(hass, "füge Aufgabe Müll rausbringen hinzu", "de")
    assert speech == "Müll rausbringen zu Test List hinzugefügt"
    assert [t["title"] for t in store.tasks] == ["Rechnung bezahlen", "Müll rausbringen"]
