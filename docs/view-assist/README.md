# Home Tasks on View Assist

[View Assist](https://dinki.github.io/View-Assist/) turns tablets and old smart
displays into voice satellites with a screen. This folder holds the pieces that
put a Home Tasks list on one of those screens:

| File | What it is |
|------|------------|
| [`hometasks.yaml`](hometasks.yaml) | The view. Shows a Home Tasks list with the full card — priorities, tags, sub-tasks, due dates, reminders, images, voice input. **Start here.** |
| [`hometasks-dynamic.yaml`](hometasks-dynamic.yaml) | Same card, but the list is picked per satellite at runtime, wrapped in View Assist's own chrome. Needs `custom:button-card` and `card-mod`. |
| [`blueprint-hometasks.yaml`](blueprint-hometasks.yaml) | "Show me my tasks" → the satellite speaks how many tasks are open and opens the view. |
| [`blueprint-hometasks-reminders.yaml`](blueprint-hometasks-reminders.yaml) | Reminders and overdue tasks → the chosen satellites announce them, show the view and put an icon in the status bar until the task is done. |
| [`blueprint-hometasks-add.yaml`](blueprint-hometasks-add.yaml) | "Add task pay the bill for Anna with high priority due Friday" → the task is created with those fields and the satellite says so. Works on any Assist device. |

Nothing here changes the integration — these are copy-and-install assets, so a
Home Tasks update never overwrites your customised view.

> Home Tasks lists are ordinary `todo.*` entities, so View Assist's built-in
> **list** view and its **List Management** blueprint already work with them.
> What you get here is the real Home Tasks card instead of the plain todo list.

## Requirements

- Home Assistant 2024.10 or newer
- [View Assist](https://dinki.github.io/View-Assist/) integration, set up with at least one satellite
- Home Tasks with at least one native list
- For `hometasks-dynamic.yaml` only: `custom:button-card` and `card-mod` (both are View Assist requirements anyway)

## 1. Install the view

Save the file on the HA machine as
`/config/view_assist/views/hometasks/hometasks.yaml` — for example from the
Terminal add-on:

```bash
mkdir -p /config/view_assist/views/hometasks && wget -O /config/view_assist/views/hometasks/hometasks.yaml https://raw.githubusercontent.com/L3t4l3s/home-tasks/main/docs/view-assist/hometasks.yaml
```

Then let View Assist install it into its dashboard — **Developer tools →
Actions**, YAML mode:

```yaml
action: view_assist.load_asset
data:
  asset_class: views
  name: hometasks
  download_from_repo: false
```

`download_from_repo: false` matters: with `true`, View Assist would look for the
view in its own GitHub repository and fail.

The view is now at **`/view-assist/hometasks`**. Open it on a satellite with:

```yaml
action: view_assist.navigate
data:
  device: sensor.viewassist_kitchen
  path: /view-assist/hometasks
```

To use the per-satellite variant instead, install
`hometasks-dynamic.yaml` under the same path and name — use one or the other,
not both.

## 2. Choose the list

With no `list_id`, the card shows the **first** Home Tasks list. To pin a
specific one, add its config entry id to the column in the view file:

```yaml
columns:
  - list_id: 01k2m4p6r8t0v2x4z6b8d0f2h4
    compact: true
```

Get that id in **Developer tools → Template**:

```jinja
{{ config_entry_id('todo.shopping_list') }}
```

(It is also the last part of the URL when you open the list under
*Settings → Devices & Services → Home Tasks*.)

With `hometasks-dynamic.yaml` you don't pin anything: the view reads the
satellite's `home_tasks_list` attribute, which the blueprint sets before it
navigates. If that attribute is missing the card falls back to the first list;
if it points at a deleted list the card shows an empty list rather than an
error.

## 3. Install the blueprint (optional)

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FL3t4l3s%2Fhome-tasks%2Fblob%2Fmain%2Fdocs%2Fview-assist%2Fblueprint-hometasks.yaml)

Create an automation from it and pick your list. Then, on a satellite:

> — "Show me my task list."
> — "There are 4 open tasks on your Household. The next ones are Take out the bins, Water the plants, …"

…and the view opens on the screen. Audio-only satellites just get the spoken
answer.

Everything is configurable in the blueprint: the sentences, how many task
titles are read out, and the three response texts (they take `{list_name}`,
`{count}` and `{items}` placeholders, so you can translate them to your
language).

The blueprint asks for the list's **todo entity**, not for a config entry id —
it derives the id itself with `config_entry_id()` and hands it to the view.

## 4. Add tasks by voice (optional)

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FL3t4l3s%2Fhome-tasks%2Fblob%2Fmain%2Fdocs%2Fview-assist%2Fblueprint-hometasks-add.yaml)

