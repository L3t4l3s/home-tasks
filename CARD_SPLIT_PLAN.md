# Plan: several card types over one shared core

Status: stages 1 to 3 are built (2026-11-15); stage 4, the timeline card,
needs a plan of its own.

## Why

The card file holds two views today — list columns and the day plan — and a
third, a timeline ("Gantt") for planning tasks by time, is wanted. Measured
against `main`:

| | lines |
|---|---|
| Card file | 14,949 → 16,583 (+1,634, 667 KB → 745 KB) |
| Day plan only, in the card class | 707 (30 methods), about 70 style rules |
| Day plan only, in the editor | 237 |
| Day plan texts (21 keys × 16 languages) | 336 |
| Changes to shared code | about 200, at 20 `_planMode` branches |

What the day plan uses of the list card (counted by method name, so rough):
the fields of an open task 2,836 lines, drag and drop 586, reading and
writing tasks 546, row pieces 350, dialogs and helpers 157 — about 4,500
lines, plus the translation table (about 5,000) and most of the styles.

Two cards with copied code would mean about 1,300 own lines and 10,000
copied ones per card. One card with a mode switch is what there is now; the
day plan reaches the list code by loading its lists as columns that are
never drawn, which works but produced review findings (leftover column
options, dragging across columns). A third view makes neither better.

## What Home Assistant allows — checked

On the test system (Home Assistant 2026.11.1), in the open page, nothing
saved:

- The card file is loaded as `<script type="module">`.
- A second element, `class … extends customElements.get("home-tasks-card")`,
  was defined, entered in `window.customCards`, and created through Home
  Assistant's own `loadCardHelpers().createCardElement()`. It came back as
  the real element, not an error card, and showed a plan with two days.

So one file can define several card types that share code. That is also how
the card picker is fed: one `window.customCards` entry per type, each with
its own `getConfigElement()` / `getStubConfig()`.

Not checked: that the new type shows in the picker dialog (the mechanism is
the documented one, the entry was in the array), and the companion apps.

## Target

```
src/
  core/      i18n, dom + dialogs, list data (WS, linked lists, stamps),
             task details, task row, drag, styles
  views/     list-card, day-plan-card, (timeline-card)
  editors/   shared parts, list-editor, plan-editor
  index.js   defines the elements, fills window.customCards
        │  build (esbuild)
        ▼
custom_components/home_tasks/home-tasks-card.js   ← still one file, same URL
```

- Card types: `custom:home-tasks-card` (lists, as today),
  `custom:home-tasks-day-plan-card`, later `custom:home-tasks-timeline-card`.
- One shipped file. Several files loaded one by one are not an option as
  things are: only the entry URL carries the `?v=<mtime>` that gets past the
  31-day cache; imports of sibling files would be served stale.
- The built file stays committed, as now. CI already fails when the embedded
  translations are not rebuilt (`validate.yaml`); the same check covers a
  bundle. HACS installs from the release zip and needs no change.

## Stages

Each stage ends with both test suites green and can ship on its own.

### 1 — The day plan as its own card type (small; before the day plan is released) — done

No restructuring inside. The point is the public shape: once `view: day_plan`
is released, changing it is a migration for users.

- `HomeTasksDayPlanCard extends HomeTasksCard`: always in plan mode, own
  `getStubConfig()` (the first plan, 3 days), own `getConfigElement()`.
- `home-tasks-day-plan-card-editor`: the plan editor alone. The "Card shows"
  dropdown goes from both editors.
- Second `window.customCards` entry, with its own name and description.
- `view: day_plan` on `home-tasks-card`: removed (unreleased); the list
  card refuses it and names the new type. The two cards on the test
  dashboard are changed by hand.
- The list card is "Home Tasks: List" in the picker; its type stays
  `home-tasks-card`, which every existing dashboard names.
- Goes away with it: reading and folding in a leftover first column
  (`leftover()` / `effective()` in the plan editor, the root-over-column
  rule in `_setPlanConfig`) — a plan card never had columns.
