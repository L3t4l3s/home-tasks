"""Binary sensor platform for Home Tasks integration."""


import logging

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_change

from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .external_view import async_subscribe_external, get_external_tasks_snapshot

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up binary sensor entities from a config entry (native or external)."""
    if entry.data.get("type") == "external":
        entity_id = entry.data.get("entity_id")
        if entity_id:
            async_add_entities([ExternalOverdueBinarySensor(hass, entry, entity_id)])
        return
    store = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HomeTasksOverdueBinarySensor(entry, store)])


class _BaseOverdueBinarySensor(BinarySensorEntity):
    """ON when the list has overdue tasks; subclasses provide the task list."""

    _attr_has_entity_name = True
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_icon = "mdi:clock-alert"

    def __init__(self, entry: ConfigEntry) -> None:
        list_name = entry.data.get("name", entry.title)
        self._attr_name = f"{list_name} Overdue"
        self._attr_unique_id = f"{entry.entry_id}_overdue"

    def _get_tasks(self) -> list[dict]:
        raise NotImplementedError

    def _overdue(self) -> list[dict]:
        today = dt_util.now().date().isoformat()
        return [
            t for t in self._get_tasks()
            if not t.get("completed") and t.get("due_date") and t["due_date"] < today
        ]

    @property
    def is_on(self) -> bool:
        """Return true if there are overdue tasks."""
        return bool(self._overdue())

    @property
    def extra_state_attributes(self) -> dict:
        """Return overdue task details."""
        overdue = self._overdue()
        return {
            "overdue_tasks": [
                {"title": t["title"], "due_date": t["due_date"], "assigned_person": t.get("assigned_person")}
                for t in overdue
            ],
            "overdue_count": len(overdue),
        }

    async def async_added_to_hass(self) -> None:
        """A task due yesterday becomes overdue at midnight, not on the next edit."""
        self.async_on_remove(
            async_track_time_change(self.hass, self._handle_midnight, hour=0, minute=0, second=0)
        )

    @callback
    def _handle_midnight(self, _now) -> None:
        self.async_write_ha_state()

    @callback
    def _handle_store_update(self) -> None:
        """React to store data changes."""
        self.async_write_ha_state()


class HomeTasksOverdueBinarySensor(_BaseOverdueBinarySensor):
    """Binary sensor that is ON when a native list has overdue tasks."""

    def __init__(self, entry: ConfigEntry, store) -> None:
        """Initialize the binary sensor."""
        super().__init__(entry)
        self._store = store

    def _get_tasks(self) -> list[dict]:
        return list(self._store.tasks)

    async def async_added_to_hass(self) -> None:
        """Register store listener."""
        await super().async_added_to_hass()
        self.async_on_remove(
            self._store.async_add_listener(self._handle_store_update)
        )


class ExternalOverdueBinarySensor(_BaseOverdueBinarySensor):
    """Binary sensor that is ON when a linked external list has overdue tasks."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, entity_id: str) -> None:
        """Initialize the binary sensor."""
        super().__init__(entry)
        self.hass = hass
        self._source_entity_id = entity_id

    @property
    def available(self) -> bool:
        """Unavailable while the provider's entity is not there to read."""
        return self.hass.states.get(self._source_entity_id) is not None

    def _get_tasks(self) -> list[dict]:
        return get_external_tasks_snapshot(self.hass, self._source_entity_id)

    async def async_added_to_hass(self) -> None:
        """Refresh when the overlay changes or the source entity updates."""
        await super().async_added_to_hass()
        for unsub in async_subscribe_external(
            self.hass, self._source_entity_id, self._handle_store_update
        ):
            self.async_on_remove(unsub)
