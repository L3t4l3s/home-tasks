# Plan: several card types over one shared core

Status: stage 1 is built (2026-11-15); stages 2 to 4 are a proposal.

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

### 2 — A build step, nothing moved in behaviour (medium)

- `esbuild` as a dev dependency; `npm run build` writes the card file and
  takes over what `build:i18n` does (the translations become an import).
- The file is cut along seams it already has: translations and helpers, card
  class, editor class, registration. Classes stay whole in this stage.
- Tests keep loading the built file through `tests-js/setup.mjs`, unchanged.
- `validate.yaml`: "run `npm run build` and commit the card".
- Before starting: every open pull request that touches the card file is
  merged or closed. A split makes each of them conflict. (An older note
  lists seven stacked ones; not re-checked for this plan.)

### 3 — Take the core out for real (large; before the timeline card)

This is the actual decoupling. Today the shared code addresses everything by
column: `colIdx` appears 607 times, against `this._columns[colIdx]` and
`this._config.columns[colIdx]`.

- A list's data becomes an object of its own (tasks, sections, tag catalog,
  stamp, stale flag; load, update, reload of a linked list). Views hold such
  objects instead of column states; the plan view no longer invents columns.
- Task details, row pieces and drag take a list-data object and options
  instead of a column index. Done in steps: first an adapter so that both
  ways work, then one consumer after the other.
- The class `HomeTasksDayPlanCard` stops extending the list card and uses the
  core directly; the `_planMode` branches disappear from the list card.

### 4 — The timeline card (its own plan)

Needs decisions this plan does not make: a task has a due time but no
duration; a plan item has neither a start time nor a length. Likely the
plan item gets both, with the WebSocket commands, services and assistant
tools to match, and the timeline is a second view of a plan next to the
days. Stage 3 is what makes this a view to add rather than a third mode.

## Open decisions

1. When: stages 2 and 3 after the open pull requests, before the timeline.
2. The name of the timeline card's type.
