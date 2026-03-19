"""WebSocket API for My ToDo List."""

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN


@callback
def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_lists)
    websocket_api.async_register_command(hass, ws_create_list)
    websocket_api.async_register_command(hass, ws_rename_list)
    websocket_api.async_register_command(hass, ws_delete_list)
    websocket_api.async_register_command(hass, ws_get_tasks)
    websocket_api.async_register_command(hass, ws_add_task)
    websocket_api.async_register_command(hass, ws_update_task)
    websocket_api.async_register_command(hass, ws_delete_task)
    websocket_api.async_register_command(hass, ws_reorder_tasks)
    websocket_api.async_register_command(hass, ws_add_sub_item)
    websocket_api.async_register_command(hass, ws_update_sub_item)
    websocket_api.async_register_command(hass, ws_delete_sub_item)


# --- List commands ---


@websocket_api.websocket_command({vol.Required("type"): "my_todo_list/get_lists"})
@websocket_api.async_response
async def ws_get_lists(hass, connection, msg):
    """Get all lists."""
    store = hass.data[DOMAIN]
    connection.send_result(msg["id"], {"lists": store.get_lists()})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/create_list",
        vol.Required("name"): str,
    }
)
@websocket_api.async_response
async def ws_create_list(hass, connection, msg):
    """Create a new list."""
    store = hass.data[DOMAIN]
    result = await store.async_create_list(msg["name"])
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/rename_list",
        vol.Required("list_id"): str,
        vol.Required("name"): str,
    }
)
@websocket_api.async_response
async def ws_rename_list(hass, connection, msg):
    """Rename a list."""
    store = hass.data[DOMAIN]
    try:
        result = await store.async_rename_list(msg["list_id"], msg["name"])
        connection.send_result(msg["id"], result)
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/delete_list",
        vol.Required("list_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_list(hass, connection, msg):
    """Delete a list."""
    store = hass.data[DOMAIN]
    try:
        await store.async_delete_list(msg["list_id"])
        connection.send_result(msg["id"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


# --- Task commands ---


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/get_tasks",
        vol.Required("list_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_tasks(hass, connection, msg):
    """Get all tasks for a list."""
    store = hass.data[DOMAIN]
    try:
        tasks = store.get_tasks(msg["list_id"])
        connection.send_result(msg["id"], {"tasks": tasks})
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/add_task",
        vol.Required("list_id"): str,
        vol.Required("title"): str,
    }
)
@websocket_api.async_response
async def ws_add_task(hass, connection, msg):
    """Add a task."""
    store = hass.data[DOMAIN]
    try:
        task = await store.async_add_task(msg["list_id"], msg["title"])
        connection.send_result(msg["id"], task)
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/update_task",
        vol.Required("list_id"): str,
        vol.Required("task_id"): str,
        vol.Optional("title"): str,
        vol.Optional("completed"): bool,
        vol.Optional("notes"): str,
        vol.Optional("due_date"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_update_task(hass, connection, msg):
    """Update a task."""
    store = hass.data[DOMAIN]
    kwargs = {}
    for key in ("title", "completed", "notes", "due_date"):
        if key in msg:
            kwargs[key] = msg[key]
    try:
        task = await store.async_update_task(msg["list_id"], msg["task_id"], **kwargs)
        connection.send_result(msg["id"], task)
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/delete_task",
        vol.Required("list_id"): str,
        vol.Required("task_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_task(hass, connection, msg):
    """Delete a task."""
    store = hass.data[DOMAIN]
    try:
        await store.async_delete_task(msg["list_id"], msg["task_id"])
        connection.send_result(msg["id"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/reorder_tasks",
        vol.Required("list_id"): str,
        vol.Required("task_ids"): [str],
    }
)
@websocket_api.async_response
async def ws_reorder_tasks(hass, connection, msg):
    """Reorder tasks."""
    store = hass.data[DOMAIN]
    try:
        await store.async_reorder_tasks(msg["list_id"], msg["task_ids"])
        connection.send_result(msg["id"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


# --- Sub-item commands ---


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/add_sub_item",
        vol.Required("list_id"): str,
        vol.Required("task_id"): str,
        vol.Required("title"): str,
    }
)
@websocket_api.async_response
async def ws_add_sub_item(hass, connection, msg):
    """Add a sub-item."""
    store = hass.data[DOMAIN]
    try:
        sub = await store.async_add_sub_item(
            msg["list_id"], msg["task_id"], msg["title"]
        )
        connection.send_result(msg["id"], sub)
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/update_sub_item",
        vol.Required("list_id"): str,
        vol.Required("task_id"): str,
        vol.Required("sub_item_id"): str,
        vol.Optional("title"): str,
        vol.Optional("completed"): bool,
    }
)
@websocket_api.async_response
async def ws_update_sub_item(hass, connection, msg):
    """Update a sub-item."""
    store = hass.data[DOMAIN]
    kwargs = {}
    for key in ("title", "completed"):
        if key in msg:
            kwargs[key] = msg[key]
    try:
        sub = await store.async_update_sub_item(
            msg["list_id"], msg["task_id"], msg["sub_item_id"], **kwargs
        )
        connection.send_result(msg["id"], sub)
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "my_todo_list/delete_sub_item",
        vol.Required("list_id"): str,
        vol.Required("task_id"): str,
        vol.Required("sub_item_id"): str,
    }
)
@websocket_api.async_response
async def ws_delete_sub_item(hass, connection, msg):
    """Delete a sub-item."""
    store = hass.data[DOMAIN]
    try:
        await store.async_delete_sub_item(
            msg["list_id"], msg["task_id"], msg["sub_item_id"]
        )
        connection.send_result(msg["id"])
    except ValueError as err:
        connection.send_error(msg["id"], "not_found", str(err))
