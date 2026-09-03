"""The open-tasks sensor and the overdue binary sensor on a linked list.

Native lists always had both; a linked list had neither, so an automation
that says "remind me when the shared shopping list has something overdue"
could only be written against a native one. The linked variants read the
merged view - the provider's items plus our overlay - and refresh when
either half changes.
"""
from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import MagicMock

import pytest
from homeassistant.components.todo import TodoItem, TodoItemStatus
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.home_tasks.overlay_store import ExternalTaskOverlayStore

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.linked_sensors"


def _today() -> date:
    return dt_util.now().date()


def _open(uid: str, title: str, due: date | None = None) -> TodoItem:
    return TodoItem(uid=uid, summary=title, status=TodoItemStatus.NEEDS_ACTION, due=due)


def _done(uid: str, title: str, due: date | None = None) -> TodoItem:
    return TodoItem(uid=uid, summary=title, status=TodoItemStatus.COMPLETED, due=due)


@pytest.fixture
async def linked(hass: HomeAssistant, freezer, patch_add_extra_js_url):
    """A linked list whose provider entity is a mock todo entity.

    Time is frozen (at "now") before the entry is set up, so the midnight
    timers the sensors register can be driven with async_fire_time_changed.
    """
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": EXT_ENTITY, "name": "Linked Sensors"},
        title="Linked Sensors (External)",
    )
    entry.add_to_hass(hass)

    hass.states.async_set(EXT_ENTITY, "0")
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    # After setup: loading the entry pulls in the real todo component, which
    # would replace a mock installed earlier.
    mock_entity = MagicMock()
    mock_entity.todo_items = []
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    overlay = hass.data[DOMAIN][entry.entry_id]
    assert isinstance(overlay, ExternalTaskOverlayStore)
    return entry, overlay, mock_entity


async def _provider_now_holds(hass: HomeAssistant, mock_entity, items: list[TodoItem]) -> None:
    """The provider's items changed and its entity wrote its state, as a real
    one does: the open-item count, nothing else. When the count is the same
    HA only *reports* the write, it does not count as a change."""
    mock_entity.todo_items = items
    open_count = sum(1 for i in items if i.status != TodoItemStatus.COMPLETED)
    hass.states.async_set(EXT_ENTITY, str(open_count))
    await hass.async_block_till_done()


def _sensor_id(hass: HomeAssistant, entry) -> str | None:
    return er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_open_tasks")


def _binary_id(hass: HomeAssistant, entry) -> str | None:
    return er.async_get(hass).async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_overdue")


# ---------------------------------------------------------------------------
# Both entities exist
# ---------------------------------------------------------------------------

async def test_a_linked_list_gets_both_sensors(hass: HomeAssistant, linked) -> None:
    entry, _overlay, _entity = linked
    assert _sensor_id(hass, entry) is not None
    assert _binary_id(hass, entry) is not None


async def test_the_todo_entity_stays_the_providers(hass: HomeAssistant, linked) -> None:
    """We add sensors next to the provider's list, never a second todo entity."""
    entry, _overlay, _entity = linked
    reg = er.async_get(hass)
    ours = [e for e in reg.entities.values() if e.config_entry_id == entry.entry_id]
    assert sorted(e.domain for e in ours) == ["binary_sensor", "calendar", "sensor"]


# ---------------------------------------------------------------------------
# The open-tasks sensor
# ---------------------------------------------------------------------------

async def test_the_sensor_counts_what_the_provider_holds(hass: HomeAssistant, linked) -> None:
    entry, _overlay, entity = linked
    await _provider_now_holds(hass, entity, [
        _open("u1", "Milk"), _open("u2", "Bread"), _done("u3", "Eggs"),
    ])

    state = hass.states.get(_sensor_id(hass, entry))
    assert int(state.state) == 2
    assert state.attributes["open_task_titles"] == ["Milk", "Bread"]
    assert state.attributes["total_tasks"] == 3
    assert state.attributes["overdue_count"] == 0


async def test_the_sensor_follows_the_provider(hass: HomeAssistant, linked) -> None:
    """Ticked off in the provider's own app: the count drops with the next state."""
    entry, _overlay, entity = linked
    await _provider_now_holds(hass, entity, [_open("u1", "Milk")])
    assert int(hass.states.get(_sensor_id(hass, entry)).state) == 1

    await _provider_now_holds(hass, entity, [_done("u1", "Milk")])
    assert int(hass.states.get(_sensor_id(hass, entry)).state) == 0


async def test_an_edit_that_keeps_the_count_still_gets_through(hass: HomeAssistant, linked) -> None:
    """A rename or a moved due date changes no state on a todo entity - the
    state is the count - so the sensors listen to the report as well (review)."""
    entry, _overlay, entity = linked
    await _provider_now_holds(hass, entity, [_open("u1", "Milk")])
    assert hass.states.get(_sensor_id(hass, entry)).attributes["open_task_titles"] == ["Milk"]

    await _provider_now_holds(hass, entity, [_open("u1", "Oat milk", due=_today() - timedelta(days=1))])

    assert hass.states.get(_sensor_id(hass, entry)).attributes["open_task_titles"] == ["Oat milk"]
    assert hass.states.get(_binary_id(hass, entry)).state == "on"


# ---------------------------------------------------------------------------
# The overdue binary sensor
# ---------------------------------------------------------------------------

async def test_overdue_comes_from_the_providers_due_date(hass: HomeAssistant, linked) -> None:
    entry, _overlay, entity = linked
    yesterday = _today() - timedelta(days=1)
    await _provider_now_holds(hass, entity, [
        _open("u1", "Late", due=yesterday),
        _open("u2", "Not yet", due=_today() + timedelta(days=3)),
        _done("u3", "Late but done", due=yesterday),
    ])

    state = hass.states.get(_binary_id(hass, entry))
    assert state.state == "on"
    assert state.attributes["overdue_count"] == 1
    assert state.attributes["overdue_tasks"] == [
        {"title": "Late", "due_date": yesterday.isoformat(), "assigned_person": None}
    ]
    assert hass.states.get(_sensor_id(hass, entry)).attributes["overdue_count"] == 1


