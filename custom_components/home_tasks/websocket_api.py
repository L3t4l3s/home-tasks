"""WebSocket API for Home Tasks - extended features (sub-tasks, reorder, external)."""

import logging
import time

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, MAX_IMAGE_URL_LENGTH, MAX_REORDER_IDS, MAX_RECURRENCE_VALUE, MAX_REMINDER_OFFSET_MINUTES, MAX_REMINDERS_PER_TASK, MAX_SUB_TASKS_PER_TASK, MAX_TAGS_PER_TASK, MAX_TITLE_LENGTH, VALID_RECURRENCE_UNITS
from .overlay_store import ExternalTaskOverlayStore, OVERLAY_FIELDS
from .provider_adapters import ProviderAdapter, GenericAdapter, _get_external_todo_items

_LOGGER = logging.getLogger(__name__)

_val_title = vol.All(str, vol.Length(min=1, max=MAX_TITLE_LENGTH))
_val_id = vol.All(str, vol.Length(min=1, max=40))
_val_entity_id = vol.All(str, vol.Length(min=1, max=255))
_val_task_uid = vol.All(str, vol.Length(min=1, max=255))
_val_date = vol.Any(vol.All(str, vol.Match(r"^\d{4}-\d{2}-\d{2}$")), None)
_val_time = vol.Any(vol.All(str, vol.Match(r"^\d{2}:\d{2}$")), None)
# Anniversary is "MM-DD" — month 01–12, day 01–31.  The deeper calendar
# check (e.g. rejecting 02-30) lives in store.py's validate_recurrence_anniversary;
# this regex just keeps obvious garbage out of the WS layer.
_val_anniversary = vol.Any(
    vol.All(str, vol.Match(r"^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")),
    None,
)


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register WebSocket commands."""
    # Native list commands
    websocket_api.async_register_command(hass, ws_get_lists)
    websocket_api.async_register_command(hass, ws_get_tasks)
    websocket_api.async_register_command(hass, ws_add_task)
    websocket_api.async_register_command(hass, ws_update_task)
    websocket_api.async_register_command(hass, ws_delete_task)
    websocket_api.async_register_command(hass, ws_duplicate_task)
    websocket_api.async_register_command(hass, ws_reorder_tasks)
    websocket_api.async_register_command(hass, ws_add_sub_task)
    websocket_api.async_register_command(hass, ws_update_sub_task)
    websocket_api.async_register_command(hass, ws_delete_sub_task)
    websocket_api.async_register_command(hass, ws_reorder_sub_tasks)
    websocket_api.async_register_command(hass, ws_move_task)
    websocket_api.async_register_command(hass, ws_move_task_cross)
    # External list commands
    websocket_api.async_register_command(hass, ws_get_external_lists)
    websocket_api.async_register_command(hass, ws_get_external_tasks)
    websocket_api.async_register_command(hass, ws_update_external_overlay)
    websocket_api.async_register_command(hass, ws_add_external_sub_task)
    websocket_api.async_register_command(hass, ws_update_external_sub_task)
    websocket_api.async_register_command(hass, ws_delete_external_sub_task)
    websocket_api.async_register_command(hass, ws_reorder_external_sub_tasks)
    websocket_api.async_register_command(hass, ws_delete_external_overlay)
    # Adapter-routed external commands
    websocket_api.async_register_command(hass, ws_create_external_task)
    websocket_api.async_register_command(hass, ws_update_external_task)
    websocket_api.async_register_command(hass, ws_reorder_external_tasks)
    # Section commands (work for both native and external lists)
    websocket_api.async_register_command(hass, ws_get_sections)
    websocket_api.async_register_command(hass, ws_add_section)
    websocket_api.async_register_command(hass, ws_update_section)
    websocket_api.async_register_command(hass, ws_delete_section)
    websocket_api.async_register_command(hass, ws_reorder_sections)
    # Image generation
    websocket_api.async_register_command(hass, ws_generate_task_image)


def _get_store(hass, entry_id):
    """Get native HomeTasksStore for a config entry."""
    from .store import HomeTasksStore

    stores = hass.data.get(DOMAIN, {})
    store = stores.get(entry_id)
    if store is None:
        raise ValueError("List not found")
    if not isinstance(store, HomeTasksStore):
        raise ValueError("This command is not supported for external lists")
    return store


def _handle_error(connection, msg_id, err):
    """Send error without leaking internals."""
    if isinstance(err, ValueError):
        connection.send_error(msg_id, "invalid_request", str(err))
    else:
        _LOGGER.exception("Unexpected error in home_tasks")
        connection.send_error(msg_id, "unknown_error", "An internal error occurred")


# --- List overview (returns config entries as lists) ---


@websocket_api.websocket_command({vol.Required("type"): "home_tasks/get_lists"})
@websocket_api.async_response
async def ws_get_lists(hass, connection, msg):
    """Get all lists (native config entries only)."""
    try:
        from .store import HomeTasksStore
        from homeassistant.helpers import entity_registry as er

        stores = hass.data.get(DOMAIN, {})
        entries = hass.config_entries.async_entries(DOMAIN)
        entity_reg = er.async_get(hass)
        lists = []
        for entry in entries:
            if entry.data.get("type") == "external":
                continue  # external lists handled by ws_get_external_lists
            store = stores.get(entry.entry_id)
            # Resolve the sensor entity ID so the frontend can subscribe to
            # state-changed events for real-time cross-device updates.
            sensor_unique_id = f"{entry.entry_id}_open_tasks"
            sensor_entity_id = entity_reg.async_get_entity_id("sensor", DOMAIN, sensor_unique_id)
            lists.append({
                "id": entry.entry_id,
                "name": entry.data.get("name", entry.title),
                "task_count": len(store.tasks) if store and isinstance(store, HomeTasksStore) else 0,
                "sensor_entity_id": sensor_entity_id,
            })
        connection.send_result(msg["id"], {"lists": lists})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# --- Task commands (list_id = entry_id) ---


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/get_tasks",
        vol.Required("list_id"): _val_id,
    }
)
@websocket_api.async_response
async def ws_get_tasks(hass, connection, msg):
    """Get all tasks for a list."""
    try:
        store = _get_store(hass, msg["list_id"])
        connection.send_result(msg["id"], {"tasks": store.tasks, "sections": store.sections})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/add_task",
        vol.Required("list_id"): _val_id,
        vol.Required("title"): _val_title,
        vol.Optional("assigned_person"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_add_task(hass, connection, msg):
    """Add a task."""
    try:
        store = _get_store(hass, msg["list_id"])
        actor = connection.user.name if connection.user else None
        task = await store.async_add_task(
            msg["title"],
            actor=actor,
            assigned_person=msg.get("assigned_person"),
        )
        connection.send_result(msg["id"], task)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Optional("title"): _val_title,
        vol.Optional("completed"): bool,
        vol.Optional("notes"): vol.All(str, vol.Length(max=5000)),
        vol.Optional("due_date"): _val_date,
        vol.Optional("due_time"): _val_time,
        vol.Optional("reminders"): vol.All(
            list,
            vol.Length(max=MAX_REMINDERS_PER_TASK),
            [vol.All(int, vol.Range(min=0, max=MAX_REMINDER_OFFSET_MINUTES))],
        ),
        vol.Optional("priority"): vol.Any(vol.In([1, 2, 3]), None),
        vol.Optional("recurrence_value"): vol.All(int, vol.Range(min=1, max=MAX_RECURRENCE_VALUE)),
        vol.Optional("recurrence_unit"): vol.Any(vol.In(list(VALID_RECURRENCE_UNITS)), None),
        vol.Optional("recurrence_enabled"): bool,
        vol.Optional("recurrence_type"): vol.In(["interval", "weekdays"]),
        vol.Optional("recurrence_weekdays"): vol.All(list, [vol.All(int, vol.Range(min=0, max=6))]),
        vol.Optional("recurrence_start_date"): _val_date,
        vol.Optional("recurrence_time"): _val_time,
        vol.Optional("recurrence_end_type"): vol.In(["none", "date", "count"]),
        vol.Optional("recurrence_end_date"): _val_date,
        vol.Optional("recurrence_max_count"): vol.Any(vol.All(int, vol.Range(min=1)), None),
        vol.Optional("recurrence_remaining_count"): vol.Any(vol.All(int, vol.Range(min=0)), None),
        vol.Optional("recurrence_month_pattern"): vol.Any(vol.In(["day_of_month", "nth_weekday"]), None),
        vol.Optional("recurrence_day_of_month"): vol.Any(vol.All(int, vol.Range(min=1, max=31)), "last", None),
        vol.Optional("recurrence_nth_week"): vol.Any(vol.All(int, vol.Range(min=1, max=4)), "last", None),
        vol.Optional("recurrence_anniversary"): _val_anniversary,
        vol.Optional("assigned_person"): vol.Any(str, None),
        vol.Optional("tags"): vol.All(list, vol.Length(max=MAX_TAGS_PER_TASK)),
        vol.Optional("section_id"): vol.Any(_val_id, None),
        vol.Optional("image_url"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_update_task(hass, connection, msg):
    """Update a task."""
    try:
        store = _get_store(hass, msg["list_id"])
        actor = connection.user.name if connection.user else None
        kwargs = {}
        for key in (
            "title", "completed", "notes", "due_date", "due_time", "reminders", "priority",
            "recurrence_value", "recurrence_unit", "recurrence_enabled", "recurrence_type",
            "recurrence_weekdays", "recurrence_start_date", "recurrence_time",
            "recurrence_end_type", "recurrence_end_date", "recurrence_max_count",
            "recurrence_remaining_count", "recurrence_month_pattern",
            "recurrence_day_of_month", "recurrence_nth_week", "recurrence_anniversary",
            "assigned_person", "tags", "section_id", "image_url",
        ):
            if key in msg:
                kwargs[key] = msg[key]
        # Re-publish a newly set image into our public www dir so the card can
        # load it without auth and it doesn't expire when the issuing token is
        # removed. media-source:// URIs are copied off disk; internal signed
        # paths are downloaded. /local/home_tasks/ URLs are already public.
        iu = kwargs.get("image_url")
        if iu and len(iu) > MAX_IMAGE_URL_LENGTH:
            # Reject over-length URLs before doing any download/copy I/O (the
            # store validates the final /local URL, which is always short, so the
            # cap would otherwise be bypassed for the original input).
            raise ValueError(f"image_url must be at most {MAX_IMAGE_URL_LENGTH} characters")
        # Remember the previous image so we can reclaim it if it changes/clears.
        old_image_url = None
        if "image_url" in kwargs:
            try:
                old_image_url = store.get_task(msg["task_id"]).get("image_url")
            except Exception:  # noqa: BLE001
                old_image_url = None
        if iu and (
            iu.startswith("media-source://")
            or (iu.startswith("/") and not iu.split("?")[0].startswith("/local/home_tasks/"))
        ):
            import hashlib
            import os
            clean = iu.split("?")[0]
            ext = os.path.splitext(clean)[1] or ".png"
            fn = f"{hashlib.sha1(clean.encode()).hexdigest()[:16]}{ext}"
            kwargs["image_url"] = await _save_image_to_public_media(hass, connection, iu, fn)
        task = await store.async_update_task(msg["task_id"], actor=actor, **kwargs)
        if "image_url" in kwargs:
            await _cleanup_orphan_image(hass, old_image_url, kwargs.get("image_url"))
        connection.send_result(msg["id"], task)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/delete_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
    }
)
@websocket_api.async_response
async def ws_delete_task(hass, connection, msg):
    """Delete a task."""
    try:
        store = _get_store(hass, msg["list_id"])
        await store.async_delete_task(msg["task_id"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/duplicate_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Optional("assigned_person"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_duplicate_task(hass, connection, msg):
    """Duplicate a task, optionally reassigning it to another person."""
    try:
        store = _get_store(hass, msg["list_id"])
        actor = connection.user.name if connection.user else None
        task = await store.async_duplicate_task(
            msg["task_id"],
            assigned_person=msg.get("assigned_person"),
            actor=actor,
        )
        connection.send_result(msg["id"], task)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/reorder_tasks",
        vol.Required("list_id"): _val_id,
        vol.Required("task_ids"): vol.All([_val_id], vol.Length(max=MAX_REORDER_IDS)),
    }
)
@websocket_api.async_response
async def ws_reorder_tasks(hass, connection, msg):
    """Reorder tasks."""
    try:
        store = _get_store(hass, msg["list_id"])
        await store.async_reorder_tasks(msg["task_ids"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# --- Sub-task commands ---


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/add_sub_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Required("title"): _val_title,
    }
)
@websocket_api.async_response
async def ws_add_sub_task(hass, connection, msg):
    """Add a sub-task."""
    try:
        store = _get_store(hass, msg["list_id"])
        sub = await store.async_add_sub_task(msg["task_id"], msg["title"])
        connection.send_result(msg["id"], sub)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_sub_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Required("sub_task_id"): _val_id,
        vol.Optional("title"): _val_title,
        vol.Optional("completed"): bool,
    }
)
@websocket_api.async_response
async def ws_update_sub_task(hass, connection, msg):
    """Update a sub-task."""
    try:
        store = _get_store(hass, msg["list_id"])
        kwargs = {}
        for key in ("title", "completed"):
            if key in msg:
                kwargs[key] = msg[key]
        sub = await store.async_update_sub_task(msg["task_id"], msg["sub_task_id"], **kwargs)
        connection.send_result(msg["id"], sub)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/delete_sub_task",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Required("sub_task_id"): _val_id,
    }
)
@websocket_api.async_response
async def ws_delete_sub_task(hass, connection, msg):
    """Delete a sub-task."""
    try:
        store = _get_store(hass, msg["list_id"])
        await store.async_delete_sub_task(msg["task_id"], msg["sub_task_id"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/reorder_sub_tasks",
        vol.Required("list_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Required("sub_task_ids"): vol.All([_val_id], vol.Length(max=MAX_SUB_TASKS_PER_TASK)),
    }
)
@websocket_api.async_response
async def ws_reorder_sub_tasks(hass, connection, msg):
    """Reorder sub-tasks within a task."""
    try:
        store = _get_store(hass, msg["list_id"])
        await store.async_reorder_sub_tasks(msg["task_id"], msg["sub_task_ids"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# --- Cross-list move ---


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/move_task",
        vol.Required("source_list_id"): _val_id,
        vol.Required("target_list_id"): _val_id,
        vol.Required("task_id"): _val_id,
    }
)
@websocket_api.async_response
async def ws_move_task(hass, connection, msg):
    """Move a task from one list to another."""
    try:
        if msg["source_list_id"] == msg["target_list_id"]:
            raise ValueError("source_list_id and target_list_id must be different")
        src = _get_store(hass, msg["source_list_id"])
        tgt = _get_store(hass, msg["target_list_id"])
        task = await src.async_export_task(msg["task_id"])
        await tgt.async_import_task(task)
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/move_task_cross",
        vol.Required("task_id"): vol.All(str, vol.Length(min=1, max=255)),
        vol.Optional("source_list_id"): _val_id,
        vol.Optional("source_entity_id"): _val_entity_id,
        vol.Optional("target_list_id"): _val_id,
        vol.Optional("target_entity_id"): _val_entity_id,
    }
)
@websocket_api.async_response
async def ws_move_task_cross(hass, connection, msg):
    """Move a task between any combination of native and external lists."""
    import uuid as _uuid
    from .store import HomeTasksStore

    try:
        src_list_id = msg.get("source_list_id")
        src_entity_id = msg.get("source_entity_id")
        tgt_list_id = msg.get("target_list_id")
        tgt_entity_id = msg.get("target_entity_id")
        task_id = msg["task_id"]

        if not (src_list_id or src_entity_id):
            raise ValueError("source_list_id or source_entity_id required")
        if not (tgt_list_id or tgt_entity_id):
            raise ValueError("target_list_id or target_entity_id required")

        src_is_native = bool(src_list_id)
        tgt_is_native = bool(tgt_list_id)

        # --- Native → Native (delegate to existing logic) ---
        if src_is_native and tgt_is_native:
            if src_list_id == tgt_list_id:
                raise ValueError("source and target must be different")
            src_store = _get_store(hass, src_list_id)
            tgt_store = _get_store(hass, tgt_list_id)
            task_data = await src_store.async_export_task(task_id)
            await tgt_store.async_import_task(task_data)
            connection.send_result(msg["id"])
            return

        # --- Read full task data from source ---
        if src_is_native:
            src_store = _get_store(hass, src_list_id)
            task_data = src_store.get_task(task_id)
        else:
            # External source: read via adapter if available, else HA entity + overlay
            src_overlay = _get_overlay_store(hass, src_entity_id)
            src_adapter = _get_adapter(hass, src_entity_id)
            overlay = src_overlay.get_overlay(task_id)

            if src_adapter and not isinstance(src_adapter, GenericAdapter):
                # Rich adapter (e.g. Todoist) — read from provider API + overlay merge
                adapter_items = await src_adapter.async_read_tasks()
                merged = _merge_tasks_with_adapter_data(
                    adapter_items, src_overlay, src_adapter.capabilities,
                )
                item = next((t for t in merged if t.get("id") == task_id), None)
                if item is None:
                    raise ValueError(f"Task {task_id} not found in {src_entity_id}")
                task_data = {
                    "title": item.get("title", ""),
                    "completed": item.get("completed", False),
                    "notes": item.get("notes", ""),
                    "due_date": item.get("due_date"),
                    "due_time": item.get("due_time"),
                    "priority": item.get("priority"),
                    "assigned_person": item.get("assigned_person"),
                    "tags": item.get("tags", []),
                    "reminders": item.get("reminders", []),
                    "sub_items": item.get("sub_items", []),
                    "recurrence_enabled": item.get("recurrence_enabled", False),
                    "recurrence_type": item.get("recurrence_type", "interval"),
                    "recurrence_value": item.get("recurrence_value", 1),
                    "recurrence_unit": item.get("recurrence_unit"),
                    "recurrence_weekdays": item.get("recurrence_weekdays", []),
                    "recurrence_start_date": item.get("recurrence_start_date"),
                    "recurrence_time": item.get("recurrence_time"),
                    "recurrence_end_type": item.get("recurrence_end_type", "none"),
                    "recurrence_end_date": item.get("recurrence_end_date"),
                    "recurrence_max_count": item.get("recurrence_max_count"),
                    "recurrence_remaining_count": item.get("recurrence_remaining_count"),
                    "recurrence_month_pattern": item.get("recurrence_month_pattern"),
                    "recurrence_day_of_month": item.get("recurrence_day_of_month"),
                    "recurrence_nth_week": item.get("recurrence_nth_week"),
                    "recurrence_anniversary": item.get("recurrence_anniversary"),
                    "completed_at": item.get("completed_at"),
                    "history": item.get("history", []),
                }
            else:
                # Generic path — HA entity + overlay
                items = _get_external_todo_items(hass, src_entity_id)
                item = next((i for i in items if (i.get("uid") or "") == task_id), None)
                if item is None:
                    raise ValueError(f"Task {task_id} not found in {src_entity_id}")
                task_data = {
                    "title": item.get("summary") or "",
                    "completed": item.get("status") == "completed",
                    "notes": item.get("description") or "",
                    "due_date": item.get("due"),
                    "due_time": item.get("due_time") or overlay.get("due_time"),
                    "priority": overlay.get("priority"),
                    "assigned_person": overlay.get("assigned_person"),
                    "tags": overlay.get("tags", []),
                    "reminders": overlay.get("reminders", []),
                    "sub_items": overlay.get("sub_items", []),
                    "recurrence_enabled": overlay.get("recurrence_enabled", False),
                    "recurrence_type": overlay.get("recurrence_type", "interval"),
                    "recurrence_value": overlay.get("recurrence_value", 1),
                    "recurrence_unit": overlay.get("recurrence_unit"),
                    "recurrence_weekdays": overlay.get("recurrence_weekdays", []),
                    "recurrence_start_date": overlay.get("recurrence_start_date"),
                    "recurrence_time": overlay.get("recurrence_time"),
                    "recurrence_end_type": overlay.get("recurrence_end_type", "none"),
                    "recurrence_end_date": overlay.get("recurrence_end_date"),
                    "recurrence_max_count": overlay.get("recurrence_max_count"),
                    "recurrence_remaining_count": overlay.get("recurrence_remaining_count"),
                    "recurrence_month_pattern": overlay.get("recurrence_month_pattern"),
                    "recurrence_day_of_month": overlay.get("recurrence_day_of_month"),
                    "recurrence_nth_week": overlay.get("recurrence_nth_week"),
                    "recurrence_anniversary": overlay.get("recurrence_anniversary"),
                    "completed_at": overlay.get("completed_at"),
                    "history": overlay.get("history", []),
                }

        # --- Create task in target ---
        if tgt_is_native:
            tgt_store = _get_store(hass, tgt_list_id)
            # Build a full native task dict
            max_order = max((t["sort_order"] for t in tgt_store._data["tasks"]), default=-1)
            new_task = {
                "id": str(_uuid.uuid4()),
                "title": task_data.get("title", ""),
                "completed": task_data.get("completed", False),
                "notes": task_data.get("notes", ""),
                "due_date": task_data.get("due_date"),
                "sort_order": max_order + 1,
                "sub_items": task_data.get("sub_items", []),
                "priority": task_data.get("priority"),
                "due_time": task_data.get("due_time"),
                "reminders": task_data.get("reminders", []),
                "recurrence_value": task_data.get("recurrence_value", 1),
                "recurrence_unit": task_data.get("recurrence_unit"),
                "recurrence_enabled": task_data.get("recurrence_enabled", False),
                "recurrence_type": task_data.get("recurrence_type", "interval"),
                "recurrence_weekdays": task_data.get("recurrence_weekdays", []),
                "recurrence_start_date": task_data.get("recurrence_start_date"),
                "recurrence_time": task_data.get("recurrence_time"),
                "recurrence_end_type": task_data.get("recurrence_end_type", "none"),
                "recurrence_end_date": task_data.get("recurrence_end_date"),
                "recurrence_max_count": task_data.get("recurrence_max_count"),
                "recurrence_remaining_count": task_data.get("recurrence_remaining_count"),
                "recurrence_month_pattern": task_data.get("recurrence_month_pattern"),
                "recurrence_day_of_month": task_data.get("recurrence_day_of_month"),
                "recurrence_nth_week": task_data.get("recurrence_nth_week"),
                "recurrence_anniversary": task_data.get("recurrence_anniversary"),
                "completed_at": task_data.get("completed_at"),
                "assigned_person": task_data.get("assigned_person"),
                "tags": task_data.get("tags", []),
                "history": task_data.get("history", []),
                "external_id": None,
                "sync_source": None,
            }
            tgt_store._data["tasks"].append(new_task)
            await tgt_store._async_save()
            if tgt_store.on_task_created:
                tgt_store.on_task_created(new_task)
        else:
            # External target: create via adapter, then set overlay for all fields
            tgt_adapter = _get_adapter(hass, tgt_entity_id)
            tgt_overlay = _get_overlay_store(hass, tgt_entity_id)
            # Don't pass reminders in create_fields — Todoist may add
            # default reminders on creation.  We sync them explicitly
            # afterwards via _sync_reminders to avoid duplicates.
            move_reminders = task_data.get("reminders", [])
            create_fields = {
                "title": task_data.get("title", ""),
                "notes": task_data.get("notes", ""),
                "due_date": task_data.get("due_date"),
                "due_time": task_data.get("due_time"),
                "priority": task_data.get("priority"),
                "tags": task_data.get("tags", []),
                "assigned_person": task_data.get("assigned_person"),
            }
            if task_data.get("recurrence_enabled"):
                create_fields["recurrence_enabled"] = True
                for k in (
                    "recurrence_type", "recurrence_value", "recurrence_unit",
                    "recurrence_weekdays", "recurrence_start_date", "recurrence_time",
                    "recurrence_month_pattern", "recurrence_day_of_month",
                    "recurrence_nth_week", "recurrence_anniversary",
                ):
                    if task_data.get(k) is not None:
                        create_fields[k] = task_data[k]

            if tgt_adapter:
                new_uid, _adapter_unsynced = await tgt_adapter.async_create_task(create_fields)
            else:
                generic = GenericAdapter(hass, tgt_entity_id, {})
                new_uid, _adapter_unsynced = await generic.async_create_task(create_fields)

            # If the adapter couldn't discover the UID on its own, fall back
            # to re-fetching and picking the newest matching task by title.
            if new_uid is None:
                import asyncio
                await asyncio.sleep(1)  # give provider time to persist
                new_items = _get_external_todo_items(hass, tgt_entity_id)
                title_lower = (task_data.get("title") or "").lower()
                for ni in reversed(new_items):
                    if (ni.get("summary") or "").lower() == title_lower:
                        new_uid = ni.get("uid")
                        break

            # Sync reminders after creation (avoids duplicates with provider defaults)
            if new_uid and move_reminders and tgt_adapter and hasattr(tgt_adapter, "_sync_reminders"):
                try:
                    await tgt_adapter._sync_reminders(new_uid, move_reminders)
                except Exception:  # noqa: BLE001
                    _LOGGER.debug("Could not sync reminders for moved task %s", new_uid)

            # Create sub-tasks via adapter if supported (e.g. Todoist)
            sub_items = task_data.get("sub_items", [])
            if new_uid and sub_items and tgt_adapter:
                for sub in sub_items:
                    sub_title = sub.get("title", "")
                    if sub_title:
                        try:
                            await tgt_adapter.async_add_sub_task(new_uid, sub_title)
                        except Exception:  # noqa: BLE001
                            _LOGGER.debug("Could not create sub-task '%s' via adapter", sub_title)

            # Store ALL overlay fields on the new task so nothing is lost
            overlay_fields = {}
            for field in OVERLAY_FIELDS:
                val = task_data.get(field)
                if val is not None:
                    overlay_fields[field] = val
            # Always transfer list-type fields even if empty (to preserve cleared state)
            for field in ("tags", "reminders", "sub_items", "recurrence_weekdays"):
                overlay_fields[field] = task_data.get(field, [])

            if new_uid and overlay_fields:
                await tgt_overlay.async_set_overlay(new_uid, **overlay_fields)
            elif not new_uid:
                _LOGGER.warning(
                    "Could not discover UID for moved task '%s' in %s — overlay fields not saved",
                    task_data.get("title"), tgt_entity_id,
                )

        # --- Delete task from source ---
        if src_is_native:
            await src_store.async_export_task(task_id)  # removes + triggers callback
        else:
            # Delete from external provider
            src_adapter = _get_adapter(hass, src_entity_id)
            if src_adapter:
                await src_adapter.async_delete_task(task_id)
            else:
                generic = GenericAdapter(hass, src_entity_id, {})
                await generic.async_delete_task(task_id)
            # Clean up overlay
            await src_overlay.async_delete_overlay(task_id)

        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# ---------------------------------------------------------------------------
#  External todo entity commands
# ---------------------------------------------------------------------------


def _get_overlay_store(hass, entity_id: str) -> ExternalTaskOverlayStore:
    """Get the overlay store for an external entity_id."""
    stores = hass.data.get(DOMAIN, {})
    for store in stores.values():
        if isinstance(store, ExternalTaskOverlayStore) and store.entity_id == entity_id:
            return store
    raise ValueError(f"No overlay store found for entity: {entity_id}")


def _get_adapter(hass, entity_id: str) -> ProviderAdapter | None:
    """Get the provider adapter for an external entity_id.  Returns *None* if not found."""
    return hass.data.get(f"{DOMAIN}_adapters", {}).get(entity_id)



def _merge_tasks_with_overlays(
    external_items: list[dict],
    overlay_store: ExternalTaskOverlayStore,
    provider_owns_order: bool = False,
) -> list[dict]:
    """Merge external todo items with overlay data to produce Home Tasks-compatible dicts."""
    overlays = overlay_store.get_all_overlays()
    raw_overlays = overlay_store._data.get("overlays", {}) if overlay_store._data else {}
    tasks = []
    for idx, item in enumerate(external_items):
        uid = item.get("uid") or ""
        overlay = overlays.get(uid, {})
        if provider_owns_order:
            # Provider can reorder natively (MOVE_TODO_ITEM supported) — its index
            # is authoritative.  This lets external reorders (e.g. in the Google
            # Tasks app) flow back through our card without a stale overlay
            # sort_order overriding them.
            sort_order = idx
        else:
            # No MOVE support — overlay sort_order is our only way to persist a
            # user-initiated reorder, so it wins when explicitly set.
            raw = raw_overlays.get(uid, {})
            sort_order = raw["sort_order"] if "sort_order" in raw else idx
        completed = item.get("status") == "completed"
        task = {
            "id": uid,
            "title": item.get("summary") or "",
            "completed": completed,
            # Provider wins; fall back to overlay when the provider can't
            # hold the field (e.g. shopping_list has no description/due).
            "notes": item.get("description") or overlay.get("notes") or "",
            "due_date": item.get("due") or overlay.get("due_date"),
            "sort_order": sort_order,
            "sub_items": overlay.get("sub_items", []),
            "priority": overlay.get("priority"),
            "due_time": item.get("due_time") or overlay.get("due_time"),
            "reminders": overlay.get("reminders", []),
            "recurrence_value": overlay.get("recurrence_value", 1),
            "recurrence_unit": overlay.get("recurrence_unit"),
            "recurrence_enabled": overlay.get("recurrence_enabled", False),
            "recurrence_type": overlay.get("recurrence_type", "interval"),
            "recurrence_weekdays": overlay.get("recurrence_weekdays", []),
            "recurrence_start_date": overlay.get("recurrence_start_date"),
            "recurrence_time": overlay.get("recurrence_time"),
            "recurrence_end_type": overlay.get("recurrence_end_type", "none"),
            "recurrence_end_date": overlay.get("recurrence_end_date"),
            "recurrence_max_count": overlay.get("recurrence_max_count"),
            "recurrence_remaining_count": overlay.get("recurrence_remaining_count"),
            "recurrence_month_pattern": overlay.get("recurrence_month_pattern"),
            "recurrence_day_of_month": overlay.get("recurrence_day_of_month"),
            "recurrence_nth_week": overlay.get("recurrence_nth_week"),
            "recurrence_anniversary": overlay.get("recurrence_anniversary"),
            "completed_at": overlay.get("completed_at"),
            "assigned_person": overlay.get("assigned_person"),
            "tags": overlay.get("tags", []),
            "history": overlay.get("history", []),
            # Mark as external so the card knows how to route CRUD
            "_external": True,
        }
        tasks.append(task)
    return tasks


def _merge_tasks_with_adapter_data(
    adapter_items: list[dict],
    overlay_store: ExternalTaskOverlayStore,
    adapter_capabilities=None,
) -> list[dict]:
    """Merge tasks from a rich adapter with remaining overlay data.

    The adapter already provides synced fields (priority, labels, order, sub_items,
    assigned_person, recurrence, etc.).  The overlay is only consulted for fields
    the adapter does NOT sync.
    """
    overlays = overlay_store.get_all_overlays()
    raw_overlays = overlay_store._data.get("overlays", {}) if overlay_store._data else {}
    can_sync_order = adapter_capabilities.can_sync_order if adapter_capabilities else False
    tasks = []
    for idx, item in enumerate(adapter_items):
        uid = item.get("uid") or ""
        overlay = overlays.get(uid, {})
        raw = raw_overlays.get(uid, {})
        completed = item.get("status") == "completed"

        # Sort order: use provider order if synced, else overlay, else provider index
        if can_sync_order:
            sort_order = item.get("order", idx)
        else:
            sort_order = raw["sort_order"] if "sort_order" in raw else item.get("order", idx)

        # When overlay holds a structured monthly/yearly pattern, the value
        # parsed back from Todoist's simplified phrase is unreliable —
        # prefer overlay's value in that case so user-set "every 2 months"
        # survives the round-trip even when Todoist only stores "every month".
        overlay_owns_recurrence_shape = (
            overlay.get("recurrence_month_pattern") is not None
            or overlay.get("recurrence_anniversary") is not None
        )
        recurrence_value = (
            overlay.get("recurrence_value", 1) if overlay_owns_recurrence_shape
            else item.get("recurrence_value", overlay.get("recurrence_value", 1))
        )

        task = {
            "id": uid,
            "title": item.get("summary") or "",
            "completed": completed,
            # Provider wins; overlay fallback for providers that can't hold it.
            "notes": item.get("description") or overlay.get("notes") or "",
            "due_date": item.get("due") or overlay.get("due_date"),
            "sort_order": sort_order,
            # --- Fields from adapter (synced) ---
            "priority": item.get("priority"),
            "tags": item.get("labels", []),
            "due_time": item.get("due_time") or overlay.get("due_time"),
            "sub_items": item.get("sub_items", []),
            "assigned_person": overlay.get("assigned_person"),
            # Recurrence (from adapter if synced, else overlay)
            "recurrence_enabled": item.get("recurrence_enabled", overlay.get("recurrence_enabled", False)),
            "recurrence_type": item.get("recurrence_type", overlay.get("recurrence_type", "interval")),
            "recurrence_value": recurrence_value,
            "recurrence_unit": item.get("recurrence_unit", overlay.get("recurrence_unit")),
            "recurrence_weekdays": item.get("recurrence_weekdays", overlay.get("recurrence_weekdays", [])),
            "recurrence_start_date": item.get("recurrence_start_date", overlay.get("recurrence_start_date")),
            "recurrence_time": item.get("recurrence_time", overlay.get("recurrence_time")),
            # Recurrence end — from adapter (parsed from due_string) or overlay
            "recurrence_end_type": item.get("recurrence_end_type", overlay.get("recurrence_end_type", "none")),
            "recurrence_end_date": item.get("recurrence_end_date", overlay.get("recurrence_end_date")),
            "recurrence_max_count": overlay.get("recurrence_max_count"),
            "recurrence_remaining_count": overlay.get("recurrence_remaining_count"),
            "recurrence_month_pattern": item.get("recurrence_month_pattern", overlay.get("recurrence_month_pattern")),
            "recurrence_day_of_month": item.get("recurrence_day_of_month", overlay.get("recurrence_day_of_month")),
            "recurrence_nth_week": item.get("recurrence_nth_week", overlay.get("recurrence_nth_week")),
            "recurrence_anniversary": item.get("recurrence_anniversary", overlay.get("recurrence_anniversary")),
            # Reminders — adapter reads them, overlay as fallback
            "reminders": item.get("reminders", overlay.get("reminders", [])),
            # History & completed_at always from overlay
            "completed_at": overlay.get("completed_at"),
            "history": overlay.get("history", []),
            # Todoist recurrence string for read-only display
            "_todoist_recurrence_string": item.get("_todoist_recurrence_string"),
            # Mark as external
            "_external": True,
        }
        tasks.append(task)
    return tasks


@websocket_api.websocket_command({vol.Required("type"): "home_tasks/get_external_lists"})
@websocket_api.async_response
async def ws_get_external_lists(hass, connection, msg):
    """List all available external todo entities (from other integrations)."""
    try:
        # Find all todo entities NOT owned by home_tasks
        from homeassistant.helpers import entity_registry as er
        entity_reg = er.async_get(hass)
        our_entries = {e.entry_id for e in hass.config_entries.async_entries(DOMAIN)}

        external = []
        # Also include linked external entries
        linked_entity_ids = set()
        for entry in hass.config_entries.async_entries(DOMAIN):
            if entry.data.get("type") == "external":
                eid = entry.data.get("entity_id")
                if eid:
                    linked_entity_ids.add(eid)

        for entity_entry in entity_reg.entities.values():
            if entity_entry.domain != "todo":
                continue
            if entity_entry.config_entry_id in our_entries:
                continue

            # Read supported_features from entity state attributes
            features = 0
            state = hass.states.get(entity_entry.entity_id)
            if state and state.attributes:
                features = state.attributes.get("supported_features", 0)

            # Look up adapter for capabilities
            adapter = _get_adapter(hass, entity_entry.entity_id)
            provider_type = adapter.provider_type if adapter else "generic"
            capabilities = adapter.capabilities.to_dict() if adapter else {}

            external.append({
                "entity_id": entity_entry.entity_id,
                "name": entity_entry.name or entity_entry.original_name or entity_entry.entity_id,
                "linked": entity_entry.entity_id in linked_entity_ids,
                "supported_features": features,
                "provider_type": provider_type,
                "capabilities": capabilities,
            })

        connection.send_result(msg["id"], {"external_lists": external})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/get_external_tasks",
        vol.Required("entity_id"): _val_entity_id,
    }
)
@websocket_api.async_response
async def ws_get_external_tasks(hass, connection, msg):
    """Get tasks from an external todo entity, merged with overlay data."""
    try:
        entity_id = msg["entity_id"]
        overlay_store = _get_overlay_store(hass, entity_id)
        adapter = _get_adapter(hass, entity_id)

        if adapter and not isinstance(adapter, GenericAdapter):
            # Rich adapter (e.g. Todoist) — read directly from provider API
            external_items = await adapter.async_read_tasks()
            tasks = _merge_tasks_with_adapter_data(
                external_items, overlay_store, adapter.capabilities,
            )
        else:
            # Generic path — read via HA todo entity + overlay
            external_items = _get_external_todo_items(hass, entity_id)
            features = 0
            state = hass.states.get(entity_id)
            if state and state.attributes:
                features = state.attributes.get("supported_features", 0)
            provider_owns_order = bool(features & 8)  # MOVE_TODO_ITEM
            tasks = _merge_tasks_with_overlays(external_items, overlay_store, provider_owns_order)

        connection.send_result(msg["id"], {"tasks": tasks, "sections": overlay_store.sections})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_external_overlay",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Optional("priority"): vol.Any(vol.In([1, 2, 3]), None),
        vol.Optional("due_time"): _val_time,
        vol.Optional("assigned_person"): vol.Any(str, None),
        vol.Optional("tags"): vol.All(list, vol.Length(max=MAX_TAGS_PER_TASK)),
        vol.Optional("reminders"): vol.All(
            list,
            vol.Length(max=MAX_REMINDERS_PER_TASK),
            [vol.All(int, vol.Range(min=0, max=MAX_REMINDER_OFFSET_MINUTES))],
        ),
        vol.Optional("sort_order"): int,
        vol.Optional("recurrence_value"): vol.All(int, vol.Range(min=1, max=MAX_RECURRENCE_VALUE)),
        vol.Optional("recurrence_unit"): vol.Any(vol.In(list(VALID_RECURRENCE_UNITS)), None),
        vol.Optional("recurrence_enabled"): bool,
        vol.Optional("recurrence_type"): vol.In(["interval", "weekdays"]),
        vol.Optional("recurrence_weekdays"): vol.All(list, [vol.All(int, vol.Range(min=0, max=6))]),
        vol.Optional("recurrence_start_date"): _val_date,
        vol.Optional("recurrence_time"): _val_time,
        vol.Optional("recurrence_end_type"): vol.In(["none", "date", "count"]),
        vol.Optional("recurrence_end_date"): _val_date,
        vol.Optional("recurrence_max_count"): vol.Any(vol.All(int, vol.Range(min=1)), None),
        vol.Optional("recurrence_remaining_count"): vol.Any(vol.All(int, vol.Range(min=0)), None),
        vol.Optional("recurrence_month_pattern"): vol.Any(vol.In(["day_of_month", "nth_weekday"]), None),
        vol.Optional("recurrence_day_of_month"): vol.Any(vol.All(int, vol.Range(min=1, max=31)), "last", None),
        vol.Optional("recurrence_nth_week"): vol.Any(vol.All(int, vol.Range(min=1, max=4)), "last", None),
        vol.Optional("recurrence_anniversary"): _val_anniversary,
        vol.Optional("section_id"): vol.Any(_val_id, None),
    }
)
@websocket_api.async_response
async def ws_update_external_overlay(hass, connection, msg):
    """Update overlay fields for an external task."""
    try:
        overlay_store = _get_overlay_store(hass, msg["entity_id"])
        kwargs = {}
        for key in OVERLAY_FIELDS:
            if key in msg:
                kwargs[key] = msg[key]
        overlay = await overlay_store.async_set_overlay(msg["task_uid"], **kwargs)
        connection.send_result(msg["id"], overlay)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/add_external_sub_task",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Required("title"): _val_title,
    }
)
@websocket_api.async_response
async def ws_add_external_sub_task(hass, connection, msg):
    """Add a sub-task to an external task — via adapter or overlay."""
    try:
        entity_id = msg["entity_id"]
        adapter = _get_adapter(hass, entity_id)

        if adapter and adapter.capabilities.can_sync_sub_items:
            new_uid = await adapter.async_add_sub_task(msg["task_uid"], msg["title"])
            sub = {"id": new_uid, "title": msg["title"], "completed": False}
        else:
            overlay_store = _get_overlay_store(hass, entity_id)
            sub = await overlay_store.async_add_sub_task(msg["task_uid"], msg["title"])

        connection.send_result(msg["id"], sub)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_external_sub_task",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Required("sub_task_id"): _val_id,
        vol.Optional("title"): _val_title,
        vol.Optional("completed"): bool,
    }
)
@websocket_api.async_response
async def ws_update_external_sub_task(hass, connection, msg):
    """Update a sub-task — via adapter or overlay."""
    try:
        entity_id = msg["entity_id"]
        adapter = _get_adapter(hass, entity_id)
        kwargs = {}
        for key in ("title", "completed"):
            if key in msg:
                kwargs[key] = msg[key]

        if adapter and adapter.capabilities.can_sync_sub_items:
            await adapter.async_update_sub_task(msg["sub_task_id"], **kwargs)
            sub = {"id": msg["sub_task_id"], **kwargs}
        else:
            overlay_store = _get_overlay_store(hass, entity_id)
            sub = await overlay_store.async_update_sub_task(msg["task_uid"], msg["sub_task_id"], **kwargs)

        connection.send_result(msg["id"], sub)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/delete_external_sub_task",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Required("sub_task_id"): _val_id,
    }
)
@websocket_api.async_response
async def ws_delete_external_sub_task(hass, connection, msg):
    """Delete a sub-task — via adapter or overlay."""
    try:
        entity_id = msg["entity_id"]
        adapter = _get_adapter(hass, entity_id)

        if adapter and adapter.capabilities.can_sync_sub_items:
            await adapter.async_delete_sub_task(msg["sub_task_id"])
        else:
            overlay_store = _get_overlay_store(hass, entity_id)
            await overlay_store.async_delete_sub_task(msg["task_uid"], msg["sub_task_id"])

        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/reorder_external_sub_tasks",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Required("sub_task_ids"): vol.All([_val_id], vol.Length(max=MAX_SUB_TASKS_PER_TASK)),
    }
)
@websocket_api.async_response
async def ws_reorder_external_sub_tasks(hass, connection, msg):
    """Reorder sub-tasks — via adapter or overlay."""
    try:
        entity_id = msg["entity_id"]
        adapter = _get_adapter(hass, entity_id)

        if adapter and adapter.capabilities.can_sync_sub_items:
            await adapter.async_reorder_sub_tasks(msg["task_uid"], msg["sub_task_ids"])
        else:
            overlay_store = _get_overlay_store(hass, entity_id)
            await overlay_store.async_reorder_sub_tasks(msg["task_uid"], msg["sub_task_ids"])

        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# ---------------------------------------------------------------------------
#  Adapter-routed external commands (create / update / reorder)
# ---------------------------------------------------------------------------


def _external_entry_id(hass, entity_id: str) -> str | None:
    """Config-entry id of the external list linked to entity_id, if any."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.data.get("type") == "external" and entry.data.get("entity_id") == entity_id:
            return entry.entry_id
    return None


