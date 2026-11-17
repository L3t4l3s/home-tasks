"""Config flow for Home Tasks integration."""

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er, selector

from .const import DOMAIN, MAX_LIST_NAME_LENGTH, MAX_LISTS
from .plan import (
    CARRY_OVER_MODES,
    CONF_CARRY_OVER,
    CONF_INCLUDE_DUE,
    CONF_SOURCE_LISTS,
    CONF_WORKDAYS,
    DEFAULT_CARRY_OVER,
    ENTRY_TYPE_PLAN,
    WEEKDAYS,
    is_plan,
    plan_name,
)


class HomeTasksConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Home Tasks."""

    VERSION = 1
    # 2: each list and plan is a service; areas moved to it (device.py).
    MINOR_VERSION = 2

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return PlanOptionsFlow()

    @classmethod
    @callback
    def async_supports_options_flow(cls, config_entry) -> bool:
        """Only a plan has settings here; a list has them in the card."""
        return is_plan(config_entry)

    def _lists(self) -> list:
        """The entries that are lists - a plan is a view, not a list."""
        return [entry for entry in self._async_current_entries() if not is_plan(entry)]

    async def async_step_user(self, user_input=None):
        """Let the user choose between a native list, a linked one, or a plan."""
        return self.async_show_menu(
            step_id="user",
            menu_options=["native", "external", "plan"],
        )

    async def async_step_plan(self, user_input=None):
        """Create a day plan: a view across lists, with nothing in it yet."""
        errors = {}

        if user_input is not None:
            name = user_input["name"].strip()
            if not name:
                errors["name"] = "empty_name"
            elif len(name) > MAX_LIST_NAME_LENGTH:
                errors["name"] = "name_too_long"
            elif any(
                is_plan(entry) and plan_name(entry).lower() == name.lower()
                for entry in self._async_current_entries()
            ):
                errors["name"] = "duplicate_plan_name"

            if not errors:
                return self.async_create_entry(
                    title=name, data={"type": ENTRY_TYPE_PLAN, "name": name},
                )

        return self.async_show_form(
            step_id="plan",
            data_schema=vol.Schema({vol.Required("name"): str}),
            errors=errors,
        )

    async def async_step_native(self, user_input=None):
        """Handle creating a new native task list."""
        if len(self._lists()) >= MAX_LISTS:
            return self.async_abort(reason="max_lists_reached")
        errors = {}

        if user_input is not None:
            name = user_input["name"].strip()
            if not name:
                errors["name"] = "empty_name"
            elif len(name) > MAX_LIST_NAME_LENGTH:
                errors["name"] = "name_too_long"
            else:
                for entry in self._lists():
                    if entry.data.get("name", "").lower() == name.lower():
                        errors["name"] = "duplicate_name"
                        break

            if not errors:
                return self.async_create_entry(
                    title=name,
                    data={"name": name},
                )

        return self.async_show_form(
            step_id="native",
            data_schema=vol.Schema(
                {vol.Required("name"): str}
            ),
            errors=errors,
        )

    async def async_step_external(self, user_input=None):
        """Handle linking an external todo entity."""
        if len(self._lists()) >= MAX_LISTS:
            return self.async_abort(reason="max_lists_reached")
        errors = {}

        if user_input is not None:
            entity_id = user_input.get("entity_id", "").strip()
            if not entity_id:
                errors["entity_id"] = "empty_entity"
            else:
                # Check not already linked
                for entry in self._async_current_entries():
                    if entry.data.get("entity_id") == entity_id:
                        errors["entity_id"] = "already_linked"
                        break

            if not errors:
                # Derive a friendly name from the entity
                entity_reg = er.async_get(self.hass)
                entity_entry = entity_reg.async_get(entity_id)
                name = (
                    entity_entry.name
                    or entity_entry.original_name
                    or entity_id
                ) if entity_entry else entity_id

                # Auto-detect provider type
                from .provider_adapters import detect_provider_type  # noqa: WPS433

                provider_type = detect_provider_type(self.hass, entity_id)
                if provider_type == "generic":
                    title_suffix = "External"
                else:
                    title_suffix = provider_type.replace("_", " ").title()

                return self.async_create_entry(
                    title=f"{name} ({title_suffix})",
                    data={
                        "type": "external",
                        "entity_id": entity_id,
                        "name": name,
                        "provider_type": provider_type,
                    },
                )

        # Build list of available external todo entities
        entity_reg = er.async_get(self.hass)
        our_entries = {e.entry_id for e in self._async_current_entries()}
        already_linked = {
            e.data.get("entity_id")
            for e in self._async_current_entries()
            if e.data.get("type") == "external"
        }

        options = {}
        for entity_entry in entity_reg.entities.values():
            if entity_entry.domain != "todo":
                continue
            if entity_entry.config_entry_id in our_entries:
                continue
            if entity_entry.entity_id in already_linked:
                continue
            label = (
                entity_entry.name
                or entity_entry.original_name
                or entity_entry.entity_id
            )
            options[entity_entry.entity_id] = label

        if not options:
            return self.async_abort(reason="no_external_entities")

        return self.async_show_form(
            step_id="external",
            data_schema=vol.Schema(
                {vol.Required("entity_id"): vol.In(options)}
            ),
            errors=errors,
        )


class PlanOptionsFlow(config_entries.OptionsFlow):
    """The settings of a day plan."""

    async def async_step_init(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(data=user_input)

        options = self.config_entry.options
        lists = [
            selector.SelectOptionDict(value=entry.entry_id, label=plan_name(entry))
            for entry in self.hass.config_entries.async_entries(DOMAIN)
            if not is_plan(entry)
        ]
        known = {option["value"] for option in lists}
        chosen = list(options.get(CONF_SOURCE_LISTS) or [])
        # A chosen list that has been deleted still limits the plan - it does
        # not fall back to all lists behind the user's back. So it has to
        # show here as chosen too, until the user takes it out.
        lists += [
            selector.SelectOptionDict(value=entry_id, label="Deleted list")
            for entry_id in chosen if entry_id not in known
        ]
        schema = vol.Schema({
            # Nothing chosen means all lists, also those added later.
            vol.Optional(CONF_SOURCE_LISTS, default=chosen): selector.SelectSelector(
                selector.SelectSelectorConfig(options=lists, multiple=True)
            ),
            # Nothing chosen means every day.
            vol.Optional(
                CONF_WORKDAYS, default=list(options.get(CONF_WORKDAYS) or []),
            ): selector.SelectSelector(selector.SelectSelectorConfig(
                options=list(WEEKDAYS), multiple=True, translation_key="plan_workdays",
            )),
            vol.Required(
                CONF_INCLUDE_DUE, default=options.get(CONF_INCLUDE_DUE, True),
            ): selector.BooleanSelector(),
            vol.Required(
                CONF_CARRY_OVER, default=options.get(CONF_CARRY_OVER, DEFAULT_CARRY_OVER),
            ): selector.SelectSelector(selector.SelectSelectorConfig(
                options=list(CARRY_OVER_MODES), translation_key="plan_carry_over",
            )),
        })
        return self.async_show_form(step_id="init", data_schema=schema)
