# Home Tasks – Day Plan, Spec v0.3

Status: v0.3 · 2026-11-13 · built, see §10.
Scope: the feature as the integration ships it. How someone names their lists,
uses tags or schedules a briefing is theirs to decide and not part of this.

---

## 1. Concept

A **plan** is a view across lists: per date, an ordered set of *references* to
tasks. Tasks stay in their lists, with their position, section and all fields.
Checking off or editing a row acts on the task in its own list. Removing a row
removes only the reference.

A plan is its own **config entry** (third entry type `plan`, next to `native`
and `external`). That gives it a place for settings, a sensor and an LLM API,
and allows several plans side by side (e.g. work and private). Plan entries do
not count towards `MAX_LISTS`.

## 2. Plan settings (config entry options)

| Setting | Default | Meaning |
|---|---|---|
| Name | – | Shown in the card header and as device name |
| Source lists | all lists | Lists (native or linked) the plan may reference. Enforced by the integration on every read and write. |
| Workdays | all days | Days that exist in this plan. Other days are skipped everywhere (columns, carry-over, "tomorrow"). |
| Include due tasks | on | Tasks with a due date appear on their day automatically (§4). |
| Carry-over | suggest | `off` / `suggest` / `auto` for unfinished planned items of the previous workday. |

## 3. Storage

One store per plan entry.

```json
{
  "version": 1,
  "days": {
    "2026-11-16": {
      "items": [
        { "task_id": "<id>", "list": "<entry_id | entity_id>", "auto": false, "done_on": null }
      ],
      "note": "Focus: …",
      "updated": "2026-11-16T07:41:00+01:00",
      "updated_by": "user | llm | service"
    }
  }
}
```

- `list` is a hint. A reference resolves by `task_id`; when the task is not in
  the hinted list, the other source lists are searched (the task was moved).
- `done_on` is written when the task is completed while it sits on that day.
  A recurring task that reopens later still reads as done on that day.
- `auto: true` marks a due item that was written only to keep its position
  after a reorder (§4). It is ignored and pruned once the task's due day is no
  longer this day.
- `dropped: true` marks an unfinished item of a past day that was taken off
  the plan afterwards. The day still shows it; it is no longer carried over.
- A task on the plan is its list and its id together: ids are only unique
  within a list. Services, WebSocket commands and tools take the list
  (`entry_id`) as an optional hint next to the task id.
- A change that is refused (day full, note too long, beyond the horizon)
  leaves the stored plan exactly as it was.
- Past days are kept for 14 days, then pruned. References to deleted tasks are
  dropped when a day is resolved.

## 4. What a day shows

A day is resolved live, in this order of rules:

1. **Planned items**: the stored `items` of that day, in stored order.
2. **Due items** (if enabled): every open task from the source lists whose due
   date is that day and that is not planned on any day from today on. They are
   not stored. Default position: top of the day, by due time, then priority.
3. **Overdue**: open tasks with a due date before today appear in *today*.
4. **Explicit wins**: a task planned on another day shows only there; its due
   badge stays visible on the row.
5. **One day only**: from today on, a task sits on at most one day. Planning
   it for another day moves it.
6. **Non-workdays**: a due date on a non-workday shows on the last workday
   before it.
7. **Due items cannot be removed**, only moved to another day. To get rid of
   one, change the task's due date.

Reordering a day stores its full order, including due items (as `auto`).

## 5. Services

| Service | Fields | Response |
|---|---|---|
| `home_tasks.get_day_plan` | plan, `date` (default today), `days` (1–7, default 1) | Per day: `date`, `note`, `items[]` with `task_id`, list id and name, `title`, `priority`, `tags`, assignees, `due_date`, `completed`, `kind: planned \| due \| overdue` |
| `home_tasks.set_day_plan` | plan, `date`, `items` (ordered task refs), `note`, `mode: merge \| replace` (default `merge`) | – |
| `home_tasks.plan_task` | plan, task ref, `date`, `position: top \| bottom` | – |
| `home_tasks.unplan_task` | plan, task ref | – |