def _fire_external_task_event(
    hass, event_type: str, entity_id: str, task_uid: str, fields: dict, *, task: dict | None = None
) -> None:
    """Fire a home_tasks_<event_type> event for an external-list task.

    External tasks live on the linked todo entity and are mutated through the
    provider adapter, which bypasses the native store's on_task_* callbacks — so
    we fire the same events here for parity with native lists (issue #27).

    Event data is taken from the merged task snapshot (``task``) when given so
    completion events carry title/assignee/due/tags like native; the WS payload
    (``fields``) overrides it for the values the caller just changed.
    """
    src = dict(task or {})  # merged snapshot: title, assigned_person, due_date, tags …
    for key in ("title", "assigned_person", "due_date", "tags"):
        if key in fields:
            src[key] = fields[key]
    data: dict = {"task_id": task_uid, "task_title": src.get("title") or "", "entity_id": entity_id}
    entry_id = _external_entry_id(hass, entity_id)
    if entry_id:
        data["entry_id"] = entry_id
    if src.get("due_date"):
        data["due_date"] = src["due_date"]
    if src.get("tags"):
        data["tags"] = src["tags"]
    if src.get("assigned_person"):
        data["assigned_person"] = src["assigned_person"]
    hass.bus.async_fire(f"{DOMAIN}_{event_type}", data)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/create_external_task",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("title"): _val_title,
        vol.Optional("notes"): vol.All(str, vol.Length(max=5000)),
        vol.Optional("due_date"): _val_date,
        vol.Optional("due_time"): _val_time,
        vol.Optional("priority"): vol.Any(vol.In([1, 2, 3]), None),
        vol.Optional("tags"): vol.All(list, vol.Length(max=MAX_TAGS_PER_TASK)),
        vol.Optional("assigned_person"): vol.Any(str, None),
        vol.Optional("reminders"): vol.All(
            list,
            vol.Length(max=MAX_REMINDERS_PER_TASK),
            [vol.All(int, vol.Range(min=0, max=MAX_REMINDER_OFFSET_MINUTES))],
        ),
        vol.Optional("recurrence_enabled"): bool,
        vol.Optional("recurrence_type"): vol.In(["interval", "weekdays"]),
        vol.Optional("recurrence_value"): vol.All(int, vol.Range(min=1, max=MAX_RECURRENCE_VALUE)),
        vol.Optional("recurrence_unit"): vol.Any(vol.In(list(VALID_RECURRENCE_UNITS)), None),
        vol.Optional("recurrence_weekdays"): vol.All(list, [vol.All(int, vol.Range(min=0, max=6))]),
        vol.Optional("recurrence_start_date"): _val_date,
        vol.Optional("recurrence_time"): _val_time,
        vol.Optional("recurrence_end_date"): _val_date,
        vol.Optional("recurrence_month_pattern"): vol.Any(vol.In(["day_of_month", "nth_weekday"]), None),
        vol.Optional("recurrence_day_of_month"): vol.Any(vol.All(int, vol.Range(min=1, max=31)), "last", None),
        vol.Optional("recurrence_nth_week"): vol.Any(vol.All(int, vol.Range(min=1, max=4)), "last", None),
        vol.Optional("recurrence_anniversary"): _val_anniversary,
    }
)
@websocket_api.async_response
async def ws_create_external_task(hass, connection, msg):
    """Create a task via the provider adapter."""
    try:
        entity_id = msg["entity_id"]
        adapter = _get_adapter(hass, entity_id)

        fields = {k: v for k, v in msg.items() if k not in ("id", "type", "entity_id")}

        if adapter:
            new_uid, adapter_unsynced = await adapter.async_create_task(fields)
        else:
            # Fallback: generic create via todo.add_item
            generic = GenericAdapter(hass, entity_id, {})
            new_uid, adapter_unsynced = await generic.async_create_task(fields)

        # Store overlay fields: the adapter's unsynced set (fields the
        # provider couldn't accept) PLUS the fields that home_tasks keeps
        # locally regardless of adapter (reminders for non-reminder-syncing
        # adapters, recurrence bookkeeping).
        if new_uid and adapter:  # overlay store only exists for registered externals
            overlay_store = _get_overlay_store(hass, entity_id)
            overlay_fields: dict = dict(adapter_unsynced) if adapter_unsynced else {}
            if not adapter.capabilities.can_sync_reminders and fields.get("reminders"):
                overlay_fields.setdefault("reminders", fields["reminders"])
            for key in ("recurrence_end_type", "recurrence_max_count", "recurrence_remaining_count"):
                if key in fields:
                    overlay_fields.setdefault(key, fields[key])
            # Only persist keys the overlay store knows about
            overlay_kwargs = {k: v for k, v in overlay_fields.items() if k in OVERLAY_FIELDS}
            if overlay_kwargs:
                await overlay_store.async_set_overlay(new_uid, **overlay_kwargs)
        elif adapter_unsynced:
            _LOGGER.warning(
                "Created external task on %s but could not discover UID; "
                "overlay fields lost: %s",
                entity_id, list(adapter_unsynced.keys()),
            )
        # Fire created for every provider — even when the generic adapter can't
        # resolve a UID, the title + entity are still useful to automations.
        _fire_external_task_event(hass, "task_created", entity_id, new_uid or "", fields)
        connection.send_result(msg["id"], {"uid": new_uid})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_external_task",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
        vol.Optional("title"): _val_title,
        vol.Optional("completed"): bool,
        vol.Optional("notes"): vol.All(str, vol.Length(max=5000)),
        vol.Optional("due_date"): _val_date,
        vol.Optional("due_time"): _val_time,
        vol.Optional("priority"): vol.Any(vol.In([1, 2, 3]), None),
        vol.Optional("tags"): vol.All(list, vol.Length(max=MAX_TAGS_PER_TASK)),
        vol.Optional("assigned_person"): vol.Any(str, None),
        vol.Optional("reminders"): vol.All(
            list,
            vol.Length(max=MAX_REMINDERS_PER_TASK),
            [vol.All(int, vol.Range(min=0, max=MAX_REMINDER_OFFSET_MINUTES))],
        ),
        vol.Optional("sort_order"): int,
        vol.Optional("recurrence_enabled"): bool,
        vol.Optional("recurrence_type"): vol.In(["interval", "weekdays"]),
        vol.Optional("recurrence_value"): vol.All(int, vol.Range(min=1, max=MAX_RECURRENCE_VALUE)),
        vol.Optional("recurrence_unit"): vol.Any(vol.In(list(VALID_RECURRENCE_UNITS)), None),
        vol.Optional("recurrence_weekdays"): vol.All(list, [vol.All(int, vol.Range(min=0, max=6))]),
        vol.Optional("recurrence_start_date"): _val_date,
        vol.Optional("recurrence_time"): _val_time,
        vol.Optional("recurrence_end_type"): vol.In(["none", "date", "count"]),
        vol.Optional("recurrence_end_date"): _val_date,
        vol.Optional("recurrence_max_count"): vol.Any(vol.All(int, vol.Range(min=1)), None),
        vol.Optional("recurrence_remaining_count"): vol.Any(vol.All(int, vol.Range(min=0)), None),
        vol.Optional("recurrence_month_pattern"): vol.Any(vol.In(["day_of_month", "nth_weekday"]), None),
        vol.Optional("recurrence_day_of_month"): vol.Any(vol.All(int, vol.Range(min=1, max=31)), "last", None),
        vol.Optional("recurrence_nth_week"): vol.Any(vol.All(int, vol.Range(min=1, max=4)), "last", None),
        vol.Optional("recurrence_anniversary"): _val_anniversary,
    }
)
@websocket_api.async_response
async def ws_update_external_task(hass, connection, msg):
    """Update a task via the provider adapter.  Unsynced fields go to overlay."""
    try:
        entity_id = msg["entity_id"]
        task_uid = msg["task_uid"]
        adapter = _get_adapter(hass, entity_id)

        fields = {k: v for k, v in msg.items() if k not in ("id", "type", "entity_id", "task_uid")}

        if adapter:
            unsynced = await adapter.async_update_task(task_uid, fields)
        else:
            generic = GenericAdapter(hass, entity_id, {})
            unsynced = await generic.async_update_task(task_uid, fields)

        # Store unsynced fields in overlay
        if unsynced:
            overlay_store = _get_overlay_store(hass, entity_id)
            overlay_kwargs = {}
            for key in OVERLAY_FIELDS:
                if key in unsynced:
                    overlay_kwargs[key] = unsynced[key]
            if overlay_kwargs:
                await overlay_store.async_set_overlay(task_uid, **overlay_kwargs)

        # Fire native-parity events so automations work for external lists too
        # (issue #27): the adapter path bypasses the store's on_task_* callbacks.
        if "completed" in fields:
            merged = None
            try:
                ostore = _get_overlay_store(hass, entity_id)
                merged = next(
                    (t for t in _merge_tasks_with_overlays(_get_external_todo_items(hass, entity_id), ostore)
                     if str(t.get("id")) == str(task_uid)),
                    None,
                )
            except Exception:  # noqa: BLE001
                merged = None
            event_type = "task_completed" if fields["completed"] else "task_reopened"
            _fire_external_task_event(hass, event_type, entity_id, task_uid, fields, task=merged)
            # Overlay-driven recurrence (issue #27): on completion schedule the
            # reopen (skipped for providers that own recurrence); on a manual
            # reopen, cancel any pending reopen timer.
            from . import _cancel_recurrence, _handle_external_recurrence_completion
            if fields["completed"]:
                entry_id = _external_entry_id(hass, entity_id)
                if entry_id:
                    await _handle_external_recurrence_completion(hass, entry_id, entity_id, task_uid)
            else:
                _cancel_recurrence(hass, task_uid)
                # Clear the recurrence completion stamp so a manually reopened
                # task isn't seen as still-completed by startup recovery / UI.
                if merged and merged.get("completed_at"):
                    await _get_overlay_store(hass, entity_id).async_set_overlay(
                        task_uid, completed_at=None
                    )
        connection.send_result(msg["id"], {"unsynced": list(unsynced.keys()) if unsynced else []})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/reorder_external_tasks",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uids"): vol.All([_val_task_uid], vol.Length(max=MAX_REORDER_IDS)),
    }
)
@websocket_api.async_response
async def ws_reorder_external_tasks(hass, connection, msg):
    """Reorder tasks via the provider adapter."""
    try:
        entity_id = msg["entity_id"]
        task_uids = msg["task_uids"]
        adapter = _get_adapter(hass, entity_id)

        handled = False
        if adapter:
            handled = await adapter.async_reorder_tasks(task_uids)

        if not handled:
            # Fallback: store order in overlay
            overlay_store = _get_overlay_store(hass, entity_id)
            for i, uid in enumerate(task_uids):
                await overlay_store.async_set_overlay(uid, sort_order=i)

        connection.send_result(msg["id"], {"provider_handled": handled})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# ---------------------------------------------------------------------------
