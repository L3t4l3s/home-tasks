"""The services of a day plan: read it, set a day, put a task on or take it off."""

from __future__ import annotations

from datetime import date

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .plan import (
    PLAN_HORIZON_DAYS,
    SET_MODES,
    PlanView,
    async_plan_task,
    async_set_day,
    async_unplan_task,
    plan_name,
    resolve_plan,
)

# A task on a plan: its id, or the id with the list it is in. The list is
# only a hint - ids are looked up across the plan's lists.
TASK_REF = vol.Any(
    cv.string,
    vol.Schema({vol.Required("task_id"): cv.string, vol.Optional("entry_id"): cv.string}),
)


def task_ref(value) -> tuple[str, str | None]:
    """``(task id, list hint)`` of a reference as TASK_REF lets it through."""
    if isinstance(value, dict):
        return value["task_id"], value.get("entry_id")
    return value, None


def async_register_plan_services(hass: HomeAssistant) -> None:
    """Register the plan services (once, with the other services)."""

    async def async_handle_get_day_plan(call: ServiceCall) -> ServiceResponse:
        entry, store = resolve_plan(hass, call.data.get("plan"))
        view = PlanView(hass, entry, store)
        start: date = call.data.get("date") or view.current
        return {
            "plan": plan_name(entry),
            "entry_id": entry.entry_id,
            "days": view.days(start, call.data["days"]),
        }

    async def async_handle_set_day_plan(call: ServiceCall) -> None:
        entry, store = resolve_plan(hass, call.data.get("plan"))
        extra = {"note": call.data["note"]} if "note" in call.data else {}
        await async_set_day(
            hass, entry, store, [task_ref(item) for item in call.data["items"]],
            day=call.data.get("date"), mode=call.data["mode"], **extra,
        )

    async def async_handle_plan_task(call: ServiceCall) -> None:
        entry, store = resolve_plan(hass, call.data.get("plan"))
        await async_plan_task(
            hass, entry, store, call.data["task_id"],
            day=call.data.get("date"), position=call.data["position"],
            list_hint=call.data.get("entry_id"),
        )

    async def async_handle_unplan_task(call: ServiceCall) -> None:
        entry, store = resolve_plan(hass, call.data.get("plan"))
        await async_unplan_task(
            hass, entry, store, call.data["task_id"], list_hint=call.data.get("entry_id"),
        )

    hass.services.async_register(
        DOMAIN, "get_day_plan", async_handle_get_day_plan,
        schema=vol.Schema({
            vol.Optional("plan"): cv.string,
            vol.Optional("date"): cv.date,
            vol.Optional("days", default=1): vol.All(
                vol.Coerce(int), vol.Range(min=1, max=PLAN_HORIZON_DAYS)
            ),
        }),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN, "set_day_plan", async_handle_set_day_plan,
        schema=vol.Schema({
            vol.Optional("plan"): cv.string,
            vol.Optional("date"): cv.date,
            # Resolve first: automatic due rows do not use up planned slots.
            vol.Required("items"): vol.All(cv.ensure_list, [TASK_REF]),
            vol.Optional("note"): vol.Any(None, cv.string),
            vol.Optional("mode", default="merge"): vol.In(SET_MODES),
        }),
    )
    hass.services.async_register(
        DOMAIN, "plan_task", async_handle_plan_task,
        schema=vol.Schema({
            vol.Optional("plan"): cv.string,
            vol.Required("task_id"): cv.string,
            vol.Optional("entry_id"): cv.string,
            vol.Optional("date"): cv.date,
            vol.Optional("position", default="bottom"): vol.In(["top", "bottom"]),
        }),
    )
    hass.services.async_register(
        DOMAIN, "unplan_task", async_handle_unplan_task,
        schema=vol.Schema({
            vol.Optional("plan"): cv.string,
            vol.Required("task_id"): cv.string,
            vol.Optional("entry_id"): cv.string,
        }),
    )


__all__ = ["async_register_plan_services", "ServiceValidationError"]
