"""Day plans: per date, an ordered set of references to tasks.

A plan is a view across lists. The tasks stay where they are - in their
list, their section, their place in the list's order - and the plan only
remembers which of them are meant for which day, and in what order. Ticking
a row off or editing it acts on the task in its own list; taking a row out
of the plan removes the reference and nothing else.

A plan is a config entry of its own (type "plan") so that it has a place for
its settings and its sensor, and so that several plans can sit side by side.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import copy
from dataclasses import dataclass
from datetime import date, timedelta
import json
import logging
import zlib

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN, STORAGE_VERSION
from .overlay_store import ExternalTaskOverlayStore
from .store import HomeTasksStore, task_assignees

_LOGGER = logging.getLogger(__name__)

ENTRY_TYPE_PLAN = "plan"
# Plan stores live apart from the list stores in hass.data[DOMAIN]: plenty of
# code walks those and takes whatever is not a native store for a linked one.
DATA_PLANS = f"{DOMAIN}_plans"
# Sent when a list is set up or unloaded, so a plan re-reads which lists it
# draws from.
SIGNAL_LISTS_CHANGED = f"{DOMAIN}_lists_changed"

CONF_SOURCE_LISTS = "source_lists"
CONF_WORKDAYS = "workdays"
CONF_INCLUDE_DUE = "include_due"
CONF_CARRY_OVER = "carry_over"

WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
CARRY_OVER_MODES = ("off", "suggest", "auto")
DEFAULT_CARRY_OVER = "suggest"
SET_MODES = ("merge", "replace")

# Today plus the next six workdays: what the card shows and what may be
# written. A plan further out than a week is a calendar, not a plan.
PLAN_HORIZON_DAYS = 7
PLAN_KEEP_PAST_DAYS = 14
MAX_PLAN_ITEMS_PER_DAY = 100
MAX_PLAN_NOTE_LENGTH = 255

_UNSET = object()


def is_plan(entry: ConfigEntry) -> bool:
    """Whether a config entry is a plan rather than a list."""
    return entry.data.get("type") == ENTRY_TYPE_PLAN


def plan_name(entry: ConfigEntry) -> str:
    return entry.data.get("name") or entry.title


# ---------------------------------------------------------------------------
#  Storage
# ---------------------------------------------------------------------------

class PlanStore:
    """What a plan remembers: per date, the ordered references and a note.

    An item is ``{"task_id", "list", "auto", "done_on"}``:

    - ``list`` is the entry id of the list the task was in. A hint only - a
      task that moved to another list is found there by its id.
    - ``auto`` marks a task that is on the day through its due date and was
      written only to keep its place after a reorder. Once the due date
      points elsewhere the item no longer counts.
    - ``done_on`` is the day itself once the task was completed while it sat
      there. A recurring task opens again later; the day it was done on
      still shows it as done.
    - ``dropped`` (only ever true) marks an unfinished item of a past day
      that was taken off the plan afterwards: the day keeps it as it was
      left, but it is not carried over any more.
    """

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        self._store = Store(hass, STORAGE_VERSION, f"home_tasks_plan_{entry_id}")
        self._data: dict | None = None
        self._listeners: list[Callable[[], None]] = []

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Add a listener for changes. Returns a removal callable."""
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener) if listener in self._listeners else None

    async def async_load(self) -> None:
        data = await self._store.async_load()
        self._data = data if isinstance(data, dict) else {}
        self._data.setdefault("days", {})

    @property
    def days(self) -> dict[str, dict]:
        """The stored days by ISO date. Mutated in place, then saved."""
        return self._data["days"]

    def day(self, key: str) -> dict:
        """The stored day for *key*, created empty when there is none."""
        return self.days.setdefault(
            key, {"items": [], "note": "", "updated": None, "updated_by": None}
        )

    def restore(self, days: dict[str, dict]) -> None:
        """Put back the days as they were (see _all_or_nothing)."""
        self._data["days"] = days

    @callback
    def notify(self) -> None:
        """Tell the listeners the plan reads differently now."""
        for listener in list(self._listeners):
            listener()

    async def async_save(self, today: date) -> None:
        """Persist, dropping what is too old to matter and what is empty."""
        oldest = (today - timedelta(days=PLAN_KEEP_PAST_DAYS)).isoformat()
        for key in [k for k, d in self.days.items() if k < oldest or not (d["items"] or d["note"])]:
            del self.days[key]
        await self._store.async_save(self._data)
        self.notify()

    async def async_remove(self) -> None:
        await self._store.async_remove()


# ---------------------------------------------------------------------------
#  Days
# ---------------------------------------------------------------------------

def plan_workdays(entry: ConfigEntry) -> frozenset[int]:
    """The weekdays (Monday = 0) that exist in this plan; none chosen = all."""
    chosen = [WEEKDAYS.index(d) for d in entry.options.get(CONF_WORKDAYS) or [] if d in WEEKDAYS]
    return frozenset(chosen or range(7))


def next_workday(day: date, workdays: frozenset[int]) -> date:
    """*day* itself when it is a workday, otherwise the first one after it."""
    while day.weekday() not in workdays:
        day += timedelta(days=1)
    return day