#  External overlay commands (backward compat + cleanup)
# ---------------------------------------------------------------------------


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/delete_external_overlay",
        vol.Required("entity_id"): _val_entity_id,
        vol.Required("task_uid"): _val_task_uid,
    }
)
@websocket_api.async_response
async def ws_delete_external_overlay(hass, connection, msg):
    """Delete overlay data for an external task (cleanup after deletion)."""
    try:
        overlay_store = _get_overlay_store(hass, msg["entity_id"])
        await overlay_store.async_delete_overlay(msg["task_uid"])
        # Cancel any pending reminder/recurrence timers so they don't fire (and
        # leak) for a task that no longer exists.
        from . import _cancel_recurrence, _cancel_reminders
        _cancel_reminders(hass, msg["task_uid"])
        _cancel_recurrence(hass, msg["task_uid"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# --- Sections (work for both native lists via list_id and external lists via entity_id) ---


_val_icon = vol.Any(vol.All(str, vol.Length(min=1, max=64)), None)
_val_section_name = vol.All(str, vol.Length(min=1, max=100))


def _get_sections_store(hass, msg):
    """Return the store (native or overlay) that holds sections for this target."""
    if "list_id" in msg:
        return _get_store(hass, msg["list_id"])
    if "entity_id" in msg:
        return _get_overlay_store(hass, msg["entity_id"])
    raise ValueError("Either list_id or entity_id is required")


_SECTION_TARGET = {
    vol.Exclusive("list_id", "target"): _val_id,
    vol.Exclusive("entity_id", "target"): _val_entity_id,
}


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/get_sections",
        **_SECTION_TARGET,
    }
)
@websocket_api.async_response
async def ws_get_sections(hass, connection, msg):
    """Return sections for a list."""
    try:
        store = _get_sections_store(hass, msg)
        connection.send_result(msg["id"], {"sections": store.sections})
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/add_section",
        vol.Required("name"): _val_section_name,
        vol.Optional("icon"): _val_icon,
        **_SECTION_TARGET,
    }
)
@websocket_api.async_response
async def ws_add_section(hass, connection, msg):
    """Create a new section."""
    try:
        store = _get_sections_store(hass, msg)
        section = await store.async_add_section(msg["name"], icon=msg.get("icon"))
        connection.send_result(msg["id"], section)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/update_section",
        vol.Required("section_id"): _val_id,
        vol.Optional("name"): _val_section_name,
        vol.Optional("icon"): _val_icon,
        **_SECTION_TARGET,
    }
)
@websocket_api.async_response
async def ws_update_section(hass, connection, msg):
    """Update a section's name and/or icon."""
    try:
        store = _get_sections_store(hass, msg)
        kwargs = {}
        if "name" in msg:
            kwargs["name"] = msg["name"]
        if "icon" in msg:
            kwargs["icon"] = msg["icon"]
        section = await store.async_update_section(msg["section_id"], **kwargs)
        connection.send_result(msg["id"], section)
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/delete_section",
        vol.Required("section_id"): _val_id,
        **_SECTION_TARGET,
    }
)
@websocket_api.async_response
async def ws_delete_section(hass, connection, msg):
    """Delete a section; tasks fall back to section_id=None."""
    try:
        store = _get_sections_store(hass, msg)
        await store.async_delete_section(msg["section_id"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/reorder_sections",
        vol.Required("section_ids"): vol.All(list, vol.Length(max=MAX_REORDER_IDS), [_val_id]),
        **_SECTION_TARGET,
    }
)
@websocket_api.async_response
async def ws_reorder_sections(hass, connection, msg):
    """Reorder sections."""
    try:
        store = _get_sections_store(hass, msg)
        await store.async_reorder_sections(msg["section_ids"])
        connection.send_result(msg["id"])
    except Exception as err:
        _handle_error(connection, msg["id"], err)


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------

