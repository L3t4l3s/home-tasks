"""Todo platform for Home Tasks integration."""

from datetime import date, datetime, timezone
import logging
import time

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.entity import CONTEXT_RECENT_TIME_SECONDS
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .config_flow import (
    OPTION_FILTER_ASSIGNEES,
    OPTION_FILTER_TAGS,
    OPTION_INCLUDE_UNASSIGNED,
    OPTION_TAG_MODE,
    OPTION_TODO_SORT,
    SORT_DUE,
    SORT_MANUAL,
    SORT_PERSON,
    SORT_PRIORITY,
    SORT_TITLE,
    TAG_MODE_EXCLUDE,
    TAG_MODE_INCLUDE,
    TAG_MODE_OFF,
)
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


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
        # Refresh the filtered todo list when the config entry options change
        # (e.g. the user adjusts the assignee/tag filter).  Updating the
        # entry reference here lets todo_items read the fresh options without
        # a full entry reload.
        self.async_on_remove(
            self._entry.add_update_listener(self._on_options_changed)
        )

    async def _on_options_changed(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Pick up new filter options and push a state refresh."""
        self._entry = entry
        self.async_write_ha_state()

    @callback
    def _handle_store_update(self) -> None:
        """React to store data changes."""
        self.async_write_ha_state()

    @property
    def todo_items(self) -> list[TodoItem]:
        """Return the todo items."""
        opts = self._entry.options
        sort_mode = opts.get(OPTION_TODO_SORT, SORT_MANUAL)
        tasks = [
            t for t in self._store.tasks
            if self._task_matches_filter(t, opts)
        ]
        tasks = self._sort_tasks(tasks, sort_mode)
        items = []
        for task in tasks:
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

    @staticmethod
    def _sort_tasks(tasks: list, sort_mode: str) -> list:
        """Sort tasks for the todo entity, mirroring the card's sort options."""
        if sort_mode == SORT_DUE:
            return sorted(tasks, key=lambda t: (
                t.get("due_date") is None,
                t.get("due_date") or "",
                t.get("due_time") or "",
            ))
        if sort_mode == SORT_PRIORITY:
            return sorted(tasks, key=lambda t: -(t.get("priority") or 0))
        if sort_mode == SORT_TITLE:
            return sorted(tasks, key=lambda t: (t.get("title") or "").lower())
        if sort_mode == SORT_PERSON:
            return sorted(tasks, key=lambda t: (
                t.get("assigned_person") is None,
                t.get("assigned_person") or "",
            ))
        # manual — preserve store sort_order
        return sorted(tasks, key=lambda t: t.get("sort_order", 0))

    @staticmethod
    def _task_matches_filter(task: dict, opts) -> bool:
        """Check whether a task should appear in the filtered todo entity."""
        # --- Assignee filter ---
        selected_assignees = opts.get(OPTION_FILTER_ASSIGNEES) or []
        include_unassigned = opts.get(OPTION_INCLUDE_UNASSIGNED, True)
        assignee = task.get("assigned_person")
        if assignee:
            if selected_assignees and assignee not in selected_assignees:
                return False
        elif not include_unassigned:
            return False

        # --- Tag filter ---
        tag_mode = opts.get(OPTION_TAG_MODE, TAG_MODE_OFF)
        selected_tags = set(opts.get(OPTION_FILTER_TAGS) or [])
        if tag_mode != TAG_MODE_OFF and selected_tags:
            task_tags = set(task.get("tags", []))
            if tag_mode == TAG_MODE_INCLUDE:
                if not (task_tags & selected_tags):
                    return False
            elif tag_mode == TAG_MODE_EXCLUDE:
                if task_tags & selected_tags:
                    return False

        return True

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
        """Delete todo items - but not a recurring task waiting for its next
        occurrence (issue #88).

        To Home Assistant, the phone and other apps such a task is just a
        completed item, so "clear completed" would end the whole series. It
        stays and reopens as planned; the card deletes it, or the item goes
        once its recurrence is switched off.
        """
        self._actor_context = None
        kept = []
        for uid in uids:
            try:
                task = self._store.get_task(uid)
            except ValueError:
                task = None
            if task and task.get("completed") and task.get("recurrence_enabled"):
                kept.append(task.get("title") or uid)
                continue
            await self._store.async_delete_task(uid)
        self.async_write_ha_state()
        if kept and len(kept) < len(uids):
            # Mixed in with others ("clear completed"): the rest goes, and an
            # error here would greet every clear-up - the log says why these stay.
            _LOGGER.info("Kept recurring tasks that reopen at their next occurrence: %s",
                         ", ".join(kept))
        elif kept:
            raise ServiceValidationError(
                "Recurring tasks are not deleted here - they reopen at their next "
                f"occurrence: {', '.join(kept)}. Delete them in the Home Tasks card, "
                "or switch their recurrence off first."
            )

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
