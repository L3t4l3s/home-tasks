"""The View Assist reminders blueprint (issue #18), end to end.

Home Tasks fires its real events (reminder timer, hourly due check,
completion); the automation built from the blueprint reacts to them.

View Assist itself can't run here, so its satellites are registry entries
of platform "view_assist" with the attributes View Assist gives them, and
its actions are stand-ins whose schemas copy View Assist's own
(custom_components/view_assist/devices/menu.py, core/services.py and
services.yaml upstream) — a call the real integration would reject is
rejected here too.  assist_satellite.announce is stubbed the same way.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from homeassistant.util.yaml import parse_yaml
from pytest_homeassistant_custom_component.common import (
    MockEntity,
    MockEntityPlatform,
    async_fire_time_changed,
)

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
BLUEPRINT = Path(__file__).resolve().parents[2] / "docs" / "view-assist" / "blueprint-hometasks-reminders.yaml"
KITCHEN, KIDS = "sensor.viewassist_kitchen", "sensor.viewassist_kids"

# The icon and path the blueprint uses by default.
def _item(task_id: str) -> str:
    return f"view:/view-assist/hometasks?task={task_id}|clipboard-alert"


@pytest.fixture
async def satellites(hass: HomeAssistant) -> dict[str, list]:
    """Two View Assist satellites and recorders for the actions they get."""
    # Loaded through a real entity platform named "view_assist", so
    # integration_entities('view_assist') finds them as it does in HA.
    platform = MockEntityPlatform(hass, domain="sensor", platform_name="view_assist")
    await platform.async_add_entities([
        MockEntity(
            entity_id=entity_id, unique_id=entity_id, name=entity_id.split(".")[1],
            should_poll=False,
            extra_state_attributes={"type": "view_audio", "mic_device": mic, "do_not_disturb": "off"},
        )
        for entity_id, mic in ((KITCHEN, "assist_satellite.kitchen"), (KIDS, "assist_satellite.kids"))
    ])
    for mic in ("assist_satellite.kitchen", "assist_satellite.kids"):
        hass.states.async_set(mic, "idle")

    calls: dict[str, list] = {k: [] for k in ("add", "remove", "navigate", "set_state", "announce")}

    def recorder(key):
        async def _handle(call: ServiceCall) -> None:
            calls[key].append(dict(call.data))
        return _handle

    status_item_schema = {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("status_item"): vol.Any(str, [str]),
        vol.Optional("menu", default=False): cv.boolean,
    }
    hass.services.async_register("view_assist", "add_status_item", recorder("add"), schema=vol.Schema(
        {**status_item_schema, vol.Optional("timeout"): vol.Any(int, None)}))
    hass.services.async_register("view_assist", "remove_status_item", recorder("remove"),
                                 schema=vol.Schema(status_item_schema))
    hass.services.async_register("view_assist", "navigate", recorder("navigate"), schema=vol.Schema({
        vol.Required("device"): cv.entity_id, vol.Required("path"): str,
        vol.Optional("revert_timeout"): vol.Coerce(int),
    }))
    hass.services.async_register("view_assist", "set_state", recorder("set_state"),
                                 schema=cv.make_entity_service_schema({}, extra=vol.ALLOW_EXTRA))
    hass.services.async_register("assist_satellite", "announce", recorder("announce"),
                                 schema=cv.make_entity_service_schema({
                                     vol.Optional("message"): str, vol.Optional("preannounce"): bool,
                                 }))
    return calls


async def _automation(hass: HomeAssistant, **inputs) -> None:
    from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA
    from homeassistant.components.blueprint import models

    blueprint = models.Blueprint(
        parse_yaml(BLUEPRINT.read_text(encoding="utf-8")),
        expected_domain="automation", path=BLUEPRINT.name, schema=AUTOMATION_BLUEPRINT_SCHEMA,
    )
    config = models.BlueprintInputs(blueprint, {
        "use_blueprint": {"path": BLUEPRINT.name, "input": inputs},
        "alias": "Home Tasks reminders",
    }).async_substitute()
    assert await async_setup_component(hass, "automation", {"automation": [config]})
    await hass.async_block_till_done()


def _at(freezer, hour: int, minute: int = 0) -> datetime:
    moment = datetime(2026, 9, 28, hour, minute, tzinfo=dt_util.DEFAULT_TIME_ZONE)
    freezer.move_to(moment)
    return moment


async def _reminder_fires(hass, store, freezer, title="Pay the bill", **fields) -> dict:
    """A task due today 17:00 with a 30-minute reminder; run the clock to 16:30."""
    _at(freezer, 16, 0)
    task = await store.async_add_task(title)
    await store.async_update_task(task["id"], due_date="2026-09-28", due_time="17:00", reminders=[30], **fields)
    moment = _at(freezer, 16, 30)
    async_fire_time_changed(hass, moment)
    await hass.async_block_till_done()
    return task


# ---------------------------------------------------------------------------
# Blueprint shape
# ---------------------------------------------------------------------------

def test_blueprint_declares_exactly_the_inputs_it_uses() -> None:
    from homeassistant.components.automation.config import AUTOMATION_BLUEPRINT_SCHEMA
    from homeassistant.components.blueprint import models
    from homeassistant.util import yaml as yaml_util

    blueprint = models.Blueprint(
        parse_yaml(BLUEPRINT.read_text(encoding="utf-8")),
        expected_domain="automation", path=BLUEPRINT.name, schema=AUTOMATION_BLUEPRINT_SCHEMA,
    )
    assert set(blueprint.inputs) == yaml_util.extract_inputs(blueprint.data)


def test_satellite_selection_matches_view_assists_device_alerts() -> None:
    """Same three options, same order, as View Assist's own Device Alerts blueprint."""
    data = parse_yaml(BLUEPRINT.read_text(encoding="utf-8"))
    section = data["blueprint"]["input"]["satellite_definitions"]["input"]
    assert list(section) == ["satellite_use_all", "satellites", "satellites_by_template"]


