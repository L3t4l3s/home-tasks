# Testing

## Philosophy

**The job of a test is to catch broken functionality — not to prove that
our code ran.**  A test that registers a mock service with exactly the
name our code calls, then asserts our code called that name, proves
nothing about whether the real system offers that service.  That pattern
hid a provider reorder bug for months and must stay out of the suite.

Concretely:

1. **Mocks only from HA's official test infrastructure**
   (`pytest-homeassistant-custom-component`'s `hass` fixture,
   `MockConfigEntry`, `hass_ws_client`, `async_fire_time_changed`,
   official mock entities, etc.).  No hand-rolled `hass.data["todo"] =
   MagicMock()`, no `hass.services.async_register` of service names our
   own code is about to call.
2. **Everything else runs against the real environment and real
   providers.**  A reorder test is only meaningful if it verifies the
   change reached the external system — that's what the live-test
   ``get_provider_items`` helper (calls ``todo.get_items`` directly) is
   for.
3. **The card is part of the product.**  Drag-drop, FLIP animation and
   optimistic delete need browser-level verification (via the Chrome
   MCP), not only WebSocket-command assertions.

## Test types

| Type | Directory | Marker | Requirements | Speed |
|---|---|---|---|---|
| **Unit** | `tests/unit/` | `unit` | Pure Python, no `hass` | ~1s |
| **Integration** | `tests/integration/` | `integration` | in-memory HA via pytest-hacc | ~5s |
| **E2E** | `tests/e2e/` | `e2e` | in-memory HA + WebSocket, native flows only | ~10s |
| **Live** | `tests/live/` | `live` | Real HA instance + real providers | ~60s |

**Unit**: Pure-function tests only (priority mapping, recurrence parsing,
Todoist payload builders, …).  Testing anything that touches `hass`
belongs in Integration or Live — a handwritten `hass = MagicMock()`
mock accepts any call and silently green-lights broken code.

**Integration**: Drive real store / websocket_api / platform code against
pytest-hacc's in-memory `hass`.  Only official fixtures — do **not**
inject a fake ``hass.data["todo"]`` or register services our own code
is about to call.

**E2E**: Full WebSocket command chains for **native** home_tasks lists
(own store, own sub-tasks, own reorder), all against pytest-hacc's
`hass`.  External-list flows are **not** tested here — every attempt
to do so in-memory ends up fabricating provider behaviour.  External
reorder/create/update is verified in **Live**.

**Live**: Run against a real HA instance with real providers configured.
Each reorder test uses a dual-view assertion: it checks both our merged
`home_tasks/get_external_tasks` response and the provider's own
`todo.get_items` response.  If the provider doesn't confirm the change,
the test fails with a precise message — no more silent overlay
fallbacks.  Live tests opt-in via `-m live` or a provider-specific
marker.

---

## Setup

### Prerequisites
- Python 3.12 (tested with 3.12.2)
- Windows: no Docker required

### Create the virtual environment

```bash
# From D:\projects\Home_Tasks
# Clear any global PYTHONHOME/PYTHONPATH that might interfere (e.g. Python 3.7 globally)
PYTHONHOME="" PYTHONPATH="" \
  "C:/Users/schim/AppData/Local/Programs/Python/Python312/python.exe" \
  -m venv .venv

PYTHONHOME="" PYTHONPATH="" \
  .venv/Scripts/python.exe -m pip install --upgrade pip
PYTHONHOME="" PYTHONPATH="" \
  .venv/Scripts/python.exe -m pip install -r requirements_test.txt
```

On first run, this downloads and installs Home Assistant core (~500 MB). Subsequent runs use the cache.

---

## Running tests

### Activate the venv (optional convenience)
```bash
source .venv/Scripts/activate   # Git Bash / WSL
.venv\Scripts\activate          # Windows cmd
```

All commands below assume the venv is active, or prefix with `PYTHONHOME="" PYTHONPATH="" .venv/Scripts/python.exe -m`.