`merge` keeps items already on the day that the call does not name and applies
the given order to the rest. An LLM briefing uses `merge`, so that items the
user planned the evening before survive.

Changes to existing services:

- `get_tasks` accepts several lists and returns the list id and a last-changed
  timestamp on each task. The single-list response shape stays as it is.
- `add_task` returns the new `task_id` (optional response).
- `update_task` keeps its way of clearing a due date: an empty `due_date`
  string clears date and time. Document it in `services.yaml` and cover it
  with a service-level test, for native and linked lists.

**Horizon**: a plan covers today plus the next six workdays (7 days in
total). The card and the services share this limit; writes beyond it are
rejected.

The card uses matching WebSocket commands (`plan_ws.py`): `get_plans`,
`get_plan` (with the plan's lists and its sensor), `plan_task`,
`set_plan_day` (order after a drag, note, or both) and `unplan_task`.

## 6. Card: `custom:home-tasks-day-plan-card`

```yaml
type: custom:home-tasks-day-plan-card
plan: <plan entry>
days: 5          # 1–7 day columns; 1 = today only
```

First built as `view: day_plan` of the list card, a card type of its own
since stage 1 of `CARD_SPLIT_PLAN.md` (see the notes at the end).

A separate render path of the list card's code; it reuses the task editor,
check-off and drag-and-drop sorting. No filters, sort menu, sections or
new-task input.

**Today column**
- Header on an accent-tinted surface: "Today" + date, focus note, "n of m
  done", progress bar.
- Rows carry their order number instead of a checkbox. Tapping it completes
  the task; the row stays struck through for the day.
- Each row shows a badge of its list, plus priority, tags, assignee, due date.

**Further days**
- Plain header ("Tomorrow", then weekday + date) with the item count.
- Same rows.

**Interactions**
- Drag within a day reorders; drag to another day re-plans.
- In a row's details, next to the task's other actions: "→ <next day>",
  "Other day…", "Remove from plan" (planned items only).
- "Plan a task" under each day: search across the source lists.
- Carry-over hint on an empty today: "Carry over n open items from <date>".
- Tap opens the task editor of the task's own list.
- Columns have a minimum width and scroll horizontally; today stays first.

**In normal list cards**: task menu entry "Plan for…" with a day picker
(shown when a plan exists whose source lists include that list).

## 7. Sensor

One sensor per plan: state = open items today (planned, due and overdue).
Attributes: `date`, `done`, `total`. The card watches it for live updates,
as it does with the list sensors today.

## 8. LLM access

Each plan registers its own **set of tools** (an HA "LLM API") with
`llm.async_register_api` in the plan entry's setup: id
`home_tasks-<entry_id>`, name = plan name, unregistered on unload. No MCP
server in the integration; HA's own MCP Server integration serves the set,
and so does any HA conversation agent that is given it.

- Tools, each named `home_tasks__<name>`. Tasks: `get_tasks`, `get_task`,
  `add_task`, `update_task`, `complete_task`, `reopen_task`, `delete_task`,
  `move_task`, `add_sub_task`, `update_sub_task`, `remove_sub_task`. Plan:
  `get_plan`, `set_plan`, `plan_task`, `unplan_task`. Typed arguments
  (priority 1–3, tag lists, real nulls, recurrence as one object).
- Together they cover what the task services cover, plus deleting. Left out
  on purpose: list settings and defaults, and anything outside the plan's
  lists.
- Scope: the plan's source lists only, enforced in the tools. Nothing else of
  the house is reachable through the set.
- Task tools go through the integration's services, so they behave like a
  service call (validation, linked lists, events). Plan writes are stored
  with `updated_by: llm`.
- Each tool says what it does (read-only, destructive, idempotent, reaches
  outside HA when the plan has a linked list), which HA's MCP Server passes
  on and uses for read-only connections.
- The set's prompt tells the assistant the plan's name, lists, today's date
  and workdays, how the plan works, and the planning rules of §9.
- In HA's MCP Server, every set has its own URL
  (`/api/mcp/home_tasks-<entry_id>`, administrator account required).
  Pointing the assistant's connector at the plan's URL gives it the plan
  tools and no device control.

Without this set, an assistant only gets what Assist offers for exposed todo
entities (titles and status, no priority, tags, assignees, order or plan),
or needs hand-written scripts per user as in spec v0.2.

## 9. Planning rules for an LLM briefing

1. Read the open tasks of the source lists and the plan for today.
2. Keep what is already on today; due and overdue items are fixed points.
3. Fill up to a sensible number of items, in working order: committed dates,
   then high priority in list order, then items others are waiting on.
4. Write with `mode: merge`. Do not touch future days.
5. Read delegated tasks with status `all`: a checked-off recurring follow-up
   counts as done until it reopens.

## 10. Build order

1. Service changes: `get_tasks` for several lists, `add_task` response. — done
2. Plan entry: config flow, store, resolution rules, services, sensor, tests. — done
   (`plan.py`, `plan_services.py`, `tests/integration/test_plan.py`)
3. Plan tool set (LLM API) and the briefing. — done (`plan_llm.py`,
   `tests/integration/test_plan_llm.py`). The briefing is the set's prompt
   plus one automation calling a conversation agent (README); the
   integration has no scheduler of its own.
4. Card view mode `day_plan`, then "Plan for…" in list cards. — done
   (`plan_ws.py`, the "Day plan view" block in `home-tasks-card.js`,
   `tests/integration/test_plan_ws.py`, `tests-js/test_day_plan.mjs`)

## 11. Open points

None at the moment.

Known limits:

- `last_changed` in `get_tasks` is the time of the task's last history
  entry. Sub-task edits write no history, so they do not move it.
- A plan reads linked lists through the snapshot the sensors use (no I/O).
  Fields that a rich provider holds itself (on Todoist: priority and labels)
  can be missing on plan rows; title, done, due date and assignee are there.
  `get_tasks` reads the provider and has them.
- The tool set is written for HA's tool interface of 2026.10 (tools name
  their integration and return a `ToolResult`) and falls back to plain
  results on versions without it. Only 2026.10 is tested.
