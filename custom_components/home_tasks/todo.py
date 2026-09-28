"""Todo platform for Home Tasks integration."""

from datetime import date, datetime, timezone
import time

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.helpers.entity import CONTEXT_RECENT_TIME_SECONDS
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up todo list entity from a config entry."""
    if entry.data.get("type") == "external":
        return  # External entries do not get a todo entity (managed by other integration)
    store = hass.data[DOMAIN][entry.entry_id]
    entity = HomeTasksEntity(entry, store)
    async_add_entities([entity])


class HomeTasksEntity(TodoListEntity):
    """A todo list entity backed by our custom store."""

    _attr_has_entity_name = True
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
        | TodoListEntityFeature.MOVE_TODO_ITEM
        | TodoListEntityFeature.SET_DUE_DATE_ON_ITEM
        | TodoListEntityFeature.SET_DUE_DATETIME_ON_ITEM
        | TodoListEntityFeature.SET_DESCRIPTION_ON_ITEM
    )

    def __init__(self, entry: ConfigEntry, store) -> None:
        """Initialize the entity."""
        self._entry = entry
        self._store = store
        self._attr_name = entry.data.get("name", entry.title)
        self._attr_unique_id = entry.entry_id

    async def async_added_to_hass(self) -> None:
        """Register store listener so state updates on any data change."""
        self.async_on_remove(
            self._store.async_add_listener(self._handle_store_update)
        )

    @callback
    def _handle_store_update(self) -> None:
        """React to store data changes."""
        self.async_write_ha_state()

    @property
    def todo_items(self) -> list[TodoItem]:
        """Return the todo items."""
        items = []
        for task in self._store.tasks:
            # due: expose as datetime when due_time is set, date otherwise
            due = None
            if task.get("due_date"):
                if task.get("due_time"):
                    h, m = int(task["due_time"][:2]), int(task["due_time"][3:5])
                    due = datetime(
                        *map(int, task["due_date"].split("-")),
                        h, m, tzinfo=dt_util.DEFAULT_TIME_ZONE,
                    )
                else:
                    due = date.fromisoformat(task["due_date"])

            # completed: expose the completion timestamp if available
            completed_dt = None
            if task.get("completed") and task.get("completed_at"):
                try:
                    completed_dt = datetime.fromisoformat(task["completed_at"])
                    if completed_dt.tzinfo is None:
                        completed_dt = completed_dt.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    pass

            items.append(
                TodoItem(
                    uid=task["id"],
                    summary=task["title"],
                    status=(
                        TodoItemStatus.COMPLETED
                        if task["completed"]
                        else TodoItemStatus.NEEDS_ACTION
                    ),
                    due=due,
                    description=task.get("notes") or None,
                    completed=completed_dt,
                )
            )
        return items

    # State is pushed by the store listener; polling did nothing but make HA
    # hand the entity a service call's context again *after* the call, where
    # it would be credited to the next one.
    _attr_should_poll = False

    # The context of the service call that is about to reach this entity —
    # set by HA right before it calls us, used once (issue #65).
    _actor_context: Context | None = None
    _actor_context_at: float = 0.0

    @callback
    def async_set_context(self, context: Context) -> None:
        """HA hands every entity action's context over here first."""
        super().async_set_context(context)
        self._actor_context = context
        self._actor_context_at = time.time()

    async def _async_actor(self) -> tuple[str | None, str | None]:
        """(name, user id) of the user behind the current todo action.

        The context HA set for this call is taken and cleared, so it can't be
        credited to a later call that brought none — Assist's todo intents
        call the entity directly, without a context, and must name nobody
        rather than whoever used a todo action a moment before.
        """
        ctx, at = self._actor_context, self._actor_context_at
        self._actor_context = None
        if not ctx or not ctx.user_id or time.time() - at > CONTEXT_RECENT_TIME_SECONDS:
            return None, None
        user = await self.hass.auth.async_get_user(ctx.user_id)
        return (user.name if user else None), ctx.user_id

    async def async_create_todo_item(self, item: TodoItem) -> None:
        """Create a new todo item."""
        # Due goes in at creation (single 'created' history entry, task_created
        # carries the due); notes/completed remain follow-up updates.
        due_date = due_time = None
        if item.due:
            if isinstance(item.due, datetime):
                due_date = item.due.date().isoformat()
                due_time = item.due.strftime("%H:%M")
            else:
                due_date = item.due.isoformat()
        actor, user_id = await self._async_actor()
        task = await self._store.async_add_task(
            item.summary or "", actor=actor, due_date=due_date, due_time=due_time
        )
        # Apply optional fields
        kwargs = {}
        if item.description:
            kwargs["notes"] = item.description
        if item.status == TodoItemStatus.COMPLETED:
            kwargs["completed"] = True
        if kwargs:
            await self._store.async_update_task(
                task["id"], actor=actor, actor_user_id=user_id, **kwargs
            )
        self.async_write_ha_state()

    async def async_update_todo_item(self, item: TodoItem) -> None:
        """Update a todo item.

        HA always passes a complete TodoItem (existing fields + changes).
        We update all standard fields unconditionally.
        """
        if not item.uid:
            return
        kwargs = {}
        if item.summary is not None:
            kwargs["title"] = item.summary
        if item.status is not None:
            kwargs["completed"] = item.status == TodoItemStatus.COMPLETED
        # due can be a date, datetime, or None (cleared)
        if isinstance(item.due, datetime):
            kwargs["due_date"] = item.due.date().isoformat()
            kwargs["due_time"] = item.due.strftime("%H:%M")
        elif isinstance(item.due, date):
            kwargs["due_date"] = item.due.isoformat()
            kwargs["due_time"] = None
        else:
            kwargs["due_date"] = None
        if item.description is not None:
            kwargs["notes"] = item.description
        if kwargs:
            actor, user_id = await self._async_actor()
            await self._store.async_update_task(
                item.uid, actor=actor, actor_user_id=user_id, **kwargs
            )
        self.async_write_ha_state()

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        """Delete todo items."""
        self._actor_context = None
        for uid in uids:
            await self._store.async_delete_task(uid)
        self.async_write_ha_state()

    async def async_move_todo_item(
        self, uid: str, previous_uid: str | None = None
    ) -> None:
        """Re-order a todo item by placing it after previous_uid (or first if None)."""
        self._actor_context = None
        current_ids = [t["id"] for t in sorted(
            self._store.tasks, key=lambda t: t.get("sort_order", 0)
        )]
        if uid not in current_ids:
            return
        current_ids.remove(uid)
        if previous_uid is None:
            current_ids.insert(0, uid)
        else:
            try:
                idx = current_ids.index(previous_uid)
                current_ids.insert(idx + 1, uid)
            except ValueError:
                current_ids.append(uid)
        await self._store.async_reorder_tasks(current_ids)
        self.async_write_ha_state()
