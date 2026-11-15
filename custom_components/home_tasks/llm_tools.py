"""Home Tasks' sets of tools for an LLM.

Home Assistant calls a set of tools an "LLM API". Whatever talks to Home
Assistant through an LLM can be given one: a conversation agent, or an
assistant outside the house through Home Assistant's MCP Server, where every
set has its own address. A set reaches nothing until it is given to one.

There are two kinds of set:

- "Home Tasks", one set for everything: all lists, and all day plans.
- One set per day plan: that plan, and the lists it draws from.

Both offer the same tools; what differs is what they reach. That boundary
is enforced here, on every call, not left to the prompt. The tools do what
a person can do in the cards and an automation with the services: read,
add, change, complete, move, duplicate, order and delete tasks and their
sub-tasks, keep a list's sections and defaults, and fill a plan. Making or
removing a list or a plan, and a plan's settings, stay in Home Assistant's
settings.

Tasks are read and written through the integration's own services, so a
tool does what the same call from an automation would do - validation,
linked lists, completion events and all. What has no service (sections,
defaults, order, copies) goes where the card's commands go.

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
from homeassistant.util import dt as dt_util

from .const import DOMAIN, MAX_REOPEN_LEAD_MINUTES, VALID_RECURRENCE_ANCHORS, VALID_RECURRENCE_UNITS
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
    find_task,
    is_plan,
    plan_name,
    plan_store,
    read_lists,
    resolve_plan,
    source_lists,
)

_WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

_DATE = "Date as YYYY-MM-DD"
_PRIORITY = vol.All(vol.Coerce(int), vol.Range(min=1, max=3))
_ENTRY_ID = (
    "The task's list (entry_id as returned with the task); only needed when two lists hold a task with this id"
)
_LIST = "Name of the list; needed when there are several"

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


async def _actor(hass: HomeAssistant, llm_context: llm.LLMContext) -> str | None:
    """The name of the user an assistant acts for, for a task's history."""
    user_id = llm_context.context.user_id if llm_context.context else None
    if not user_id:
        return None
    user = await hass.auth.async_get_user(user_id)
    return user.name if user else None


# What an assistant has to know to use the tools well.
_TASK_RULES = """\
How the tools work:
- Tasks live in lists. {p}get_lists shows the lists, their sections, their \
fixed tags and what new tasks get by default.
- Priority is 1 (low), 2 (medium) or 3 (high). Dates are YYYY-MM-DD, times HH:MM.
- {p}get_task shows all of one task: its reminders, how it recurs, its history.
- {p}delete_task cannot be undone. Delete only when asked to.
- A completed recurring task counts as done until it opens again; read with \
status "all" to see those.""".replace("{p}", f"{DOMAIN}__")

# How a plan works, and the briefing: how to put a day together when asked to.
_PLAN_RULES = """\
How a day plan works:
- The plan holds references. Tasks stay in their lists: {p}complete_task and \
{p}update_task change the task in its list, {p}unplan_task only takes it off the \
plan. A task that is merely not for today is taken off the plan, not deleted.
- From today on a task is on one day only. {p}plan_task moves it when it is \
already planned.
- Every item of a day has a kind. "planned": put there on purpose. "due" and \
"overdue": there because of the task's due date. Those can be moved to another \
day with {p}plan_task but not removed; to get one off the plan, change the task's \
due date.
- The plan covers its current day and the six workdays after it.

When asked to plan the day:
1. Read the open tasks ({p}get_tasks) and today's plan ({p}get_plan).
2. Keep what is already on today. Due and overdue items are fixed points.
3. If {p}get_plan returns "carry_over", those are open items of the last planned \
day: consider them first.
4. Fill up to a number of items that fits one day, in working order: \
committed dates first, then high priority in the order of the list, then what \
other people are waiting on.
5. Write the order with {p}set_plan and mode "merge", so that nothing the user \
planned gets lost. Leave other days alone unless asked.""".replace("{p}", f"{DOMAIN}__")


