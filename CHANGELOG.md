# Changelog

All notable changes to Home Tasks are documented here.

---

## [1.2.0] — unreleased

### Added

- **Multi-column card** — display multiple lists side-by-side in a single card, with cross-list drag & drop reordering
- **Global card title** — optional title displayed above all columns in multi-column mode
- **Sort** — tasks can be sorted by due date, priority, title, or assigned person; sort button is shown in the card header and configurable per column
- **Default sort** — configurable per column; the card opens with the chosen sort order active
- **Column icon** — optional MDI icon shown next to the column title
- **YAML code editor** — the card editor now offers a `{}` toggle to edit column config as YAML directly, powered by HA's built-in `ha-yaml-editor` (syntax highlighting, undo/redo, fullscreen)

### Changed

- **Card editor overhauled** — all controls now match HA's native editor style:
  - Animated toggle switches (`ha-switch`) replace checkboxes
  - `ha-textfield` and `ha-icon-picker` for text and icon inputs
  - Tab bar with underline highlight for column navigation; `+` button right-aligned with circular hover
  - Icon buttons (arrows, duplicate, delete) use consistent circular hover style
  - Settings organized into collapsible sections (*Darstellung*, *Konfiguration*) with animated chevrons
- **Editor labels shortened** — toggle labels no longer repeat "anzeigen" / "show" (e.g. "Notizen anzeigen" → "Notizen")
- **Config format** — card config now uses a `columns` array; the previous flat format (`list_id` at root level) is automatically migrated on load

### Fixed

- Multi-column divider lines now extend the full height of the tallest column
- Stray `type` key no longer leaks into column config objects during normalization
- Same-list move guard prevents accidental no-op reorders; silent drag failures are handled gracefully
- Editor no longer re-renders the DOM during active input interactions (dropdown stays open, text fields keep focus)
- Card title and column title inputs keep focus while typing (re-render deferred until field blur)
- Sort button shows active state correctly and visibility respects the `show_sort` toggle
- `ha-select` replaced with native `<select>` to ensure reliable selection across all HA versions

### Internal

- `_callWs().then()` → `?.then()` on all call sites (null-safe on WS failure)
- Removed dead `_dragOverTaskId` field
- Duplicate `const col` declaration in `_buildTask` removed
- Sort-dropdown outside-click handler uses a named `_sortCloseHandler` (no listener stacking); cleaned up in `disconnectedCallback`
- `_render()` deferred during active drag; flushes via `_pendingRender` flag after `_finishDrag`
- `parseInt` fallback in `_finishDrag` fixed (explicit `undefined` check, radix 10)
- Style element cached in `_styleEl`; no longer re-parsed on every render
- `task.sub_items` null-guarded in `_buildTaskDetails`
- Double WS call on blur + Enter for task and sub-item title editing fixed
- `CSS.escape()` applied to all `querySelector` calls using task IDs
- Redundant `textarea.textContent` assignment removed
- `aria-label` added to `ha-switch` toggles in the editor
- Date+time sort comparison uses `"T"` separator for valid ISO format
- `_sectionOpen` state keyed by stable ID (not i18n key) — survives language changes
- Empty column title saved as `undefined` instead of `""`
- `makeToggle`'s unused `_id` parameter retained as `_id` (documents intended accessibility hook)
- Column removal in `setConfig` now cleans up stale `_editingTaskId` and `_expandedTasks` entries

---

## [1.1.0] — 2025-01-xx

### Added

- **Reminders** — up to 5 per task, fire as `home_tasks_task_reminder` HA events at a configurable offset before the due time
- **Due time** — tasks can have both a due date and a specific time
- **Priority** (Low / Medium / High) with colored badges and sort support
- **Recurring tasks** — fixed intervals (hours, days, weeks, months) or specific weekdays
- **Person assignment** using HA person entities
- **Tags** — per-task labels with clickable filter chips in the card header
- **Services**: `add_task`, `complete_task`, `reopen_task`, `assign_task`
- **Sensors**: open task count and overdue binary sensor per list
- **Events**: `task_created`, `task_completed`, `task_due`, `task_overdue`, `task_assigned`, `task_reopened`, `task_reminder`
- **Auto-delete** completed tasks (optional, per card)
- **Compact mode** for denser task rows
- **i18n**: English and German, follows HA language setting

### Fixed

- Completed tasks move to the bottom in *All* filter view
- Double-click title editing on desktop Firefox
- Various stability and UX fixes from internal code review

---

## [1.0.1] — 2024-xx-xx

### Fixed

- Priority button order (Low left, High right)
- Weekday recurrence and midnight-snap for daily/weekly/monthly tasks
- Three bugs found in internal code review

---

## [1.0.0] — 2024-xx-xx

Initial release.

- Task lists with drag & drop reordering (desktop and mobile)
- Sub-items with progress tracking
- Notes per task
- Due date with overdue highlighting
- Multiple lists via integration config entries
- HACS support