- Tests: `makeCard` / `makeEditor` in `tests-js/test_day_plan.mjs` use the new
  type; the tests about switching the view go.
- README, `DAY_PLAN_SPEC.md`.

### 2 — A build step, nothing moved in behaviour (medium) — done

- `esbuild` as a dev dependency; `npm run build` writes the card file and
  takes over what `build:i18n` does (the translations become an import).
- The file is cut along seams it already has: translations and helpers, card
  class, editor class, registration. Classes stay whole in this stage.
- Tests keep loading the built file through `tests-js/setup.mjs`, unchanged.
- `validate.yaml`: "run `npm run build` and commit the card".
- Before starting: every open pull request that touches the card file is
  merged or closed. A split makes each of them conflict. Checked when it
  was done: one open pull request (#90), which does not touch the card.

How it was checked: the old file and the bundle, both put through esbuild,
differ only in how top-level names are declared (`var` instead of `const`,
classes as expressions) and in where `_htText` stands; the translation
table is the same as data. The bundle builds the same twice, and every
module boundary is a comment like `// src/views/list-card.js` in it.
Comments of the sources do not go into the bundle.

### 3 — Take the core out for real (large; before the timeline card) — done, in part

What was built:

```
src/core/card-base.js      TasksCardBase extends HTMLElement     (~6,500 lines)
src/views/list-card.js     HomeTasksCard extends TasksCardBase   (~1,800)
src/views/day-plan-card.js HomeTasksDayPlanCard extends TasksCardBase (~900)
src/editors/editor-base.js EditorBase extends HTMLElement        (~500)
src/editors/list-editor.js HomeTasksCardEditor extends EditorBase (~1,450)
src/editors/plan-editor.js HomeTasksDayPlanCardEditor extends EditorBase (~200)
```

- The day plan card no longer extends the list card: both extend
  `TasksCardBase`, as both editors extend `EditorBase`. `_planMode` and
  `_isPlanEditor` are gone; the places that asked became hooks a card type
  fills in (`_buildCardContent`, `_watchHass`, `_loadOwnData`,
  `_bootIncomplete`, `_afterListsLoaded`, `_loadAllTasks`, `_sourceStamps`,
  `_dropDragged`, `_findTaskRow`, `_extraTaskActions` and a few that are
  empty by default; `_buildEditorBody` and `_afterListsLoaded` in the
  editors). Defaults sit at the end of each base class.
- The plan view no longer invents columns: shared code reaches a card's
  lists through `_sourceCols()` / `_sourceCol(i)` - the configured columns
  of a list card, the lists a plan draws from (`_planCols`) - and a plan
  card's `_config` holds its own options only.
- The plan's styles moved with the day plan card; "Plan for…" with the
  list card.
- How it was sorted: what the day plan card calls, and what those call, is
  the base; the rest of the old class is the list card. Methods moved
  verbatim. A check over the three classes finds no method called that the
  class or its base lacks.

Left as it was, for later:

- The list's data is not an object of its own yet: per list the card keeps
  one state object with its tasks and the list card's view state (filter,
  sort, the add-task row) together, and shared code still addresses a list
  by its index (`colIdx`, "the card's list number" now). Taking the data out
  is the next step towards the timeline card.
- The base holds some styles and helpers only the list card uses (tiles,
  sections); harmless, since the day plan card simply does not use them.

### 4 — The timeline card (its own plan)

Needs decisions this plan does not make: a task has a due time but no
duration; a plan item has neither a start time nor a length. Likely the
plan item gets both, with the WebSocket commands, services and assistant
tools to match, and the timeline is a second view of a plan next to the
days. Stage 3 is what makes this a view to add rather than a third mode.

## Open decisions

1. The name of the timeline card's type.
2. Pull request #90 (filters and "advance on completion" for native lists)
   conflicts with the day-plan branch in six backend files, not in the card.