def _local_image_name(url: str | None) -> str | None:
    """Bare filename if url is one of our public /local/home_tasks/ images, else None."""
    if not url:
        return None
    path = url.split("?")[0]
    prefix = "/local/home_tasks/"
    return path[len(prefix):] if path.startswith(prefix) else None


def _is_private_host(host: str | None) -> bool:
    """True if host is a private/loopback IP (LAN address). Named hosts → False."""
    if not host:
        return False
    try:
        import ipaddress
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False


async def _cleanup_orphan_image(hass, old_url: str | None, new_url: str | None) -> None:
    """Delete an old public www image once no task references it any more.

    Bounds growth of config/www/home_tasks: when a task's image changes or is
    removed, the previous /local/home_tasks/<file> is deleted — unless another
    task in any list still points at it (same-title tasks share one file).
    """
    old_name = _local_image_name(old_url)
    if not old_name or old_name == _local_image_name(new_url):
        return
    # A truthy new value that isn't one of our public files means the re-save
    # failed (it returned the raw media-source:// / http URL) — keep the old file
    # as a fallback. (new_url is None for an explicit removal, which still reclaims it.)
    if new_url and _local_image_name(new_url) is None:
        return
    for s in hass.data.get(DOMAIN, {}).values():
        if not hasattr(s, "tasks"):
            continue
        # Membership only — read the raw list instead of the .tasks property,
        # which builds a freshly-sorted copy on every access.
        raw = getattr(s, "_data", None)
        tasks = raw["tasks"] if isinstance(raw, dict) and "tasks" in raw else s.tasks
        for t in tasks:
            if _local_image_name(t.get("image_url")) == old_name:
                return  # still referenced — keep the file
    import os
    path = hass.config.path("www", "home_tasks", old_name)
    thumb = os.path.splitext(path)[0] + "_thumb.webp"

    def _rm() -> None:
        for p in (path, thumb):
            try:
                os.remove(p)
            except OSError:
                pass

    await hass.async_add_executor_job(_rm)