def plan_dates(start: date, count: int, workdays: frozenset[int]) -> list[date]:
    """*count* workdays from *start* on."""
    dates: list[date] = []
    day = next_workday(start, workdays)
    while len(dates) < count:
        dates.append(day)
        day = next_workday(day + timedelta(days=1), workdays)
    return dates


def plan_today_and_horizon(entry: ConfigEntry) -> tuple[date, list[date]]:
    """Today, and the days of a plan that can be planned.

    Needs the plan's workdays and nothing else - no list is read for it.
    """
    today = dt_util.now().date()
    workdays = plan_workdays(entry)
    return today, plan_dates(next_workday(today, workdays), PLAN_HORIZON_DAYS, workdays)


def due_day(due: date, today: date, workdays: frozenset[int]) -> date:
    """The plan day a due date falls on.

    A due date on a day off is work for the workday before it - a delivery
    promised for Saturday has to be finished on Friday. What is already past
    belongs to the current day.
    """
    day = due
    while day.weekday() not in workdays:
        day -= timedelta(days=1)
    return max(day, next_workday(today, workdays))


def plan_fingerprint(view: "PlanView") -> str:
    """Changes exactly when a plan may read differently.

    That is: a task of one of its lists changed, something was written to
    the plan, its settings changed, or the day turned. A provider reporting
    the same tasks again - which linked lists do every few minutes - leaves
    it as it is.
    """
    raw = json.dumps([
        view.today.isoformat(),
        [(src.entry_id, src.name, source_stamp(src)) for src in view.sources],
        view.store.days,
        dict(view.entry.options),
    ], sort_keys=True, default=str)
    return format(zlib.crc32(raw.encode()), "08x")


def _due_order(task: dict) -> tuple:
    """Where a task that is on a day through its due date stands among its like."""
    return (task.get("due_date") or "", task.get("due_time") or "99:99", -(task.get("priority") or 0))


def _parse_date(value) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _completed_on(task: dict) -> date | None:
    """The local date a task was completed on."""
    stamp = dt_util.parse_datetime(task.get("completed_at") or "")
    return dt_util.as_local(stamp).date() if stamp else None


# ---------------------------------------------------------------------------
#  Reading a plan
# ---------------------------------------------------------------------------

@dataclass
class SourceList:
    """A list a plan draws from, as it reads right now."""

    entry_id: str
    name: str
    tasks: list[dict]
    # The todo entity of a linked list; None for a native one.
    entity_id: str | None = None
    # A linked list whose todo entity is not there or not answering: what it
    # reads as says nothing about its tasks.
    away: bool = False


def source_stamp(src: SourceList) -> str:
    """A fingerprint of a list's tasks as the plan reads them.

    The card keeps the tasks of every list of a plan; with this it loads a
    list again only when something in it has changed.
    """
    raw = json.dumps(src.tasks, sort_keys=True, default=str)
    return format(zlib.crc32(raw.encode()), "08x")


def all_lists(hass: HomeAssistant) -> list[SourceList]:
    """Every loaded list, native or linked, without its tasks.

    What a plan can choose its lists from. A linked list goes by the name
    of its todo entity.
    """
    stores = hass.data.get(DOMAIN, {})
    lists: list[SourceList] = []
    for other in hass.config_entries.async_entries(DOMAIN):
        if is_plan(other):
            continue
        store = stores.get(other.entry_id)
        if isinstance(store, HomeTasksStore):
            lists.append(SourceList(other.entry_id, plan_name(other), []))
        elif isinstance(store, ExternalTaskOverlayStore):
            state = hass.states.get(store.entity_id)
            lists.append(SourceList(
                other.entry_id, state.name if state else plan_name(other), [], store.entity_id,
            ))
    return lists


def plan_list_names(hass: HomeAssistant, entry: ConfigEntry) -> list[str]:
    """The names of a plan's lists, without reading their tasks."""
    wanted = set(entry.options.get(CONF_SOURCE_LISTS) or [])
    return [src.name for src in all_lists(hass) if not wanted or src.entry_id in wanted]


def source_lists(hass: HomeAssistant, entry: ConfigEntry) -> list[SourceList]:
    """The lists a plan may reference, with their tasks. No lists chosen
    means all of them."""
    return read_lists(hass, set(entry.options.get(CONF_SOURCE_LISTS) or []))


def read_lists(hass: HomeAssistant, wanted: set[str] | None = None) -> list[SourceList]:
    """Lists with their tasks: the ones in *wanted*, or all of them.

    Linked lists are read through the snapshot the sensors use - no I/O, so
    a plan can be read from an entity property as well as from a service.
    """
    from .external_view import get_external_tasks_snapshot

    stores = hass.data.get(DOMAIN, {})
    sources = [src for src in all_lists(hass) if not wanted or src.entry_id in wanted]
    for src in sources:
        if src.entity_id:
            src.tasks = get_external_tasks_snapshot(hass, src.entity_id)
            state = hass.states.get(src.entity_id)
            src.away = state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN)
        else:
            src.tasks = list(stores[src.entry_id].tasks)
    return sources


