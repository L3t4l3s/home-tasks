"""WebSocket commands of a day plan, for the card.

The card reads a plan together with what it needs to show it - the lists
it draws from, so that it can load their tasks and open a task's editor in
the task's own list - and writes it with the same operations the services
have.
"""

from __future__ import annotations

from datetime import date
import logging

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN
from .plan import (
    CONF_CARRY_OVER,
    CONF_SOURCE_LISTS,
    CONF_WORKDAYS,
    DEFAULT_CARRY_OVER,
    PLAN_HORIZON_DAYS,
    SET_MODES,
    WEEKDAYS,
    all_lists,
    async_plan_task,
    async_plan_view,
    async_set_day,
    async_unplan_task,
    async_untick,
    is_plan,
    plan_name,
    plan_store,
    plan_today_and_horizon,
    resolve_plan,
    source_lists,
    source_stamp,
)
from .plan_services import TASK_REF, task_ref

_LOGGER = logging.getLogger(__name__)

_ID = vol.All(str, vol.Length(min=1, max=255))
_DATE = vol.All(str, date.fromisoformat)


def _send_error(connection, msg_id, err: Exception) -> None:
    """A rule of the plan turned the call down, or something broke."""
    if isinstance(err, (HomeAssistantError, ValueError)):
        connection.send_error(msg_id, "invalid_request", str(err))
    else:
        _LOGGER.exception("Unexpected error in home_tasks")
        connection.send_error(msg_id, "unknown_error", "An internal error occurred")


def _plan_info(hass: HomeAssistant, entry: ConfigEntry, read=None) -> dict:
    """What the card needs to know about a plan besides its days.

    *read* are the plan's lists as a PlanView has just read them: then every
    list also gets the stamp of its tasks.
    """
    sources = [
        {
            "entry_id": src.entry_id,
            "name": src.name,
            "kind": "external" if src.entity_id else "native",
            # The card reads a linked list by its todo entity.
            "entity_id": src.entity_id,
            **({"stamp": source_stamp(src)} if read is not None else {}),
        }
        for src in (read if read is not None else source_lists(hass, entry))
    ]
    return {
        "id": entry.entry_id,
        "name": plan_name(entry),
        # The card watches this sensor to know when to read the plan again.
        "sensor_entity_id": er.async_get(hass).async_get_entity_id(
            "sensor", DOMAIN, f"{entry.entry_id}_plan_open_items"
        ),
        "carry_over": entry.options.get(CONF_CARRY_OVER, DEFAULT_CARRY_OVER),
        # The lists chosen in the plan's settings; none chosen means all.
        "source_lists": list(entry.options.get(CONF_SOURCE_LISTS) or []),
        # The weekdays the plan has (mon … sun); none chosen means all.
        "workdays": [d for d in WEEKDAYS if d in (entry.options.get(CONF_WORKDAYS) or [])],
        "sources": sources,
    }