# ---------------------------------------------------------------------------
#  Thumbnails — small WebP copies so tile grids load fast (the full PNGs the
#  AI / media picker produce are ~1-2 MB each).  Thumb path is derived by
#  convention: <base>.<ext> -> <base>_thumb.webp (no task-schema change).
# ---------------------------------------------------------------------------

_MAX_THUMB_PX = 512


def _make_thumbnail(src_path: str) -> None:
    """Write a downscaled WebP thumbnail next to src_path as <base>_thumb.webp."""
    import os
    from PIL import Image

    thumb_path = os.path.splitext(src_path)[0] + "_thumb.webp"
    with Image.open(src_path) as im:
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        im.thumbnail((_MAX_THUMB_PX, _MAX_THUMB_PX))
        im.save(thumb_path, "WEBP", quality=80, method=4)


async def _save_thumbnail(hass, dest: str) -> None:
    """Generate a thumbnail for a freshly-saved image; best-effort (never raises)."""
    try:
        await hass.async_add_executor_job(_make_thumbnail, dest)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Thumbnail generation failed for %s: %s", dest, err)


async def _backfill_thumbnails(hass) -> None:
    """One-time: create thumbnails for existing public images that lack one."""
    import os
    www_dir = hass.config.path("www", "home_tasks")

    def _scan() -> None:
        if not os.path.isdir(www_dir):
            return
        for fn in os.listdir(www_dir):
            base, _ext = os.path.splitext(fn)
            if base.endswith("_thumb"):
                continue  # already a thumbnail
            if os.path.exists(os.path.join(www_dir, base + "_thumb.webp")):
                continue
            try:
                _make_thumbnail(os.path.join(www_dir, fn))
            except Exception:  # noqa: BLE001
                pass  # skip non-images / unreadable files

    try:
        await hass.async_add_executor_job(_scan)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Thumbnail backfill failed: %s", err)


