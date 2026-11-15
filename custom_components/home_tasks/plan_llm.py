"""A plan's set of tools for an LLM.

Each plan registers one set (Home Assistant calls it an "LLM API"). Whatever
talks to Home Assistant through an LLM can be given it: a conversation agent,
or an assistant outside the house through Home Assistant's MCP Server, where
every set has its own address.

The set reaches the plan and the lists the plan draws from, and nothing
else: no devices, no other lists. That boundary is enforced here, on every
call, not left to the prompt.

Tasks are read and written through the integration's own services, so a
tool does what the same call from an automation would do - validation,
linked lists, completion events and all.

Home Assistant's tool interface grew in 2026: tools name their integration,
carry its domain in their name, say whether they only read, and answer with
a ToolResult. All of that is done here where the running version knows it,
and left out where it does not.
"""

from __future__ import annotations

from datetime import date
import json

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import llm

from .const import DOMAIN, VALID_RECURRENCE_ANCHORS, VALID_RECURRENCE_UNITS
from .plan import (
    MAX_PLAN_NOTE_LENGTH,
    PLAN_HORIZON_DAYS,
    SET_MODES,
    PlanStore,
    PlanView,
    SourceList,
    async_plan_task,
    async_set_day,
    async_unplan_task,
    plan_name,
    source_lists,
)

_WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

_DATE = "Date as YYYY-MM-DD"
_PRIORITY = vol.All(vol.Coerce(int), vol.Range(min=1, max=3))

# How much of a task's history get_task returns.
_HISTORY_ENTRIES = 20

_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# How a task recurs, as one argument. The services take the same as
# recurrence_* fields and check how they go together.
_RECURRENCE = vol.Schema({
    vol.Optional(
        "unit", description="hours, days, weeks, months or years; needed to make a task recurring"
    ): vol.In(list(VALID_RECURRENCE_UNITS)),
    vol.Optional("every", description="Every n units; 1 when left out"): vol.All(
        vol.Coerce(int), vol.Range(min=1)
    ),
    vol.Optional(
        "weekdays", description="With unit weeks: the days it recurs on. With nth_week: that one weekday"
    ): [vol.In(_WEEKDAYS)],
    vol.Optional("day_of_month", description='With unit months: 1-31 or "last"'): vol.Any(
        "last", vol.All(vol.Coerce(int), vol.Range(min=1, max=31))
    ),
    vol.Optional(
        "nth_week", description='With unit months and one weekday: 1-4 or "last" - the 2nd Tuesday'
    ): vol.Any("last", vol.All(vol.Coerce(int), vol.Range(min=1, max=4))),
    vol.Optional("anniversary", description="With unit years: the day as MM-DD"): str,
    vol.Optional(
        "anchor", description="Count from the completion (the default) or from the due date"
    ): vol.In(list(VALID_RECURRENCE_ANCHORS)),
    vol.Optional("start_date", description=_DATE): str,
    vol.Optional("time", description="The time of day it comes back, HH:MM"): str,
    vol.Optional("end_date", description=_DATE + "; null for no end"): vol.Any(None, str),
    vol.Optional("max_count", description="Ends after this many times; null for no limit"): vol.Any(
        None, vol.All(vol.Coerce(int), vol.Range(min=1))
    ),
})


def _more_fields(update: bool) -> dict:
    """What a task can have beyond the basics, for add_task and update_task."""
    clear = "; null for none" if update else ""
    return {
        vol.Optional("section", description="Name of a section of the task's list" + clear): (
            vol.Any(None, str) if update else str
        ),
        vol.Optional(
            "reminders",
            description="Minutes before the due moment, e.g. [60, 0] (0 = at the due time). Needs a due date"
            + ("; an empty list clears them" if update else ""),
        ): [vol.All(vol.Coerce(int), vol.Range(min=0))],
        vol.Optional(
            "recurrence",
            description="How the task recurs" + ("; null switches recurring off" if update else ""),
        ): vol.Any(None, _RECURRENCE) if update else _RECURRENCE,
        vol.Optional("position", description="Where in its list: top or bottom"): vol.In(["top", "bottom"]),
        vol.Optional("image_url", description="A picture for the task (URL or /local/ path)" + clear): (
            vol.Any(None, str) if update else str
        ),
        vol.Optional(
            "generate_image", description="Have the picture drawn by the AI set up for task pictures"
        ): bool,
    }


