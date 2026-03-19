"""Config flow for My ToDo List integration."""

import voluptuous as vol

from homeassistant import config_entries

from .const import DOMAIN, MAX_LIST_NAME_LENGTH


class MyToDoListConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for My ToDo List."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        """Handle the initial step - ask for list name."""
        errors = {}

        if user_input is not None:
            name = user_input["name"].strip()
            if not name:
                errors["name"] = "empty_name"
            elif len(name) > MAX_LIST_NAME_LENGTH:
                errors["name"] = "name_too_long"
            else:
                # Check for duplicate names
                for entry in self._async_current_entries():
                    if entry.data.get("name", "").lower() == name.lower():
                        errors["name"] = "duplicate_name"
                        break

            if not errors:
                return self.async_create_entry(
                    title=name,
                    data={"name": name},
                )

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {vol.Required("name"): str}
            ),
            errors=errors,
        )