async def _save_image_to_public_media(hass, connection, image_url: str, filename: str) -> str:
    """Download an image URL and save it to the public media dir.

    Handles HA-internal paths (auth-required), external https:// URLs (may expire),
    and media-source:// URIs (only renderable by native HA apps).
    Returns a /local/home_tasks/<filename> URL (public www, no auth, no expiry)
    accessible on all devices.
    Falls back to the original URL on any error.
    """
    import os
    from homeassistant.helpers.aiohttp_client import async_get_clientsession

    if not image_url:
        return image_url

    # Already saved to our local directory — nothing to do.
    # Strip any ?v= query param before checking so versioned URLs don't slip through.
    if image_url.split("?")[0].startswith("/local/home_tasks/"):
        return image_url

    try:
        www_dir = hass.config.path("www", "home_tasks")
        await hass.async_add_executor_job(os.makedirs, www_dir, 0o755, True)
        dest = os.path.join(www_dir, filename)

        session = async_get_clientsession(hass, verify_ssl=False)

        # Resolve media-source:// URIs (returned by HA's ai_task integration)
        # to an actual HTTP URL before downloading.
        if image_url.startswith("media-source://"):
            try:
                from homeassistant.components.media_source import async_resolve_media
                resolved = await async_resolve_media(hass, image_url, None)
            except Exception as resolve_err:  # noqa: BLE001
                _LOGGER.warning("Failed to resolve media source %s: %s", image_url, resolve_err)
                return image_url
            # Prefer copying the file straight off disk — no HTTP request, so no
            # dependency on a signed URL (those die the moment their issuing
            # refresh token is removed). Fall back to the resolved URL otherwise.
            src_path = getattr(resolved, "path", None)
            if src_path:
                import shutil
                try:
                    await hass.async_add_executor_job(shutil.copyfile, str(src_path), dest)
                    await _save_thumbnail(hass, dest)
                    return f"/local/home_tasks/{filename}"
                except Exception as copy_err:  # noqa: BLE001
                    _LOGGER.warning("Failed to copy media file %s: %s", src_path, copy_err)
                    return image_url
            image_url = resolved.url

        # Determine the download URL and headers
        if image_url.startswith(("http://", "https://")):
            # Fully-qualified URL.  Could be external (OpenAI CDN) or an internal
            # HA URL (e.g. ai_task may return http://<host>[:port]/ai_task/image/
            # ...?authSig=...).  We recognise the internal case by the path HA
            # serves (or our own host/port) and always fetch it via the 127.0.0.1
            # loopback on the real internal server port + a Bearer token.  That
            # works no matter how HA is exposed — LAN IP, a custom port, or a
            # reverse-proxied domain (where there is no port to compare).
            from urllib.parse import urlparse, urlunparse
            parsed = urlparse(image_url)
            try:
                ha_port = hass.http.server_port
            except AttributeError:
                ha_port = 8123
            # Internal = points at THIS HA instance. Cheap checks first (loopback,
            # our server port, or a private/LAN IP); only consult get_url() — which
            # can trigger cloud remote-UI resolution — as a fallback for named
            # hosts. Matching on path prefix alone is unsafe (an external CDN URL
            # like https://cdn.x/media/y.png would be wrongly rewritten to loopback).
            host = parsed.hostname
            is_internal = (
                host in ("127.0.0.1", "localhost")
                or parsed.port == ha_port
                or _is_private_host(host)
            )
            if not is_internal and host:
                ha_hosts: set = set()
                try:
                    from homeassistant.helpers.network import get_url
                    for _pref in (False, True):
                        try:
                            ha_hosts.add(urlparse(get_url(hass, prefer_external=_pref)).hostname)
                        except Exception:  # noqa: BLE001
                            pass
                except Exception:  # noqa: BLE001
                    pass
                is_internal = host in ha_hosts
            if is_internal:
                refresh_token = hass.auth.async_get_refresh_token(connection.refresh_token_id)
                if refresh_token is None:
                    _LOGGER.warning("No refresh token available for internal URL download")
                    return image_url
                access_token = hass.auth.async_create_access_token(refresh_token)
                use_ssl = bool(getattr(hass.http, "ssl_certificate", None))
                scheme = "https" if use_ssl else "http"
                download_url = urlunparse((
                    scheme, f"127.0.0.1:{ha_port}",
                    parsed.path, parsed.params, parsed.query, "",
                ))
                headers: dict = {"Authorization": f"Bearer {access_token}"}
            else:
                # Genuinely external (e.g. the OpenAI image CDN) — fetch as-is.
                download_url = image_url
                headers = {}
        else:
            # HA-internal path — needs Bearer token + loopback URL
            refresh_token = hass.auth.async_get_refresh_token(connection.refresh_token_id)
            if refresh_token is None:
                _LOGGER.warning("No refresh token available; skipping image re-save")
                return image_url
            access_token = hass.auth.async_create_access_token(refresh_token)

            try:
                port = hass.http.server_port
                use_ssl = bool(getattr(hass.http, "ssl_certificate", None))
            except AttributeError:
                port = 8123
                use_ssl = False

            scheme = "https" if use_ssl else "http"
            download_url = f"{scheme}://127.0.0.1:{port}{image_url}"
            headers = {"Authorization": f"Bearer {access_token}"}

        async with session.get(download_url, headers=headers) as resp:
            if resp.status != 200:
                _LOGGER.warning(
                    "Image download returned HTTP %s for %s — keeping original URL",
                    resp.status, image_url,
                )
                return image_url
            image_data = await resp.read()

        def _write() -> None:
            with open(dest, "wb") as fh:
                fh.write(image_data)

        await hass.async_add_executor_job(_write)
        await _save_thumbnail(hass, dest)
        return f"/local/home_tasks/{filename}"

    except Exception as exc:  # noqa: BLE001
        _LOGGER.warning("Failed to save image to public media dir: %s", exc)
        return image_url