def api_id(entry: ConfigEntry) -> str:
    """The id a plan's tool set is registered under."""
    return f"{DOMAIN}-{entry.entry_id}"


# ---------------------------------------------------------------------------
#  What a set reaches
# ---------------------------------------------------------------------------

class _Scope:
    """The lists and plans a set of tools reaches."""

    # Added to "No list ..." and "No task ..." when a set reaches only part.
    lists_where = ""
    tasks_where = ""
    # True: the plan tools act on one plan and take no `plan` argument.
    bound_plan = False

    def lists(self, hass: HomeAssistant) -> list[SourceList]:
        raise NotImplementedError

    def find(self, hass: HomeAssistant, task_id: str, list_hint: str | None) -> tuple[str, dict] | None:
        raise NotImplementedError

    def plans(self, hass: HomeAssistant) -> list[tuple[ConfigEntry, PlanStore]]:
        raise NotImplementedError

    def plan(self, hass: HomeAssistant, name: str | None) -> tuple[ConfigEntry, PlanStore]:
        raise NotImplementedError


class _PlanScope(_Scope):
    """One plan and the lists it draws from."""

    lists_where = " in this plan"
    tasks_where = " in the lists of this plan"
    bound_plan = True

    def __init__(self, entry: ConfigEntry, store: PlanStore) -> None:
        self.entry = entry
        self.store = store

    def lists(self, hass: HomeAssistant) -> list[SourceList]:
        return source_lists(hass, self.entry)

    def find(self, hass, task_id, list_hint):
        return PlanView(hass, self.entry, self.store).find(task_id, list_hint)

    def plans(self, hass):
        return [(self.entry, self.store)]

    def plan(self, hass, name):
        return self.entry, self.store


class _AllScope(_Scope):
    """Every list and every plan."""

    def lists(self, hass: HomeAssistant) -> list[SourceList]:
        return read_lists(hass)

    def find(self, hass, task_id, list_hint):
        sources = read_lists(hass)
        tasks = {src.entry_id: {str(t["id"]): t for t in src.tasks} for src in sources}
        linked = {src.entry_id for src in sources if src.entity_id}
        return find_task(tasks, linked, task_id, list_hint)

    def plans(self, hass):
        plans = []
        for entry in hass.config_entries.async_entries(DOMAIN):
            store = plan_store(hass, entry.entry_id) if is_plan(entry) else None
            if store is not None:
                plans.append((entry, store))
        return plans

    def plan(self, hass, name):
        return resolve_plan(hass, name)


# ---------------------------------------------------------------------------
#  A tool
# ---------------------------------------------------------------------------