Create an automation from it and pick the list new tasks go to — native or
linked. Then:

> — "Add task pay the bill for Anna with high priority due Friday at 5 pm."
> — "Added Pay the bill to your Household, for Anna, high priority, due Friday 2 October at 17:00"

The sentence only has to catch the task text; the fields are read by the
[`home_tasks.add_task_from_text`](../../README.md#home_tasksadd_task_from_text)
action. It picks up, at the end of the sentence and in any order:

- a **person** — `for Anna` (only people that exist in Home Assistant, by full
  or unique first name),
- a **priority** — `with high priority`, `low priority`,
- a **due date** — `today`, `tomorrow`, `due Friday`, `next Monday`,
  `in 3 days`, `on 5 October`,
- a **time** — `at 5 pm`, `at 17:30`.

What it doesn't recognise stays in the title, so "add task look for the keys"
gives you *Look for the keys*, not a task for someone called "the keys".

The default commands are `(add | create) [a] [new] task {task}` and
`new task {task}`. Keep a word like "task" in yours: sentence triggers are
checked before Home Assistant's own intents, so a bare `add {task}` would also
swallow "add milk to my shopping list".

**German** — the words are built in; set the blueprint inputs to:

| Input | Value |
|-------|-------|
| Command text 1 | `[neue] aufgabe {task}` |
| Command text 2 | `füge [die] aufgabe {task} hinzu` |
| Language | `de` (or leave empty if Home Assistant runs in German) |
| Response - added | `{title} zu {list_name} hinzugefügt` |
| Response - added, with fields | `{title} zu {list_name} hinzugefügt, {details}` |
| Response - failed | `Daraus konnte ich keine Aufgabe machen: {text}` |

> — „Neue Aufgabe Rechnung bezahlen für Anna mit hoher Priorität fällig am Freitag um 17 Uhr.“

Other languages work for the title, but their dates and priorities are read
with the English words — say on
[issue #18](https://github.com/L3t4l3s/home-tasks/issues/18) if you'd like
your language added.

With **Show the list on View Assist** switched on, the satellite that heard the
command also opens the Home Tasks view afterwards (a linked list opens the
view's default list).

## 5. Reminders on the satellites (optional)

[![Open your Home Assistant instance and show the blueprint import dialog with a specific blueprint pre-filled.](https://my.home-assistant.io/badges/blueprint_import.svg)](https://my.home-assistant.io/redirect/blueprint_import/?blueprint_url=https%3A%2F%2Fgithub.com%2FL3t4l3s%2Fhome-tasks%2Fblob%2Fmain%2Fdocs%2Fview-assist%2Fblueprint-hometasks-reminders.yaml)

When a Home Tasks [reminder](../../README.md#events) fires — or a task is due
today or overdue, if you pick those events — the satellite

- **announces** it ("Reminder: Pay the bill, due at 17:00"),
- **opens the Home Tasks view** for a while, then goes back,
- **puts an icon in its status bar** — one per task; tapping it opens the view,
  and it disappears when the task is done.

Each of the three can be switched off, and the messages are configurable
(placeholders `{title}`, `{list_name}`, `{person}`, `{due_time}`).

**Which satellite.** View Assist has no idea where people are, so the
blueprint chooses satellites the way View Assist's own *Device Alerts*
blueprint does — the first of these you fill in wins:

1. **All satellites**
2. **Specific satellites**
3. **Dynamic satellites** — a template returning a list. This is where
   "the nearest one" goes. The template can use `assigned_person`,
   `task_title`, `list_name`, `task_id` and `trigger.event.data`.

*By assigned person* — Anna's tasks go to the kids' room, everything else to
the kitchen:

```jinja
{{ {'person.anna': ['sensor.viewassist_kids_room']}.get(assigned_person, ['sensor.viewassist_kitchen']) }}
```

*The satellite that last heard a voice command:*

```jinja
{% set ns = namespace(best=none, t=none) %}
{% for s in integration_entities('view_assist') if s.startswith('sensor.') %}
  {% set m = state_attr(s, 'mic_device') %}
  {% if m and states[m] is defined and (ns.t is none or states[m].last_changed > ns.t) %}
    {% set ns.best = s %}{% set ns.t = states[m].last_changed %}
  {% endif %}
{% endfor %}
{{ [ns.best] if ns.best else [] }}
```

If you have room presence (Bermuda, mmWave sensors, …), map that to
satellites in the same way.

**Quiet times.** Satellites in do-not-disturb mode get the icon and the view
but no announcement — the View Assist convention. Outside the
*announcement hours* (default 07:00–21:00):

- a **reminder** only sets the icon — it is about that moment, and saying it
  hours later would be wrong;
- **due today** and **overdue**, which Home Tasks fires in its first hourly
  check after midnight, set the icon right away and are announced when the
  announcement hours begin — unless the task was done in the meantime. One
  that arrives in the evening (a task added late) only sets the icon; next
  morning it is overdue and says so itself.

**The icon** disappears when the task is done in Home Tasks, and after
12 hours at the latest (configurable). The timeout catches what Home Tasks
can't see: a deleted task, or one ticked off in a linked provider's own app.

The announcement uses `assist_satellite.announce` on the satellites' mic
devices — one call for all of them, so they speak at the same time — and
needs Assist satellites that support announcements. The blueprint needs
Home Assistant 2025.4 or newer. A satellite that is offline doesn't stop the others.

## Tuning for the screen

Measured with the shipped view at the two common satellite resolutions:

| Screen | Behaviour |
|--------|-----------|
| 1280×800 | The whole card fits, no scrolling. |
| 800×480 | The header, add-task row and filter chips take ~170 px; the page scrolls once about six tasks are open. |

Two ways to keep the header and the add-task row fixed on small screens — add
either to the column in the view file:

- `max_height: 280` — caps the **task body** in px and scrolls only that part.
  Measured with the shipped view on 800×480: 290 is the largest value that still
  fits, 300 already tips the page back into scrolling. On 1280×800 no cap is needed.
- `show_tag_chips: false` and `show_person_chips: false` — frees about 55 px
  by dropping the two filter chip rows.

Other options worth knowing on a wall tablet: `view_mode: tiles` with
`show_images: true` for a picture grid (great for kids' chores), and
`show_add_task: false` for a display-only view. The full list is in the
[Card Configuration](../../README.md#card-configuration) section of the main
README.

`confirm_complete: true` is on by default here — it asks before ticking a task
off, which is worth having on a screen that gets walked past.

## Status

The views, the blueprints and the fallback behaviour are covered by the test
suite — the add-by-voice blueprint runs end to end through Assist there, in
English and German, and the reminders blueprint against Home Tasks' real
events, with View Assist's actions checked against its own schemas — and the card was checked in a browser at 800×480 and
1280×800. They have
**not** been run on physical View Assist hardware yet — if you try them,
feedback on [issue #18](https://github.com/L3t4l3s/home-tasks/issues/18) is very
welcome.
