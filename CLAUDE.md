# Home Tasks — Development Context

## Project

Home Assistant custom integration for task management. Native todo lists + external provider sync (CalDAV, Google Tasks, Todoist). Lovelace card with drag & drop, sub-tasks, recurrence, reminders, 15 languages.

## Todoist Deep Integration (Active Development)

We bypass `todoist-api-python` entirely with our own REST API client (`todoist_api.py`, ~300 lines, aiohttp). Token is read from HA's existing Todoist config entry. The adapter auto-detects Todoist entities via `entity_registry → config_entry.domain`.

### What works
- Task CRUD (create, read, update, delete)
- Priority (mapped: HT 1/2/3 = Todoist P3/P2/P1)
- Labels/Tags (1:1 string mapping)
- Sub-tasks (real Todoist tasks with parent_id)
- Sort order (via child_order field)
- Recurrence (structured ↔ natural language, e.g. "every monday at 9am")
- Reminders (via /reminders endpoint, minute_offset based)
- Optimistic task + sub-task creation (instant UI, background sync)

### What does NOT work / limitations
- **Assignee**: API v1 silently ignores `assignee_id` on both GET and POST. Write sends it (visible in Todoist app via some internal mechanism), display reads from overlay. Clearing assignee not possible via API.
- **Recurrence count** ("after N times"): Todoist has no concept — overlay only, UI hidden for Todoist lists.
- **Recurrence start date / time**: Hidden for Todoist lists — due date IS the start date in Todoist.

### Open bugs to fix
1. **Switching recurrence to "months" deactivates everything** — same bug pattern as the hours/weeks fix. The `_build_recurrence_string` or `_build_due_params` fails silently for certain unit changes. API errors now propagate to browser console (not caught) to aid debugging.
2. **Switching to "hours" might still append "at 00:00"** — Todoist returns 400 for "every hour at HH:MM". We skip "at" for hours and "00:00", but edge cases may remain.
3. **Recurrence changes via card cause `_loadAllTasks` which re-renders DOM** — user loses focus/typed text during editing. The sub-task creation was fixed (no reload), but recurrence fields still reload.

### API quirks (todoist-api-python v3.1.0 / REST API v1)
- `get_tasks`, `get_projects`, `get_collaborators` return paginated `{"results": [...], "next_cursor": ...}`
- `assignee_id` is silently ignored on both create and update (verified by direct HTTP tests)
- "every hour at HH:MM" → 400 error. "every month at 00:00" → 200 OK.
- `due.date` field contains the date string (may include "T" for datetime)
- Task IDs are alphanumeric strings (e.g. "6gJ4CC7HWjQFjp9r")
- Collaborator IDs are numeric strings (e.g. "58285958")

## Key Architecture

```
provider_adapters.py    — ProviderAdapter ABC, GenericAdapter, TodoistAdapter
todoist_api.py          — TodoistAPIClient (own REST client, no library dependency)
websocket_api.py        — WS commands, adapter routing, merge logic
home-tasks-card.js      — Lovelace card (~4500 lines, 15 languages)
overlay_store.py        — Local storage for fields providers don't support
__init__.py             — Entry setup, adapter instantiation, services
config_flow.py          — Config flow with auto-detection of provider type
```

### Data flow for Todoist lists
1. Card calls `home_tasks/get_external_tasks` → `ws_get_external_tasks`
2. Adapter `async_read_tasks()` → own REST client → Todoist API
3. `_merge_tasks_with_adapter_data()` combines API data + overlay
4. Card renders tasks

### Data flow for updates
1. Card calls `home_tasks/update_external_task` with changed fields
2. `ws_update_external_task` → `adapter.async_update_task(uid, fields)`
3. Adapter splits: API-syncable fields → REST call, rest → `unsynced` dict
4. WS handler stores `unsynced` in overlay via `overlay_store.async_set_overlay()`

### Recurrence flow (most complex part)
- Card sends partial fields (e.g. only `{recurrence_unit: "weeks"}`)
- `_merge_due_fields` fetches current task from API, parses due object, merges
- `_build_recurrence_string` converts structured fields to Todoist natural language
- `_build_due_params` wraps it as `due_string` parameter

## Test Suite

```bash
# 287 tests, pytest-homeassistant-custom-component
python -m pytest          # all tests
python -m pytest tests/test_provider_adapters.py -v  # adapter tests
```

## Todoist test credentials

The API token is in HA's config entry store:
```python
import json
with open('/config/.storage/core.config_entries') as f:
    entries = json.load(f)['data']['entries']
token = next(e['data']['token'] for e in entries if e.get('domain') == 'todoist')
```

Test project: "Familienliste" (shared, project_id=6gJ4C9Wg635wc4HJ)
Collaborator: Kevin (id=58285958)