class _Tool(llm.Tool):
    """A tool bound to what its set reaches.

    ``key`` is the tool's name without the domain. ``reads`` marks a tool
    that changes nothing, ``destructive`` one that replaces or removes what
    is there, ``idempotent`` one that can be repeated without a further
    change. ``on_tasks`` marks the tools that reach the lists themselves -
    for a linked list that is a provider outside Home Assistant.
    ``plan_note`` is added to the description of a set that has plans.
    """

    key: str
    integration = DOMAIN
    reads = False
    destructive = False
    idempotent = False
    on_tasks = False
    plan_note = ""

    def __init__(self, scope: _Scope, linked: bool = False, has_plans: bool = False) -> None:
        self._scope = scope
        self.name = f"{DOMAIN}__{self.key}"
        if self.plan_note and has_plans:
            self.description = f"{self.description} {self.plan_note}"
        if _ToolAnnotations:
            self.annotations = _ToolAnnotations(
                read_only=self.reads,
                destructive=self.destructive,
                idempotent=self.idempotent,
                open_world=self.on_tasks and linked,
            )

    # --- the set's boundary ---

    def _list_names(self, hass: HomeAssistant) -> str:
        return ", ".join(src.name for src in self._scope.lists(hass)) or "none"

    def _list_id(self, hass: HomeAssistant, value: str | None) -> str:
        """The entry id of one of the set's lists, by name or id."""
        sources = self._scope.lists(hass)
        if not value:
            if len(sources) == 1:
                return sources[0].entry_id
            raise HomeAssistantError(f"Name the list (lists: {self._list_names(hass)})")
        key = value.strip().lower()
        for src in sources:
            if src.entry_id == value or src.name.lower() == key:
                return src.entry_id
        raise HomeAssistantError(
            f"No list {value!r}{self._scope.lists_where} (lists: {self._list_names(hass)})"
        )

    def _task(self, hass: HomeAssistant, task_id: str, list_hint: str | None = None) -> tuple[str, dict]:
        """``(list entry id, task)`` for a task in one of the set's lists.

        *list_hint* only chooses between the set's lists: a list outside it
        is never looked at.
        """
        found = self._scope.find(hass, task_id, list_hint)
        if not found:
            raise HomeAssistantError(f"No task with id {task_id}{self._scope.tasks_where}")
        return found

    def _source(self, hass: HomeAssistant, entry_id: str) -> SourceList:
        """One of the set's lists; its entity_id says whether it is linked."""
        return next(src for src in self._scope.lists(hass) if src.entry_id == entry_id)

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

    async def async_call(
        self, hass: HomeAssistant, tool_input: llm.ToolInput, llm_context: llm.LLMContext
    ):
        args = self.parameters(tool_input.tool_args)
        try:
            data = await self._run(hass, args, llm_context)
        except ValueError as err:
            # What the stores turn down, said the way a tool says it.
            raise HomeAssistantError(str(err)) from err
        return _result(data)

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        raise NotImplementedError


# ---------------------------------------------------------------------------
#  Lists
# ---------------------------------------------------------------------------

def _list_store(hass: HomeAssistant, entry_id: str):
    """What Home Tasks keeps for a list: its tasks (native) or what it adds
    to a provider's (linked). Both have the same sections and defaults."""
    return hass.data[DOMAIN][entry_id]


def _sections(store) -> list[dict]:
    return sorted(store.sections, key=lambda s: s.get("sort_order", 0))


def _section(store, value: str, list_name: str) -> dict:
    """A section of a list, by name or id."""
    sections = _sections(store)
    key = value.strip().lower()
    for section in sections:
        if section["id"] == value or section["name"].lower() == key:
            return section
    names = ", ".join(s["name"] for s in sections) or "none"
    raise HomeAssistantError(f"No section {value!r} in {list_name} (sections: {names})")


def _list_info(hass: HomeAssistant, src: SourceList) -> dict:
    store = _list_store(hass, src.entry_id)
    sections = _sections(store)
    names = {s["id"]: s["name"] for s in sections}
    defaults = store.get_defaults()
    info: dict = {"entry_id": src.entry_id, "name": src.name, "kind": "linked" if src.entity_id else "native"}
    if src.entity_id:
        info["entity_id"] = src.entity_id
        if src.away:
            info["away"] = True
    info["open_tasks"] = sum(1 for task in src.tasks if not task.get("completed"))
    info["sections"] = [s["name"] for s in sections]
    info["fixed_tags"] = defaults["tag_catalog"]
    info["defaults"] = {
        "assigned_persons": defaults["assignees"],
        "reminders": defaults["reminders"],
        "tags": defaults["tags"],
        "priority": defaults["priority"],
        "section": names.get(defaults["section_id"]),
    }
    if not src.entity_id:
        info["defaults"]["reopen_early_minutes"] = defaults.get("recurrence_reopen_lead", 0)
    return info


class GetListsTool(_Tool):
    key = "get_lists"
    title = "Read the lists"
    reads = True
    idempotent = True
    description = (
        "Read the lists: per list its id, name and kind (native, or linked to another app), "
        "how many tasks are open, its sections, its fixed tags and what new tasks get by default."
    )
    plan_note = "Also the day plans, with the lists each draws from."
    parameters = vol.Schema({})

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        result: dict = {"lists": [_list_info(hass, src) for src in self._scope.lists(hass)]}
        plans = self._scope.plans(hass)
        if plans:
            result["plans"] = [
                {
                    "entry_id": entry.entry_id,
                    "name": plan_name(entry),
                    "lists": [src.name for src in source_lists(hass, entry)],
                }
                for entry, _store in plans
            ]
        return result