def _apply_more_fields(args: dict, data: dict) -> None:
    """Put the arguments of _more_fields into a service call's data."""
    for key in ("section", "reminders", "position", "image_url", "generate_image"):
        if key in args:
            data[key] = args[key]
    if "recurrence" not in args:
        return
    recurrence = args["recurrence"]
    if recurrence is None:
        data["recurrence_enabled"] = False
        return
    if not recurrence:
        data["recurrence_enabled"] = True
    for key, value in recurrence.items():
        data["recurrence_value" if key == "every" else f"recurrence_{key}"] = value


# Not there before Home Assistant 2026: a tool then returns the plain data.
_ToolResult = getattr(llm, "ToolResult", None)
_ToolAnnotations = getattr(llm, "ToolAnnotations", None)


def _result(data: dict):
    return _ToolResult(data=data) if _ToolResult else data


def _date(value: str | None) -> date | None:
    """A tool's date argument. A plain string in the schema, so that every
    client is told its type; what the string says is checked here."""
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as err:
        raise HomeAssistantError(f"Not a date: {value!r} (use YYYY-MM-DD)") from err


# What an assistant has to know to use the tools well. The second half is
# the briefing: how to put a day together when asked to.
_RULES = """\
How the plan works:
- The plan holds references. Tasks stay in their lists: {p}complete_task and \
{p}update_task change the task in its list, {p}unplan_task only takes it off the plan.
- From today on a task is on one day only. {p}plan_task moves it when it is \
already planned.
- Every item of a day has a kind. "planned": put there on purpose. "due" and \
"overdue": there because of the task's due date. Those can be moved to another \
day with {p}plan_task but not removed; to get one off the plan, change the task's \
due date.
- The plan covers its current day and the six workdays after it.
- Priority is 1 (low), 2 (medium) or 3 (high). Dates are YYYY-MM-DD, times HH:MM.
- {p}get_task shows all of one task: its reminders, how it recurs, its history.
- {p}delete_task cannot be undone. Delete only when asked to; a task that is \
merely not for today is taken off the plan, not deleted.

When asked to plan the day:
1. Read the open tasks ({p}get_tasks) and today's plan ({p}get_plan).
2. Keep what is already on today. Due and overdue items are fixed points.
3. If {p}get_plan returns "carry_over", those are open items of the last planned \
day: consider them first.
4. Fill up to a number of items that fits one day, in working order: \
committed dates first, then high priority in the order of the list, then what \
other people are waiting on.
5. Write the order with {p}set_plan and mode "merge", so that nothing the user \
planned gets lost. Leave other days alone unless asked.
6. A completed recurring task counts as done until it opens again; read with \
status "all" to see those.""".replace("{p}", f"{DOMAIN}__")


def api_id(entry: ConfigEntry) -> str:
    """The id a plan's tool set is registered under."""
    return f"{DOMAIN}-{entry.entry_id}"


