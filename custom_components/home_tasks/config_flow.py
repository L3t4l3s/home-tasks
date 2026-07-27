"""Config flow for Home Tasks integration."""

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from .const import DOMAIN, MAX_LIST_NAME_LENGTH, MAX_LISTS

OPTION_RECURRING_ADVANCES = "recurring_complete_advances"

# --- Todo-list filter options (native lists only) ---
OPTION_FILTER_ASSIGNEES = "todo_filter_assignees"
OPTION_INCLUDE_UNASSIGNED = "todo_filter_include_unassigned"
OPTION_TAG_MODE = "todo_filter_tag_mode"
OPTION_FILTER_TAGS = "todo_filter_tags"

TAG_MODE_OFF = "off"
TAG_MODE_EXCLUDE = "exclude"
TAG_MODE_INCLUDE = "include"

# --- Todo-list sort option (native lists only) ---
OPTION_TODO_SORT = "todo_sort"
SORT_MANUAL = "manual"
SORT_DUE = "due"
SORT_PRIORITY = "priority"
SORT_TITLE = "title"
SORT_PERSON = "person"


def recurring_advances_on_complete(entry) -> bool:
    """Read the "advance on complete" option for a config entry (default False)."""
    if entry is None:
        return False
    return bool(entry.options.get(OPTION_RECURRING_ADVANCES, False))


class HomeTasksOptionsFlow(config_entries.OptionsFlow):
    """Per-list options (e.g. recurring-task advance-on-complete behavior)."""

    async def async_step_init(self, user_input=None):
        """Manage list-level options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        entry = self.config_entry
        opts = entry.options
        is_external = entry.data.get("type") == "external"

        schema = {
            vol.Optional(
                OPTION_RECURRING_ADVANCES,
                default=bool(opts.get(OPTION_RECURRING_ADVANCES, False)),
            ): bool,
        }

        if not is_external:
            # Collect available assignees and tags from the store so the
            # selectors show only values that actually exist in the list.
            store = self.hass.data.get(DOMAIN, {}).get(entry.entry_id)
            tasks = getattr(store, "tasks", []) or []
            assignees = sorted(
                {t["assigned_person"] for t in tasks if t.get("assigned_person")}
            )
            tags = sorted(
                {tag for t in tasks for tag in t.get("tags", [])}
            )

            schema[vol.Optional(
                OPTION_FILTER_ASSIGNEES,
                default=opts.get(OPTION_FILTER_ASSIGNEES, []),
            )] = SelectSelector(
                SelectSelectorConfig(
                    options=assignees,
                    multiple=True,
                    custom_value=True,
                )
            )
            schema[vol.Optional(
                OPTION_INCLUDE_UNASSIGNED,
                default=bool(opts.get(OPTION_INCLUDE_UNASSIGNED, True)),
            )] = bool
            schema[vol.Optional(
                OPTION_TAG_MODE,
                default=opts.get(OPTION_TAG_MODE, TAG_MODE_OFF),
            )] = SelectSelector(
                SelectSelectorConfig(
                    options=[TAG_MODE_OFF, TAG_MODE_EXCLUDE, TAG_MODE_INCLUDE],
                    mode=SelectSelectorMode.DROPDOWN,
                )
            )
            schema[vol.Optional(
                OPTION_FILTER_TAGS,
                default=opts.get(OPTION_FILTER_TAGS, []),
            )] = SelectSelector(
                SelectSelectorConfig(
                    options=tags,
                    multiple=True,
                    custom_value=True,
                )
            )
            schema[vol.Optional(
                OPTION_TODO_SORT,
                default=opts.get(OPTION_TODO_SORT, SORT_MANUAL),
            )] = SelectSelector(
                SelectSelectorConfig(
                    options=[
                        SORT_MANUAL, SORT_DUE, SORT_PRIORITY,
                        SORT_TITLE, SORT_PERSON,
                    ],
                    mode=SelectSelectorMode.DROPDOWN,
                )
            )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(schema),
        )


class HomeTasksConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Home Tasks."""

    VERSION = 1

    @staticmethod
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> HomeTasksOptionsFlow:
        """Return the options flow handler."""
        return HomeTasksOptionsFlow()

    async def async_step_user(self, user_input=None):
        """Let the user choose between creating a native list or linking an external one."""
        if len(self._async_current_entries()) >= MAX_LISTS:
            return self.async_abort(reason="max_lists_reached")
        return self.async_show_menu(
            step_id="user",
            menu_options=["native", "external"],
        )

    async def async_step_native(self, user_input=None):
        """Handle creating a new native task list."""
        errors = {}

        if user_input is not None:
            name = user_input["name"].strip()
            if not name:
                errors["name"] = "empty_name"
            elif len(name) > MAX_LIST_NAME_LENGTH:
                errors["name"] = "name_too_long"
            else:
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
            step_id="native",
            data_schema=vol.Schema(
                {vol.Required("name"): str}
            ),
            errors=errors,
        )

    async def async_step_external(self, user_input=None):
        """Handle linking an external todo entity."""
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