# ---------------------------------------------------------------------------
#  Tasks
# ---------------------------------------------------------------------------

class GetTasksTool(_Tool):
    key = "get_tasks"
    title = "Read tasks"
    reads = True
    idempotent = True
    on_tasks = True
    description = (
        "Read tasks with all their fields: id, list, title, priority, tags, assignees, "
        "due date, notes, sub-tasks, last change. Open tasks by default, in the order of each list."
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
            entry_ids = [src.entry_id for src in self._scope.lists(hass)]
        if not entry_ids:
            return {"lists": [], "tasks": []}
        data = {"entry_id": entry_ids, "status": args["status"]}
        for key in ("tag", "assigned_person", "due"):
            if args.get(key):
                data[key] = args[key]
        result = await self._service(hass, llm_context, "get_tasks", data, response=True)
        return {"lists": result["lists"], "tasks": result["tasks"]}


class GetTaskTool(_Tool):
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
        vol.Optional("entry_id", description=_ENTRY_ID): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        src = self._source(hass, entry_id)
        if src.entity_id:
            # The lists are read without asking a linked list's provider. For
            # one task in full the provider is asked: it may hold fields of
            # its own (labels, a priority).
            from . import _external_tasks

            try:
                fresh = await _external_tasks(hass, src.entity_id)
            except Exception:  # noqa: BLE001 - the provider is away: what Home Tasks knows
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


class AddTaskTool(_Tool):
    key = "add_task"
    title = "Add a task"
    on_tasks = True
    description = "Create a task in a list. Returns its id."
    plan_note = f"The task is not on a day plan yet: use {DOMAIN}__plan_task for that, or give it a due date."
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
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


class UpdateTaskTool(_Tool):
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
        vol.Optional("entry_id", description=_ENTRY_ID): str,
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
        result = {"success": True, "task_id": data["task_id"]}
        if "title" in args:
            # A provider that makes a new item of a renamed one (Bring!): the
            # task goes on under a new id, which later calls need.
            from .websocket_api import renamed_task_uid

            entry = hass.config_entries.async_get_entry(data["entry_id"])
            entity_id = entry.data.get("entity_id") if entry else None
            new_id = renamed_task_uid(hass, entity_id, data["task_id"]) if entity_id else None
            if new_id:
                result["task_id"] = new_id
                result["id_changed"] = True
        return result


class CompleteTaskTool(_Tool):
    key = "complete_task"
    title = "Complete a task"
    # Not idempotent: a recurring task that has opened again is completed
    # once more, for its next occurrence.
    on_tasks = True
    description = "Mark a task as done. A recurring task opens again for its next occurrence."
    plan_note = "On a day plan it stays on its day as done."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        await self._service(
            hass, llm_context, "complete_task", {"entry_id": entry_id, "task_id": str(task["id"])}
        )
        return {"success": True, "task_id": str(task["id"]), "title": task.get("title", "")}


class ReopenTaskTool(_Tool):
    key = "reopen_task"
    title = "Reopen a task"
    idempotent = True
    on_tasks = True
    description = "Open a completed task again - the way to take back a tick."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        await self._service(
            hass, llm_context, "reopen_task", {"entry_id": entry_id, "task_id": str(task["id"])}
        )
        return {"success": True, "task_id": str(task["id"]), "title": task.get("title", "")}


class DeleteTaskTool(_Tool):
    key = "delete_task"
    title = "Delete a task"
    destructive = True
    on_tasks = True
    description = (
        "Delete a task for good, with its sub-tasks and its history. This cannot be undone: "
        "use it only when asked to delete."
    )
    plan_note = f"To take a task off a day plan, use {DOMAIN}__unplan_task."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
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


class MoveTaskTool(_Tool):
    key = "move_task"
    title = "Move a task to another list"
    on_tasks = True
    description = (
        "Move a task to another list. Between lists of different kinds the task "
        "gets a new id: read the target list for it."
    )
    plan_note = "A task keeps its day on a plan that draws from both lists."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
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


class DuplicateTaskTool(_Tool):
    key = "duplicate_task"
    title = "Duplicate a task"
    on_tasks = True
    description = (
        "Make an open copy of a task in the same list, with everything it has; its sub-tasks "
        "start open. The copy is a task of its own. Returns its id."
    )
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
        vol.Optional(
            "assigned_person",
            description="Give the copy to this person only (entity id); left out, it keeps the task's assignees",
        ): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        src = self._source(hass, entry_id)
        # A copy made for the same primary assignee keeps all of them.
        person = args.get("assigned_person") or task.get("assigned_person")
        if src.entity_id:
            from .websocket_api import async_duplicate_external_task

            new_id = await async_duplicate_external_task(hass, src.entity_id, str(task["id"]), person)
        else:
            copy = await _list_store(hass, entry_id).async_duplicate_task(
                str(task["id"]), assigned_person=person, actor=await _actor(hass, llm_context),
            )
            new_id = copy["id"]
        return {"success": True, "task_id": str(new_id), "entry_id": entry_id, "title": task.get("title", "")}


class ReorderTasksTool(_Tool):
    key = "reorder_tasks"
    title = "Put tasks in order"
    idempotent = True
    on_tasks = True
    description = (
        "Put the tasks of a list in order. The tasks named come first, in the order given; "
        "the others follow in the order they had. In a list with sections the order holds "
        "within each section."
    )
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
        vol.Required("task_ids", description="Ids of tasks of the list, in the order wanted"): [str],
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        src = self._source(hass, entry_id)
        current = [str(task["id"]) for task in src.tasks]
        named = list(dict.fromkeys(str(task_id) for task_id in args["task_ids"]))
        unknown = [task_id for task_id in named if task_id not in current]
        if unknown:
            raise HomeAssistantError(f"Not in {src.name}: {', '.join(unknown)}")
        order = named + [task_id for task_id in current if task_id not in named]
        if src.entity_id:
            from .websocket_api import async_reorder_external_tasks

            await async_reorder_external_tasks(hass, src.entity_id, order)
        else:
            await _list_store(hass, entry_id).async_reorder_tasks(order)
        return {"success": True, "list_name": src.name}


class AddSubTaskTool(_Tool):
    key = "add_sub_task"
    title = "Add a sub-task"
    on_tasks = True
    description = "Add a sub-task to a task. Returns the sub-task's id."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
        vol.Required("title"): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id, task = self._task(hass, args["task_id"], args.get("entry_id"))
        result = await self._service(
            hass, llm_context, "add_sub_task",
            {"entry_id": entry_id, "task_id": str(task["id"]), "title": args["title"]}, response=True,
        )
        return {"success": True, "task_id": str(task["id"]), "sub_task_id": result.get("sub_task_id")}


class UpdateSubTaskTool(_Tool):
    key = "update_sub_task"
    title = "Change a sub-task"
    destructive = True
    idempotent = True
    on_tasks = True
    description = f"Rename a sub-task, tick it off or open it again. Its id is in {DOMAIN}__get_tasks."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
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


class RemoveSubTaskTool(_Tool):
    key = "remove_sub_task"
    title = "Remove a sub-task"
    destructive = True
    on_tasks = True
    description = "Delete a sub-task of a task. This cannot be undone."
    parameters = vol.Schema({
        vol.Required("task_id"): str,
        vol.Optional("entry_id", description=_ENTRY_ID): str,
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
#  A list's sections and defaults
# ---------------------------------------------------------------------------

_ICON = "A Material Design icon, e.g. mdi:cart"


async def _place_section(store, section_id: str, position: int) -> None:
    """Put a section at a place (1 = first) among the list's sections."""
    order = [s["id"] for s in _sections(store) if s["id"] != section_id]
    order.insert(max(0, min(position - 1, len(order))), section_id)
    await store.async_reorder_sections(order)


class AddSectionTool(_Tool):
    key = "add_section"
    title = "Add a section to a list"
    description = (
        "Add a section to a list - a heading tasks are grouped under, like a store aisle or a room. "
        "New sections come last unless a position is given."
    )
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
        vol.Required("name"): str,
        vol.Optional("icon", description=_ICON): str,
        vol.Optional("position", description="Its place among the sections, 1 = first"): vol.All(
            vol.Coerce(int), vol.Range(min=1)
        ),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        store = _list_store(hass, entry_id)
        section = await store.async_add_section(args["name"], icon=args.get("icon"))
        if "position" in args:
            await _place_section(store, section["id"], args["position"])
        return {"success": True, "list_name": self._source(hass, entry_id).name,
                "sections": [s["name"] for s in _sections(store)]}


class UpdateSectionTool(_Tool):
    key = "update_section"
    title = "Change a section"
    destructive = True
    idempotent = True
    description = "Rename a section of a list, change its icon, or move it to another place among the sections."
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
        vol.Required("section", description="The section's name"): str,
        vol.Optional("name", description="Its new name"): str,
        vol.Optional("icon", description=_ICON + "; null for none"): vol.Any(None, str),
        vol.Optional("position", description="Its place among the sections, 1 = first"): vol.All(
            vol.Coerce(int), vol.Range(min=1)
        ),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        src = self._source(hass, entry_id)
        store = _list_store(hass, entry_id)
        section = _section(store, args["section"], src.name)
        changes = {key: args[key] for key in ("name", "icon") if key in args}
        if not changes and "position" not in args:
            raise HomeAssistantError("Nothing to change: give name, icon or position")
        if changes:
            await store.async_update_section(section["id"], **changes)
        if "position" in args:
            await _place_section(store, section["id"], args["position"])
        return {"success": True, "list_name": src.name, "sections": [s["name"] for s in _sections(store)]}


class DeleteSectionTool(_Tool):
    key = "delete_section"
    title = "Delete a section"
    destructive = True
    description = "Delete a section of a list. Its tasks stay in the list, without a section."
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
        vol.Required("section", description="The section's name"): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        src = self._source(hass, entry_id)
        store = _list_store(hass, entry_id)
        section = _section(store, args["section"], src.name)
        await store.async_delete_section(section["id"])
        return {"success": True, "list_name": src.name, "sections": [s["name"] for s in _sections(store)]}


class SetListDefaultsTool(_Tool):
    key = "set_list_defaults"
    title = "Set a list's defaults"
    destructive = True
    idempotent = True
    description = (
        "Set what every new task of a list gets, however it is added, and the list's fixed tags "
        "(always offered when tagging). Only the fields given are changed; null or an empty list "
        f"clears one. {DOMAIN}__get_lists shows what is set."
    )
    parameters = vol.Schema({
        vol.Optional("list", description=_LIST): str,
        vol.Optional("assigned_persons", description="Person entity ids"): [str],
        vol.Optional("reminders", description="Minutes before the due moment"): [
            vol.All(vol.Coerce(int), vol.Range(min=0))
        ],
        vol.Optional("tags"): [str],
        vol.Optional("priority", description="1 (low), 2 (medium), 3 (high), or null for none"): vol.Any(
            None, _PRIORITY
        ),
        vol.Optional("section", description="Name of a section of the list, or null for none"): vol.Any(
            None, str
        ),
        vol.Optional("fixed_tags", description="The tags always offered in this list"): [str],
        vol.Optional(
            "reopen_early_minutes",
            description="Native lists: a recurring task comes back this many minutes before it is due; 0 = when due",
        ): vol.All(vol.Coerce(int), vol.Range(min=0, max=MAX_REOPEN_LEAD_MINUTES)),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry_id = self._list_id(hass, args.get("list"))
        src = self._source(hass, entry_id)
        store = _list_store(hass, entry_id)
        changes: dict = {}
        for arg, field in (
            ("assigned_persons", "assignees"), ("reminders", "reminders"), ("tags", "tags"),
            ("priority", "priority"), ("fixed_tags", "tag_catalog"),
        ):
            if arg in args:
                changes[field] = args[arg]
        if "section" in args:
            changes["section_id"] = (
                _section(store, args["section"], src.name)["id"] if args["section"] else None
            )
        if "reopen_early_minutes" in args:
            if src.entity_id:
                raise HomeAssistantError("Reopening early is for native lists only")
            changes["recurrence_reopen_lead"] = args["reopen_early_minutes"]
        if not changes:
            raise HomeAssistantError("Nothing to change: give at least one field")
        await store.async_set_defaults(**changes)
        info = _list_info(hass, src)
        return {"success": True, "list_name": src.name, "defaults": info["defaults"],
                "fixed_tags": info["fixed_tags"]}


# ---------------------------------------------------------------------------
#  Day plans
# ---------------------------------------------------------------------------

class _PlanTool(_Tool):
    """A tool on a day plan. In a set of every list it names the plan."""

    def __init__(self, scope: _Scope, linked: bool = False, has_plans: bool = False) -> None:
        super().__init__(scope, linked, has_plans)
        if not scope.bound_plan:
            self.parameters = self.parameters.extend({
                vol.Optional("plan", description="Name of the day plan; needed when there are several"): str,
            })

    def _plan(self, hass: HomeAssistant, args: dict) -> tuple[ConfigEntry, PlanStore]:
        return self._scope.plan(hass, args.get("plan"))

    @staticmethod
    def _day(hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, day: date | None) -> dict:
        view = PlanView(hass, entry, store)
        return view.day(day or view.current)


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
        entry, store = self._plan(hass, args)
        view = PlanView(hass, entry, store)
        return {
            "plan": plan_name(entry),
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
        entry, store = self._plan(hass, args)
        day = _date(args.get("date"))
        extra = {"note": args["note"]} if "note" in args else {}
        refs = [
            (item["task_id"], item["entry_id"]) if isinstance(item, dict) else (item, None)
            for item in args["task_ids"]
        ]
        await async_set_day(
            hass, entry, store, refs,
            day=day, mode=args["mode"], updated_by="llm", **extra,
        )
        return {"success": True, "day": self._day(hass, entry, store, day)}


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
        vol.Optional("entry_id", description=_ENTRY_ID): str,
        vol.Optional("date", description=_DATE + "; today when left out"): str,
        vol.Optional("position", default="bottom"): vol.In(["top", "bottom"]),
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry, store = self._plan(hass, args)
        day = _date(args.get("date"))
        await async_plan_task(
            hass, entry, store, args["task_id"],
            day=day, position=args["position"], list_hint=args.get("entry_id"), updated_by="llm",
        )
        return {"success": True, "date": self._day(hass, entry, store, day)["date"]}


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
        vol.Optional("entry_id", description=_ENTRY_ID): str,
    })

    async def _run(self, hass: HomeAssistant, args: dict, llm_context: llm.LLMContext) -> dict:
        entry, store = self._plan(hass, args)
        await async_unplan_task(hass, entry, store, args["task_id"], list_hint=args.get("entry_id"))
        return {"success": True}


_TOOLS = (
    GetListsTool,
    GetTasksTool, GetTaskTool, AddTaskTool, UpdateTaskTool, CompleteTaskTool, ReopenTaskTool,
    DeleteTaskTool, MoveTaskTool, DuplicateTaskTool, ReorderTasksTool,
    AddSubTaskTool, UpdateSubTaskTool, RemoveSubTaskTool,
    AddSectionTool, UpdateSectionTool, DeleteSectionTool, SetListDefaultsTool,
)
_PLAN_TOOLS = (GetPlanTool, SetPlanTool, PlanTaskTool, UnplanTaskTool)


# ---------------------------------------------------------------------------
#  The sets
# ---------------------------------------------------------------------------

def _names(names: list[str]) -> str:
    return ", ".join(f'"{name}"' for name in names)


class _ToolSet(llm.API):
    """The tools of a scope, and what an assistant should know about it."""

    scope: _Scope

    def _intro(self, lists: list[SourceList], plans: list[tuple[ConfigEntry, PlanStore]]) -> list[str]:
        raise NotImplementedError

    async def async_get_api_instance(self, llm_context: llm.LLMContext) -> llm.APIInstance:
        lists = self.scope.lists(self.hass)
        plans = self.scope.plans(self.hass)
        # A linked list is kept by a provider, often one outside the house.
        linked = any(src.entity_id for src in lists)
        tools = [tool(self.scope, linked, bool(plans)) for tool in _TOOLS]
        if plans:
            tools += [tool(self.scope, linked, True) for tool in _PLAN_TOOLS]
        prompt = "\n".join(self._intro(lists, plans)) + "\n\n" + _TASK_RULES
        if plans:
            prompt += "\n\n" + _PLAN_RULES
        return llm.APIInstance(api=self, api_prompt=prompt, llm_context=llm_context, tools=tools)


class PlanAPI(_ToolSet):
    """One plan and the lists it draws from."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
        super().__init__(hass=hass, id=api_id(entry), name=plan_name(entry))
        self.scope = _PlanScope(entry, store)

    def _intro(self, lists, plans) -> list[str]:
        entry, store = self.scope.entry, self.scope.store
        view = PlanView(self.hass, entry, store)
        names = _names([src.name for src in lists]) or "none yet"
        lines = [
            f'These tools work on the day plan "{plan_name(entry)}" of Home Tasks and on '
            f"the task lists it draws from: {names}. Nothing else can be reached through them.",
            f"Today is {_WEEKDAY_NAMES[view.today.weekday()]}, {view.today.isoformat()}.",
        ]
        if view.current != view.today:
            lines.append(
                "Today is a day off in this plan. Its current day, which the tools mean by "
                f'"today", is {_WEEKDAY_NAMES[view.current.weekday()]}, {view.current.isoformat()}.'
            )
        if len(view.workdays) < 7:
            days = ", ".join(_WEEKDAY_NAMES[day] for day in sorted(view.workdays))
            lines.append(f"The plan's workdays are {days}. Other days do not exist in it.")
        return lines


class HomeTasksAPI(_ToolSet):
    """Every list and every plan of Home Tasks."""

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass=hass, id=DOMAIN, name="Home Tasks")
        self.scope = _AllScope()

    def _intro(self, lists, plans) -> list[str]:
        today = dt_util.now().date()
        text = f"the task lists {_names([src.name for src in lists])}" if lists else "no task lists yet"
        if plans:
            described = [
                f'"{plan_name(entry)}" (lists: {_names([src.name for src in source_lists(self.hass, entry)]) or "none"})'
                for entry, _store in plans
            ]
            text += f", and the day plans {', '.join(described)}"
        lines = [
            f"These tools work on Home Tasks: {text}. Nothing else can be reached through them.",
            f"Today is {_WEEKDAY_NAMES[today.weekday()]}, {today.isoformat()}.",
        ]
        if len(plans) > 1:
            lines.append('There are several day plans: the plan tools take the plan\'s name as "plan".')
        return lines


@callback
def async_register_plan_api(hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
    """Offer a plan's tools for as long as the plan is loaded."""
    entry.async_on_unload(llm.async_register_api(hass, PlanAPI(hass, entry, store)))


@callback
def async_register_home_tasks_api(hass: HomeAssistant) -> None:
    """Offer the tools for every list and plan, for as long as Home Assistant runs."""
    llm.async_register_api(hass, HomeTasksAPI(hass))