- The day plan view has no fixed-height layout of its own (sections view
  with a fixed number of rows): the card grows with its longest day.
- On touch, dragging a row to a day that is scrolled out of view is not
  possible; use "Other day…" in the row's details.
- Changing a plan's workdays does not move what is already stored on a day
  that is now a day off; such items stay hidden until that day is pruned.

How it was built, where the spec left it open:

- On a day off, the plan's current day is the next workday.
- A completed task cannot be planned.
- Carry-over `suggest`: `get_day_plan` returns `carry_over` (date and items)
  for the current day while nothing is planned on it. `auto`: the items show
  on the current day with `carried_from` and are stored with the day's next
  write.
- The config flow's list limit no longer blocks the menu; it applies when a
  list is created or linked, and plans do not count.
- Tools name a task by its id only; the list is found within the plan's
  lists. `add_task` needs the list's name when the plan has several.
- `set_plan` takes `task_ids` and returns the day as it reads afterwards.
- The card loads the plan's lists as columns it never draws; a row is a task
  of one of them, so completing and editing run through the list code.
- `days` defaults to 1. What a row shows is set with the task-related column
  options at the root of the card config (or in `columns[0]`).
- A done row is not draggable; `set_plan_day` accepts the day's done rows in
  an order so that the rest can be sorted around them.
- A row that is done for the day while its task is open again (a recurring
  task) has an inactive number: a tap would complete the next round.
- The list badge on a row is left out when the plan has one list.
- The visual editor offers the view once a plan exists and then shows only
  title, plan and days; row options are YAML for now.