### Run all offline tests (default)
```bash
pytest
```
Runs unit + integration + e2e. Live tests are excluded by default (`-m "not live"` in `pytest.ini`).

### Run by type
```bash
pytest tests/unit/          # unit only   (~1s)
pytest tests/integration/   # integration only (~5s)
pytest tests/e2e/           # e2e only (~10s)
```

### Run by marker
```bash
pytest -m unit
pytest -m integration
pytest -m e2e
pytest -m "unit or integration"
```

### Run a single file or test
```bash
pytest tests/unit/test_store.py -v
pytest tests/integration/test_websocket_api.py::test_ws_add_task -v
pytest tests/e2e/test_flows.py::test_reorder_external_tasks_move_failure_falls_back_to_overlay_flow -v
```

### With coverage
```bash
pytest --cov=custom_components/home_tasks --cov-report=term-missing
pytest tests/e2e/ --cov=custom_components/home_tasks --cov-report=term-missing
```

---

## Live tests

Live tests require a real HA instance and credentials. They are excluded by default.

### Setup

1. Copy the template and fill in your credentials:
   ```bash
   cp tests/live/.env.example tests/live/.env
   ```
2. Edit `tests/live/.env`:
   ```env
   HT_HA_URL=http://192.168.1.x:8123
   HT_HA_TOKEN=eyJ...          # long-lived access token
   HT_NATIVE_LIST_NAME=Home-Tasks E2E Test
   HT_NATIVE_LIST_NAME_2=Home-Tasks E2E Test 2
   HT_TODOIST_TEST_ENTITY=todo.ht_test_todoist
   HT_GOOGLE_TASKS_TEST_ENTITY=todo.ht_test_google
   HT_CALDAV_TEST_ENTITY=todo.ht_test_nextcloud
   HT_LOCAL_TODO_TEST_ENTITY=todo.ht_test_local
   HT_BRING_TEST_ENTITY=todo.ht_test_bring
   HT_MAX_EXISTING_ITEMS=50
   ```
   `tests/live/.env` is gitignored — never commit credentials.

3. Create dedicated test lists/entities in your HA instance. The tests wipe these lists on each run. **Do not point them at real data.**

### Run live tests
```bash
# All live tests (all configured providers)
pytest tests/live/ -m live -v

# Specific provider
pytest tests/live/ -m live_google_tasks -v
pytest tests/live/ -m live_todoist -v
pytest tests/live/ -m live_caldav -v
pytest tests/live/ -m live_local_todo -v
pytest tests/live/ -m live_bring -v
pytest tests/live/ -m live_websocket -v

# Native list E2E (create/update/move/complete flows)
pytest tests/live/test_e2e_websocket.py -m live -v
```

Missing env vars are auto-skipped — a partial setup (e.g. only Todoist configured) will skip unconfigured providers cleanly.

---

## Adding new tests

### Where to put them
- **New business logic / data model** → `tests/unit/`
- **New HA platform or service** → `tests/integration/`
- **New multi-command flow or cross-component interaction** → `tests/e2e/`
- **New provider or real-API behavior** → `tests/live/`

### Marking
Each file must have a module-level `pytestmark`:
```python
pytestmark = pytest.mark.unit        # or integration / e2e
```
Live tests use:
```python
pytestmark = [pytest.mark.live, pytest.mark.live_google_tasks]
```

### E2E test pattern
Use the `_cmd` / `_cmd_fail` helpers from `tests/e2e/test_flows.py` to issue WebSocket commands and assert responses. Always test the full cycle: command → subsequent read → assert state reflects the change.

---

## Deploying to the live HA instance

`scripts/deploy.py` uploads the integration via SSH (tar-pipe) and then reloads all
`home_tasks` config entries via the HA WebSocket API.  No Docker or SCP needed.

### Prerequisites

```bash
pip install paramiko websocket-client   # already in requirements_test.txt
```

### Usage

Set credentials via environment variables (never hard-code them):

