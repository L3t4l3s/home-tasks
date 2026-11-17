"""One device per list and per plan.

The entities of a list (its todo entity, sensors and calendar) or of a plan
belong together; the device groups them in Home Assistant. Its identifier
also says what it is, and Home Assistant hands device identifiers to the
frontend: the card reads them to suggest itself for an entity in the "add to
dashboard" dialog, which has to answer from what the frontend holds.

  list:<entry id>               a Home Tasks list
  linked:<provider entity id>   a provider's list linked to Home Tasks
  plan:<entry id>               a day plan
"""
from __future__ import annotations

from collections import Counter

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.entity import DeviceInfo

from .const import DOMAIN
from .plan import is_plan, plan_name


def device_key(entry: ConfigEntry) -> str:
    """The identifier of the entry's device (see above)."""
    if is_plan(entry):
        return f"plan:{entry.entry_id}"
    if entry.data.get("type") == "external":
        return f"linked:{entry.data['entity_id']}"
    return f"list:{entry.entry_id}"


def entry_device_info(entry: ConfigEntry) -> DeviceInfo:
    """The device the entry's entities belong to."""
    if is_plan(entry):
        name, model = plan_name(entry), "Day plan"
    elif entry.data.get("type") == "external":
        name, model = entry.data.get("name", entry.title), "Linked list"
    else:
        name, model = entry.data.get("name", entry.title), "List"
    return DeviceInfo(
        identifiers={(DOMAIN, device_key(entry))},
        name=name,
        manufacturer="Home Tasks",
        model=model,
        entry_type=DeviceEntryType.SERVICE,
    )


@callback
def async_move_areas_to_service(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Once, when a list or plan becomes a service: its area goes there.

    Before, an entity could only be put in an area of its own. Under a
    service, Home Assistant names an entity with an area of its own without
    the service's name - in Assist the todo entity had no name left, a
    sensor "Open Tasks" like every other list's - and the todo entity, which
    has no name of its own, may not have an area of its own at all.

    The service takes the area of the todo entity, else the one most of the
    entities have; the entities with that area inherit it from then on. One
    with another area keeps its own.
    """
    ent_reg = er.async_get(hass)
    entities = er.async_entries_for_config_entry(ent_reg, entry.entry_id)
    areas = [e.area_id for e in entities if e.area_id]
    if not areas:
        return
    area = next((e.area_id for e in entities if e.domain == "todo" and e.area_id), None)
    area = area or Counter(areas).most_common(1)[0][0]
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get_or_create(config_entry_id=entry.entry_id, **entry_device_info(entry))
    if device.area_id is None:
        dev_reg.async_update_device(device.id, area_id=area)
    for e in entities:
        if e.area_id == area:
            ent_reg.async_update_entity(e.entity_id, area_id=None)