@websocket_api.websocket_command(
    {
        vol.Required("type"): "home_tasks/generate_task_image",
        vol.Required("entry_id"): _val_id,
        vol.Required("task_id"): _val_id,
        vol.Optional("prompt_prefix"): vol.All(str, vol.Length(max=200)),
        vol.Optional("entity_id"): _val_entity_id,
        vol.Optional("force"): bool,
    }
)
@websocket_api.async_response
async def ws_generate_task_image(hass: HomeAssistant, connection, msg):
    """Generate an AI image for a task via HA's ai_task integration.

    Delegates to ai_task.generate_image — works with any configured AI
    provider (OpenAI, Gemini, Anthropic, local models).  The generated image
    lands in HA's Media Source; no API key handling or file I/O needed here.

    Tasks with the same normalised title share a single image: before calling
    the service the stores are checked for an existing URL.  After generation
    the URL is propagated to every task with the same title across all lists.
    """
    import hashlib

    try:
        store = _get_store(hass, msg["entry_id"])
        task = store.get_task(msg["task_id"])

        title = task.get("title", "")
        title_key = title.strip().lower()
        title_hash = hashlib.md5(title_key.encode(), usedforsecurity=False).hexdigest()[:16]

        all_stores = hass.data.get(DOMAIN, {})

        # ------------------------------------------------------------------
        # 1. Reuse: if any task with the same title already has an image URL,
        #    skip the service call (bypass with force=True).
        # ------------------------------------------------------------------
        if not msg.get("force", False) and title_key:
            existing_url: str | None = None
            for s in all_stores.values():
                if not hasattr(s, "tasks"):
                    continue
                for t in s.tasks:
                    if t.get("title", "").strip().lower() == title_key and t.get("image_url"):
                        existing_url = t["image_url"]
                        break
                if existing_url:
                    break

            if existing_url:
                updated_task = await store.async_update_task(msg["task_id"], image_url=existing_url)
                connection.send_result(msg["id"], {"task": updated_task})
                return

        # ------------------------------------------------------------------
        # 2. Generate via ai_task.generate_image (provider-agnostic).
        # ------------------------------------------------------------------
        prompt_prefix = msg.get("prompt_prefix", "")
        prompt = f"{prompt_prefix}{title}" if prompt_prefix else title
        # The card renders images in square tiles. ai_task exposes no size
        # parameter, but gpt-image (and most models) honour an explicit aspect
        # instruction — so ask for 1:1 to avoid the tiles cropping the result.
        # For providers that ignore it this is just harmless extra prompt text.
        instructions = f"{prompt}\n\nThe image must have a square 1:1 aspect ratio."

        entity_id = msg.get("entity_id")
        if not entity_id:
            from homeassistant.helpers import entity_registry as er
            ent_reg = er.async_get(hass)
            ai_entities = [
                e.entity_id for e in ent_reg.entities.values()
                if e.domain == "ai_task" and not e.disabled_by
            ]
            if not ai_entities:
                raise ValueError("No ai_task entity found — configure one in the card editor")
            entity_id = ai_entities[0]

        try:
            service_result = await hass.services.async_call(
                "ai_task",
                "generate_image",
                {
                    "task_name": f"home_tasks_{title_hash}",
                    "instructions": instructions,
                    "entity_id": entity_id,
                },
                blocking=True,
                return_response=True,
            )
        except Exception as service_err:
            raise ValueError(f"Image generation failed: {service_err}") from service_err

        _LOGGER.debug("ai_task.generate_image result: %s", service_result)
        result_dict = service_result or {}
        # Prefer the media-source id: it lets _save_image_to_public_media copy
        # the file straight off disk (no auth-dependent HTTP download). The
        # signed "url" is only a fallback.
        image_url = (
            result_dict.get("media_source_id")
            or result_dict.get("url")
            or (result_dict.get("image") or {}).get("url")
        )
        if not image_url:
            raise ValueError(
                f"ai_task.generate_image returned no image URL. Full result: {result_dict}"
            )

        # Convert auth-required internal URLs to public /media/local/ URLs so
        # the Lovelace card can display them without auth headers.
        image_filename = f"{title_hash}.png"
        image_url = await _save_image_to_public_media(hass, connection, image_url, image_filename)

        # Never persist an unresolved media-source:// URI — the browser can't
        # render it, so it would show as a permanently broken image. Surface a
        # clear error instead (e.g. media-source resolution failed above).
        if image_url and image_url.startswith("media-source://"):
            raise ValueError(
                "Generated image could not be resolved to a displayable URL"
            )

        # Append a cache-busting timestamp so browsers/apps that cache by URL
        # (including the Android HA app which cannot be hard-refreshed) always
        # fetch the new image after regeneration.
        if image_url.startswith("/local/home_tasks/"):
            image_url = f"{image_url}?v={int(time.time())}"

        # ------------------------------------------------------------------
        # 3. Propagate URL to every task with the same title across all lists.
        # ------------------------------------------------------------------
        updated_task = None
        # Only fan out to same-title tasks when the title is non-empty — an empty
        # title would match every blank-title task across all lists and overwrite
        # their images.
        if title_key:
            for s in all_stores.values():
                if not hasattr(s, "tasks"):
                    continue
                for t in s.tasks:
                    if t.get("title", "").strip().lower() == title_key and t.get("image_url") != image_url:
                        stamped = await s.async_update_task(t["id"], image_url=image_url)
                        if t["id"] == msg["task_id"]:
                            updated_task = stamped

        if updated_task is None:
            updated_task = await store.async_update_task(msg["task_id"], image_url=image_url)

        connection.send_result(msg["id"], {"task": updated_task})

    except Exception as err:
        _handle_error(connection, msg["id"], err)