- "Plan for…" is always offered on lists a plan draws from (no switch).
- `home_tasks_task_reopened` carries `reopened_by: recurrence` when the
  recurrence opened the task for its next occurrence. That, not the task's
  history, is how a plan tells it from an un-tick (linked lists write no
  such history).
- A source list that is deleted stays in the plan's selection and keeps
  limiting it; the settings show it as "Deleted list". A plan never widens
  to all lists on its own.
- With carry-over `auto`, taking a carried row off the plan marks its item
  on the last planned day as `dropped`.
- A day plan card whose plan is refused (entry reloading, restart) keeps
  watching the plan's sensor and asks again with the lists' backoff.

After the first try on a real system (27 lists, 16 of them linked):

- The plan's sensor changes only when the plan reads differently (a
  fingerprint of its lists' tasks, what is stored, its settings and the day).
  Linked lists report in every few minutes with nothing new; that used to
  reach the card as a change and made it reload and rebuild all the time.
- `get_plan` gives every list a stamp of its tasks. The card loads a list
  again only when its stamp moved, after its own write to a linked list, or -
  for linked lists with a row on the days shown - with the 30 s poll.
- A background look that finds nothing new does not rebuild the card.
- Ticking a row off shows at once; the list and the plan follow.
- The plan's actions sit at the top of an open row, above the task's fields.
- "Plan a task" has the lists with something to plan as filter chips.
- The card editor sets the plan's lists (WebSocket `set_plan_lists`,
  administrators only) and a compact mode.
- The editor of the view is laid out like a list column's: the plan where a
  column has its list, then the sections *Display* (card: days, compact;
  day header: date, progress, focus) and *Lists*. Date, progress bar and
  focus line can each be switched off (`show_date`, `show_progress`,
  `show_focus`; all on by default). A third section, *Task features*, sets
  which fields an open row shows and in which order (the columns' `show_*`
  and `detail_order`, at the root of the card config). Row badges stay YAML.
- The editor has a weekend switch. It writes the plan's workdays (WebSocket
  `set_plan_workdays`, administrators only), leaving the other days as they
  are; all seven days is stored as "none chosen".
- Lists and plans are still made in Home Assistant's dialog for the
  integration; the card does not copy it. For administrators the editor and
  the "no plan" message link to the integration's page
  (`/config/integrations/integration/home_tasks`), where "Add service"
  starts that dialog: from the editor in a new tab, so that unsaved changes
  stay, and the editor reads lists and plans again when the window gets the
  focus back. No address starts the dialog itself for an integration that is
  already set up: `/config/integrations/dashboard/add?domain=…` does, but
  first asks whether to "set up Home Tasks" - and the card only exists once
  it is.
- A row that is done for the day while its task is open again no longer
  has an inactive number. A tap takes back the day's "done" (WebSocket
  `untick_plan_task`) and nothing else: the task is not toggled - that
  would complete its next round - and the recurrence is not rolled back.
  The item stays on the day, as planned if the due date no longer holds it
  there. Found on a real plan: a completed recurring task whose due date was
  set to today was reopened by the recurrence at once, and its row was done
  and locked while the task was open and due.
- Second review, what it changed:
  - A day is written as it reads, and a list that cannot be read right now
    (not loaded, or a linked list reading as empty - a provider that is away)
    does not read. Its stored items are carried along by every write instead
    of being lost. A linked list that reads without the task has lost it.
  - When the workdays change, what is planned on a day that is a day off now
    moves to the workday before it (to the current day when that is past).
  - Taking a day's "done" back removes the task's open references on later
    days: one day only.
  - The card's own options win over those of a first column left over from a
    card of lists; the editor reads both that way and folds the column in
    with the first change.
  - The editor's list chips show a chosen list that is not there as a chip of
    its own and save it along; `set_plan_lists` accepts an unknown id that is
    already chosen. A plan never widens to all lists by a list being absent.
  - A tick the list refuses is taken back on the card, and the list read
    again. The second click of a double-click on a tick that only takes the
    day's "done" back is ignored.
  - A background look renders only when a list came back different, not when
    it was merely asked again (the 30 s poll of linked lists).
  - Dragging in a card that shows one list in two columns takes the row of
    the column the drag started in.
  - Todoist collaborators are asked for again after a failed first read.
