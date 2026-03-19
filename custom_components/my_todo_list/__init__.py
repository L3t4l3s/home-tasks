"""The My ToDo List integration."""

import logging

from homeassistant.components.frontend import async_register_built_in_panel
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

    # Register as a Lovelace resource
    await _async_register_lovelace_resource(hass)

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    hass.data.pop(DOMAIN, None)
    return True


async def _async_register_lovelace_resource(hass: HomeAssistant) -> None:
    """Register the card as a Lovelace resource."""
    # Use the lovelace resources collection if available
    try:
        resources = hass.data.get("lovelace", {})
        if hasattr(resources, "resources"):
            # Check if already registered
            for resource in resources.resources.async_items():
                if resource.get("url", "") == CARD_URL:
                    return
            await resources.resources.async_create_item(
                {"res_type": "module", "url": CARD_URL}
            )
            return
    except Exception:  # noqa: BLE001
        pass

    # Fallback: log instruction for manual registration
    _LOGGER.info(
        "Please add the following to your Lovelace resources: "
        "URL: %s, Type: JavaScript Module",
        CARD_URL,
    )
