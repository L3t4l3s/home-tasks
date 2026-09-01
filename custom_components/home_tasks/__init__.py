"""The Home Tasks integration."""

from calendar import monthrange
import logging
import os
from datetime import date, datetime, timedelta, timezone

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HassJob, HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from .image_queue import async_get_image_queue, async_register_image_queue
from homeassistant.util import dt as dt_util

from .const import DOMAIN, RECURRENCE_UNIT_SECONDS

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
from .overlay_store import ExternalTaskOverlayStore
from .store import HomeTasksStore, _REOPEN_UNCHANGED, validate_reminders
from .websocket_api import async_move_task_any, async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["todo", "sensor", "binary_sensor", "calendar"]
# External entries only get a calendar entity; their todo/sensor data is owned
# by the source integration.
EXTERNAL_PLATFORMS = ["calendar"]
CARD_URL = "/home_tasks/home-tasks-card.js"
DATA_SETUP_DONE = f"{DOMAIN}_setup_done"
DATA_RESOURCE_UNSUB = f"{DOMAIN}_resource_unsub"
DATA_RECURRENCE_TIMERS = f"{DOMAIN}_recurrence_timers"
DATA_REMINDER_TIMERS = f"{DOMAIN}_reminder_timers"
DATA_DUE_CHECK_UNSUB = f"{DOMAIN}_due_check_unsub"
DATA_DUE_FIRED = f"{DOMAIN}_due_fired"
DATA_DUE_STARTUP_DONE = f"{DOMAIN}_due_startup_done"

DUE_CHECK_INTERVAL = timedelta(hours=1)


# ---------------------------------------------------------------------------
#  Setup
# ---------------------------------------------------------------------------

async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the Home Tasks component."""
    hass.data.setdefault(DOMAIN, {})
    await _async_register_card(hass)
    _async_register_services(hass)
    _async_register_due_checker(hass)
    async_register_image_queue(hass)
    # One-time: generate thumbnails for any pre-existing task images so tile
    # grids load fast without re-saving each image. Runs in the background.
    from .websocket_api import _backfill_thumbnails
    hass.async_create_task(_backfill_thumbnails(hass))
    return True


async def _async_register_card(hass: HomeAssistant) -> None:
    """Register websocket commands and serve static files (once)."""
    if hass.data.get(DATA_SETUP_DONE):
        return
    hass.data[DATA_SETUP_DONE] = True

    async_register_websocket_commands(hass)

    comp_path = hass.config.path(f"custom_components/{DOMAIN}")
    static_paths = [
        StaticPathConfig(
            CARD_URL,
            f"{comp_path}/home-tasks-card.js",
            # Long-lived cache headers (31 days), like HACS serves /hacsfiles/
            # and HA core serves /local/.  Safe because every load path uses
            # the mtime-versioned ?v= URL: any file change produces a new URL
            # and forces a fresh fetch.  Critically, the cached copy bridges
            # the startup window in which the frontend is already serving but
            # this static path is not yet registered (404), and failed
            # revalidations on flaky reconnects (companion-app warm resume) —
            # without it the module import fails and the dashboard shows
            # "Custom element doesn't exist" until a full reload (#37).
            cache_headers=True,
        ),
        StaticPathConfig(
            f"/brands/{DOMAIN}/icon.png",
            f"{comp_path}/icon.png",
            cache_headers=True,
        ),
        StaticPathConfig(
            f"/brands/{DOMAIN}/icon@2x.png",
            f"{comp_path}/icon@2x.png",
            cache_headers=True,
        ),
        StaticPathConfig(
            f"/brands/{DOMAIN}/logo.png",
            f"{comp_path}/icon.png",
            cache_headers=True,
        ),
    ]
    try:
        await hass.http.async_register_static_paths(static_paths)
    except RuntimeError as err:
        # A failure here means the card cannot be served and will not load
        # automatically — surface it instead of silently swallowing it.
        _LOGGER.warning(
            "Home Tasks could not register static paths; the dashboard card "
            "may not load automatically: %s",
            err,
        )

    # Cache-bust the card URL with the file's modification time so browsers and
    # the Lovelace resource cache pick up updates instead of serving a stale
    # copy. Using mtime (not the integration version) means every change to the
    # file busts the cache — including dev deploys that don't bump the version.
    # Resolve the card relative to this package (os.path.dirname(__file__)).
    # In a real install this equals comp_path, but the divergence is
    # intentional and load-bearing: under the test harness the config dir
    # differs from the package dir, so deriving this from comp_path would make
    # the mtime lookup miss the file (no ?v=) and break the regression test.
    # Do not "DRY" this against comp_path.
    card_path = os.path.join(os.path.dirname(__file__), "home-tasks-card.js")
    card_url = CARD_URL
    try:
        mtime = await hass.async_add_executor_job(os.path.getmtime, card_path)
        card_url = f"{CARD_URL}?v={int(mtime)}"
    except OSError as err:
        # Never advertise the bare URL: with cache_headers=True an unversioned
        # response would be cached for a month.  A per-boot timestamp busts
        # the cache each restart in this (rare) error path, which is the safe
        # direction; the next successful stat restores mtime versioning.
        card_url = f"{CARD_URL}?v={int(datetime.now(timezone.utc).timestamp())}"
        _LOGGER.warning("Could not stat card file for cache-busting: %s", err)

    # Auto-register card JS so users don't need to add a Lovelace resource manually
    add_extra_js_url(hass, card_url)
    _LOGGER.info("Home Tasks card served at %s", card_url)

    # add_extra_js_url only lands in frontend pages served *after* this point.
    # A client that fetched the index while HA was still starting (typical for
    # the Companion App, which auto-reloads on reconnect during a restart)
    # never loads the card and shows "Custom element doesn't exist" until a
    # hard refresh (#37, #41).  Registering the card additionally as a
    # Lovelace *resource* closes that gap: resources are loaded dynamically on
    # every dashboard render, independent of when the index was served.  Both
    # point at the identical module URL, so the browser evaluates it once.
    if hass.is_running:
        hass.async_create_task(_async_register_lovelace_resource(hass, card_url))
    else:
        async def _on_started(_event) -> None:
            hass.data.pop(DATA_RESOURCE_UNSUB, None)
            # All entries removed before HA finished starting — don't
            # (re)create a resource for an integration that is gone.
            if not hass.config_entries.async_entries(DOMAIN):
                return
            await _async_register_lovelace_resource(hass, card_url)

        hass.data[DATA_RESOURCE_UNSUB] = hass.bus.async_listen_once(
            EVENT_HOMEASSISTANT_STARTED, _on_started
        )


async def _async_register_lovelace_resource(hass: HomeAssistant, card_url: str) -> None:
    """Ensure a Lovelace resource entry for the card exists and is current.

    Storage mode only — in YAML mode the resource collection isn't editable
    and add_extra_js_url remains the sole mechanism (unchanged behavior).
    An existing entry (auto-created earlier, or added manually by a user)
    is updated in place when the cache-busting ?v= changed, never duplicated.
    Best-effort: any failure is logged and the card still loads via
    add_extra_js_url for freshly served pages.
    """
    try:
        lovelace = hass.data.get("lovelace")
        resources = getattr(lovelace, "resources", None)
        if resources is None and isinstance(lovelace, dict):  # pre-2024 layout
            resources = lovelace.get("resources")
        if resources is None or not hasattr(resources, "async_create_item"):
            return  # lovelace not set up, or YAML mode
        if not resources.loaded:
            await resources.async_load()
            resources.loaded = True
        for item in resources.async_items():
            if (item.get("url") or "").split("?")[0] == CARD_URL:
                if item["url"] != card_url:
                    # Never downgrade a versioned URL to an unversioned one: an
                    # unversioned card_url means the mtime lookup failed this
                    # start (transient) — overwriting would un-bust the cache
                    # for every client (the #24 stale-card class).
                    if "?v=" in item["url"] and "?v=" not in card_url:
                        return
                    await resources.async_update_item(
                        item["id"], {"url": card_url}
                    )
                    _LOGGER.info(
                        "Updated Lovelace resource for Home Tasks card: %s", card_url
                    )
                return
        await resources.async_create_item({"res_type": "module", "url": card_url})
        _LOGGER.info("Registered Lovelace resource for Home Tasks card: %s", card_url)
    except Exception as err:  # noqa: BLE001 — must never break setup
        _LOGGER.warning(
            "Could not register the Home Tasks card as a Lovelace resource "
            "(the card still loads via frontend extra module): %s",
            err,
        )


# ---------------------------------------------------------------------------
#  Events
# ---------------------------------------------------------------------------

def _build_event_data(hass: HomeAssistant, entry_id: str, task: dict) -> dict:
    """Build common event data dict."""
    data = {
        "entry_id": entry_id,
        "task_id": task["id"],
        "task_title": task.get("title", ""),
    }
    entry = hass.config_entries.async_get_entry(entry_id)
    if entry:
        data["list_name"] = entry.data.get("name", entry.title)
    if task.get("_entity_id"):
        data["entity_id"] = task["_entity_id"]
    if task.get("assigned_person"):
        data["assigned_person"] = task["assigned_person"]
    if task.get("due_date"):
        data["due_date"] = task["due_date"]
    if task.get("due_time"):
        data["due_time"] = task["due_time"]
    if task.get("priority"):
        data["priority"] = task["priority"]
    if task.get("notes"):
        # Events are persisted verbatim by HA's recorder; full notes (up to
        # 5000 chars, re-fired daily by due/overdue) would bloat the events
        # table and can push an event over the recorder size cap. Ship a
        # preview; consumers needing the full text fetch the task.
        data["notes"] = task["notes"][:255]
    if task.get("tags"):
        data["tags"] = task["tags"]
    return data


def _parse_completed_at(task: dict) -> datetime:
    """Parse task['completed_at'] to a timezone-aware UTC datetime, or fall back to now()."""
    raw = task.get("completed_at")
    if raw:
        try:
            parsed = datetime.fromisoformat(raw)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except (ValueError, TypeError):
            pass
    return datetime.now(timezone.utc)


def _record_auto_advance_history(task: dict, old_due_date, new_due_date, old_due_time, new_due_time) -> None:
    """Append history entries for the auto-advance of due_date/due_time on completion.

    Uses `by: "recurrence"` so the UI renders it like other automatic entries
    (no "by Kevin" suffix) — matching the existing "Automatisch zurückgesetzt"
    convention for reopen entries.
    """
    if old_due_date == new_due_date and old_due_time == new_due_time:
        return
    ts = datetime.now(timezone.utc).isoformat()
    hist = task.setdefault("history", [])
    if old_due_date != new_due_date:
        hist.append({
            "ts": ts, "action": "updated", "field": "due_date",
            "from": old_due_date, "to": new_due_date, "by": "recurrence",
        })
    if old_due_time != new_due_time:
        hist.append({
            "ts": ts, "action": "updated", "field": "due_time",
            "from": old_due_time, "to": new_due_time, "by": "recurrence",
        })


def _on_task_completed(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Handle task completion: fire event, advance due_date, schedule reminders + recurrence.

    For a recurring task with a due_date we advance due_date/due_time on the
    task dict to the next occurrence *immediately* (while still completed).
    This has two benefits:

    1. Reminders (scheduled right after) target the NEXT occurrence's due
       moment, so "N days before" reminders can fire during the window
       between completion and actual reopen.
    2. The UI / calendar show the task as "completed, next due <future>"
       rather than "completed, was due <past>".

    The due advance is also recorded in task["history"] (by="recurrence")
    so the user sees the shift in the task's audit trail.

    The task dict is mutated in place; the store persists it on its next
    _async_save() (which is triggered by the same update_task call that
    invoked this callback).
    """
    hass.bus.async_fire(f"{DOMAIN}_task_completed", _build_event_data(hass, entry_id, task))

    completed_at = _parse_completed_at(task)

    target = None
    if task.get("recurrence_enabled"):
        target = _compute_next_reopen_target(task, completed_at)
        # Persist the reopen moment on the task.  The in-memory timer dies
        # with HA; after a restart this field is the *authoritative* target
        # (see _recovery_reopen_target) — recomputing against the advanced
        # due_date would roll one interval further (#35, #36, #40).
        # Explicit None (recurrence end reached) is meaningful too: it tells
        # recovery there is nothing to re-arm.
        task["reopen_at"] = (
            target.astimezone(timezone.utc).isoformat() if target is not None else None
        )
    if target is not None and task.get("due_date"):
        local_target = target.astimezone(dt_util.DEFAULT_TIME_ZONE)
        old_due_date = task.get("due_date")
        task["due_date"] = local_target.date().isoformat()
        # due_time belongs to the user.  We advance the DATE to the next
        # occurrence; the time-of-day — if the user set one — is kept,
        # and if the user didn't set one we don't invent one.  The
        # recurrence_time field is only used by the scheduler to place
        # the reopen timer, not to rewrite the task's due_time.
        _record_auto_advance_history(
            task,
            old_due_date, task["due_date"],
            task.get("due_time"), task.get("due_time"),
        )

    # Pass the already-computed target into the scheduler so it doesn't
    # recompute against the just-advanced due_date and double-advance.
    _schedule_recurrence(hass, entry_id, task, completed_at=completed_at, precomputed_target=target)
    # _schedule_reminders cancels old timers first, then (for recurring tasks)
    # reschedules against the newly-advanced due_date.
    _schedule_reminders(hass, entry_id, task)