- Run through in the browser on Home Assistant 2026.11.1, what it found:
  - The same plan read again stays the same objects, and so do a list's
    tasks. A background look that finds nothing new does not rebuild the
    rows; with new objects behind them a tick was set on a row nobody drew
    from any more and showed only once the list had answered (about 190 ms).
  - The editor's title fields are inputs of its own. `ha-textfield` is not
    defined in 2026.11; the fields took no room and were simply gone.
  - A task that is on a day through its due date and is ticked off keeps
    its place: the day is written as it reads, with the task where it stood
    among the due rows. It used to drop behind every due row still open.
- The day plan is a card type of its own (`custom:home-tasks-day-plan-card`,
  "Home Tasks: Day plan" in the picker) with its own editor element. The
  class extends the list card and puts it in plan mode; nothing inside moved
  (stage 1 of `CARD_SPLIT_PLAN.md`). The list card is "Home Tasks: List" in
  the picker and keeps its type. With it went: the "Card shows" switch, the
  `view` key (the list card refuses `view: day_plan` and names the new
  type), and everything about a first column left over in a plan's config -
  a plan card has no columns, the key is ignored. A new card from the picker
  names the first plan; the editor does the same for a config without one
  when there are several. The picker's names and descriptions are
  translated, by the language Home Assistant keeps for the browser.
- Third review, what it changed:
  - A plan change the backend refuses is not kept on the card: the plan as
    it is read next replaces the card's copy, also when it reads the same
    as before.
  - The limit of items per day counts what was put on the day, not what is
    there through its due date.
  - The guard against the second click of a double-click, after a day's
    "done" was taken back, is that row's alone.
  - A recurring task that is due again the same day is on it once.
  - A linked list is away when its todo entity is missing or unavailable.
    One that answers with no tasks is empty, and has lost what it no longer
    names.
  - A day that becomes a day off hands its focus on with its tasks, to a
    day that has none of its own.
  - One lookup for every text - card, editors, picker: the language, its
    base language, English.
  - Left as it is: a list that is asked again is serialized twice to see
    whether it changed. The second pass is what notices a change the card
    made on its own and the backend refused.
- A row that is on a day through its due date says so in place of "Remove
  from plan"; both move actions carry the arrow.
- On a plan that leaves due tasks out, a task planned on its due day is a
  planned item like any other (`auto` is never set there) - it used to
  vanish, because such a plan shows no `auto` items.
- A reference follows its task to another list only between native lists
  (a move keeps the id there, and native ids are unique). It never leaves a
  linked list and never ends in one: a provider's id found elsewhere is
  another task. A deleted task used to be replaced by such a twin.
- With carry-over `auto`, what `replace` takes off the day is marked
  `dropped` on the last planned day, as unplanning does - it used to walk
  back in with the next read.
- `get_tasks` over several lists survives a list that cannot be read: its
  entry in `lists` carries `error`.
- The tool set grew from eight tools to fifteen (reopen, delete, move,
  sub-tasks, one task in full; recurrence, reminders, section, position and
  picture when adding or changing). `delete_task` is the one tool that cannot
  be undone; it is marked destructive and the prompt says to use it only
  when asked to delete.
- A reopen is the recurrence's only when its timer did it. The store says so
  (`reopened_by_recurrence`); the history label cannot, because a reopen
  without a user is recorded as "recurrence" either way.
- A linked Todoist list whose project is not found reads as empty and
  refuses new tasks, instead of reading every task of the account and
  creating in the Inbox. The project id comes from Home Assistant's own
  Todoist entity; names are only the fallback.
