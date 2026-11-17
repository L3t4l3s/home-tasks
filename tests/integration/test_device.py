"""One device per list and per plan (device.py).

The card reads the device's identifier to suggest itself for an entity in
Home Assistant's "add to dashboard" dialog; the entities keep their names.
"""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

DOMAIN = "home_tasks"
EXT_ENTITY = "todo.provider_list"

pytestmark = pytest.mark.integration


async def _setup(hass: HomeAssistant, data: dict, title: str) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data=data, title=title)
    entry.add_to_hass(hass)
    await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def _entities(hass: HomeAssistant, entry: MockConfigEntry) -> dict[str, er.RegistryEntry]:
    return {e.unique_id: e for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}


def _device(hass: HomeAssistant, entry: MockConfigEntry) -> dr.DeviceEntry:
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert len(devices) == 1
    return devices[0]


def _names(hass: HomeAssistant, entities) -> set[str]:
    return {hass.states.get(e.entity_id).name for e in entities}


async def test_a_list_has_one_device_for_all_its_entities(
    hass: HomeAssistant, mock_config_entry
) -> None:
    device = _device(hass, mock_config_entry)
    assert device.identifiers == {(DOMAIN, f"list:{mock_config_entry.entry_id}")}
    assert (device.name, device.model, device.entry_type) == (
        "Test List", "List", dr.DeviceEntryType.SERVICE,
    )
    entities = _entities(hass, mock_config_entry).values()
    assert {e.domain for e in entities} == {"todo", "sensor", "binary_sensor", "calendar"}
    assert {e.device_id for e in entities} == {device.id}
    # The names read as before the device: the todo entity is the list itself.
    assert _names(hass, entities) == {
        "Test List", "Test List Open Tasks", "Test List Overdue", "Test List Calendar",
    }


async def test_a_linked_list_names_the_providers_entity(
    hass: HomeAssistant, patch_add_extra_js_url
) -> None:
    hass.states.async_set(EXT_ENTITY, "0")
    entry = await _setup(
        hass, {"type": "external", "entity_id": EXT_ENTITY, "name": "Garden"}, "Garden (External)",
    )
    device = _device(hass, entry)
    # By the provider's entity: the card is suggested for that entity.
    assert device.identifiers == {(DOMAIN, f"linked:{EXT_ENTITY}")}
    assert (device.name, device.model) == ("Garden", "Linked list")
    entities = _entities(hass, entry).values()
    assert {e.device_id for e in entities} == {device.id}
    assert _names(hass, entities) == {"Garden Open Tasks", "Garden Overdue", "Garden Calendar"}


async def test_a_plan_has_a_device_of_its_own(
    hass: HomeAssistant, patch_add_extra_js_url
) -> None:
    entry = await _setup(hass, {"type": "plan", "name": "Today"}, "Today")
    device = _device(hass, entry)
    assert device.identifiers == {(DOMAIN, f"plan:{entry.entry_id}")}
    assert (device.name, device.model) == ("Today", "Day plan")
    entities = list(_entities(hass, entry).values())
    assert [e.device_id for e in entities] == [device.id]
    assert _names(hass, entities) == {"Today Open Items"}