```bash
export HT_SSH_HOST=<ip-of-ha-vm>
export HT_SSH_USER=<ssh-user>
export HT_SSH_PASSWORD=<ssh-password>
export HT_HA_URL=http://<ha-host>:8123
export HT_HA_TOKEN=<long-lived-access-token>   # same as live tests .env
```

Then run:

```bash
# From D:\projects\Home_Tasks with the venv active:
python scripts/deploy.py

# Or without activating the venv:
PYTHONHOME="" PYTHONPATH="" .venv/Scripts/python.exe scripts/deploy.py

# Deploy only (skip the WebSocket reload):
python scripts/deploy.py --no-reload

# Override individual params on the CLI:
python scripts/deploy.py --host 192.168.1.x --user myuser --password mypassword
```

### What it does

1. Builds an in-memory `.tar.gz` of `custom_components/home_tasks/` (excluding `__pycache__`).
2. SSHs into the target host and extracts the archive into
   `/homeassistant/custom_components/home_tasks`.  
   (`/config` → `/homeassistant` are a symlink on most HA VMs — both paths work.)
3. Calls `homeassistant.reload_config_entry` for every `home_tasks` config entry via
   the HA WebSocket API so the new code is active without a full restart.

### Full HA restart

If a reload is not enough (e.g. after JS card changes), restart HA core via:

```bash
python - <<'EOF'
import urllib.request, os
token = os.environ["HT_HA_TOKEN"]
base  = os.environ["HT_HA_URL"]
req = urllib.request.Request(
    f"{base}/api/services/homeassistant/restart",
    data=b"{}", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
try:
    urllib.request.urlopen(req, timeout=10)
except Exception as e:
    print(f"Restart triggered (connection drop expected): {e}")
EOF
```

---

## CI / CD notes

Only unit, integration, and e2e tests are suitable for CI. Live tests require external services and should be run manually before releases.

Suggested CI command:
```bash
PYTHONHOME="" PYTHONPATH="" .venv/Scripts/python.exe -m pytest \
  tests/unit/ tests/integration/ tests/e2e/ \
  --tb=short -q
```

---

## Fixture architecture

```
hass (pytest-hacc)
 └── auto_enable_custom_integrations  [autouse] — pops DATA_CUSTOM_COMPONENTS cache
      └── enable_custom_integrations  (pytest-hacc) — allows our integration to load

 └── patch_add_extra_js_url           [autouse] — prevents frontend KeyError

mock_config_entry(hass)
 └── loads the integration via hass.config_entries.async_setup()
 └── depends on patch_add_extra_js_url

store(hass, mock_config_entry)
 └── returns hass.data["home_tasks"][entry.entry_id]
```

---

## Windows-specific workarounds (already in conftest.py)

These are solved once and committed — no manual action needed:

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| `SocketBlockedError` on event loop creation | pytest-hacc blocks all sockets; asyncio needs `socketpair()` internally | Save real `socket.socket` before guarding; restore it during `socketpair()` calls |
| `ModuleNotFoundError: hass_frontend` | `frontend.async_setup` imports the compiled bundle (not in test venv) | Replace `frontend.async_setup` with a lightweight mock |
| `custom_components.__path__` points to testing_config | pytest-hacc's `_async_mount_config_dir` imports `custom_components` as a regular package from its own testing_config dir | Import `custom_components` at conftest module level (before any fixtures run) so the namespace package from our project root is cached first |
| `RuntimeError: aiodns needs SelectorEventLoop` | aiohttp's `AsyncResolver` uses `aiodns` which requires `SelectorEventLoop`; pytest-hacc forces `ProactorEventLoop` on Windows | Patch `aiohttp.connector.DefaultResolver = ThreadedResolver` at import time; also install `winloop` |
| Lingering IOCP accept tasks | Windows `ProactorEventLoop` accept coroutines don't cancel cleanly when HTTP server stops | Override `expected_lingering_tasks = True` for Windows in conftest |
