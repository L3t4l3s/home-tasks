# Home Tasks on View Assist

[View Assist](https://dinki.github.io/View-Assist/) turns tablets and old smart
displays into voice satellites with a screen. This folder holds the pieces that
put a Home Tasks list on one of those screens:

| File | What it is |
|------|------------|
| [`hometasks.yaml`](hometasks.yaml) | The view. Shows a Home Tasks list with the full card — priorities, tags, sub-tasks, due dates, reminders, images, voice input. **Start here.** |
| [`hometasks-dynamic.yaml`](hometasks-dynamic.yaml) | Same card, but the list is picked per satellite at runtime, wrapped in View Assist's own chrome. Needs `custom:button-card` and `card-mod`. |
| [`blueprint-hometasks.yaml`](blueprint-hometasks.yaml) | "Show me my tasks" → the satellite speaks how many tasks are open and opens the view. |

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

## What this does not do (yet)

Adding a task **with Home Tasks fields** by voice ("add pay the bill for Anna
with high priority, due Friday") needs its own sentence blueprint on top of
`home_tasks.add_task`; the same goes for having reminder and overdue
[events](../../README.md#events) push a task onto the nearest satellite. Both
are on the list for [issue #18](https://github.com/L3t4l3s/home-tasks/issues/18)
— say so on the issue if you'd use them.

## Status

The views, the blueprint and the fallback behaviour are covered by the test
suite, and the card was checked in a browser at 800×480 and 1280×800. They have
**not** been run on physical View Assist hardware yet — if you try them,
feedback on [issue #18](https://github.com/L3t4l3s/home-tasks/issues/18) is very
welcome.
