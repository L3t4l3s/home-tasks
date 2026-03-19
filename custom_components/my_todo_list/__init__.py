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

CARD_URL = "/my_todo_list/my-todo-list-card.js"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the My ToDo List component."""
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up My ToDo List from a config entry."""
    store = MyToDoListStore(hass)
    await store.async_load()
    hass.data[DOMAIN] = store

    async_register_websocket_commands(hass)

    # Register the card JS file as a static path
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

    # Register the JS module so it loads on the frontend
    add_extra_js_url(hass, CARD_URL)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    hass.data.pop(DOMAIN, None)
    return True
