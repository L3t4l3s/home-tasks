"""Sensor platform for Home Tasks integration."""

from datetime import datetime, timezone
import logging

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_change

from homeassistant.util import dt as dt_util

from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN
from .external_view import (
    async_subscribe_external,
    get_external_tasks_snapshot,
    provider_available,
)
from .overlay_store import ExternalTaskOverlayStore
from .plan import (
    CONF_SOURCE_LISTS,
    SIGNAL_LISTS_CHANGED,
    PlanStore,
    PlanView,
    is_plan,
    plan_fingerprint,
    plan_name,
    plan_store,
)
from .store import HomeTasksStore

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up sensor entities from a config entry (native, external or plan)."""
    if is_plan(entry):
        async_add_entities([PlanOpenItemsSensor(hass, entry, plan_store(hass, entry.entry_id))])
        return
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
        return provider_available(self.hass, self._source_entity_id)

    def _get_tasks(self) -> list[dict]:
        return get_external_tasks_snapshot(self.hass, self._source_entity_id)

    async def async_added_to_hass(self) -> None:
        """Refresh when the overlay changes or the source entity updates."""
        await super().async_added_to_hass()
        for unsub in async_subscribe_external(
            self.hass, self._source_entity_id, self._handle_store_update
        ):
            self.async_on_remove(unsub)


class PlanOpenItemsSensor(SensorEntity):
    """How many tasks on a day plan are still open today.

    The card watches this entity to refresh, as it watches a list's sensor:
    its state object changes whenever the plan reads differently, also when
    the count happens to stay the same - and only then. A plan can draw from
    many linked lists, each of which reports in every few minutes with
    nothing new; none of that may reach the card as a change.
    """

    _attr_has_entity_name = True
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "tasks"
    _attr_icon = "mdi:calendar-check"

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
        self.hass = hass
        self._entry = entry
        self._store = store
        self._attr_name = f"{plan_name(entry)} Open Items"
        self._attr_unique_id = f"{entry.entry_id}_plan_open_items"
        self._last_modified = datetime.now(timezone.utc).isoformat()
        self._source_unsubs: list = []
        # entry id -> identity of the store that is listened to
        self._sources: dict[str, int] = {}
        self._day: dict | None = None
        self._fingerprint: str | None = None

    def _read(self) -> bool:
        """Resolve the plan. False when it reads exactly as it did before."""
        view = PlanView(self.hass, self._entry, self._store)
        fingerprint = plan_fingerprint(view)
        if self._day is not None and fingerprint == self._fingerprint:
            return False
        self._fingerprint = fingerprint
        self._day = view.day(view.current)
        return True

    def _today(self) -> dict:
        """The current day, resolved once per change.

        State and attributes are read one after the other for every state
        write, and resolving a day indexes every task of every list.
        """
        if self._day is None:
            self._read()
        return self._day

    @property
    def native_value(self) -> int:
        return len([row for row in self._today()["items"] if not row["completed"]])

    @property
    def extra_state_attributes(self) -> dict:
        day = self._today()
        done = len([row for row in day["items"] if row["completed"]])
        return {
            "date": day["date"],
            "done": done,
            "total": len(day["items"]),
            "note": day["note"],
            "last_modified": self._last_modified,
        }

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self._store.async_add_listener(self._handle_plan_update))
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_LISTS_CHANGED, self._handle_plan_update)
        )
        # What is due, overdue and "today" all turn over at midnight.
        self.async_on_remove(
            async_track_time_change(self.hass, self._handle_midnight, hour=0, minute=0, second=0)
        )
        self.async_on_remove(self._unsubscribe_sources)
        self._subscribe_sources()

    @callback
    def _unsubscribe_sources(self) -> None:
        for unsub in self._source_unsubs:
            unsub()
        self._source_unsubs = []
        self._sources = {}

    @callback
    def _subscribe_sources(self) -> None:
        """Follow every list the plan draws from."""
        wanted = set(self._entry.options.get(CONF_SOURCE_LISTS) or [])
        stores = {
            entry_id: store for entry_id, store in self.hass.data.get(DOMAIN, {}).items()
            if (not wanted or entry_id in wanted)
            and isinstance(store, (HomeTasksStore, ExternalTaskOverlayStore))
        }
        sources = {entry_id: id(store) for entry_id, store in stores.items()}
        if sources == self._sources:
            return  # the same lists as before - which is every save of the plan
        self._unsubscribe_sources()
        self._sources = sources
        for store in stores.values():
            if isinstance(store, HomeTasksStore):
                self._source_unsubs.append(store.async_add_listener(self._handle_update))
            else:
                self._source_unsubs.extend(
                    async_subscribe_external(self.hass, store.entity_id, self._handle_update)
                )

    @callback
    def _handle_midnight(self, _now) -> None:
        if self._read():
            self.async_write_ha_state()

    @callback
    def _handle_update(self) -> None:
        if not self._read():
            return  # reported, but nothing new
        self._last_modified = datetime.now(timezone.utc).isoformat()
        self.async_write_ha_state()

    @callback
    def _handle_plan_update(self) -> None:
        """The plan or its settings changed, or a list came or went."""
        self._subscribe_sources()
        self._handle_update()
