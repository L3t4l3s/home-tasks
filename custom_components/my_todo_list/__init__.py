"""The My ToDo List integration."""

import logging

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .store import MyToDoListStore
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["todo"]
CARD_URL = "/my_todo_list/my-todo-list-card.js"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the My ToDo List component."""
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up My ToDo List from a config entry."""
    store = MyToDoListStore(hass, entry.entry_id)
    await store.async_load()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = store

    # Register websocket commands (only once)
    if not hass.data.get(f"{DOMAIN}_ws_registered"):
        async_register_websocket_commands(hass)
        hass.data[f"{DOMAIN}_ws_registered"] = True

    # Register the card JS file (only once)
    if not hass.data.get(f"{DOMAIN}_card_registered"):
        await hass.http.async_register_static_paths(
            [
                StaticPathConfig(
                    CARD_URL,
                    hass.config.path(
                        f"custom_components/{DOMAIN}/www/my-todo-list-card.js"
                    ),
                    cache_headers=False,
                )
            ]
        )
        add_extra_js_url(hass, CARD_URL)
        hass.data[f"{DOMAIN}_card_registered"] = True

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