@websocket_api.websocket_command({vol.Required("type"): "home_tasks/get_plans"})
@websocket_api.async_response
async def ws_get_plans(hass, connection, msg):
    """All plans with their lists - for the card editor and "Plan for…"."""
    try:
        plans = [
            _plan_info(hass, entry)
            for entry in hass.config_entries.async_entries(DOMAIN)
            if is_plan(entry) and plan_store(hass, entry.entry_id) is not None
        ]
        for info in plans:
            today, horizon = plan_today_and_horizon(hass.config_entries.async_get_entry(info["id"]))
            info["today"] = today.isoformat()
            info["horizon"] = [day.isoformat() for day in horizon]
        # Every list there is, for choosing a plan's lists in the card editor.
        lists = [
            {"entry_id": src.entry_id, "name": src.name, "kind": "external" if src.entity_id else "native"}
            for src in all_lists(hass)
        ]
        connection.send_result(msg["id"], {"plans": plans, "lists": lists})
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/get_plan",
    vol.Optional("plan"): _ID,
    vol.Optional("days", default=1): vol.All(int, vol.Range(min=1, max=PLAN_HORIZON_DAYS)),
})
@websocket_api.async_response
async def ws_get_plan(hass, connection, msg):
    """A plan from its current day on, with the lists it draws from."""
    try:
        entry, store = resolve_plan(hass, msg.get("plan"))
        view = await async_plan_view(hass, entry, store)
        connection.send_result(msg["id"], {
            **_plan_info(hass, entry, view.sources),
            "today": view.today.isoformat(),
            "current": view.current.isoformat(),
            "horizon": [day.isoformat() for day in view.horizon()],
            "days": view.days(view.current, msg["days"]),
        })
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/plan_task",
    vol.Optional("plan"): _ID,
    vol.Required("task_id"): _ID,
    vol.Optional("entry_id"): _ID,
    vol.Optional("date"): _DATE,
    vol.Optional("position", default="bottom"): vol.In(["top", "bottom"]),
})
@websocket_api.async_response
async def ws_plan_task(hass, connection, msg):
    """Put a task on a day, or move it there."""
    try:
        entry, store = resolve_plan(hass, msg.get("plan"))
        await async_plan_task(
            hass, entry, store, msg["task_id"], day=msg.get("date"),
            position=msg["position"], list_hint=msg.get("entry_id"), updated_by="user",
        )
        connection.send_result(msg["id"], {})
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/set_plan_day",
    vol.Optional("plan"): _ID,
    vol.Optional("date"): _DATE,
    # Only explicitly planned tasks count toward the day limit, checked by
    # async_set_day after resolving references; due rows may exceed it.
    vol.Optional("items"): [TASK_REF],
    vol.Optional("note"): vol.Any(None, str),
    vol.Optional("mode", default="merge"): vol.In(SET_MODES),
})
@websocket_api.async_response
async def ws_set_plan_day(hass, connection, msg):
    """Set a day's order (after a drag), its note, or both."""
    try:
        entry, store = resolve_plan(hass, msg.get("plan"))
        extra = {"note": msg["note"]} if "note" in msg else {}
        await async_set_day(
            hass, entry, store, [task_ref(item) for item in msg.get("items", [])],
            day=msg.get("date"), mode=msg["mode"], updated_by="user", **extra,
        )
        connection.send_result(msg["id"], {})
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/unplan_task",
    vol.Optional("plan"): _ID,
    vol.Required("task_id"): _ID,
    vol.Optional("entry_id"): _ID,
})
@websocket_api.async_response
async def ws_unplan_task(hass, connection, msg):
    """Take a task off the plan; the task stays as it is."""
    try:
        entry, store = resolve_plan(hass, msg.get("plan"))
        await async_unplan_task(hass, entry, store, msg["task_id"], list_hint=msg.get("entry_id"))
        connection.send_result(msg["id"], {})
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/untick_plan_task",
    vol.Optional("plan"): _ID,
    vol.Required("task_id"): _ID,
    vol.Optional("entry_id"): _ID,
})
@websocket_api.async_response
async def ws_untick_plan_task(hass, connection, msg):
    """Take back today's "done" of a row whose task is open again."""
    try:
        entry, store = resolve_plan(hass, msg.get("plan"))
        await async_untick(hass, entry, store, msg["task_id"], list_hint=msg.get("entry_id"))
        connection.send_result(msg["id"], {})
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/set_plan_lists",
    vol.Optional("plan"): _ID,
    vol.Required("source_lists"): [_ID],
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_plan_lists(hass, connection, msg):
    """Choose the lists a plan draws from - the plan's own setting, offered
    in the card editor as well. An empty choice means all lists.

    Which lists a plan reaches is also what its LLM tools reach, so this is
    for administrators, as the settings dialog is.
    """
    try:
        entry, _store = resolve_plan(hass, msg.get("plan"))
        known = {
            other.entry_id for other in hass.config_entries.async_entries(DOMAIN) if not is_plan(other)
        }
        # A list that was chosen and has been deleted may stay in the choice:
        # it keeps limiting the plan until somebody takes it out on purpose.
        known |= set(entry.options.get(CONF_SOURCE_LISTS) or [])
        unknown = [entry_id for entry_id in msg["source_lists"] if entry_id not in known]
        if unknown:
            raise ValueError(f"No list with entry id: {', '.join(unknown)}")
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, CONF_SOURCE_LISTS: list(dict.fromkeys(msg["source_lists"]))},
        )
        connection.send_result(msg["id"], _plan_info(hass, entry))
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


@websocket_api.websocket_command({
    vol.Required("type"): "home_tasks/set_plan_workdays",
    vol.Optional("plan"): _ID,
    vol.Required("workdays"): [vol.In(WEEKDAYS)],
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_set_plan_workdays(hass, connection, msg):
    """Choose the weekdays a plan has - the plan's own setting, offered in
    the card editor as one chip per weekday. None chosen means every day, and so
    does all seven.

    It moves what every card and every assistant reads as the plan's days,
    so it is for administrators, as the settings dialog is.
    """
    try:
        entry, _store = resolve_plan(hass, msg.get("plan"))
        chosen = [d for d in WEEKDAYS if d in msg["workdays"]]
        if len(chosen) == len(WEEKDAYS):
            chosen = []
        hass.config_entries.async_update_entry(entry, options={**entry.options, CONF_WORKDAYS: chosen})
        connection.send_result(msg["id"], _plan_info(hass, entry))
    except Exception as err:  # noqa: BLE001
        _send_error(connection, msg["id"], err)


def async_register_plan_websocket_commands(hass: HomeAssistant) -> None:
    for command in (
        ws_get_plans, ws_get_plan, ws_plan_task, ws_set_plan_day, ws_unplan_task, ws_set_plan_lists,
        ws_set_plan_workdays, ws_untick_plan_task,
    ):
        websocket_api.async_register_command(hass, command)