# ---------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------

async def test_reminder_goes_to_every_satellite(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    await _automation(hass, satellite_use_all=True)
    task = await _reminder_fires(hass, store, freezer)

    assert sorted(c["entity_id"] for c in satellites["add"]) == [KIDS, KITCHEN]
    assert {c["status_item"] for c in satellites["add"]} == {_item(task["id"])}
    assert sorted(c["device"] for c in satellites["navigate"]) == [KIDS, KITCHEN]
    assert satellites["navigate"][0]["path"] == "/view-assist/hometasks"
    assert satellites["set_state"][0]["home_tasks_list"] == mock_config_entry.entry_id
    # One announce call for all, so the satellites speak together.
    (announce,) = satellites["announce"]
    assert sorted(announce["entity_id"]) == ["assist_satellite.kids", "assist_satellite.kitchen"]
    assert announce["message"] == "Reminder: Pay the bill, due at 17:00"


async def test_do_not_disturb_gets_the_icon_but_no_announcement(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    hass.states.async_set(KIDS, "idle", {
        "type": "view_audio", "mic_device": "assist_satellite.kids", "do_not_disturb": "on",
    })
    await _automation(hass, satellite_use_all=True)
    await _reminder_fires(hass, store, freezer)

    assert sorted(c["entity_id"] for c in satellites["add"]) == [KIDS, KITCHEN]
    assert [c["entity_id"] for c in satellites["announce"]] == [["assist_satellite.kitchen"]]


async def test_one_failing_satellite_does_not_stop_the_others(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    async def _offline(call: ServiceCall) -> None:
        if call.data["entity_id"] == KIDS:
            from homeassistant.exceptions import HomeAssistantError
            raise HomeAssistantError("satellite offline")
        satellites["add"].append(dict(call.data))

    hass.services.async_register("view_assist", "add_status_item", _offline)
    await _automation(hass, satellites=[KIDS, KITCHEN])
    await _reminder_fires(hass, store, freezer)
    assert [c["entity_id"] for c in satellites["add"]] == [KITCHEN]
    assert len(satellites["announce"]) == 1


async def test_specific_satellites(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    await _automation(hass, satellites=[KITCHEN])
    await _reminder_fires(hass, store, freezer)
    assert [c["entity_id"] for c in satellites["add"]] == [KITCHEN]


PERSON_TEMPLATE = (
    "{{ {'person.anna': ['sensor.viewassist_kids']}"
    ".get(assigned_person, ['sensor.viewassist_kitchen']) }}"
)

LAST_USED_TEMPLATE = """
{% set ns = namespace(best=none, t=none) %}
{% for s in integration_entities('view_assist') if s.startswith('sensor.') %}
  {% set m = state_attr(s, 'mic_device') %}
  {% if m and states[m] is defined and (ns.t is none or states[m].last_changed > ns.t) %}
    {% set ns.best = s %}{% set ns.t = states[m].last_changed %}
  {% endif %}
{% endfor %}
{{ [ns.best] if ns.best else [] }}
"""


async def test_template_by_assigned_person(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    """The documented person → satellite template."""
    assert await async_setup_component(hass, "person", {"person": [{"id": "anna", "name": "Anna"}]})
    await _automation(hass, satellites_by_template=PERSON_TEMPLATE)

    await _reminder_fires(hass, store, freezer, "Tidy your room", assigned_person="person.anna")
    assert [c["entity_id"] for c in satellites["add"]] == [KIDS]
    assert satellites["announce"][0]["message"] == "Reminder: Tidy your room, due at 17:00"

    satellites["add"].clear()
    await _reminder_fires(hass, store, freezer, "Empty the bins")
    assert [c["entity_id"] for c in satellites["add"]] == [KITCHEN]


async def test_template_last_used_satellite(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    """The documented "satellite that last heard a command" template."""
    await _automation(hass, satellites_by_template=LAST_USED_TEMPLATE)
    _at(freezer, 14, 0)
    hass.states.async_set("assist_satellite.kitchen", "listening")
    hass.states.async_set("assist_satellite.kitchen", "idle")
    _at(freezer, 15, 0)
    hass.states.async_set("assist_satellite.kids", "listening")
    hass.states.async_set("assist_satellite.kids", "idle")
    await _reminder_fires(hass, store, freezer)
    assert [c["entity_id"] for c in satellites["add"]] == [KIDS]


async def _settle(hass: HomeAssistant) -> None:
    """Let the automation run up to its next wait.

    async_block_till_done would wait for the run that is waiting for the
    morning — i.e. forever — so just yield to the loop a few times.
    """
    for _ in range(20):
        await asyncio.sleep(0)


async def _overdue_after_midnight(hass, store, freezer) -> dict:
    from custom_components.home_tasks import _async_check_due_dates

    _at(freezer, 0, 30)
    task = await store.async_add_task("Pay the bill")
    await store.async_update_task(task["id"], due_date="2026-09-27")
    await _async_check_due_dates(hass)
    await _settle(hass)
    return task


async def _morning(hass, freezer) -> None:
    moment = _at(freezer, 7, 0)
    async_fire_time_changed(hass, moment)
    await _settle(hass)


async def test_overdue_at_night_waits_for_the_morning(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    """Overdue fires after midnight: the icon at once, the words at 07:00."""
    await _automation(hass, satellite_use_all=True)
    task = await _overdue_after_midnight(hass, store, freezer)

    assert {c["status_item"] for c in satellites["add"]} == {_item(task["id"])}
    assert satellites["announce"] == [] and satellites["navigate"] == []

    await _morning(hass, freezer)
    assert [c["message"] for c in satellites["announce"]] == ["Pay the bill is overdue"]
    assert sorted(c["device"] for c in satellites["navigate"]) == [KIDS, KITCHEN]


async def test_overdue_done_before_the_morning_stays_quiet(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    await _automation(hass, satellite_use_all=True)
    task = await _overdue_after_midnight(hass, store, freezer)
    await store.async_update_task(task["id"], completed=True)
    await _settle(hass)
    assert {c["status_item"] for c in satellites["remove"]} == {_item(task["id"])}

    await _morning(hass, freezer)
    assert satellites["announce"] == [] and satellites["navigate"] == []


async def test_reminder_at_night_is_icon_only(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    """A reminder is about now — outside the hours it doesn't wait."""
    await _automation(hass, satellites=[KITCHEN], announce_until="16:00:00")
    await _reminder_fires(hass, store, freezer)
    assert len(satellites["add"]) == 1
    assert satellites["announce"] == [] and satellites["navigate"] == []


async def test_overdue_in_the_day_is_announced(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    from custom_components.home_tasks import _async_check_due_dates

    await _automation(hass, satellites=[KITCHEN])
    _at(freezer, 9, 0)
    task = await store.async_add_task("Pay the bill")
    await store.async_update_task(task["id"], due_date="2026-09-27")
    await _async_check_due_dates(hass)
    await hass.async_block_till_done()
    assert [c["message"] for c in satellites["announce"]] == ["Pay the bill is overdue"]


async def test_completing_the_task_removes_its_icon_everywhere(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    await _automation(hass, satellites=[KITCHEN])
    task = await _reminder_fires(hass, store, freezer)
    await store.async_update_task(task["id"], completed=True)
    await hass.async_block_till_done()

    # It doesn't know which satellites got it, so it clears the icon on all.
    assert sorted(c["entity_id"] for c in satellites["remove"]) == [KIDS, KITCHEN]
    assert {c["status_item"] for c in satellites["remove"]} == {_item(task["id"])}


async def test_icon_timeout(hass: HomeAssistant, mock_config_entry, store, satellites, freezer) -> None:
    """12 hours by default — catches deleted tasks and provider-side ticks."""
    await _automation(hass, satellites=[KITCHEN])
    await _reminder_fires(hass, store, freezer)
    assert satellites["add"][0]["timeout"] == 12 * 3600



async def test_icon_without_timeout(hass: HomeAssistant, mock_config_entry, store, satellites, freezer) -> None:
    await _automation(hass, satellites=[KITCHEN], status_icon_timeout=0)
    await _reminder_fires(hass, store, freezer)
    assert "timeout" not in satellites["add"][0]


async def test_event_types_and_list_filter(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    from custom_components.home_tasks import _async_check_due_dates

    # Only reminders: an overdue task stays quiet.
    await _automation(hass, satellites=[KITCHEN], event_types=["reminder"])
    _at(freezer, 9, 0)
    task = await store.async_add_task("Old one")
    await store.async_update_task(task["id"], due_date="2026-09-27")
    await _async_check_due_dates(hass)
    await hass.async_block_till_done()
    assert satellites["add"] == []


async def test_other_lists_are_ignored(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    await _automation(hass, satellites=[KITCHEN], todo_entities=["todo.some_other_list"])
    await _reminder_fires(hass, store, freezer)
    assert satellites["add"] == []


async def test_the_chosen_list_by_its_todo_entity(
    hass: HomeAssistant, mock_config_entry, store, satellites, freezer
) -> None:
    todo_entity = er.async_get(hass).async_get_entity_id("todo", DOMAIN, mock_config_entry.entry_id)
    await _automation(hass, satellites=[KITCHEN], todo_entities=[todo_entity])
    await _reminder_fires(hass, store, freezer)
    assert [c["entity_id"] for c in satellites["add"]] == [KITCHEN]