class _PlanTool(llm.Tool):
    """A tool bound to one plan.

    ``key`` is the tool's name without the domain. ``reads`` marks a tool
    that changes nothing, ``destructive`` one that replaces or removes what
    is there, ``idempotent`` one that can be repeated without a further
    change. ``on_tasks`` marks the tools that reach the lists themselves -
    for a linked list that is a provider outside Home Assistant.
    """

    key: str
    integration = DOMAIN
    reads = False
    destructive = False
    idempotent = False
    on_tasks = False

    def __init__(self, entry: ConfigEntry, store: PlanStore, linked: bool = False) -> None:
        self._entry = entry
        self._store = store
        self.name = f"{DOMAIN}__{self.key}"
        if _ToolAnnotations:
            self.annotations = _ToolAnnotations(
                read_only=self.reads,
                destructive=self.destructive,
                idempotent=self.idempotent,
                open_world=self.on_tasks and linked,
            )

    # --- the plan's boundary ---

    def _list_names(self, hass: HomeAssistant) -> str:
        return ", ".join(src.name for src in source_lists(hass, self._entry)) or "none"

    def _list_id(self, hass: HomeAssistant, value: str | None) -> str:
        """The entry id of one of the plan's lists, by name or id."""
        sources = source_lists(hass, self._entry)
        if not value:
            if len(sources) == 1:
                return sources[0].entry_id
            raise HomeAssistantError(f"Name the list (lists: {self._list_names(hass)})")
        key = value.strip().lower()
        for src in sources:
            if src.entry_id == value or src.name.lower() == key:
                return src.entry_id
        raise HomeAssistantError(
            f"No list {value!r} in this plan (lists: {self._list_names(hass)})"
        )

    def _task(self, hass: HomeAssistant, task_id: str, list_hint: str | None = None) -> tuple[str, dict]:
        """``(list entry id, task)`` for a task in one of the plan's lists.

        *list_hint* only chooses between lists of the plan: a list outside
        it is never looked at.
        """
        found = PlanView(hass, self._entry, self._store).find(task_id, list_hint)
        if not found:
            raise HomeAssistantError(f"No task with id {task_id} in the lists of this plan")
        return found

    def _source(self, hass: HomeAssistant, entry_id: str) -> SourceList:
        """One of the plan's lists; its entity_id says whether it is linked."""
        return next(src for src in source_lists(hass, self._entry) if src.entry_id == entry_id)

    async def _service(
        self, hass: HomeAssistant, llm_context: llm.LLMContext, service: str, data: dict,
        response: bool = False,
    ):
        try:
            return await hass.services.async_call(
                DOMAIN, service, data, blocking=True,
                context=llm_context.context, return_response=response,
            )
        except (vol.Invalid, ValueError) as err:
            # The services report a bad value either way; a tool has one way.
            raise HomeAssistantError(str(err)) from err

    def _day(self, hass: HomeAssistant, day: date | None) -> dict:
        view = PlanView(hass, self._entry, self._store)
        return view.day(day or view.current)

    async def async_call(
        self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext
    ):
        args = self.parameters(tool_input.tool_args)
        return _result(await self._run(hass, args, llm_context))

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        raise NotImplementedError


# ---------------------------------------------------------------------------
#  Tasks
# ---------------------------------------------------------------------------

