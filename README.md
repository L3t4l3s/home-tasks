# Home Tasks

[![hacs_badge](https://img.shields.io/badge/HACS-Default-41BDF5.svg)](https://hacs.xyz/)
[![Validate](https://github.com/L3t4l3s/home-tasks/actions/workflows/validate.yaml/badge.svg)](https://github.com/L3t4l3s/home-tasks/actions/workflows/validate.yaml)

A feature-rich, highly customizable task management solution for Home Assistant — combining a native **integration** (sensors, calendar, events, services) with a versatile Lovelace **dashboard card** offering list and image-tile views, recurring tasks, reminders, sub-tasks, voice input, and optional AI-generated task images. Supports linking **external todo lists** from CalDAV, Google Tasks, Todoist, Bring, Local Todo, and other providers — with full feature parity (recurrence, events, and calendar included).

<p align="center">
  <img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/header-light.png" width="400" alt="Home Tasks in light mode">
  <img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/header-dark.png" width="400" alt="Home Tasks in dark mode">
</p>

## Features

### Per-Task Fields

Every task can carry over 20 individual attributes:

- **Title** — edit inline (expand a task in list view, or open its detail sheet in tiles view)
- **Image** — an optional picture per task, set manually or auto-generated with AI (see [Task Images & AI Generation](#task-images--ai-generation))
- **Notes** — free-text field per task
- **Due date** with overdue highlighting
- **Due time**
- **Priority** — Low / Medium / High with colored badges
- **Assigned person** — any HA person entity
- **Tags** — multiple tags for categorization
- **Sub-tasks** — nested checklist with progress bar
- **Reminders** — up to 5 per task, fire as HA events at a configurable offset before due time
- **Recurring** — fixed intervals: every N hours, days, weeks, months, years
- **Recurring (weekly)** — every N weeks on selected weekdays (Mon – Sun, any combination)
- **Recurring (monthly)** — every N months on a specific day (1–31 or "last") **or** an Nth weekday (1st – 4th + last × Mon – Sun) — e.g. "every 24th", "every last day", "every 2nd Saturday", "every last Wednesday every 2 months"
- **Recurring (yearly)** — every N years on a specific TT.MM anniversary (e.g. "every 24.12.")
- **Recurrence start date** ("Beginn")
- **Recurrence end date**
- **Maximum repetitions**
- **Completion state** with timestamp
- **Task history / audit log** — every field change recorded with actor and timestamp

### External Todo Lists

Display tasks from **any HA todo integration** alongside native Home Tasks lists — on the same card, in the same UI.

- Link external todo entities via **Settings > Integrations > Home Tasks > Link external todo list**
- Provider type is **auto-detected** (Todoist, CalDAV, Google Tasks, etc.) — no extra configuration needed
- For **generic providers** (CalDAV, Google Tasks, Shopping List, etc.): each field is bidirectionally synced only if the provider's todo entity advertises the matching capability (SET_DUE_DATE, SET_DESCRIPTION, …). Everything else — priority, tags, sub-tasks, reminders, recurrence, and base fields the provider can't hold — lives in a local overlay so every Home Tasks feature keeps working.
- For **Todoist**: full bidirectional sync via direct API access — see [Todoist Deep Integration](#todoist-deep-integration) below
- The card editor **auto-configures visibility** based on the provider's capabilities when you select an external list
- You can manually enable overlay fields for external lists if you want them locally
- **Full feature parity**: all [automation events](#events) fire for external lists too (created, completed, reopened, due, overdue, assigned, reminder), they get a [calendar entity](#entities), and **recurrence runs locally** for providers that don't manage it themselves — completing a recurring task reopens it on schedule (for providers that *do* own recurrence, like Todoist, theirs is used instead)

#### Verified Providers

| Provider | HA Integration | Title & Status | Due Date | Due Time | Description | Reorder | Priority | Labels | Sub-tasks | Assignee | Recurrence | Reminders |
|----------|---------------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **CalDAV** (Nextcloud, etc.) | [CalDAV](https://www.home-assistant.io/integrations/caldav/) (Core) | yes | yes | yes | yes | no | no | no | no | no | no | no |
| **Google Tasks** | [Google Tasks](https://www.home-assistant.io/integrations/google_tasks/) (Core) | yes | yes | no | yes | yes | no | no | no | no | no | no |
| **Todoist** | [Todoist](https://www.home-assistant.io/integrations/todoist/) (Core) | yes | yes | yes | yes | yes | yes | yes | yes | no | yes | yes |
| **Local Todo** | [Local Todo](https://www.home-assistant.io/integrations/local_todo/) (Core) | yes | yes | no | yes | no | no | no | no | no | no | no |
| **Bring** | [Bring](https://www.home-assistant.io/integrations/bring/) (Core) | yes | no | no | yes | no | no | no | no | no | no | no |
| **Shopping List** | [Shopping List](https://www.home-assistant.io/integrations/shopping_list/) (Core) | yes | no | no | no | no | no | no | no | no | no | no |

**yes** = bidirectionally synced with the provider. **no** = not synced, but still available locally in Home Tasks via overlay.

**Provider notes:**

- **Google Tasks** — Google's REST API does not expose due times or recurrence ([open issue](https://issuetracker.google.com/issues/36759725)). The Google Tasks web UI shows recurrence dropdowns, but those are written client-side only and never appear in the API — Home Assistant therefore can't read or write them. Use Home Tasks' local recurrence (executed by the integration, not the provider).
- **Todoist** — full bidirectional sync via direct Todoist API.
- **Local Todo** — simple file-based lists built into HA.
- **Bring** — shopping list; all extra fields available locally via overlay.
- **Shopping List** — minimal core shopping list (title + status only); all extra fields via overlay.

Any other integration that creates `todo.*` entities following HA's standard `TodoListEntity` should also work.

Tasks can be **moved between native and external lists** via drag & drop on multi-column cards. Fields that the target provider cannot sync are preserved in the local overlay.

#### Todoist Deep Integration

When you link a Todoist list, Home Tasks automatically detects the Todoist provider and uses the **Todoist REST API directly** (via the existing Todoist integration's API token — no extra configuration required). This enables full bidirectional sync for nearly all fields including title, status, description, due date/time, priority, labels/tags, sort order, sub-tasks, assigned person, recurrence, and reminders.

Home Tasks uses its **own lightweight REST API client** (no dependency on `todoist-api-python`) to communicate directly with the Todoist API. The only requirement is the existing HA Todoist integration being configured — the API token is read from its config entry automatically.

**Unsupported Todoist features** (not synchronized):

- **Comments** — Todoist has a threaded comment system with timestamps and multiple authors; Home Tasks uses a single notes/description field
- **Attachments** — file attachments on tasks or comments
- **Sections** — task grouping within Todoist projects
- **Task duration** — how long a task takes (e.g. 30 minutes)
- **Label colors** — Todoist labels have their own colors and ordering
- **Deadline vs. due date** — Todoist separates planned work date (due) from deadline
- **Favorites** — marking tasks or projects as favorites
- **Saved filters** — Todoist's own filter query language

### Sections

Group tasks within a list under named, optionally icon-bearing **sections** that render as headers between rows. Auto-sort runs *within* each section so manual order is preserved across groups; completed tasks pool in a single "Done" header at the bottom and return to their original section on reopen. Sections live with the list (server-side), so every card and every dashboard sees the same sections — and tasks created from voice, automations, or HA's todo entity can be assigned to a section just like via the card.

Manage sections from the **card editor → Sections**: add, rename, change icon, reorder, delete (tasks fall back to "no section" — never lost). On the card itself, sections can be **collapsed / expanded** with a tap on the header (state persists per browser); during drag & drop, hovering a collapsed section header for ~600 ms automatically opens it ("spring-loaded folder") so you can drop into it. The "Done" header is the only header that's not a drop target — completion is changed via the checkbox.

Typical use: a shopping list whose sections are store aisles ("Produce", "Frozen", "Bakery"), a project list grouped by status, or a chore list grouped by room. v1 supports manual assignment; auto-assignment by tag, title keyword, or learned history is on the roadmap.

### Dashboard Card

- **Multi-column layout** — display multiple lists side-by-side on a single card
- **Per-column configuration** — title, icon, default filter, default sort, show/hide every field individually
- **List or Tiles view** — choose per column between detailed task rows and a compact image grid (see [Tile View](#tile-view))
- **Task images** — show a picture per task; optionally auto-generate them with AI (see [Task Images & AI Generation](#task-images--ai-generation))
- **Sections** — group tasks under named headers with optional icons (see above)
- **Drag & drop** reordering on desktop and mobile, including across sections
- **Cross-list drag & drop** — move tasks between columns (multi-column cards only)
- **Click a task** to expand its details and edit every field inline
- **Duplicate** a task with one click — the copy appears right after the original
- **Filter** per column — All / Open / Done, plus optional **Due Soon** filter (shows tasks due within a configurable number of days)
- **Sort** per column — manual, due date, priority, title, assigned person
- **Tag & person filter chips** in the column header — tap to filter; assigning the active person to new tasks automatically
- **Voice input** — dictate a new task title via the mic button (HA Assist speech-to-text, with browser speech as fallback)
- **Compact mode** for denser task rows
- **Auto-delete** completed tasks (optional, per column)
- **Smooth animations** — FLIP transitions for sort, filter, create, delete, complete, and reopen
- **Visual card editor** — fully configurable without writing YAML

#### Tile View

Set a column's **view mode** to **Tiles** for a compact, visual grid instead of detailed rows — ideal for lists where the image matters (recipes, products, chores for kids). Each tile shows the task image as background (or a colored letter placeholder when there's none), the title overlaid (toggle with `show_tile_title`), and a checkmark when done.

- **Tap** a tile to toggle completion
- **Long-press** (or click & hold) a tile to open its **detail sheet** — the full editor with every field, including an editable title
- **Drag** a tile to reorder, with the same live animations as the list view

#### Voice Input

A mic button on the add-task row lets you dictate a task title instead of typing it. It uses Home Assistant's **Assist speech-to-text** when available and falls back to the browser's built-in speech recognition. Hide the button per column with `show_voice: false`.

### Task Images & AI Generation

Give tasks a picture — handy for recipes, products on a shopping list, or visual chores for kids. Images appear as the tile background in [Tiles view](#tile-view) and as a thumbnail in list view.

- **Enable display** per column with `show_images: true`
- **Pick an image** from the task's detail view via the media-browser button — any file under your Home Assistant `media/` sources
- **Generate with AI** — the generate button creates an image from the task title via an [`ai_task`](https://www.home-assistant.io/integrations/ai_task/) entity (configured card-wide, see below)
- **Remove** an image anytime with the × on its thumbnail

Images are managed on **native** Home Tasks lists.

**AI image generation setup** (card-level, in the visual editor under *AI Image Generation*):

```yaml
type: custom:home-tasks-card
image_generation:
  entity_id: ai_task.openai          # any ai_task.* entity (OpenAI, Gemini, …)
  prompt_prefix: "Minimalist icon of" # optional, prepended to every prompt
columns:
  - list_id: "your-list-id"
    show_images: true
    auto_generate_image: true        # generate automatically on task creation
```

> The main **Model** of your AI entity must be a text/vision model; the actual image model is configured in the AI integration's *image generation* option. `auto_generate_image` only runs when `show_images` is on **and** an `image_generation` entity is set.

**Good to know:**

- **No duplicate work** — if another task with the same title already has an image, it's reused instead of generating again; regenerating an image updates every task with that title across the card.
- **Persistent** — generated and picked images are copied into `config/www/home_tasks/` and served from `/local/…`, so they keep working regardless of how you access Home Assistant (local IP, custom port, or a domain) and don't expire. Unused image files are cleaned up automatically.
- **Duplicating** a task copies its image too.

### Home Assistant Integration

- **7 automation events**: created, completed, reopened, due, overdue, assigned, reminder
- **Services**: add, complete, reopen, and assign tasks from automations
- **Sensors**: open task count + overdue binary sensor per list
- **Calendar**: every list — native **and external** — gets a `calendar.*` entity. Tasks with due dates appear as all-day or timed events, and **recurring tasks are projected onto every occurrence** (each week, month, etc.) via standard RRULE, usable in any HA calendar card or automation
- **Todo entity**: each native list is exposed as a standard `todo.*` entity with full HA todo platform support (Companion App, Apple Watch, etc.)
- **Multiple lists** via separate integration config entries

### Languages

Available in 15 languages — follows your HA language setting automatically:

English · German · French · Spanish · Portuguese · Italian · Dutch · Polish · Swedish · Danish · Norwegian · Finnish · Czech · Russian · Hungarian

---

## Installation

### HACS (recommended)

Home Tasks is available in the HACS default repository.

[![Open your Home Assistant instance and open the Home Tasks repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=L3t4l3s&repository=home-tasks&category=integration)

1. Click the button above — or open HACS and search for **Home Tasks**
2. Click **Download**
3. Restart Home Assistant

### Manual

1. Copy the `custom_components/home_tasks` folder into your `config/custom_components/` directory
2. Restart Home Assistant

## Setup

### Native Lists

1. Go to **Settings** → **Devices & Services** → **Add Integration**
2. Search for **Home Tasks**
3. Click **Add Service**
4. Choose **Create a new task list**
5. Enter a name for your list
6. Repeat for additional lists

### External Lists

1. Set up the external provider's HA integration first (e.g. CalDAV, Google Tasks, Todoist)
2. Go to **Settings** → **Devices & Services** → **Add Integration**
3. Search for **Home Tasks**
4. Click **Add Service**
5. Choose **Link an external todo list**
6. Select the todo entity from the dropdown
7. The external list is now available in the card editor

The Lovelace card is automatically registered — just add it to your dashboard.

---

## Card Configuration

All options are available in the visual card editor. The examples below cover the most common setups.

### Column option reference

Each entry in `columns` accepts the following options.

| Option | Default | Description |
|--------|---------|-------------|
| `list_id` | — | The native list to display (use this **or** `entity_id`) |
| `entity_id` | — | An external todo entity to display (use this **or** `list_id`) |
| `title` | List name | Custom column title |
| `icon` | — | MDI icon shown next to the column title (e.g. `mdi:home`) |
| `view_mode` | `list` | Layout: `list` (detailed rows) or `tiles` (image grid) |
| `default_filter` | `all` | Initial filter: `all`, `open`, `done`, or `due_soon` |
| `default_sort` | `manual` | Initial sort: `manual`, `due`, `priority`, `title`, or `person` |
| `compact` | `false` | Compact mode for denser task rows |
| `auto_delete_completed` | `false` | Automatically delete completed tasks |
| **Header / chrome** | | |
| `show_title` | `true` | Show/hide the column title |
| `show_progress` | `true` | Show/hide the task progress counter |
| `show_add_task` | `true` | Show/hide the "add task" input row (set `false` for a read-only display) |
| `show_voice` | `true` | Show/hide the voice-input mic button on the add-task row |
| `show_sort` | `true` | Show/hide the sort button |
| `show_filters` | `true` | Show/hide the All / Open / Done filter buttons |
| `show_tag_chips` | `true` | Show/hide the tag filter chips in the header |
| `show_person_chips` | `true` | Show/hide the person filter chips in the header |
| `show_due_soon_filter` | `false` | Enable the "Due Soon" filter button |
| `due_soon_days` | `7` | Days ahead for the "Due Soon" filter (0–90, 0 = due today only) |
| `hide_overdue` | `false` | Hide overdue tasks in the "Due Soon" filter (overdue shown by default) |
| **Per-task fields** | | |
| `show_images` | `false` | Show task images (tile background / list thumbnail) |
| `auto_generate_image` | `false` | Auto-generate an image with AI when a task is created (needs `show_images` + a card-level `image_generation` entity) |
| `show_tile_title` | `true` | (Tiles view) Show the title overlay on each tile |
| `show_notes` | `true` | Show/hide the notes field |
| `show_sub_tasks` | `true` | Show/hide sub-tasks |
| `show_assigned_person` | `true` | Show/hide person assignment |
| `show_priority` | `true` | Show/hide priority field and badge |
| `show_tags` | `true` | Show/hide tags, badges, and filter chips |
| `show_due_date` | `true` | Show/hide due date and time |
| `show_reminders` | `true` | Show/hide reminders |
| `show_recurrence` | `true` | Show/hide recurrence settings |
| `show_history` | `false` | Show/hide the task change history |

### Card-level option reference

These options live at the **root** of the card config, not inside a column.

| Option | Default | Description |
|--------|---------|-------------|
| `columns` | — | List of column configs (required) |
| `title` | — | Optional card title shown above the columns |
| `image_generation.entity_id` | — | An `ai_task.*` entity used to generate task images |
| `image_generation.prompt_prefix` | — | Text prepended to every AI image prompt (e.g. `Minimalist icon of`) |
| `grid_options` | — | Standard HA grid sizing (e.g. `columns: 36`, `rows: auto`) |

The old flat format (`list_id` at root level) is still supported and migrated automatically.

---

### Use Cases

<table>
<tr>
<td width="50%" valign="top">

#### 🏠 Household

<img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/Household-full.png" alt="Household list">

Full-featured list for shared household tasks — priorities, due dates, person assignment, and recurrence keep everything organized. Default filter `open` keeps the view focused.

```yaml
type: custom:home-tasks-card
columns:
  - list_id: "your-list-id"
    default_filter: open
```

</td>
<td width="50%" valign="top">

#### 🛒 Shopping List

<img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/Shopping-list.png" alt="Shopping list">

Minimal and fast — just items and checkboxes. Completed entries disappear immediately. All metadata fields hidden to reduce clutter.

```yaml
type: custom:home-tasks-card
columns:
  - list_id: "your-list-id"
    auto_delete_completed: true
    show_notes: false
    show_sub_tasks: false
    show_assigned_person: false
    show_priority: false
    show_tags: false
    show_due_date: false
    show_reminders: false
    show_recurrence: false
    show_sort: false
```

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### 💼 Work / Projects

<img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/usecase-work.png" alt="Work and projects list">

Focused on deadlines — priorities, due dates, reminders, and sub-tasks. Person assignment and recurrence hidden to reduce noise.

```yaml
type: custom:home-tasks-card
columns:
  - list_id: "your-list-id"
    default_filter: open
    default_sort: due
    show_assigned_person: false
    show_tags: false
    show_recurrence: false
```

</td>
<td width="50%" valign="top">

#### 🎒 Kids Chores

<img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/usecase-chores.png" alt="Kids chores list">

Who does what and when — person assignment, weekday recurrence, and tags for time-of-day filtering. No deadlines, notes, or sub-tasks needed.

```yaml
type: custom:home-tasks-card
columns:
  - list_id: "your-list-id"
    title: Kids Chores
    icon: mdi:school
    show_priority: false
    show_due_date: false
    show_reminders: false
    show_notes: false
    show_sub_tasks: false
```

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### External: Nextcloud CalDAV

Display a Nextcloud todo list in the Home Tasks card. The external provider handles title, status, due date, and description. Local overlay adds priority and tags.

```yaml
type: custom:home-tasks-card
columns:
  - entity_id: "todo.nextcloud_tasks"
    title: Nextcloud Tasks
    icon: mdi:cloud-sync
    show_priority: true
    show_tags: true
    show_sub_tasks: false
    show_assigned_person: false
    show_reminders: false
    show_recurrence: false
```

</td>
<td width="50%" valign="top">

#### Mixed: Native + External

Combine a native Home Tasks list with a synced Google Tasks list on the same card. Each column is independently configured.

```yaml
type: custom:home-tasks-card
columns:
  - list_id: "your-native-list-id"
    title: Home
    icon: mdi:home
  - entity_id: "todo.google_tasks_my_tasks"
    title: Google
    icon: mdi:google
```

</td>
</tr>
</table>

---

### Multi-Column Example: Kanban Board

<p align="center">
  <img src="https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/Multi-column-kanban.png" width="820" alt="Multi-column Kanban board">
</p>

Multiple lists displayed side-by-side on a single card. Tasks can be dragged between columns. Extend `grid_options` to give the card more horizontal space.

```yaml
type: custom:home-tasks-card
title: Kanban Board
columns:
  - list_id: "your-list-id1"
    auto_delete_completed: true
    show_recurrence: false
  - list_id: "your-list-id2"
    show_recurrence: false
  - list_id: "your-list-id3"
    show_recurrence: false
grid_options:
  columns: 36
  rows: auto
```

---

## Automations

### Events

| Event | Description |
|-------|-------------|
| `home_tasks_task_created` | Fired when a task is created |
| `home_tasks_task_completed` | Fired when a task is marked as done |
| `home_tasks_task_due` | Fired when a task's due date is today (once per day) |
| `home_tasks_task_overdue` | Fired when a task is past its due date (once per day) |
| `home_tasks_task_assigned` | Fired when a person is assigned to a task |
| `home_tasks_task_reopened` | Fired when a task is reopened (manually or by recurrence) |
| `home_tasks_task_reminder` | Fired at the configured offset before a task's due time |

All events include: `entry_id`, `task_id`, `task_title`, and (if set) `assigned_person`, `due_date`, `tags`.
Events for external lists additionally include `entity_id` (the external todo entity).
The `home_tasks_task_reminder` event additionally includes `reminder_offset_minutes`.

### Services

#### `home_tasks.add_task`

| Field | Required | Description |
|-------|----------|-------------|
| `list_name` | * | Name of the list |
| `entry_id` | * | Config entry ID (alternative to `list_name`) |
| `title` | yes | Task title |
| `assigned_person` | no | Person entity ID (e.g. `person.ben`) |
| `due_date` | no | Due date (`YYYY-MM-DD`) |
| `tags` | no | Comma-separated tags (e.g. `"kitchen,daily"`) |

#### `home_tasks.complete_task`

Provide `task_title`/`task_id` for a single task, or `tag` to complete all open tasks with that tag.

| Field | Required | Description |
|-------|----------|-------------|
| `list_name` | * | Name of the list |
| `entry_id` | * | Config entry ID |
| `task_title` | ** | Title of the task |
| `task_id` | ** | UUID of the task |
| `tag` | ** | Complete all open tasks with this tag |

#### `home_tasks.reopen_task`

Target by single task, person, tag, or a combination.

| Field | Required | Description |
|-------|----------|-------------|
| `list_name` | * | Name of the list |
| `entry_id` | * | Config entry ID |
| `task_title` | ** | Title of the task |
| `task_id` | ** | UUID of the task |
| `assigned_person` | ** | Reopen all completed tasks for this person |
| `tag` | ** | Reopen all completed tasks with this tag |

#### `home_tasks.assign_task`

| Field | Required | Description |
|-------|----------|-------------|
| `list_name` | * | Name of the list |
| `entry_id` | * | Config entry ID |
| `task_title` | ** | Title of the task |
| `task_id` | ** | UUID of the task |
| `person` | yes | Person entity ID |

*\* Either `list_name` or `entry_id`. \*\* See individual service descriptions for required combinations.*

### Entities

For each native list, the integration creates:

- **Todo** (`todo.{list_name}`): Standard HA todo entity — works with the Companion App, Apple Watch, Google Home, and any HA automation that targets `todo.*` entities.
- **Calendar** (`calendar.{list_name}_calendar`): Tasks with a due date appear as calendar events. Tasks with only a due date show as all-day events; tasks with both due date and due time show as 1-hour timed events with a rich description (notes, priority, assignee, tags, sub-task progress, reminders). **Recurring tasks expand onto every occurrence** in the viewed range (mapped to an RFC-5545 RRULE — daily, weekly on selected weekdays, monthly by day-of-month/Nth-weekday, yearly anniversary). External lists get a calendar entity too. A calendar needs a date to anchor on, so tasks without a due date aren't shown (hourly recurrence has no calendar equivalent and shows as a single event).
- **Sensor** (`sensor.{list_name}_open_tasks`): Number of open tasks. Attributes: `open_task_titles`, `overdue_count`.
- **Binary Sensor** (`binary_sensor.{list_name}_overdue`): `on` if any task is past its due date.

### Example Automations

Send a notification when a reminder fires:

```yaml
automation:
  - alias: "Home Tasks: Reminder notification"
    trigger:
      - platform: event
        event_type: home_tasks_task_reminder
    action:
      - service: notify.mobile_app
        data:
          title: "Task reminder"
          message: "{{ trigger.event.data.task_title }} is due soon"
```

Reopen morning chores when a child arrives home:

```yaml
automation:
  - alias: "Reopen morning tasks for Ben"
    trigger:
      - platform: state
        entity_id: person.ben
        to: "home"
    action:
      - service: home_tasks.reopen_task
        data:
          list_name: "Kids Chores"
          assigned_person: person.ben
          tag: "morning"
```

Complete all weekend tasks on Monday morning:

```yaml
automation:
  - alias: "Complete weekend tasks"
    trigger:
      - platform: time
        at: "08:00:00"
    condition:
      - condition: time
        weekday: [mon]
    action:
      - service: home_tasks.complete_task
        data:
          list_name: "Household"
          tag: "weekend"
```

## Support

If Home Tasks is useful to you, consider supporting the project — it keeps the motivation going and helps fund future development. 🙏

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-%23EA4AAA?logo=github)](https://github.com/sponsors/L3t4l3s)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%23FFDD00?logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/l3t4l3s)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-%2300457C?logo=paypal&logoColor=white)](https://paypal.me/kevinschimnick)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
