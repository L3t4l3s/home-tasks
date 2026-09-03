"""Sensor platform for Home Tasks integration."""

from datetime import datetime, timezone
import logging

from homeassistant.components.sensor import SensorEntity, SensorStateClass
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
    """Set up sensor entities from a config entry (native or external)."""
    if entry.data.get("type") == "external":
        entity_id = entry.data.get("entity_id")
        if entity_id:
            async_add_entities([ExternalOpenTasksSensor(hass, entry, entity_id)])
        return
    store = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([HomeTasksOpenTasksSensor(entry, store)])


class _BaseOpenTasksSensor(SensorEntity):
    """Number of open tasks in a list; subclasses provide the task list."""

    _attr_has_entity_name = True
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:clipboard-list"

    def __init__(self, entry: ConfigEntry) -> None:
        list_name = entry.data.get("name", entry.title)
        self._attr_name = f"{list_name} Open Tasks"
        self._attr_unique_id = f"{entry.entry_id}_open_tasks"
        self._last_modified = datetime.now(timezone.utc).isoformat()

    def _get_tasks(self) -> list[dict]:
        raise NotImplementedError

    @property
    def native_value(self) -> int:
        """Return number of open tasks."""
        return len([t for t in self._get_tasks() if not t.get("completed")])

    @property
    def extra_state_attributes(self) -> dict:
        """Return additional attributes."""
        today = dt_util.now().date().isoformat()
        tasks = self._get_tasks()
        open_tasks = [t for t in tasks if not t.get("completed")]
        overdue = [t for t in open_tasks if t.get("due_date") and t["due_date"] < today]
        return {
            "open_task_titles": [t["title"] for t in open_tasks],
            "overdue_count": len(overdue),
            "total_tasks": len(tasks),
            "last_modified": self._last_modified,
        }

    async def async_added_to_hass(self) -> None:
        """overdue_count depends on the date, so recount when the day rolls over."""
        self.async_on_remove(
            async_track_time_change(self.hass, self._handle_midnight, hour=0, minute=0, second=0)
        )

    @callback
    def _handle_midnight(self, _now) -> None:
        self.async_write_ha_state()

    @callback
    def _handle_store_update(self) -> None:
        """React to store data changes."""
        self._last_modified = datetime.now(timezone.utc).isoformat()
        self.async_write_ha_state()


class HomeTasksOpenTasksSensor(_BaseOpenTasksSensor):
    """Sensor that reports the number of open tasks in a native list."""

    def __init__(self, entry: ConfigEntry, store) -> None:
        """Initialize the sensor."""
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


class ExternalOpenTasksSensor(_BaseOpenTasksSensor):
    """Sensor that reports the number of open tasks in a linked external list."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, entity_id: str) -> None:
        """Initialize the sensor."""
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