async def test_overdue_comes_from_the_overlay_too(hass: HomeAssistant, linked) -> None:
    """A provider that cannot hold a due date (Bring, shopping_list) keeps it
    in our overlay - and an overlay write alone must refresh the sensor, the
    provider's entity has nothing to announce."""
    entry, overlay, entity = linked
    await _provider_now_holds(hass, entity, [_open("u1", "Bins")])
    assert hass.states.get(_binary_id(hass, entry)).state == "off"

    yesterday = (_today() - timedelta(days=1)).isoformat()
    await overlay.async_set_overlay("u1", due_date=yesterday, assigned_person="person.kevin")
    await hass.async_block_till_done()

    state = hass.states.get(_binary_id(hass, entry))
    assert state.state == "on"
    assert state.attributes["overdue_tasks"] == [
        {"title": "Bins", "due_date": yesterday, "assigned_person": "person.kevin"}
    ]


async def test_overdue_clears_when_the_provider_completes_it(hass: HomeAssistant, linked) -> None:
    entry, _overlay, entity = linked
    yesterday = _today() - timedelta(days=1)
    await _provider_now_holds(hass, entity, [_open("u1", "Late", due=yesterday)])
    assert hass.states.get(_binary_id(hass, entry)).state == "on"

    await _provider_now_holds(hass, entity, [_done("u1", "Late", due=yesterday)])
    assert hass.states.get(_binary_id(hass, entry)).state == "off"


async def test_midnight_turns_a_task_due_today_overdue(hass: HomeAssistant, linked, freezer) -> None:
    """Nobody edits the list at midnight, so the sensor has to look by itself."""
    entry, _overlay, entity = linked
    await _provider_now_holds(hass, entity, [_open("u1", "Due today", due=_today())])
    assert hass.states.get(_binary_id(hass, entry)).state == "off"

    next_midnight = dt_util.start_of_local_day(dt_util.now()) + timedelta(days=1, seconds=1)
    freezer.move_to(next_midnight)
    async_fire_time_changed(hass, next_midnight)
    await hass.async_block_till_done()

    assert hass.states.get(_binary_id(hass, entry)).state == "on"
    assert hass.states.get(_sensor_id(hass, entry)).attributes["overdue_count"] == 1


# ---------------------------------------------------------------------------
# The provider is not there (yet)
# ---------------------------------------------------------------------------

async def test_unavailable_until_the_provider_entity_shows_up(
    hass: HomeAssistant, freezer, patch_add_extra_js_url
) -> None:
    """The provider integration may load after us; the sensors wait for it
    rather than reporting a confident zero."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"type": "external", "entity_id": "todo.not_yet", "name": "Not Yet"},
        title="Not Yet (External)",
    )
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert hass.states.get(_sensor_id(hass, entry)).state == "unavailable"
    assert hass.states.get(_binary_id(hass, entry)).state == "unavailable"

    mock_entity = MagicMock()
    mock_entity.todo_items = [_open("u1", "Milk")]
    mock_comp = MagicMock()
    mock_comp.get_entity.return_value = mock_entity
    hass.data["todo"] = mock_comp
    hass.states.async_set("todo.not_yet", "1")
    await hass.async_block_till_done()

    assert hass.states.get(_sensor_id(hass, entry)).state == "1"
    assert hass.states.get(_binary_id(hass, entry)).state == "off"


async def test_a_provider_that_is_down_takes_the_sensors_down_with_it(
    hass: HomeAssistant, linked
) -> None:
    """HA keeps an 'unavailable' state object for a provider that is not
    answering (and writes one for every entity at boot). Reading through
    it yields nothing, and nothing reported with confidence is wrong (review)."""
    entry, _overlay, entity = linked
    yesterday = _today() - timedelta(days=1)
    await _provider_now_holds(hass, entity, [_open("u1", "Late", due=yesterday)])
    assert hass.states.get(_binary_id(hass, entry)).state == "on"
    calendar_id = er.async_get(hass).async_get_entity_id("calendar", DOMAIN, f"{entry.entry_id}_calendar")

    hass.states.async_set(EXT_ENTITY, "unavailable")
    await hass.async_block_till_done()

    assert hass.states.get(_sensor_id(hass, entry)).state == "unavailable"
    assert hass.states.get(_binary_id(hass, entry)).state == "unavailable"
    assert hass.states.get(calendar_id).state == "unavailable"

    hass.states.async_set(EXT_ENTITY, "1")
    await hass.async_block_till_done()
    assert hass.states.get(_binary_id(hass, entry)).state == "on", "back as it was"


async def test_unloading_the_entry_takes_the_sensors_with_it(hass: HomeAssistant, linked) -> None:
    """After unload the sensors are gone (HA keeps a restored 'unavailable'
    placeholder) and stay gone: the provider's next state change must not
    find a listener still attached."""
    entry, _overlay, entity = linked
    sensor_id, binary_id = _sensor_id(hass, entry), _binary_id(hass, entry)
    await _provider_now_holds(hass, entity, [_open("u1", "Milk")])
    assert hass.states.get(sensor_id).state == "1"

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    await _provider_now_holds(hass, entity, [_open("u1", "Milk"), _open("u2", "Bread")])

    for entity_id in (sensor_id, binary_id):
        state = hass.states.get(entity_id)
        assert state.state == "unavailable" and state.attributes.get("restored") is True