def _rearm_task_timers(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """(Re-)arm a task's reminder and recurrence-reopen timers.

    Used after creation/import — and alone (no task_created event) when a
    task is restored into its source list after a failed move, where the
    export side had cancelled its timers."""
    if task.get("reminders") and task.get("due_date"):
        _schedule_reminders(hass, entry_id, task)
    if task.get("completed") and task.get("recurrence_enabled"):
        _rearm_or_reopen(hass, entry_id, task)


def _on_task_created(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Fire event when a task is created and arm its timers (issue #43;
    completed recurring tasks arrive via cross-list import)."""
    hass.bus.async_fire(f"{DOMAIN}_task_created", _build_event_data(hass, entry_id, task))
    _rearm_task_timers(hass, entry_id, task)


def _on_task_deleted(hass: HomeAssistant, task_id: str) -> None:
    """Handle task deletion: cancel recurrence, reminders, and clean due-fired cache."""
    _cancel_recurrence(hass, task_id)
    _cancel_reminders(hass, task_id)
    hass.data.get(DATA_DUE_FIRED, {}).pop(task_id, None)


def _on_task_reopened(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Fire event when a task is reopened and reschedule its reminders."""
    hass.bus.async_fire(f"{DOMAIN}_task_reopened", _build_event_data(hass, entry_id, task))
    _schedule_reminders(hass, entry_id, task)


def _on_task_schedule_changed(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Due/recurrence fields of a task that is (and stays) completed were
    edited: the reopen schedule armed at completion time describes the old
    configuration.  Recompute the target from the current fields, rewrite the
    persisted reopen_at, and re-arm (or drop) the timer.

    Target semantics differ from completion time: the stored due_date already
    IS the next occurrence (completion advanced it, or the user just set it),
    so for date-based units the new target is due_date @ recurrence_time —
    NOT due_date plus one more interval.  Hours stay elapsed-based from
    completed_at; without a due_date the target is recomputed the same way
    completion would have.  recurrence_start_date still applies.

    (Reminders need no handling here — the store's on_reminders_changed
    already fires on due_date/due_time edits.)
    """
    _cancel_recurrence(hass, task["id"])
    if not task.get("recurrence_enabled"):
        task["reopen_at"] = None
        return

    completed_at = _parse_completed_at(task)
    if task.get("recurrence_unit") == "hours" or not task.get("due_date"):
        target = _compute_next_reopen_target(task, completed_at)
    else:
        target = _due_date_reopen_target(task)
        if target is not None:
            target = _apply_start_date(task, target)
    task["reopen_at"] = (
        target.astimezone(timezone.utc).isoformat() if target is not None else None
    )
    if target is None:
        return
    _schedule_recurrence(
        hass, entry_id, task, completed_at=completed_at, precomputed_target=target
    )


def _fire_assignment_event(
    hass: HomeAssistant, entry_id: str, task: dict, previous_person: str | None
) -> None:
    """Fire an event when a task's assigned person changes."""
    data = _build_event_data(hass, entry_id, task)
    data["previous_person"] = previous_person
    hass.bus.async_fire(f"{DOMAIN}_task_assigned", data)


# ---------------------------------------------------------------------------
#  Due-date checker (hourly)
# ---------------------------------------------------------------------------

def _async_register_due_checker(hass: HomeAssistant) -> None:
    """Register the periodic due-date checker (once globally)."""
    if hass.data.get(DATA_DUE_CHECK_UNSUB):
        return

    @callback
    def _periodic_check(_now=None) -> None:
        hass.async_create_task(_async_check_due_dates(hass))

    unsub = async_track_time_interval(hass, _periodic_check, DUE_CHECK_INTERVAL, cancel_on_shutdown=True)
    hass.data[DATA_DUE_CHECK_UNSUB] = unsub
    _LOGGER.debug("Due-date checker registered, interval=%s", DUE_CHECK_INTERVAL)


def _schedule_startup_due_check(hass: HomeAssistant) -> None:
    """Schedule a single delayed due-date check after startup (once globally).

    Delayed by 120s so external todo entities from other integrations have time
    to finish loading before we try to read their tasks.
    """
    if hass.data.get(DATA_DUE_STARTUP_DONE):
        return
    hass.data[DATA_DUE_STARTUP_DONE] = True

    @callback
    def _delayed_check(_now):
        hass.async_create_task(_async_check_due_dates(hass))

    async_call_later(hass, 120, HassJob(_delayed_check, "startup_due_check", cancel_on_shutdown=True))
    _LOGGER.debug("Startup due-date check scheduled in 120s")


async def _async_check_due_dates(hass: HomeAssistant, _now=None) -> None:
    """Check all tasks for due/overdue and fire events once per day per task."""
    # HA-configured local date, NOT date.today(): HA never sets the process
    # timezone, so in container installs date.today() can disagree with the
    # profile timezone for hours each day and fire due/overdue on the wrong day.
    today = dt_util.now().date().isoformat()
    fired = hass.data.setdefault(DATA_DUE_FIRED, {})
    stores = hass.data.get(DOMAIN, {})
    store_count = sum(1 for s in stores.values() if isinstance(s, HomeTasksStore))
    _LOGGER.debug("Due-date check: today=%s, stores=%d", today, store_count)

    for entry_id, store in stores.items():
        if not isinstance(store, HomeTasksStore):
            continue
        for task in store.tasks:
            _check_task_due(hass, entry_id, task, today, fired)
            _watchdog_recurring_reopen(hass, entry_id, task)

    # Also check external entities for due dates
    _check_external_due_dates(hass, today, fired)

    # External self-heal: the startup recovery for external lists is a single
    # shot 120s after boot and gives up silently when the third-party todo
    # entity isn't loaded yet.  Re-running it hourly (it skips tasks that
    # already own a live timer) closes that race — parity with the native
    # watchdog above.
    for entry_id, store in stores.items():
        if isinstance(store, ExternalTaskOverlayStore):
            _recover_external_recurrence_timers(hass, entry_id, store.entity_id)


def _watchdog_recurring_reopen(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Self-heal: a completed recurring task must never stay completed past
    its reopen moment.

    The reopen normally fires from an in-memory timer, which can be lost or
    mis-aimed (crash before recovery ran, an earlier scheduling bug, clock
    jumps).  Piggybacking on the hourly due checker, this re-arms a missing
    timer — or reopens immediately if the moment has passed — so a stuck
    task recovers within an hour instead of staying completed forever.
    """
    if not task.get("completed") or not task.get("recurrence_enabled"):
        return
    # Cheap O(1) check first: a live timer owns this task — nothing to heal.
    # (The common steady state; don't pay an ISO parse for it every hour.)
    if task["id"] in hass.data.get(DATA_RECURRENCE_TIMERS, {}):
        return
    if not task.get("completed_at"):
        return
    try:
        datetime.fromisoformat(task["completed_at"])
    except (ValueError, TypeError):
        return
    action = _rearm_or_reopen(hass, entry_id, task)
    if action:
        _LOGGER.warning(
            "Watchdog: completed recurring task '%s' had no reopen timer — %s",
            task.get("title", task["id"]), action,
        )


def _check_task_due(hass: HomeAssistant, entry_id: str, task: dict, today: str, fired: dict) -> None:
    """Check a single task for due/overdue and fire events."""
    if task.get("completed"):
        return
    dd = task.get("due_date")
    if not dd:
        return
    task_id = task["id"]
    task_fired = fired.setdefault(task_id, {})

    event_data = _build_event_data(hass, entry_id, task)

    if dd == today and task_fired.get("due") != today:
        _LOGGER.info("Firing task_due for '%s' (due=%s)", task.get("title"), dd)
        hass.bus.async_fire(f"{DOMAIN}_task_due", event_data)
        task_fired["due"] = today
    elif dd < today and task_fired.get("overdue") != today:
        _LOGGER.info("Firing task_overdue for '%s' (due=%s)", task.get("title"), dd)
        hass.bus.async_fire(f"{DOMAIN}_task_overdue", event_data)
        task_fired["overdue"] = today
    else:
        _LOGGER.debug(
            "Skipping task '%s': due=%s, fired=%s",
            task.get("title"), dd, task_fired,
        )


def _check_external_due_dates(hass: HomeAssistant, today: str, fired: dict) -> None:
    """Check external todo entities for due/overdue tasks."""
    stores = hass.data.get(DOMAIN, {})
    for entry_id, store in stores.items():
        if not isinstance(store, ExternalTaskOverlayStore):
            continue
        entity_id = store.entity_id
        # Read tasks from the external entity via HA state
        try:
            from .provider_adapters import _get_external_todo_items
            from .websocket_api import _merge_tasks_with_overlays
            external_items = _get_external_todo_items(hass, entity_id)
            tasks = _merge_tasks_with_overlays(external_items, store)
            for task in tasks:
                # Inject entity_id so events carry the external entity reference
                task["_entity_id"] = entity_id
                _check_task_due(hass, entry_id, task, today, fired)
        except (ValueError, Exception) as err:
            _LOGGER.debug("Could not check due dates for external entity %s: %s", entity_id, err)


def _build_external_task(hass: HomeAssistant, entry_id: str, entity_id: str, task_uid: str) -> dict | None:
    """Merge an external entity item with its overlay into a Home Tasks task dict."""
    store = hass.data.get(DOMAIN, {}).get(entry_id)
    if not isinstance(store, ExternalTaskOverlayStore):
        return None
    try:
        from .provider_adapters import _get_external_todo_items
        from .websocket_api import _merge_tasks_with_overlays
        merged = _merge_tasks_with_overlays(_get_external_todo_items(hass, entity_id), store)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not build external task %s/%s: %s", entity_id, task_uid, err)
        return None
    for task in merged:
        if str(task.get("id")) == str(task_uid):
            task["_entity_id"] = entity_id  # so events carry the external entity ref
            return task
    return None


def _fire_external_assignment(hass: HomeAssistant, entry_id: str, entity_id: str, task_uid: str, previous_person) -> None:
    """Fire home_tasks_task_assigned for an external task whose assignee changed."""
    task = _build_external_task(hass, entry_id, entity_id, task_uid) or {
        "id": task_uid, "title": "", "_entity_id": entity_id,
    }
    data = _build_event_data(hass, entry_id, task)
    data["previous_person"] = previous_person
    hass.bus.async_fire(f"{DOMAIN}_task_assigned", data)


def _schedule_external_reminders(hass: HomeAssistant, entry_id: str, entity_id: str, task_uid: str) -> None:
    """(Re)schedule reminder timers for one external task after its overlay changed."""
    task = _build_external_task(hass, entry_id, entity_id, task_uid)
    if task is not None:
        _schedule_reminders(hass, entry_id, task)


def _recover_external_reminder_timers(hass: HomeAssistant, entry_id: str, entity_id: str) -> None:
    """On startup, reschedule reminder timers for external tasks (parity with native)."""
    store = hass.data.get(DOMAIN, {}).get(entry_id)
    if not isinstance(store, ExternalTaskOverlayStore):
        return
    try:
        from .provider_adapters import _get_external_todo_items
        from .websocket_api import _merge_tasks_with_overlays
        merged = _merge_tasks_with_overlays(_get_external_todo_items(hass, entity_id), store)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not recover external reminders for %s: %s", entity_id, err)
        return
    for task in merged:
        if not task.get("reminders") or not task.get("due_date"):
            continue
        if task.get("completed") and not task.get("recurrence_enabled"):
            continue
        task["_entity_id"] = entity_id
        _schedule_reminders(hass, entry_id, task)


# ---------------------------------------------------------------------------
#  Recurrence scheduling
# ---------------------------------------------------------------------------

def _parse_rec_time(task: dict) -> tuple[int, int]:
    """Return (hour, minute) for recurrence_time, defaulting to midnight."""
    rec_time = task.get("recurrence_time")
    if rec_time and isinstance(rec_time, str) and len(rec_time) == 5:
        try:
            return int(rec_time[:2]), int(rec_time[3:5])
        except ValueError:
            pass
    return 0, 0


def _set_local_time(local_dt: datetime, hour: int, minute: int) -> datetime:
    """Replace hour/minute on a TZ-aware local datetime, robust against DST.

    - **Spring-forward gap** (e.g. 02:30 on a day where 02:00→03:00):
      the requested wall-clock time doesn't exist.  We advance to the
      first valid moment after the gap (i.e. 03:00 or later).
    - **Fall-back fold** (e.g. 02:30 on a day where 03:00→02:00 makes
      the 02:00–03:00 hour repeat): the time is ambiguous.  We pick
      ``fold=0`` (the first occurrence, pre-transition offset) for
      deterministic behaviour.

    Without this helper a naive ``replace(hour=h, minute=m)`` produces
    an "imaginary" datetime in the gap, and ``astimezone(UTC)`` lands at
    a surprising moment that differs from the user's wall-clock intent.
    """
    candidate = local_dt.replace(hour=hour, minute=minute, second=0, microsecond=0, fold=0)
    # Round-trip through UTC to detect a DST gap.  In a gap, the
    # round-tripped wall-clock time differs from the requested one
    # (zoneinfo resolves the imaginary time using the post-transition
    # offset, so 02:30 maps back to 03:30).
    tz = candidate.tzinfo
    roundtrip = candidate.astimezone(timezone.utc).astimezone(tz)
    if roundtrip.hour != hour or roundtrip.minute != minute:
        # Spring-forward: use the first valid moment after the gap.
        return roundtrip
    return candidate


def _check_end_date(task: dict, target: datetime) -> bool:
    """Return True if target exceeds the recurrence end date (meaning: stop).

    Comparison uses local date because end_date is user-specified in local time.
    """
    if task.get("recurrence_end_type") != "date":
        return False
    end_date_str = task.get("recurrence_end_date")
    if not end_date_str:
        return False
    try:
        end_date = date.fromisoformat(end_date_str)
        return target.astimezone(dt_util.DEFAULT_TIME_ZONE).date() > end_date
    except ValueError:
        return False


def _apply_start_date(task: dict, target: datetime) -> datetime:
    """Advance target to recurrence_start_date if target falls before it.

    Comparison uses local date because start_date is user-specified in local time.
    """
    start_date_str = task.get("recurrence_start_date")
    if not start_date_str:
        return target
    try:
        start_date = date.fromisoformat(start_date_str)
        local_target = target.astimezone(dt_util.DEFAULT_TIME_ZONE)
        if local_target.date() < start_date:
            t_h, t_m = _parse_rec_time(task)
            shifted = local_target.replace(
                year=start_date.year, month=start_date.month, day=start_date.day,
            )
            return _set_local_time(shifted, t_h, t_m)
    except ValueError:
        pass
    return target


def _resolve_dom(year: int, month: int, dom) -> int:
    """Resolve recurrence_day_of_month into a concrete day for (year, month).

    Accepts an int 1–31 (clamped to the month's last day) or the literal "last".
    """
    last = monthrange(year, month)[1]
    if dom == "last":
        return last
    return min(int(dom), last)


def _resolve_nth_weekday(year: int, month: int, nth, weekday: int) -> date | None:
    """Return the date of the nth (1–4) or last *weekday* in (year, month)."""
    matching_days = [
        day for day in range(1, monthrange(year, month)[1] + 1)
        if date(year, month, day).weekday() == weekday
    ]
    if not matching_days:
        return None
    if nth == "last":
        return date(year, month, matching_days[-1])
    idx = int(nth) - 1
    if 0 <= idx < len(matching_days):
        return date(year, month, matching_days[idx])
    return None


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    """Advance (year, month) by *months* months."""
    m = month - 1 + months
    return year + m // 12, m % 12 + 1


def _compute_next_reopen_target(task: dict, completed_at: datetime) -> datetime | None:
    """Compute the target datetime (UTC-aware) when the task should reopen.

    - hours: exact elapsed-based interval (e.g. every 3 h → reopen 3 h after completion)
    - days / weeks / months / years: recurrence_time (or midnight) of the target day
      with optional sub-patterns:
        * weeks  + recurrence_weekdays      → next matching weekday in N-week window
        * months + recurrence_month_pattern → day-of-month or nth-weekday-of-month
        * years  + recurrence_anniversary   → fixed MM-DD anchor
    Returns None if recurrence is not configured or end conditions are met.
    """
    rec_type = task.get("recurrence_type", "interval")
    t_h, t_m = _parse_rec_time(task)

    # Legacy "weekdays" mode (pre-migration tasks): treat as weekly with weekdays
    # filter, value=1.  The migration in store.py normalises new data to
    # interval+weeks; this branch is a safety net for unmigrated stores.
    if rec_type == "weekdays":
        weekdays = task.get("recurrence_weekdays", [])
        if not weekdays:
            return None
        local_completed = completed_at.astimezone(dt_util.DEFAULT_TIME_ZONE)
        completed_weekday = local_completed.weekday()
        min_days = min((w - completed_weekday) % 7 or 7 for w in weekdays)
        target = _set_local_time(local_completed + timedelta(days=min_days), t_h, t_m)
        if _check_end_date(task, target):
            return None
        return _apply_start_date(task, target)

    unit = task.get("recurrence_unit")
    value = task.get("recurrence_value", 1)
    if not unit or unit not in RECURRENCE_UNIT_SECONDS:
        return None

    if unit == "hours":
        reopen_at = completed_at + timedelta(seconds=RECURRENCE_UNIT_SECONDS["hours"] * value)
        if _check_end_date(task, reopen_at):
            return None
        return _apply_start_date(task, reopen_at)

    local_completed = completed_at.astimezone(dt_util.DEFAULT_TIME_ZONE)

    # For date-based intervals (days/weeks/months/years), the user's intent is
    # "advance the due_date to the next occurrence" — anchored at the existing
    # due_date, NOT at the moment of completion.  This makes early completions
    # (complete today's task at 09:00 when it's due 14:00) advance to tomorrow,
    # not stay on today.  For late completions (overdue task), we anchor at
    # local_completed so the next occurrence skips into the future rather than
    # producing another past date.
    anchor_local = local_completed
    due_date_str = task.get("due_date")
    if due_date_str:
        try:
            due_d = date.fromisoformat(due_date_str)
            due_anchor = local_completed.replace(
                year=due_d.year, month=due_d.month, day=due_d.day,
                hour=0, minute=0, second=0, microsecond=0,
            )
            if due_anchor.date() >= local_completed.date():
                anchor_local = due_anchor
        except ValueError:
            pass

    if unit == "days":
        target_local = anchor_local + timedelta(days=value)
    elif unit == "weeks":
        weekdays = task.get("recurrence_weekdays") or []
        if weekdays:
            # Each iteration = value calendar weeks (Mon–Sun blocks).  Within
            # the current iteration, pick the next selected weekday strictly
            # after the anchor weekday.  If none remain in this iteration,
            # jump to the first selected weekday of iteration N+value.
            weekdays_sorted = sorted(set(weekdays))
            anchor_wd = anchor_local.weekday()
            in_this_week = [w for w in weekdays_sorted if w > anchor_wd]
            if in_this_week:
                delta_days = in_this_week[0] - anchor_wd
            else:
                delta_days = max(1, value) * 7 - anchor_wd + weekdays_sorted[0]
            target_local = anchor_local + timedelta(days=delta_days)
        else:
            target_local = anchor_local + timedelta(weeks=value)
    elif unit == "months":
        target_local = _next_monthly_target(task, anchor_local, value)
        if target_local is None:
            return None
    else:  # years
        target_local = _next_yearly_target(task, anchor_local, value)
        if target_local is None:
            return None

    target_time = _set_local_time(target_local, t_h, t_m)
    if _check_end_date(task, target_time):
        return None
    return _apply_start_date(task, target_time)


def _next_monthly_target(task: dict, local_completed: datetime, value: int) -> datetime | None:
    """Compute the next monthly recurrence date (no time component)."""
    pattern = task.get("recurrence_month_pattern")

    if pattern == "day_of_month":
        dom = task.get("recurrence_day_of_month")
        if dom is None:
            # Misconfigured — fall back to "same day next interval".
            year, month = _add_months(local_completed.year, local_completed.month, value)
            return local_completed.replace(
                year=year, month=month,
                day=min(local_completed.day, monthrange(year, month)[1]),
            )
        # First candidate: same month if the resolved day is still ahead.
        candidate_year, candidate_month = local_completed.year, local_completed.month
        candidate_day = _resolve_dom(candidate_year, candidate_month, dom)
        candidate = local_completed.replace(year=candidate_year, month=candidate_month, day=candidate_day)
        if candidate.date() <= local_completed.date():
            candidate_year, candidate_month = _add_months(candidate_year, candidate_month, value)
            candidate_day = _resolve_dom(candidate_year, candidate_month, dom)
            candidate = local_completed.replace(year=candidate_year, month=candidate_month, day=candidate_day)
        return candidate

    if pattern == "nth_weekday":
        nth = task.get("recurrence_nth_week")
        weekdays = task.get("recurrence_weekdays") or []
        if nth is None or not weekdays:
            year, month = _add_months(local_completed.year, local_completed.month, value)
            return local_completed.replace(
                year=year, month=month,
                day=min(local_completed.day, monthrange(year, month)[1]),
            )
        weekday = weekdays[0]
        # Try the same month first; if that hit is not strictly after completion,
        # advance by *value* months.
        target_date = _resolve_nth_weekday(local_completed.year, local_completed.month, nth, weekday)
        if target_date is None or target_date <= local_completed.date():
            year, month = _add_months(local_completed.year, local_completed.month, value)
            target_date = _resolve_nth_weekday(year, month, nth, weekday)
        if target_date is None:
            return None
        return local_completed.replace(year=target_date.year, month=target_date.month, day=target_date.day)

    # No pattern → simple "every N months from completion" behaviour.
    year, month = _add_months(local_completed.year, local_completed.month, value)
    day = min(local_completed.day, monthrange(year, month)[1])
    return local_completed.replace(year=year, month=month, day=day)


def _next_yearly_target(task: dict, local_completed: datetime, value: int) -> datetime | None:
    """Compute the next yearly recurrence date (no time component)."""
    anniversary = task.get("recurrence_anniversary")
    if anniversary and len(anniversary) == 5 and anniversary[2] == "-":
        try:
            month = int(anniversary[:2])
            anchor_day = int(anniversary[3:5])
        except ValueError:
            anchor_day = local_completed.day
            month = local_completed.month
        # Try the current year's anniversary; if it's already past, jump *value* years.
        candidate_year = local_completed.year
        day = min(anchor_day, monthrange(candidate_year, month)[1])
        candidate = local_completed.replace(year=candidate_year, month=month, day=day)
        if candidate.date() <= local_completed.date():
            candidate_year += value
            day = min(anchor_day, monthrange(candidate_year, month)[1])
            candidate = local_completed.replace(year=candidate_year, month=month, day=day)
        return candidate

    # No anchor → "every N years from completion" with leap-year clamping.
    year = local_completed.year + value
    day = min(local_completed.day, monthrange(year, local_completed.month)[1])
    return local_completed.replace(year=year, day=day)


def _compute_reopen_delay(task: dict, completed_at: datetime) -> float | None:
    """Compute seconds from now until the task should reopen.

    Returns None if recurrence is not configured or end conditions are met.
    """
    target = _compute_next_reopen_target(task, completed_at)
    if target is None:
        return None
    now = datetime.now(timezone.utc)
    return (target.astimezone(timezone.utc) - now).total_seconds()


def _schedule_recurrence(
    hass: HomeAssistant,
    entry_id: str,
    task: dict,
    completed_at: datetime | None = None,
    precomputed_target: datetime | None = None,
) -> None:
    """Schedule a task to reopen at its next recurrence target.

    Reminders are NOT handled here — _on_task_completed advances the task's
    due_date/due_time at completion time and calls _schedule_reminders
    separately, so reminders can fire during the completed→reopen window.

    *precomputed_target* lets callers (specifically _on_task_completed, which
    has already mutated task['due_date'] to the next occurrence) reuse the
    target they computed before the mutation.  Without it, this function
    would recompute against the advanced due_date and roll forward a second
    time.
    """
    timers = hass.data.setdefault(DATA_RECURRENCE_TIMERS, {})
    task_id = task["id"]

    _cancel_recurrence(hass, task_id)

    if completed_at is None:
        completed_at = datetime.now(timezone.utc)

    if precomputed_target is not None:
        delay = (precomputed_target.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds()
    else:
        delay = _compute_reopen_delay(task, completed_at)
    if delay is None:
        return

    delay = max(0.0, delay)

    @callback
    def _reopen_task(_now):
        timers.pop(task_id, None)
        hass.async_create_task(_async_reopen_task(hass, entry_id, task_id))

    cancel = async_call_later(hass, delay, _reopen_task)
    timers[task_id] = cancel
    _LOGGER.debug("Scheduled recurrence for task %s in %.0f seconds", task_id, delay)


async def _async_reopen_task(hass: HomeAssistant, entry_id: str, task_id: str) -> None:
    """Reopen a recurring task and reset its sub-tasks.

    No due_date/due_time manipulation here: the advance happens at
    completion time (see _on_task_completed).  This timer callback's
    only job is to flip completed=False and reset sub-task completion
    state — the store does that for us.  Decoupling keeps the
    user-owned due fields untouched, lets manual edits between
    completion and reopen survive, and makes the reopen semantics
    explicit ("flip back to open, nothing else").
    """
    stores = hass.data.get(DOMAIN, {})
    store = stores.get(entry_id)
    if store is None:
        return
    if isinstance(store, ExternalTaskOverlayStore):
        await _async_reopen_external_task(hass, entry_id, store.entity_id, task_id)
        return
    try:
        task = store.get_task(task_id)
    except ValueError:
        return

    if not task.get("recurrence_enabled"):
        return

    await store.async_reopen_task(
        task_id,
        new_due_date=None,           # leave due_date as-is
        new_due_time=_REOPEN_UNCHANGED,  # and due_time too
    )
    _LOGGER.info("Recurring task '%s' reopened", task.get("title", task_id))


def _cancel_recurrence(hass: HomeAssistant, task_id: str) -> None:
    """Cancel a pending recurrence timer."""
    timers = hass.data.get(DATA_RECURRENCE_TIMERS, {})
    cancel = timers.pop(task_id, None)
    if cancel:
        cancel()


# ---------------------------------------------------------------------------
#  Reminder scheduling
# ---------------------------------------------------------------------------

def _compute_due_datetime(task: dict) -> datetime | None:
    """Return timezone-aware datetime for the task's due moment (local time).

    - due_date + due_time → exact datetime
    - due_date only → midnight of that day (local time)
    - no due_date → None
    """
    due_date = task.get("due_date")
    if not due_date:
        return None
    try:
        d = date.fromisoformat(due_date)
    except (ValueError, TypeError):
        return None
    due_time_str = task.get("due_time")
    if due_time_str:
        try:
            h, m = int(due_time_str[:2]), int(due_time_str[3:5])
        except (ValueError, TypeError, IndexError):
            h, m = 0, 0
    else:
        h, m = 0, 0
    return datetime(d.year, d.month, d.day, h, m, 0, tzinfo=dt_util.DEFAULT_TIME_ZONE)


def _schedule_reminders(hass: HomeAssistant, entry_id: str, task: dict) -> None:
    """Schedule async_call_later timers for all reminder offsets of a task.

    Reminders DO fire for completed *recurring* tasks.  When such a task
    is completed, _on_task_completed advances its due_date/due_time to the
    next occurrence; reminders then schedule relative to that future due
    moment and fire during the completed→reopen gap (e.g. a "2 days before"
    reminder can fire 2 days before the task next becomes active).

    Completed *non-recurring* tasks are done for good — no reminders.
    """
    task_id = task["id"]
    _cancel_reminders(hass, task_id)

    if task.get("completed") and not task.get("recurrence_enabled"):
        return

    due_dt = _compute_due_datetime(task)
    if due_dt is None:
        return

    reminders = task.get("reminders", [])
    if not reminders:
        return

    timers = hass.data.setdefault(DATA_REMINDER_TIMERS, {})
    now = datetime.now(timezone.utc)

    for offset in reminders:
        target = due_dt - timedelta(minutes=offset)
        delay = (target.astimezone(timezone.utc) - now).total_seconds()
        if delay <= 0:
            continue  # already past — silent miss

        @callback
        def _fire_reminder(_now, _task=task, _offset=offset):
            key = f"{_task['id']}_r{_offset}"
            hass.data.get(DATA_REMINDER_TIMERS, {}).pop(key, None)
            event_data = {
                **_build_event_data(hass, entry_id, _task),
                "reminder_offset_minutes": _offset,
            }
            hass.bus.async_fire(f"{DOMAIN}_task_reminder", event_data)

        cancel = async_call_later(hass, delay, _fire_reminder)
        timers[f"{task_id}_r{offset}"] = cancel
        _LOGGER.debug(
            "Scheduled reminder for task %s (offset %d min) in %.0f s",
            task_id, offset, delay,
        )


def _cancel_reminders(hass: HomeAssistant, task_id: str) -> None:
    """Cancel all pending reminder timers for a task."""
    timers = hass.data.get(DATA_REMINDER_TIMERS, {})
    prefix = f"{task_id}_r"
    keys = [k for k in list(timers) if k.startswith(prefix)]
    for key in keys:
        cancel = timers.pop(key, None)
        if cancel:
            cancel()


def _recover_reminder_timers(hass: HomeAssistant, entry_id: str, store: HomeTasksStore) -> None:
    """On startup, reschedule reminder timers for tasks with due dates.

    Includes completed *recurring* tasks: their due_date was advanced to
    the next occurrence at completion, so pending reminders may still need
    to fire.  _schedule_reminders itself short-circuits for completed
    non-recurring tasks.
    """
    for task in store.tasks:
        if not task.get("reminders"):
            continue
        if not task.get("due_date"):
            continue
        if task.get("completed") and not task.get("recurrence_enabled"):
            continue
        _schedule_reminders(hass, entry_id, task)


def _due_date_reopen_target(task: dict) -> datetime | None:
    """UTC datetime of the task's stored due_date at recurrence_time.

    For date-based units, completion advances due_date to the next occurrence
    and aims the reopen timer at exactly that day at recurrence_time (local
    midnight when unset) — so "due_date @ recurrence_time" IS the reopen
    moment encoded in the task itself.  Returns None when there is no
    parseable due_date.
    """
    due_date_str = task.get("due_date")
    if not due_date_str:
        return None
    try:
        due_d = date.fromisoformat(due_date_str)
    except (ValueError, TypeError):
        return None
    t_h, t_m = _parse_rec_time(task)
    local_midnight = datetime(due_d.year, due_d.month, due_d.day, tzinfo=dt_util.DEFAULT_TIME_ZONE)
    return _set_local_time(local_midnight, t_h, t_m).astimezone(timezone.utc)


def _recovery_reopen_target(task: dict, completed_at: datetime) -> datetime | None:
    """Reopen target for re-arming a completed recurring task's timer.

    The authoritative source is task["reopen_at"], persisted by
    _on_task_completed when the original timer was armed (and rewritten by
    _on_task_schedule_changed when due/recurrence fields are edited while
    the task sits completed).  Feeding the task back through
    _compute_next_reopen_target instead would anchor on the already-advanced
    due_date and roll one interval further, leaving the task completed a
    full extra interval after every restart (#35, #36, #40).

    Returns None when there is no usable persisted target; the caller then
    falls back to recomputing from completed_at.  (The explicit
    reopen_at=None case — nothing to re-arm — is short-circuited by
    _rearm_or_reopen before this function is consulted; an unparseable
    reopen_at string degrades to the recompute here.)

    Legacy tasks completed before reopen_at existed carry no key at all.
    For those, the stored due_date at recurrence_time is the original
    timer's target — provided it lies after completed_at (i.e. the due was
    actually advanced at completion) and the unit is date-based (for hours
    the due date carries no time-of-day information).
    """
    if "reopen_at" in task:
        raw = task["reopen_at"]
        if raw:
            try:
                parsed = datetime.fromisoformat(raw)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed
            except (ValueError, TypeError):
                pass
        return None

    # ---- Legacy inference (pre-reopen_at data) ----
    if task.get("recurrence_unit") == "hours":
        return None
    target = _due_date_reopen_target(task)
    if target is None or target <= completed_at:
        return None
    return target


def _rearm_or_reopen(hass: HomeAssistant, entry_id: str, task: dict) -> str | None:
    """Re-arm the reopen timer for a completed recurring task, or reopen it
    immediately if its reopen moment has already passed.

    Shared by startup recovery and the hourly watchdog.  Prefers the
    persisted reopen_at; falls back to legacy due-date inference for
    pre-upgrade data, then to recomputing from completed_at (hours unit,
    no due_date).

    Returns "reopened", "scheduled", or None (nothing to do — e.g. the
    recurrence hit its end condition).
    """
    if "reopen_at" in task and task["reopen_at"] is None:
        # Explicitly no target: the recurrence hit its end condition at
        # completion time (or the task completed as a one-off — enabling
        # recurrence afterwards rewrites reopen_at via
        # _on_task_schedule_changed).  Nothing to re-arm, and no point in
        # recomputing this every hourly watchdog pass.
        return None
    completed_at = _parse_completed_at(task)
    target = _recovery_reopen_target(task, completed_at)
    if target is not None:
        delay = (target - datetime.now(timezone.utc)).total_seconds()
    else:
        delay = _compute_reopen_delay(task, completed_at)
        if delay is None:
            return None

    if delay <= 0:
        hass.async_create_task(_async_reopen_task(hass, entry_id, task["id"]))
        return "reopened"
    _schedule_recurrence(
        hass, entry_id, task, completed_at=completed_at, precomputed_target=target
    )
    return "scheduled"


def _recover_recurrence_timers(hass: HomeAssistant, entry_id: str, store: HomeTasksStore) -> None:
    """On startup, recover timers for completed recurring tasks."""
    for task in store.tasks:
        if not task.get("completed") or not task.get("recurrence_enabled"):
            continue

        # Silently skip tasks with missing/invalid completed_at — there's
        # nothing to anchor the next target to.
        if not task.get("completed_at"):
            continue
        try:
            datetime.fromisoformat(task["completed_at"])
        except (ValueError, TypeError):
            continue

        _rearm_or_reopen(hass, entry_id, task)


# ---------------------------------------------------------------------------
#  External-list recurrence (overlay-driven; provider must not own recurrence)
# ---------------------------------------------------------------------------

def _external_owns_recurrence(hass: HomeAssistant, entity_id: str) -> bool:
    """True if the provider handles recurrence itself (e.g. Todoist) — then we
    must NOT apply our overlay recurrence on top (it would double up)."""
    try:
        from .websocket_api import _get_adapter
        adapter = _get_adapter(hass, entity_id)
        return bool(adapter and adapter.capabilities.can_sync_recurrence)
    except Exception:  # noqa: BLE001
        return False


async def _handle_external_recurrence_completion(
    hass: HomeAssistant, entry_id: str, entity_id: str, task_uid: str
) -> None:
    """On external completion of a recurring task: stamp completed_at, apply the
    count limit, and schedule the reopen — unless the provider owns recurrence."""
    if _external_owns_recurrence(hass, entity_id):
        return  # provider auto-recurs on close (e.g. Todoist)
    task = _build_external_task(hass, entry_id, entity_id, task_uid)
    if task is None or not task.get("recurrence_enabled"):
        return
    completed_at = datetime.now(timezone.utc)
    overlay_kwargs: dict = {"completed_at": completed_at.isoformat()}
    if task.get("recurrence_end_type") == "count" and task.get("recurrence_remaining_count") is not None:
        remaining = task["recurrence_remaining_count"] - 1
        overlay_kwargs["recurrence_remaining_count"] = max(0, remaining)
        if remaining <= 0:
            overlay_kwargs["recurrence_enabled"] = False
    from .websocket_api import _get_overlay_store
    await _get_overlay_store(hass, entity_id).async_set_overlay(task_uid, **overlay_kwargs)
    if overlay_kwargs.get("recurrence_enabled") is False:
        return  # count exhausted — no further reopen
    task["completed_at"] = overlay_kwargs["completed_at"]
    _schedule_recurrence(hass, entry_id, task, completed_at=completed_at)


async def _async_reopen_external_task(
    hass: HomeAssistant, entry_id: str, entity_id: str, task_uid: str
) -> None:
    """Reopen a recurring external task: flip the provider item back to open,
    reset sub-items, clear completed_at, fire task_reopened, reschedule reminders."""
    task = _build_external_task(hass, entry_id, entity_id, task_uid)
    if task is None or not task.get("recurrence_enabled"):
        return
    from .provider_adapters import GenericAdapter
    from .websocket_api import _get_adapter, _get_overlay_store
    adapter = _get_adapter(hass, entity_id) or GenericAdapter(hass, entity_id, {})
    try:
        await adapter.async_update_task(task_uid, {"completed": False})
    except Exception as err:  # noqa: BLE001
        _LOGGER.warning("Could not reopen external recurring task %s: %s", task_uid, err)
        return
    overlay_kwargs: dict = {"completed_at": None}
    subs = task.get("sub_items") or []
    if subs:
        overlay_kwargs["sub_items"] = [{**s, "completed": False} for s in subs]
    await _get_overlay_store(hass, entity_id).async_set_overlay(task_uid, **overlay_kwargs)
    task["completed"] = False
    task["completed_at"] = None
    hass.bus.async_fire(f"{DOMAIN}_task_reopened", _build_event_data(hass, entry_id, task))
    _schedule_reminders(hass, entry_id, task)
    _LOGGER.info("Recurring external task '%s' reopened", task.get("title", task_uid))


def _recover_external_recurrence_timers(hass: HomeAssistant, entry_id: str, entity_id: str) -> None:
    """Reschedule reopen timers for completed recurring external tasks.

    Runs once 120s after startup AND hourly from the due checker (external
    watchdog) — tasks that already own a live timer are skipped, so repeat
    invocations only pick up what the startup shot missed (e.g. a provider
    that loaded late).
    """
    if _external_owns_recurrence(hass, entity_id):
        return
    store = hass.data.get(DOMAIN, {}).get(entry_id)
    if not isinstance(store, ExternalTaskOverlayStore):
        return
    try:
        from .provider_adapters import _get_external_todo_items
        from .websocket_api import _merge_tasks_with_overlays
        merged = _merge_tasks_with_overlays(_get_external_todo_items(hass, entity_id), store)
    except Exception as err:  # noqa: BLE001
        _LOGGER.debug("Could not recover external recurrence for %s: %s", entity_id, err)
        return
    timers = hass.data.get(DATA_RECURRENCE_TIMERS, {})
    for task in merged:
        if not task.get("completed") or not task.get("recurrence_enabled"):
            continue
        if task["id"] in timers:
            continue  # live timer owns this task (hourly watchdog re-entry)
        if not task.get("completed_at"):
            continue
        try:
            datetime.fromisoformat(task["completed_at"])
        except (ValueError, TypeError):
            continue
        completed_at = _parse_completed_at(task)
        delay = _compute_reopen_delay(task, completed_at)
        if delay is None:
            continue
        task["_entity_id"] = entity_id
        if delay <= 0:
            hass.async_create_task(_async_reopen_task(hass, entry_id, task["id"]))
        else:
            _schedule_recurrence(hass, entry_id, task, completed_at=completed_at)


# ---------------------------------------------------------------------------
#  Services
# ---------------------------------------------------------------------------

def _resolve_store(hass: HomeAssistant, data: dict) -> tuple[str, HomeTasksStore]:
    """Find the store by entry_id or list_name."""
    entry_id = data.get("entry_id")
    list_name = data.get("list_name")

    if entry_id:
        store = hass.data.get(DOMAIN, {}).get(entry_id)
        if store is None or not isinstance(store, HomeTasksStore):
            raise vol.Invalid(f"No list found with entry_id: {entry_id}")
        return entry_id, store

    if list_name:
        entries = hass.config_entries.async_entries(DOMAIN)
        for entry in entries:
            name = entry.data.get("name", entry.title)
            if name.lower() == list_name.lower():
                store = hass.data.get(DOMAIN, {}).get(entry.entry_id)
                if store and isinstance(store, HomeTasksStore):
                    return entry.entry_id, store
        raise vol.Invalid(f"No list found with name: {list_name}")

    raise vol.Invalid("Either entry_id or list_name must be provided")


def _parse_service_reminders(value) -> list[int]:
    """Service input for reminders: a list of ints or a comma-separated string
    of minute offsets before the due moment (0 = at due time)."""
    if isinstance(value, list):
        return [int(v) for v in value]
    return [int(part.strip()) for part in str(value).split(",") if part.strip()]


def _validate_service_reminders(value) -> list[int]:
    """Schema-time validator for the reminders service field.

    Parses and range-checks at validation time so bad input ("5m", negative
    offsets, too many entries) surfaces as a proper service validation error
    naming the field, not as a raw ValueError traceback from deep in the
    store.
    """
    try:
        parsed = _parse_service_reminders(value)
    except (ValueError, TypeError):
        raise vol.Invalid(
            'reminders must be integer minute offsets before the due moment, '
            'e.g. "60, 0" (0 = at due time)'
        ) from None
    try:
        return validate_reminders(parsed)
    except ValueError as err:
        raise vol.Invalid(str(err)) from None


def _parse_service_tags(value: str) -> list[str]:
    """Service input for tags: a comma-separated string."""
    return [t.strip() for t in value.split(",") if t.strip()]


def _resolve_task(store: HomeTasksStore, data: dict) -> dict:
    """Find a task by task_id or task_title."""
    task_id = data.get("task_id")
    task_title = data.get("task_title")

    if task_id:
        return store.get_task(task_id)

    if task_title:
        matches = [t for t in store.tasks if t["title"].lower() == task_title.lower()]
        if not matches:
            raise ValueError(f"No task found with title: {task_title}")
        incomplete = [t for t in matches if not t.get("completed")]
        return incomplete[0] if incomplete else matches[0]

    raise ValueError("Either task_id or task_title must be provided")


async def _resolve_actor(hass: HomeAssistant, call: ServiceCall) -> str | None:
    """Resolve the actor name from a service call context (user or automation)."""
    user_id = call.context.user_id
    if not user_id:
        return None
    try:
        user = await hass.auth.async_get_user(user_id)
        return user.name if user else None
    except Exception:  # noqa: BLE001
        return None


def _async_register_services(hass: HomeAssistant) -> None:
    """Register integration services (once globally)."""
    if hass.services.has_service(DOMAIN, "add_task"):
        return

    async def async_handle_add_task(call: ServiceCall) -> None:
        entry_id, store = _resolve_store(hass, call.data)
        actor = await _resolve_actor(hass, call)
        # Everything goes in at creation (one task_created event, one
        # 'created' history entry, no intermediate bare state); the store
        # fires task_assigned itself for tasks born with an assignee, so the
        # old follow-up-update workaround is no longer needed — and no longer
        # correct, since the list default assignee is applied at creation.
        task = await store.async_add_task(
            call.data["title"],
            actor=actor,
            assigned_person=call.data.get("assigned_person"),
            due_date=call.data.get("due_date"),
            due_time=call.data.get("due_time"),
            reminders=call.data.get("reminders"),
            notes=call.data.get("notes"),
            priority=call.data.get("priority"),
        )
        # Only tags remain a follow-up update (comma parsing stays service-
        # side); everything else goes in at creation so the task_created
        # event and history carry it.
        if "tags" in call.data:
            await store.async_update_task(
                task["id"], actor=actor, tags=_parse_service_tags(call.data["tags"])
            )

    async def async_handle_update_task(call: ServiceCall) -> None:
        """Update fields of an existing task (issue #42) — find it by task_id
        or task_title, then apply whatever fields the call provides."""
        _entry_id, store = _resolve_store(hass, call.data)
        actor = await _resolve_actor(hass, call)
        task = _resolve_task(store, call.data)
        kwargs: dict = {}
        for key in ("title", "due_date", "due_time", "notes", "assigned_person", "priority"):
            if key in call.data:
                kwargs[key] = call.data[key]
        if "tags" in call.data:
            kwargs["tags"] = _parse_service_tags(call.data["tags"])
        if "reminders" in call.data:
            kwargs["reminders"] = call.data["reminders"]
        if kwargs:
            await store.async_update_task(task["id"], actor=actor, **kwargs)

    async def async_handle_move_task(call: ServiceCall) -> None:
        """Move a task to another list — parity with the card's Move button.

        Source: a native list (list_name/entry_id + task_title/task_id) or a
        linked external todo entity (source_entity_id + task_id). Target:
        exactly one of target_list_name / target_entry_id (native) or
        target_entity_id (linked external). Routes through the same shared
        cross-move implementation as the card, incl. the full-target safety
        net; errors surface as clean service validation messages.
        """
        src_entity = call.data.get("source_entity_id")
        if src_entity:
            task_id = call.data.get("task_id")
            if not task_id:
                raise ServiceValidationError(
                    "task_id is required when source_entity_id is used"
                )
            src_list_id = None
        else:
            src_list_id, store = _resolve_store(hass, call.data)
            task_id = _resolve_task(store, call.data)["id"]
        tgt_entity = call.data.get("target_entity_id")
        tgt_entry = call.data.get("target_entry_id")
        tgt_name = call.data.get("target_list_name")
        if sum(1 for x in (tgt_entity, tgt_entry, tgt_name) if x) != 1:
            raise ServiceValidationError(
                "Provide exactly one of target_list_name, target_entry_id "
                "or target_entity_id"
            )
        tgt_list_id = None
        if not tgt_entity:
            tgt_list_id, _ = _resolve_store(
                hass, {"entry_id": tgt_entry, "list_name": tgt_name}
            )
        try:
            await async_move_task_any(
                hass,
                task_id=task_id,
                src_list_id=src_list_id,
                src_entity_id=src_entity,
                tgt_list_id=tgt_list_id,
                tgt_entity_id=tgt_entity,
            )
        except ValueError as err:
            raise ServiceValidationError(str(err)) from err

    async def async_handle_complete_task(call: ServiceCall) -> None:
        _entry_id, store = _resolve_store(hass, call.data)
        actor = await _resolve_actor(hass, call)
        tag = call.data.get("tag")

        if tag:
            tag = tag.strip().lower()
            for task in store.tasks:
                if (
                    not task.get("completed")
                    and tag in (t.lower() for t in task.get("tags", []))
                ):
                    await store.async_update_task(task["id"], actor=actor, completed=True)
        else:
            task = _resolve_task(store, call.data)
            if not task.get("completed"):
                await store.async_update_task(task["id"], actor=actor, completed=True)

    async def async_handle_assign_task(call: ServiceCall) -> None:
        _entry_id, store = _resolve_store(hass, call.data)
        actor = await _resolve_actor(hass, call)
        task = _resolve_task(store, call.data)
        await store.async_update_task(task["id"], actor=actor, assigned_person=call.data["person"])

    async def async_handle_reopen_task(call: ServiceCall) -> None:
        _entry_id, store = _resolve_store(hass, call.data)
        actor = await _resolve_actor(hass, call)
        task_id = call.data.get("task_id")
        task_title = call.data.get("task_title")
        assigned_person = call.data.get("assigned_person")
        tag = call.data.get("tag")
        tags_raw = call.data.get("tags")

        # Build the required tag set.  `tags` (comma-separated, AND-logic) takes
        # precedence over the legacy `tag` (single value).  Both remain supported
        # for backwards compatibility.
        if tags_raw:
            required_tags = {t.strip().lower() for t in tags_raw.split(",") if t.strip()}
        elif tag:
            required_tags = {tag.strip().lower()}
        else:
            required_tags = set()

        if task_id or task_title:
            # Reopen a single task
            task = _resolve_task(store, call.data)
            if task.get("completed"):
                await store.async_reopen_task(task["id"], actor=actor)
        elif assigned_person or required_tags:
            # Reopen completed tasks matching person and/or tag(s).
            # When multiple tags are given, ALL must be present on the task (AND).
            for task in store.tasks:
                if not task.get("completed"):
                    continue
                if assigned_person and task.get("assigned_person") != assigned_person:
                    continue
                if required_tags:
                    task_tags = {t.lower() for t in task.get("tags", [])}
                    if not required_tags.issubset(task_tags):
                        continue
                await store.async_reopen_task(task["id"], actor=actor)
        else:
            raise vol.Invalid(
                "Either task_id, task_title, assigned_person, tag, or tags must be provided"
            )

    hass.services.async_register(
        DOMAIN, "add_task", async_handle_add_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Required("title"): cv.string,
            vol.Optional("assigned_person"): cv.string,
            vol.Optional("due_date"): cv.string,
            vol.Optional("due_time"): cv.string,
            vol.Optional("notes"): cv.string,
            vol.Optional("priority"): vol.Any(vol.All(vol.Coerce(int), vol.In([1, 2, 3])), None),
            vol.Optional("tags"): cv.string,
            vol.Optional("reminders"): _validate_service_reminders,
        }),
    )
    hass.services.async_register(
        DOMAIN, "update_task", async_handle_update_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Optional("task_id"): cv.string,
            vol.Optional("task_title"): cv.string,
            vol.Optional("title"): cv.string,
            vol.Optional("due_date"): cv.string,
            vol.Optional("due_time"): cv.string,
            vol.Optional("notes"): cv.string,
            vol.Optional("assigned_person"): cv.string,
            vol.Optional("priority"): vol.Any(vol.All(vol.Coerce(int), vol.In([1, 2, 3])), None),
            vol.Optional("tags"): cv.string,
            vol.Optional("reminders"): _validate_service_reminders,
        }),
    )
    hass.services.async_register(
        DOMAIN, "move_task", async_handle_move_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Optional("source_entity_id"): cv.string,
            vol.Optional("task_id"): cv.string,
            vol.Optional("task_title"): cv.string,
            vol.Optional("target_list_name"): cv.string,
            vol.Optional("target_entry_id"): cv.string,
            vol.Optional("target_entity_id"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, "complete_task", async_handle_complete_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Optional("task_id"): cv.string,
            vol.Optional("task_title"): cv.string,
            vol.Optional("tag"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, "assign_task", async_handle_assign_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Optional("task_id"): cv.string,
            vol.Optional("task_title"): cv.string,
            vol.Required("person"): cv.string,
        }),
    )
    hass.services.async_register(
        DOMAIN, "reopen_task", async_handle_reopen_task,
        schema=vol.Schema({
            vol.Optional("entry_id"): cv.string,
            vol.Optional("list_name"): cv.string,
            vol.Optional("task_id"): cv.string,
            vol.Optional("task_title"): cv.string,
            vol.Optional("assigned_person"): cv.string,
            vol.Optional("tag"): cv.string,
            vol.Optional("tags"): cv.string,
        }),
    )
    async def _handle_configure_image_queue(call: ServiceCall) -> None:
        """Configure the background image queue (issue #55).

        Everything is optional: a call that only flips `enabled` keeps the
        pacing and the entity that were configured before.
        """
        queue = async_get_image_queue(hass)
        if queue is None:
            raise ServiceValidationError("Image queue is not running")
        try:
            cfg = await queue.async_configure(
                enabled=call.data.get("enabled"),
                ai_task_entity_id=call.data.get("ai_task_entity_id"),
                prompt_prefix=call.data.get("prompt_prefix"),
                min_minutes=call.data.get("min_minutes"),
                max_minutes=call.data.get("max_minutes"),
            )
        except ValueError as err:
            raise ServiceValidationError(str(err)) from err
        _LOGGER.info("Image queue configured: %s", cfg)

    hass.services.async_register(
        DOMAIN,
        "configure_image_queue",
        _handle_configure_image_queue,
        schema=vol.Schema({
            vol.Optional("enabled"): cv.boolean,
            vol.Optional("ai_task_entity_id"): cv.entity_id,
            vol.Optional("prompt_prefix"): cv.string,
            vol.Optional("min_minutes"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1440)),
            vol.Optional("max_minutes"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1440)),
        }),
    )

    _LOGGER.info("Home Tasks services registered")


# ---------------------------------------------------------------------------
#  Config entry lifecycle
# ---------------------------------------------------------------------------

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Home Tasks from a config entry."""
    await _async_register_card(hass)
    _async_register_services(hass)

    if entry.data.get("type") == "external":
        return await _async_setup_external_entry(hass, entry)

    return await _async_setup_native_entry(hass, entry)


async def _async_setup_native_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a native Home Tasks list from a config entry."""
    store = HomeTasksStore(hass, entry.entry_id)
    await store.async_load()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = store

    # Wire up callbacks
    store.on_task_completed = lambda task: _on_task_completed(hass, entry.entry_id, task)
    store.on_task_created = lambda task: _on_task_created(hass, entry.entry_id, task)
    store.on_task_deleted = lambda task_id: _on_task_deleted(hass, task_id)
    store.on_task_restored = lambda task: _rearm_task_timers(hass, entry.entry_id, task)
    store.on_task_assigned = lambda task, prev: _fire_assignment_event(hass, entry.entry_id, task, prev)
    store.on_task_reopened = lambda task: _on_task_reopened(hass, entry.entry_id, task)
    store.on_reminders_changed = lambda task: _schedule_reminders(hass, entry.entry_id, task)
    store.on_task_schedule_changed = lambda task: _on_task_schedule_changed(hass, entry.entry_id, task)

    # Recover any pending timers from before restart
    _recover_recurrence_timers(hass, entry.entry_id, store)
    _recover_reminder_timers(hass, entry.entry_id, store)

    # Schedule a delayed due-date check (120s) to let all integrations finish loading.
    # This ensures external todo entities are available when we check their tasks.
    _schedule_startup_due_check(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _async_setup_external_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a linked external todo entity with an overlay store."""
    entity_id = entry.data.get("entity_id")
    if not entity_id:
        _LOGGER.error("External entry %s has no entity_id", entry.entry_id)
        return False

    overlay_store = ExternalTaskOverlayStore(hass, entity_id)
    await overlay_store.async_load()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = overlay_store

    # Wire event/reminder hooks so external lists behave like native ones:
    # assignment fires task_assigned; reminder edits (re)schedule timers.
    overlay_store.on_task_assigned = lambda uid, prev: _fire_external_assignment(
        hass, entry.entry_id, entity_id, uid, prev
    )
    overlay_store.on_reminders_changed = lambda uid: _schedule_external_reminders(
        hass, entry.entry_id, entity_id, uid
    )

    # Instantiate the provider adapter.
    # Detect provider_type on the fly if missing (pre-1.7 entries) — do NOT call
    # async_update_entry here because that triggers a config entry reload which
    # would abort this setup mid-flight and cause transient "overlay not found" errors.
    from .provider_adapters import detect_provider_type, get_adapter  # noqa: WPS433

    config_data = dict(entry.data)
    if "provider_type" not in config_data:
        config_data["provider_type"] = detect_provider_type(hass, entity_id)
        _LOGGER.info("Detected provider_type '%s' for %s", config_data["provider_type"], entity_id)

    adapter = get_adapter(hass, entity_id, config_data)
    hass.data.setdefault(f"{DOMAIN}_adapters", {})[entity_id] = adapter

    _LOGGER.info(
        "Linked external todo entity: %s (provider: %s)",
        entity_id,
        adapter.provider_type,
    )
    # External entries don't forward todo/sensor/binary_sensor (those are owned
    # by the source integration) — but they DO get a calendar entity that
    # projects their due/recurring tasks (#27).
    await hass.config_entries.async_forward_entry_setups(entry, EXTERNAL_PLATFORMS)

    _schedule_startup_due_check(hass)

    # Reschedule external reminder + recurrence timers once HA has settled (the
    # external entity may not be loaded yet at setup time).
    @callback
    def _recover_external_timers(_now) -> None:
        _recover_external_reminder_timers(hass, entry.entry_id, entity_id)
        _recover_external_recurrence_timers(hass, entry.entry_id, entity_id)

    async_call_later(hass, 120, _recover_external_timers)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    if entry.data.get("type") == "external":
        unload_ok = await hass.config_entries.async_unload_platforms(
            entry, EXTERNAL_PLATFORMS
        )
        if unload_ok:
            hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
            eid = entry.data.get("entity_id")
            if eid:
                hass.data.get(f"{DOMAIN}_adapters", {}).pop(eid, None)
        return unload_ok

    store = hass.data.get(DOMAIN, {}).get(entry.entry_id)
    if store and isinstance(store, HomeTasksStore):
        fired = hass.data.get(DATA_DUE_FIRED, {})
        for task in store.tasks:
            _cancel_recurrence(hass, task["id"])
            _cancel_reminders(hass, task["id"])
            fired.pop(task["id"], None)

    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """A config entry was permanently removed.

    When it was the last home_tasks entry, delete the Lovelace resource this
    integration auto-created — otherwise every dashboard render keeps trying
    to import a module URL nothing serves after the next restart — and drop
    the pending startup listener.  User-managed YAML resources and the
    extra_js_url registration (page-serve-time only, not persisted) need no
    cleanup.
    """
    remaining = [
        e for e in hass.config_entries.async_entries(DOMAIN)
        if e.entry_id != entry.entry_id
    ]
    if remaining:
        return

    unsub = hass.data.pop(DATA_RESOURCE_UNSUB, None)
    if unsub:
        unsub()

    try:
        lovelace = hass.data.get("lovelace")
        resources = getattr(lovelace, "resources", None)
        if resources is None and isinstance(lovelace, dict):
            resources = lovelace.get("resources")
        if resources is None or not hasattr(resources, "async_delete_item"):
            return
        if not resources.loaded:
            await resources.async_load()
            resources.loaded = True
        for item in list(resources.async_items()):
            if (item.get("url") or "").split("?")[0] == CARD_URL:
                await resources.async_delete_item(item["id"])
                _LOGGER.info("Removed Lovelace resource for Home Tasks card")
                return
    except Exception as err:  # noqa: BLE001 — cleanup must never block removal
        _LOGGER.debug("Could not remove Lovelace resource: %s", err)