class GetTasksTool(_PlanTool):
    key = "get_tasks"
    title = "Read tasks"
    reads = True
    idempotent = True
    on_tasks = True
    description = (
        "Read the tasks of the plan's lists, with all their fields: id, list, title, "
        "priority, tags, assignees, due date, notes, sub-tasks, last change. "
        "Open tasks by default, in the order of each list."
    )
    parameters = vol.Schema({
        vol.Optional("lists", description="List names to read; all lists when left out"): [str],
        vol.Optional("status", default="open"): vol.In(["open", "completed", "all"]),
        vol.Optional("tag", description="Only tasks with this tag"): str,
        vol.Optional(
            "assigned_person", description="Only tasks of this person (entity id, e.g. person.anna)"
        ): str,
        vol.Optional("due", description="Only tasks due in this range"): vol.In(
            ["today", "overdue", "today_or_overdue"]
        ),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        if args.get("lists"):
            entry_ids = list(dict.fromkeys(self._list_id(hass, name) for name in args["lists"]))
        else:
            entry_ids = [src.entry_id for src in source_lists(hass, self._entry)]
        if not entry_ids:
            return {"lists": [], "tasks": []}
        data = {"entry_id": entry_ids, "status": args["status"]}
        for key in ("tag", "assigned_person", "due"):
            if args.get(key):
                data[key] = args[key]
        result = await self._service(hass, llm_context, "get_tasks", data, response=True)
        return {"lists": result["lists"], "tasks": result["tasks"]}


class GetTaskTool(_PlanTool):
    key = "get_task"
    title = "Read one task"
    reads = True
    idempotent = True
    on_tasks = True
    description = (
        "Read everything about one task: besides what the task list shows, its reminders, "
        "how it recurs, its section, its picture and its recent history."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        src = self._source(hass, entry_id)
        if src.entity_id:
            # The plan reads a linked list without asking its provider. For
            # one task in full the provider is asked: it may hold fields of
            # its own (labels, a priority).
            from . import _external_tasks

            try:
                fresh = await _external_tasks(hass, src.entity_id)
            except Exception:  # noqa: BLE001 - the provider is away: what the plan knows
                fresh = []
            task = next((t for t in fresh if str(t.get("id")) == str(task["id"])), task)
        detail = {key: value for key, value in task.items() if not key.startswith("_")}
        if detail.get("history"):
            detail["history"] = detail["history"][-_HISTORY_ENTRIES:]
        return {
            "entry_id": entry_id,
            "list_name": src.name,
            # Through JSON once: whatever a provider put in, a tool returns plain data.
            "task": json.loads(json.dumps(detail, default=str)),
        }


class AddTaskTool(_PlanTool):
    key = "add_task"
    title = "Add a task"
    on_tasks = True
    description = (
        "Create a task in one of the plan's lists. Returns its id. "
        f"The task is not on the plan yet: use {DOMAIN}__plan_task for that, or give it a due date."
    )
    parameters = vol.Schema({
        vol.Optional("list", description="Name of the list; needed when the plan has several"): str,
        vol.Required("title"): str,
        vol.Optional("notes"): str,
        vol.Optional("due_date", description=_DATE): str,
        vol.Optional("due_time", description="Time as HH:MM; needs a due date"): str,
        vol.Optional("priority", description="1 (low), 2 (medium) or 3 (high)"): _PRIORITY,
        vol.Optional("tags"): [str],
        vol.Optional(
            "assigned_persons", description="Person entity ids, e.g. person.anna"
        ): [str],
        vol.Optional("sub_tasks", description="Titles of sub-tasks"): [str],
        **_more_fields(update=False),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        data: dict = {"entry_id": entry_id, "title": args["title"]}
        for key in ("notes", "due_date", "due_time", "priority", "assigned_persons", "sub_tasks"):
            if args.get(key):
                data[key] = args[key]
        if args.get("tags"):
            data["tags"] = ",".join(args["tags"])
        _apply_more_fields(args, data)
        result = await self._service(hass, llm_context, "add_task", data, response=True)
        return {
            "success": True,
            "task_id": result["task_id"],
            "list_name": result["list_name"],
            "entry_id": entry_id,
        }


class UpdateTaskTool(_PlanTool):
    key = "update_task"
    title = "Change a task"
    destructive = True
    idempotent = True
    on_tasks = True
    description = (
        "Change fields of a task. Only the fields given are changed. "
        "null clears a field: due_date (the time goes with it), due_time, priority, notes, "
        "section, picture; recurrence: null switches recurring off. "
        "An empty list clears tags, assignees or reminders."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Optional("title"): str,
        vol.Optional("notes"): vol.Any(None, str),
        vol.Optional("due_date", description=_DATE + ", or null for no due date"): vol.Any(None, str),
        vol.Optional("due_time", description="Time as HH:MM, or null for none"): vol.Any(None, str),
        vol.Optional("priority", description="1 (low), 2 (medium), 3 (high), or null for none"): vol.Any(
            None, _PRIORITY
        ),
        vol.Optional("tags", description="All tags of the task; replaces the ones it has"): [str],
        vol.Optional(
            "assigned_persons", description="Person entity ids; replaces the current assignees"
        ): [str],
        **_more_fields(update=True),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        data: dict = {"entry_id": entry_id, "task_id": str(task["id"])}
        if "title" in args:
            data["title"] = args["title"]
        # The service clears these with an empty string.
        for key in ("notes", "due_date", "due_time"):
            if key in args:
                data[key] = args[key] or ""
        if "priority" in args:
            data["priority"] = args["priority"]
        if "tags" in args:
            data["tags"] = ",".join(args["tags"])
        if "assigned_persons" in args:
            data["assigned_persons"] = args["assigned_persons"]
        _apply_more_fields(args, data)
        if len(data) == 2:    # only the list and the task: nothing asked for
            raise HomeAssistantError("Nothing to change: give at least one field")
        await self._service(hass, llm_context, "update_task", data)
        return {"success": True, "task_id": data["task_id"]}


class CompleteTaskTool(_PlanTool):
    key = "complete_task"
    title = "Complete a task"
    # Not idempotent: a recurring task that has opened again is completed
    # once more, for its next occurrence.
    on_tasks = True
    description = (
        "Mark a task as done. It stays on the plan as done for the day. "
        "A recurring task opens again for its next occurrence."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        await self._service(
            hass, llm_context, "complete_task", {"entry_id": entry_id, "task_id": str(task["id"])}
        )
        return {"success": True, "task_id": str(task["id"]), "title": task.get("title", "")}


class ReopenTaskTool(_PlanTool):
    key = "reopen_task"
    title = "Reopen a task"
    idempotent = True
    on_tasks = True
    description = "Open a completed task again - the way to take back a tick."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        await self._service(
            hass, llm_context, "reopen_task", {"entry_id": entry_id, "task_id": str(task["id"])}
        )
        return {"success": True, "task_id": str(task["id"]), "title": task.get("title", "")}


class DeleteTaskTool(_PlanTool):
    key = "delete_task"
    title = "Delete a task"
    destructive = True
    on_tasks = True
    description = (
        "Delete a task for good, with its sub-tasks and its history. This cannot be undone: "
        f"use it only when asked to delete. To take a task off the plan, use {DOMAIN}__unplan_task."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        src = self._source(hass, entry_id)
        task_id = str(task["id"])
        if src.entity_id:
            # As the card does it: the provider deletes the task, then what
            # Home Tasks kept for it goes too.
            from .websocket_api import async_delete_external_overlay

            await hass.services.async_call(
                "todo", "remove_item", {"item": task_id}, target={"entity_id": src.entity_id},
                blocking=True, context=llm_context.context,
            )
            await async_delete_external_overlay(hass, src.entity_id, task_id)
        else:
            await hass.data[DOMAIN][entry_id].async_delete_task(task_id)
        return {"success": True, "task_id": task_id, "title": task.get("title", "")}


class MoveTaskTool(_PlanTool):
    key = "move_task"
    title = "Move a task to another list"
    on_tasks = True
    description = (
        "Move a task to another list of the plan. Between lists of different kinds the task "
        "gets a new id: read the target list for it."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Required("to_list", description="Name of the list to move it to"): str,
        vol.Optional(
            "section", description="Name of a section in the target list; left out, a section of the same name is kept"
        ): vol.Any(None, str),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        target_id = self._list_id(hass, args["to_list"])
        if target_id == entry_id:
            raise HomeAssistantError("The task is in that list already")
        src, tgt = self._source(hass, entry_id), self._source(hass, target_id)
        data: dict = {"task_id": str(task["id"])}
        # The service names a linked list by its todo entity.
        if src.entity_id:
            data["source_entity_id"] = src.entity_id
        else:
            data["entry_id"] = entry_id
        if tgt.entity_id:
            data["target_entity_id"] = tgt.entity_id
        else:
            data["target_entry_id"] = target_id
        if "section" in args:
            data["section"] = args["section"]
        await self._service(hass, llm_context, "move_task", data)
        return {"success": True, "entry_id": target_id, "list_name": tgt.name}


class AddSubTaskTool(_PlanTool):
    key = "add_sub_task"
    title = "Add a sub-task"
    on_tasks = True
    description = "Add a sub-task to a task. Returns the sub-task's id."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Required("title"): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        result = await self._service(
            hass, llm_context, "add_sub_task",
            {"entry_id": entry_id, "task_id": str(task["id"]), "title": args["title"]}, response=True,
        )
        return {"success": True, "task_id": str(task["id"]), "sub_task_id": result.get("sub_task_id")}


class UpdateSubTaskTool(_PlanTool):
    key = "update_sub_task"
    title = "Change a sub-task"
    destructive = True
    idempotent = True
    on_tasks = True
    description = f"Rename a sub-task, tick it off or open it again. Its id is in {DOMAIN}__get_tasks."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Required("sub_task_id"): str,
        vol.Optional("title"): str,
        vol.Optional("completed"): bool,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        data: dict = {"entry_id": entry_id, "task_id": str(task["id"]), "sub_task_id": args["sub_task_id"]}
        for key in ("title", "completed"):
            if key in args:
                data[key] = args[key]
        if len(data) == 3:
            raise HomeAssistantError("Nothing to change: give title and/or completed")
        await self._service(hass, llm_context, "update_sub_task", data)
        return {"success": True, "task_id": str(task["id"]), "sub_task_id": args["sub_task_id"]}


class RemoveSubTaskTool(_PlanTool):
    key = "remove_sub_task"
    title = "Remove a sub-task"
    destructive = True
    on_tasks = True
    description = "Delete a sub-task of a task. This cannot be undone."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Required("sub_task_id"): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        await self._service(
            hass, llm_context, "remove_sub_task",
            {"entry_id": entry_id, "task_id": str(task["id"]), "sub_task_id": args["sub_task_id"]},
        )
        return {"success": True, "task_id": str(task["id"])}


# ---------------------------------------------------------------------------
#  The plan
# ---------------------------------------------------------------------------

class GetPlanTool(_PlanTool):
    key = "get_plan"
    title = "Read the day plan"
    reads = True
    idempotent = True
    description = (
        "Read the plan: per day its note and its items in working order, each with "
        "task id, list, title, priority, tags, assignees, due date, whether it is done, "
        "and its kind (planned, due, overdue). Today by default."
    )
    parameters = vol.Schema({
        vol.Optional("date", description=_DATE + "; the first day to read, today when left out"): str,
        vol.Optional("days", default=1, description="How many plan days to read"): vol.All(
            vol.Coerce(int), vol.Range(min=1, max=PLAN_HORIZON_DAYS)
        ),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        view = PlanView(hass, self._entry, self._store)
        return {
            "plan": plan_name(self._entry),
            "today": view.today.isoformat(),
            "days": view.days(_date(args.get("date")) or view.current, args["days"]),
        }


class SetPlanTool(_PlanTool):
    key = "set_plan"
    title = "Set a day of the plan"
    destructive = True
    idempotent = True
    description = (
        "Set the working order of a day, and optionally its note. "
        'With mode "merge" (the default) items already on the day that are not named '
        'stay, after the named ones. With "replace" they are taken off, except what is '
        "done or there through its due date. Returns the day as it reads afterwards."
    )
    parameters = vol.Schema({
        vol.Optional("date", description=_DATE + "; today when left out"): str,
        # No vol.Length: older versions translate it to a string's maxLength.
        # The day's limit is checked when the day is written.
        vol.Required(
            "task_ids",
            description="Tasks in working order: an id, or {task_id, entry_id} to identify its list",
        ): [vol.Any(str, vol.Schema({
            vol.Required("task_id"): str,
            vol.Required("entry_id"): str,
        }))],
        vol.Optional(
            "note", description=f"The day's focus, max {MAX_PLAN_NOTE_LENGTH} characters; null clears it"
        ): vol.Any(None, str),
        vol.Optional("mode", default="merge"): vol.In(list(SET_MODES)),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        day = _date(args.get("date"))
        extra = {"note": args["note"]} if "note" in args else {}
        refs = [
            (item["task_id"], item["entry_id"]) if isinstance(item, dict) else (item, None)
            for item in args["task_ids"]
        ]
        await async_set_day(
            hass, self._entry, self._store, refs,
            day=day, mode=args["mode"], updated_by="llm", **extra,
        )
        return {"success": True, "day": self._day(hass, day)}


class PlanTaskTool(_PlanTool):
    key = "plan_task"
    title = "Plan a task for a day"
    idempotent = True
    description = (
        "Put one task on a day of the plan, at the bottom or the top. "
        "A task that is already planned moves to that day."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
        vol.Optional("date", description=_DATE + "; today when left out"): str,
        vol.Optional("position", default="bottom"): vol.In(["top", "bottom"]),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        day = _date(args.get("date"))
        await async_plan_task(
            hass, self._entry, self._store, args["task_id"],
            day=day, position=args["position"], list_hint=args.get("entry_id"), updated_by="llm",
        )
        return {"success": True, "date": self._day(hass, day)["date"]}


class UnplanTaskTool(_PlanTool):
    key = "unplan_task"
    title = "Take a task off the plan"
    destructive = True
    description = (
        "Take a task off the plan. The task itself stays in its list, unchanged. "
        "Does not work for tasks that are on the plan through their due date."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional(
            "entry_id",
            description="The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        await async_unplan_task(
            hass, self._entry, self._store, args["task_id"], list_hint=args.get("entry_id"),
        )
        return {"success": True}


_TOOLS = (
    GetTasksTool, GetTaskTool, AddTaskTool, UpdateTaskTool, CompleteTaskTool, ReopenTaskTool,
    DeleteTaskTool, MoveTaskTool, AddSubTaskTool, UpdateSubTaskTool, RemoveSubTaskTool,
    GetPlanTool, SetPlanTool, PlanTaskTool, UnplanTaskTool,
)


# ---------------------------------------------------------------------------
#  The set
# ---------------------------------------------------------------------------

class PlanAPI(llm.API):
    """The tools of one plan, and what an assistant should know about it."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
        super().__init__(hass=hass, id=api_id(entry), name=plan_name(entry))
        self._entry = entry
        self._store = store

    def _prompt(self) -> str:
        view = PlanView(self.hass, self._entry, self._store)
        lists = ", ".join(f'"{src.name}"' for src in view.sources) or "none yet"
        lines = [
            f'These tools work on the day plan "{plan_name(self._entry)}" of Home Tasks and on '
            f"the task lists it draws from: {lists}. Nothing else can be reached through them.",
            f"Today is {_WEEKDAY_NAMES[view.today.weekday()]}, {view.today.isoformat()}.",
        ]
        if view.current != view.today:
            lines.append(
                "Today is a day off in this plan. Its current day, which the tools mean by "
                f'"today", is {_WEEKDAY_NAMES[view.current.weekday()]}, {view.current.isoformat()}.'
            )
        if len(view.workdays) < 7:
            names = ", ".join(_WEEKDAY_NAMES[day] for day in sorted(view.workdays))
            lines.append(f"The plan's workdays are {names}. Other days do not exist in it.")
        return "\n".join(lines) + "\n\n" + _RULES

    async def async_get_api_instance(self, llm_context: llm.LLMContext) -> llm.APIInstance:
        # A linked list is kept by a provider, often one outside the house.
        linked = any(src.entity_id for src in source_lists(self.hass, self._entry))
        return llm.APIInstance(
            api=self,
            api_prompt=self._prompt(),
            llm_context=llm_context,
            tools=[tool(self._entry, self._store, linked) for tool in _TOOLS],
        )


@callback
def async_register_plan_api(hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
    """Offer a plan's tools for as long as the plan is loaded."""
    entry.async_on_unload(llm.async_register_api(hass, PlanAPI(hass, entry, store)))