async def async_read_lists(hass: HomeAssistant, wanted: set[str] | None = None) -> list[SourceList]:
    """As read_lists, with a linked list whose provider has an adapter of
    its own (Todoist) read the way the card reads it: through the provider,
    with the fields only it reports - priority, labels and the like. A list
    that cannot be read that way keeps what the snapshot has."""
    from .provider_adapters import GenericAdapter
    from .websocket_api import _async_get_external_tasks, _get_adapter

    sources = read_lists(hass, wanted)
    for src in sources:
        if not src.entity_id or src.away:
            continue
        adapter = _get_adapter(hass, src.entity_id)
        if adapter is None or isinstance(adapter, GenericAdapter):
            continue  # the snapshot is what the card gets too
        try:
            src.tasks, _overlay = await _async_get_external_tasks(hass, src.entity_id)
        except Exception as err:  # noqa: BLE001 - the provider is away
            _LOGGER.debug("Reading %s through its provider failed: %s", src.entity_id, err)
    return sources


async def async_plan_view(hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> PlanView:
    """A view of the plan for an answer - card, service or assistant - with
    its lists as async_read_lists reads them."""
    wanted = set(entry.options.get(CONF_SOURCE_LISTS) or [])
    return PlanView(hass, entry, store, sources=await async_read_lists(hass, wanted))


class ListIndex:
    """Lists read once, with their tasks by id - to find a task in them."""

    def __init__(self, sources: list[SourceList]) -> None:
        self.sources = sources
        self.tasks = {src.entry_id: {str(t["id"]): t for t in src.tasks} for src in sources}
        self.linked = {src.entry_id for src in sources if src.entity_id}

    def find(
        self, task_id, list_hint: str | None = None, *, fallback: bool = True,
    ) -> tuple[str, dict] | None:
        """``(list entry id, task)`` for an id, trying its hinted list first.

        With fallback disabled, only the hinted list may supply the task.

        A task that is not in the list it is said to be in was deleted or
        moved. A move keeps the id only from one native list to another, and
        native ids are unique. A linked list's ids are its provider's: the
        same id elsewhere is another task, so a hinted lookup never leaves a
        linked list and never ends in one.
        """
        task_id = str(task_id)
        if list_hint and task_id in self.tasks.get(list_hint, {}):
            return list_hint, self.tasks[list_hint][task_id]
        if not fallback or (list_hint and list_hint in self.linked):
            return None
        for entry_id, by_id in self.tasks.items():
            if list_hint and entry_id in self.linked:
                continue
            if task_id in by_id:
                return entry_id, by_id[task_id]
        return None


class PlanView:
    """One reading of a plan against its lists, as of today.

    Build a new one after every change to the store: it indexes the tasks
    and the explicit placements once.
    """

    def __init__(
        self, hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, today: date | None = None,
        sources: list[SourceList] | None = None,
    ) -> None:
        """*sources* are the plan's lists when they have just been read."""
        self.entry = entry
        self.store = store
        self.today = today or dt_util.now().date()
        self.workdays = plan_workdays(entry)
        # The plan's "today": a plan without weekends reads Monday on a Saturday.
        self.current = next_workday(self.today, self.workdays)
        self.include_due = bool(entry.options.get(CONF_INCLUDE_DUE, True))
        self.carry_over = entry.options.get(CONF_CARRY_OVER, DEFAULT_CARRY_OVER)
        self.sources = source_lists(hass, entry) if sources is None else sources
        self._names = {src.entry_id: src.name for src in self.sources}
        self._index = ListIndex(self.sources)
        self._tasks = self._index.tasks
        self._linked = self._index.linked
        self._away = {src.entry_id for src in self.sources if src.away}
        # (list, task id) -> the day the task is explicitly planned on, from
        # the current day on. Ids are only unique within a list: two linked
        # lists can hold a task with the same id.
        self.placed: dict[tuple[str, str], str] = {}
        current_key = self.current.isoformat()
        for key, day in store.days.items():
            if key < current_key:
                continue
            for item in day["items"]:
                if not item.get("auto") and not item.get("done_on"):
                    ref = self.item_key(item)
                    if ref is not None:
                        self.placed[ref] = key
        self._carry: tuple[str | None, list[tuple[str, dict]]] | None = None

    # --- lookups ---

    def find(
        self, task_id, list_hint: str | None = None, *, fallback: bool = True,
    ) -> tuple[str, dict] | None:
        """Resolve an id, trying its hinted list first (see ListIndex.find)."""
        return self._index.find(task_id, list_hint, fallback=fallback)

    def key_of(self, task_id, list_hint: str | None = None) -> tuple[str, str] | None:
        """``(list entry id, task id)`` - what a task is on the plan."""
        found = self.find(task_id, list_hint)
        return (found[0], str(found[1]["id"])) if found else None

    def item_key(self, item: dict) -> tuple[str, str] | None:
        """The task a stored item refers to now; None once it is deleted."""
        return self.key_of(item["task_id"], item.get("list"))

    def unreadable(self, item: dict) -> bool:
        """Whether a stored item's list cannot be read right now.

        Its task is then not known to be gone - only not there to look at: a
        list that is not loaded (or no longer one of the plan's), or a linked
        list whose todo entity is missing or unavailable, which is how a
        provider that is away or still starting looks. A linked list that
        answers - also with no tasks at all - has lost a task it does not
        name; a native list always answers.
        """
        list_id = item.get("list")
        if not list_id or self.item_key(item) is not None:
            return False
        return list_id not in self._tasks or list_id in self._away

    def unread_items(self, day: date) -> list[dict]:
        """The stored items of *day* that a write must carry along unseen.

        A day is written as it reads (materialize), and an item whose list
        cannot be read does not read at all. Without these a reorder made
        while a provider is away would take its tasks off the plan for good.
        """
        stored = (self.store.days.get(day.isoformat()) or {}).get("items", [])
        return [item for item in stored if self.unreadable(item)]

    def is_auto(self, task: dict, day: date) -> bool:
        """Whether a task put on *day* is there through its due date anyway.

        Never on a plan that leaves due tasks out: there the item would not
        be shown at all, so planning a task on its due day would lose it.
        """
        return self.include_due and self.due_on(task) == day

    def due_on(self, task: dict) -> date | None:
        """The plan day an open task is on through its due date."""
        if task.get("completed"):
            return None
        due = _parse_date(task.get("due_date"))
        return due_day(due, self.today, self.workdays) if due else None

    def horizon(self) -> list[date]:
        """The days that can be planned: the current one and the six after it."""
        return plan_dates(self.current, PLAN_HORIZON_DAYS, self.workdays)

    # --- rows ---

    def _row(self, entry_id: str, task: dict, kind: str, completed: bool) -> dict:
        return {
            "task_id": str(task["id"]),
            "entry_id": entry_id,
            "list_name": self._names.get(entry_id, entry_id),
            "title": task.get("title", ""),
            "priority": task.get("priority"),
            "tags": list(task.get("tags") or []),
            "assigned_person": task.get("assigned_person"),
            "assigned_persons": task_assignees(task),
            "due_date": task.get("due_date"),
            "due_time": task.get("due_time"),
            "completed": completed,
            # planned: put there on purpose. due / overdue: there through
            # the due date, and only movable, not removable.
            "kind": kind,
        }

    def _due_kind(self, task: dict, completed: bool) -> str:
        due = task.get("due_date")
        return "overdue" if due and not completed and due < self.today.isoformat() else "due"

    def carry_candidates(self) -> tuple[str | None, list[tuple[str, dict]]]:
        """What was planned on the last planned day and is still open.

        ``(that day, [(list entry id, task), ...])`` - only tasks that are
        not planned anywhere from the current day on.
        """
        if self._carry is not None:
            return self._carry
        self._carry = (None, [])
        current_key = self.current.isoformat()
        for key in sorted((k for k in self.store.days if k < current_key), reverse=True):
            planned = [i for i in self.store.days[key]["items"] if not i.get("auto")]
            if not planned:
                continue
            still_open: list[tuple[str, dict]] = []
            for item in planned:
                if item.get("done_on") or item.get("dropped"):
                    continue
                found = self.find(item["task_id"], item.get("list"))
                if (
                    found and not found[1].get("completed")
                    and (found[0], str(found[1]["id"])) not in self.placed
                ):
                    still_open.append(found)
            self._carry = (key, still_open)
            break
        return self._carry

    def day(self, day: date) -> dict:
        """One day of the plan, resolved against the lists as they are now."""
        key = day.isoformat()
        stored = self.store.days.get(key) or {}
        past = day < self.current
        rows: list[dict] = []
        seen: set[tuple[str, str]] = set()

        for item in stored.get("items", []):
            found = self.find(item["task_id"], item.get("list"))
            if not found:
                continue  # the task was deleted: the reference just goes
            entry_id, task = found
            ref = (entry_id, str(task["id"]))
            if ref in seen:
                continue
            done = item.get("done_on") == key
            auto = bool(item.get("auto"))
            if not done and not past:
                if auto and (not self.include_due or self.due_on(task) != day):
                    continue  # the due date points elsewhere now
                if task.get("completed"):
                    # Ticked off in its list, not through the plan. A linked
                    # list's provider says nothing about when (ticked off in
                    # its own app): taken as done on the current day, as it
                    # is seen done now - not dropped from the day.
                    if (_completed_on(task) or self.current) != day:
                        continue
                    done = True
            seen.add(ref)
            rows.append(self._row(
                entry_id, task, self._due_kind(task, done) if auto else "planned", done,
            ))

        if self.include_due and not past:
            due_rows: list[tuple[str, dict]] = []
            for src in self.sources:
                for task in src.tasks:
                    ref = (src.entry_id, str(task["id"]))
                    if ref in seen or ref in self.placed or self.due_on(task) != day:
                        continue
                    seen.add(ref)
                    due_rows.append((src.entry_id, task))
            # Committed dates come first: oldest due, then by time, then by priority.
            due_rows.sort(key=lambda pair: _due_order(pair[1]))
            rows = [self._row(e, t, self._due_kind(t, False), False) for e, t in due_rows] + rows

        result = {
            "date": key,
            "note": stored.get("note") or "",
            "items": rows,
            "updated": stored.get("updated"),
            "updated_by": stored.get("updated_by"),
        }

        if day == self.current and self.carry_over != "off":
            from_day, candidates = self.carry_candidates()
            carried = [
                {**self._row(e, t, "planned", False), "carried_from": from_day}
                for e, t in candidates if (e, str(t["id"])) not in seen
            ]
            if carried and self.carry_over == "auto":
                rows.extend(carried)
            elif carried and not any(row["kind"] == "planned" for row in rows):
                # An offer, made while nothing is planned for the day yet.
                result["carry_over"] = {"date": from_day, "items": carried}
        return result

    def days(self, start: date, count: int) -> list[dict]:
        """*count* plan days from *start* on."""
        return [self.day(day) for day in plan_dates(start, count, self.workdays)]

    def materialize(self, day: date) -> list[dict]:
        """The day as items to store: its full order, due items included."""
        key = day.isoformat()
        return [
            {
                "task_id": row["task_id"],
                "list": row["entry_id"],
                "auto": row["kind"] != "planned",
                "done_on": key if row["completed"] else None,
            }
            for row in self.day(day)["items"]
        ]


# ---------------------------------------------------------------------------
#  Changing a plan
# ---------------------------------------------------------------------------

def _check_writable(view: PlanView, day: date) -> None:
    horizon = view.horizon()
    if day not in horizon:
        raise ServiceValidationError(
            f"{day.isoformat()} can't be planned: the plan covers its workdays from "
            f"{horizon[0].isoformat()} to {horizon[-1].isoformat()}"
        )


def _find_open(view: PlanView, task_id, list_hint: str | None) -> tuple[str, dict]:
    found = view.find(task_id, list_hint)
    if not found:
        raise ServiceValidationError(f"No task with id {task_id} in the lists of this plan")
    if found[1].get("completed"):
        raise ServiceValidationError(
            f"{found[1].get('title') or task_id!r} is completed and can't be planned"
        )
    return found


def _item_ref(item: dict) -> tuple[str, str]:
    """The task of an item as materialize() writes it: its list is current."""
    return item["list"], item["task_id"]


@contextmanager
def _all_or_nothing(store: PlanStore) -> Iterator[None]:
    """A change that is refused halfway leaves the plan as it was.

    Moving a task takes it off its old day before the new day is checked
    (too many items, a note too long). Without this the refusal would still
    have taken the task off the plan.
    """
    before = copy.deepcopy(store.days)
    try:
        yield
    except Exception:
        store.restore(before)
        raise


def _drop_open(
    view: PlanView, ref: tuple[str, str], from_key: str, except_key: str | None = None,
) -> None:
    """Take a task's open references out of the days from *from_key* on."""
    for key, day in view.store.days.items():
        if key < from_key or key == except_key:
            continue
        day["items"] = [i for i in day["items"] if i.get("done_on") or view.item_key(i) != ref]


def _stop_carrying(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, refs: set[tuple[str, str]],
) -> bool:
    """With carry-over ``auto``, the last planned day stops handing *refs* on.

    A task taken off the current day is otherwise back at once: it is still
    open on the day before, and that is all carry-over asks. Call it after
    the task's references were removed - only then does it read as carried.
    Returns whether there was something to stop.
    """
    view = PlanView(hass, entry, store)
    if view.carry_over != "auto" or not refs:
        return False
    from_day, candidates = view.carry_candidates()
    gone = {(entry_id, str(task["id"])) for entry_id, task in candidates} & refs
    if not gone:
        return False
    for item in store.days[from_day]["items"]:
        if not item.get("auto") and not item.get("done_on") and view.item_key(item) in gone:
            item["dropped"] = True
    return True


def _write(store: PlanStore, key: str, items: list[dict], updated_by: str, note=_UNSET) -> None:
    # The limit is on what somebody put on the day. What is there through
    # its due date comes by itself, in any number - with a hundred overdue
    # tasks the day would otherwise refuse every reorder.
    if sum(1 for item in items if not item.get("auto")) > MAX_PLAN_ITEMS_PER_DAY:
        raise ServiceValidationError(f"A day holds at most {MAX_PLAN_ITEMS_PER_DAY} planned tasks")
    day = store.day(key)
    day["items"] = items
    if note is not _UNSET:
        note = (note or "").strip()
        if len(note) > MAX_PLAN_NOTE_LENGTH:
            raise ServiceValidationError(f"The note is too long (max {MAX_PLAN_NOTE_LENGTH} characters)")
        day["note"] = note
    day["updated"] = dt_util.now().isoformat()
    day["updated_by"] = updated_by


async def async_plan_task(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, task_id,
    day: date | None = None, position: str = "bottom", list_hint: str | None = None,
    updated_by: str = "service",
) -> None:
    """Put a task on a day. From today on a task sits on one day only, so
    this moves it when it was planned elsewhere."""
    view = PlanView(hass, entry, store)
    day = day or view.current
    _check_writable(view, day)
    entry_id, task = _find_open(view, task_id, list_hint)
    ref = (entry_id, str(task["id"]))

    with _all_or_nothing(store):
        _drop_open(view, ref, view.current.isoformat())
        view = PlanView(hass, entry, store)
        # The day's full order, so that "top" is the top of what the day shows.
        items = [i for i in view.materialize(day) if _item_ref(i) != ref]
        item = {"task_id": ref[1], "list": entry_id, "auto": view.is_auto(task, day), "done_on": None}
        if position == "top":
            items.insert(0, item)
        else:
            items.append(item)
        _write(store, day.isoformat(), items + view.unread_items(day), updated_by)
        await store.async_save(view.today)


async def async_set_day(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore,
    refs: list[tuple[str, str | None]], day: date | None = None, note=_UNSET,
    mode: str = "merge", updated_by: str = "service",
) -> None:
    """Set a day's order.

    *refs* are ``(task id, list hint)`` in working order. ``merge`` keeps
    what is on the day and is not named, after the named ones - so a
    briefing can sort a day without wiping what the user planned the evening
    before. ``replace`` takes the unnamed ones off, except what is done and
    what is there through its due date.
    """
    view = PlanView(hass, entry, store)
    day = day or view.current
    _check_writable(view, day)
    key = day.isoformat()

    # What is on the day already only changes its place - also what is done:
    # a reorder in the card names the day's rows as they stand.
    on_day = {_item_ref(item) for item in view.materialize(day)}
    wanted: dict[tuple[str, str], dict] = {}
    for task_id, list_hint in refs:
        found = view.find(task_id, list_hint)
        if not found or (found[0], str(found[1]["id"])) not in on_day:
            found = _find_open(view, task_id, list_hint)
        wanted.setdefault((found[0], str(found[1]["id"])), found[1])

    with _all_or_nothing(store):
        for ref in wanted:
            _drop_open(view, ref, view.current.isoformat(), except_key=key)
        view = PlanView(hass, entry, store)
        current = view.materialize(day)
        by_ref = {_item_ref(item): item for item in current}
        named = [
            by_ref.get(ref)
            or {"task_id": ref[1], "list": ref[0], "auto": view.is_auto(task, day), "done_on": None}
            for ref, task in wanted.items()
        ]
        rest = [item for item in current if _item_ref(item) not in wanted]
        taken_off: set[tuple[str, str]] = set()
        if mode == "replace":
            keep = [item for item in rest if item["done_on"] or item["auto"]]
            taken_off = {_item_ref(item) for item in rest} - {_item_ref(item) for item in keep}
            rest = keep
        _write(store, key, named + rest + view.unread_items(day), updated_by, note)
        _stop_carrying(hass, entry, store, taken_off)
        await store.async_save(view.today)


async def async_unplan_task(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, task_id,
    list_hint: str | None = None,
) -> None:
    """Take a task off the plan. The task itself is not touched."""
    view = PlanView(hass, entry, store)
    task_id = str(task_id)
    found = view.find(task_id, list_hint)
    ref = (found[0], str(found[1]["id"])) if found else None
    current_key = view.current.isoformat()
    removed = False
    for key, day in store.days.items():
        if ref is None or key < current_key:
            continue
        kept = [
            i for i in day["items"]
            if i.get("done_on") or i.get("auto") or view.item_key(i) != ref
        ]
        removed = removed or len(kept) != len(day["items"])
        day["items"] = kept
    # On the current day only because it was left open on the last planned
    # one: that day must stop handing it on, even if today's reference was
    # already materialized and has just been removed.
    if ref is not None and _stop_carrying(hass, entry, store, {ref}):
        removed = True
    if not removed:
        if found and view.include_due and view.due_on(found[1]) is not None:
            raise ServiceValidationError(
                f"{found[1].get('title') or task_id!r} is on the plan through its due date: "
                "move it to another day or change the due date"
            )
        raise ServiceValidationError(f"No task with id {task_id} on the plan")
    await store.async_save(view.today)


async def async_untick(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, task_id,
    list_hint: str | None = None,
) -> None:
    """Take back today's "done" of a task that is open (again).

    A recurring task that was ticked off and has been opened for its next
    round stays done on the day - un-ticking it in its list is not possible,
    it is open there. This takes the day's mark back and leaves the task as
    it is: the row is open on the day again, also when the task's due date
    has moved on. Nothing of the recurrence is rolled back.

    A task that is still completed is un-ticked in its list; the plan
    follows that by itself.
    """
    view = PlanView(hass, entry, store)
    found = view.find(task_id, list_hint)
    if not found:
        raise ServiceValidationError(f"No task with id {task_id} in the lists of this plan")
    entry_id, task = found
    if task.get("completed"):
        raise ServiceValidationError(
            f"{task.get('title') or task_id!r} is completed: reopen the task itself"
        )
    ref = (entry_id, str(task["id"]))
    key = view.today.isoformat()
    for item in (store.days.get(key) or {}).get("items", []):
        if item.get("done_on") == key and view.item_key(item) == ref:
            # Open on today again - so not on a later day as well, where its
            # next round may have been planned in the meantime.
            _drop_open(view, ref, view.current.isoformat(), except_key=key)
            item["done_on"] = None
            # Kept on the day on purpose unless its due date holds it there.
            item["auto"] = view.is_auto(task, view.today)
            item.pop("dropped", None)
            await store.async_save(view.today)
            return
    raise ServiceValidationError(f"{task.get('title') or task_id!r} is not done on today's plan")


async def async_leave_days_off(hass: HomeAssistant, entry: ConfigEntry, store: PlanStore) -> None:
    """After the plan's workdays changed: nothing stays planned on a day off.

    A task planned for a day that is no plan day any more would be on no day
    that is shown, and - being planned - not on its due day either. It moves
    to the workday before, as a due date on a day off does, or to the
    current day when that is already past. What is there through its due
    date or done stays: the first follows the due date by itself, the second
    is the record of its day.
    """
    view = PlanView(hass, entry, store)
    # From today on, not from the current plan day: on a Saturday that has
    # just become a day off, the Sunday lies before the plan's Monday and
    # is still ahead.
    today_key = view.today.isoformat()
    moved = False
    for key in sorted(store.days):
        day = _parse_date(key)
        if day is None or key < today_key or day.weekday() in view.workdays:
            continue
        stay = [i for i in store.days[key]["items"] if i.get("auto") or i.get("done_on")]
        move = [i for i in store.days[key]["items"] if not (i.get("auto") or i.get("done_on"))]
        note = store.days[key].get("note") or ""
        if not move and not note:
            continue
        target = store.day(due_day(day, view.today, view.workdays).isoformat())
        there = {(i.get("list"), i["task_id"]) for i in target["items"]}
        target["items"].extend(i for i in move if (i.get("list"), i["task_id"]) not in there)
        store.days[key]["items"] = stay
        # The day's focus goes where its tasks go - on a day nobody sees it
        # could be neither read nor cleared. A focus the other day already
        # has stays; this one is then dropped with its day.
        if note:
            if not target.get("note"):
                target["note"] = note
            store.days[key]["note"] = ""
        moved = True
    if moved:
        await store.async_save(view.today)


async def async_retarget(hass: HomeAssistant, old: tuple[str, str], new: tuple[str, str]) -> None:
    """A task is now *new* (list entry id, task id) where it was *old*.

    Moving a task to a list of the other kind makes it a new task with a new
    id there, and some providers (Bring!) make a new item of a renamed one.
    Its references on every plan follow it, so it keeps the days it was put
    on. A task that keeps its id within native lists is found anyway; this
    keeps its list hint right too.
    """
    old = (old[0], str(old[1]))
    new = (new[0], str(new[1]))
    if old == new:
        return
    native = {
        e.entry_id for e in hass.config_entries.async_entries(DOMAIN)
        if e.data.get("type") not in ("external", "plan")
    }

    def stale_hint(item: dict) -> bool:
        """A reference to this native task under a list it left earlier.

        Only native ids travel between lists (and they are unique), so only a
        native hint can be stale: its list no longer holds the id.
        """
        hint = item.get("list")
        if old[0] not in native or hint not in native or str(item["task_id"]) != old[1]:
            return False
        tasks = getattr(hass.data.get(DOMAIN, {}).get(hint), "tasks", None) or []
        return not any(str(t.get("id")) == old[1] for t in tasks)

    for entry in hass.config_entries.async_entries(DOMAIN):
        if not is_plan(entry):
            continue
        store = plan_store(hass, entry.entry_id)
        if store is None:
            continue
        changed = False
        for day in store.days.values():
            for item in day["items"]:
                if (item.get("list"), str(item["task_id"])) == old or stale_hint(item):
                    item["list"], item["task_id"] = new
                    changed = True
        if changed:
            await store.async_save(dt_util.now().date())


# ---------------------------------------------------------------------------
#  Following the lists
# ---------------------------------------------------------------------------

async def async_mark_completed(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, task_id,
    list_hint: str | None = None, due_before: str | None = None,
) -> None:
    """A task was completed: if it sits on today, today remembers it as done.

    *due_before* is the due date the task had when it was ticked off - a
    recurring task has moved on to its next occurrence by the time the plan
    looks.
    """
    view = PlanView(hass, entry, store)
    if view.current != view.today or task_id is None:
        return  # no plan day today
    # Events identify the current source, not a hint to a moved task.
    found = view.find(task_id, list_hint, fallback=False)
    if not found:
        return
    entry_id, task = found
    task_id = str(task["id"])
    ref = (entry_id, task_id)
    key = view.today.isoformat()
    due = _parse_date(due_before or task.get("pre_advance_due_date") or task.get("due_date"))
    was_due_today = (
        view.include_due and due is not None and due_day(due, view.today, view.workdays) == view.today
    )
    for item in (store.days.get(key) or {}).get("items", []):
        if view.item_key(item) == ref:
            # A reorder can leave an auto reference behind after the due
            # date or plan settings change. It no longer belongs to today.
            if item.get("auto") and not was_due_today:
                continue
            if not item.get("done_on"):
                item["done_on"] = key
                await store.async_save(view.today)
            return

    if ref in view.placed:
        return
    # Carried over without having been written yet (carry-over "auto").
    from_day = next(
        (k for k in sorted(store.days, reverse=True)
         if k < key and any(not i.get("auto") for i in store.days[k]["items"])),
        None,
    )
    was_carried = view.carry_over == "auto" and from_day is not None and any(
        view.item_key(i) == ref and not i.get("auto") and not i.get("done_on") and not i.get("dropped")
        for i in store.days[from_day]["items"]
    )
    if not (was_due_today or was_carried):
        return
    item = {"task_id": task_id, "list": entry_id, "auto": not was_carried, "done_on": key}
    day = store.day(key)
    if was_carried:
        day["items"].append(item)
    else:
        # Done, it keeps the place it had. It had no stored one: rows that
        # are there through their due date stand first, in their own order,
        # and it was one of them. So the day is written as it reads, with
        # the task where it stood - at the head of the stored items it would
        # have dropped behind every due row that is still open.
        # Without the task itself: completed, it does not read - unless it
        # recurs and is open and due again today, and then the done item is
        # the one reference the day keeps for it.
        shown = [i for i in view.materialize(view.today) if _item_ref(i) != ref]
        stored = {view.item_key(i) for i in day["items"]}
        mine = _due_order({
            **task,
            "due_date": due.isoformat() if due else None,
            "due_time": task.get("pre_advance_due_time", task.get("due_time")),
        })
        at = 0
        for index, other in enumerate(shown):
            other_ref = _item_ref(other)
            if other_ref in stored or _due_order(view._tasks[other_ref[0]][other_ref[1]]) > mine:
                break
            at = index + 1
        shown.insert(at, item)
        day["items"] = shown + view.unread_items(view.today)
    await store.async_save(view.today)


async def async_mark_reopened(
    hass: HomeAssistant, entry: ConfigEntry, store: PlanStore, task_id,
    list_hint: str | None = None, by_recurrence: bool = False,
) -> None:
    """A task was reopened: an un-tick takes back today's "done".

    The recurrence opening a task for its next occurrence (*by_recurrence*,
    as the reopened event says) is not an un-tick: what was done today
    stays done today.
    """
    view = PlanView(hass, entry, store)
    if task_id is None or by_recurrence:
        return
    found = view.find(task_id, list_hint, fallback=False)
    if not found:
        return
    ref = (found[0], str(found[1]["id"]))
    key = view.today.isoformat()
    for item in (store.days.get(key) or {}).get("items", []):
        if item.get("done_on") != key or view.item_key(item) != ref:
            continue
        item["done_on"] = None
        await store.async_save(view.today)
        return


# ---------------------------------------------------------------------------
#  Config entry
# ---------------------------------------------------------------------------

def plan_store(hass: HomeAssistant, entry_id: str) -> PlanStore | None:
    return hass.data.get(DATA_PLANS, {}).get(entry_id)


def resolve_plan(hass: HomeAssistant, name_or_id: str | None) -> tuple[ConfigEntry, PlanStore]:
    """The plan a service call means: by entry id or name, or the only one."""
    plans = [
        (entry, plan_store(hass, entry.entry_id))
        for entry in hass.config_entries.async_entries(DOMAIN) if is_plan(entry)
    ]
    plans = [(entry, store) for entry, store in plans if store is not None]
    if not name_or_id:
        if len(plans) == 1:
            return plans[0]
        raise ServiceValidationError(
            "There is no plan yet - add one under Settings → Devices & services → Home Tasks"
            if not plans else "There are several plans: name one with `plan`"
        )
    for entry, store in plans:
        if entry.entry_id == name_or_id or plan_name(entry).lower() == name_or_id.lower():
            return entry, store
    raise ServiceValidationError(f"No plan found with name or id: {name_or_id}")


async def async_setup_plan_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Load a plan and let it follow completions in its lists."""
    store = PlanStore(hass, entry.entry_id)
    await store.async_load()
    hass.data.setdefault(DATA_PLANS, {})[entry.entry_id] = store

    @callback
    def _on_completed(event) -> None:
        hass.async_create_task(async_mark_completed(
            hass, entry, store, event.data.get("task_id"),
            event.data.get("entry_id"), event.data.get("due_date"),
        ))

    @callback
    def _on_reopened(event) -> None:
        hass.async_create_task(async_mark_reopened(
            hass, entry, store, event.data.get("task_id"), event.data.get("entry_id"),
            by_recurrence=event.data.get("reopened_by") == "recurrence",
        ))

    async def _on_options_changed(_hass: HomeAssistant, _entry: ConfigEntry) -> None:
        # The settings are read on every look at the plan; nothing to reload.
        # Only what was planned on a day that is a day off now has to move.
        await async_leave_days_off(hass, entry, store)
        store.notify()

    entry.async_on_unload(hass.bus.async_listen(f"{DOMAIN}_task_completed", _on_completed))
    entry.async_on_unload(hass.bus.async_listen(f"{DOMAIN}_task_reopened", _on_reopened))
    entry.async_on_unload(entry.add_update_listener(_on_options_changed))

    # The plan's tools for an LLM, there for as long as the plan is loaded.
    # A Home Assistant too old to have tool sets still gets the plan.
    try:
        from .llm_tools import async_register_plan_api
    except ImportError:
        _LOGGER.debug("No LLM tools for plan %s: this Home Assistant has none", plan_name(entry))
    else:
        async_register_plan_api(hass, entry, store)


def async_unload_plan_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    hass.data.get(DATA_PLANS, {}).pop(entry.entry_id, None)
