## v3.0.0

Day plans arrive: a plan across your lists for today and the days ahead, with its own dashboard card and services. AI assistants get tools for everything Home Tasks does, over your lists and your plans. Linked lists keep a task's data when the provider gives it a new ID, and the card editor's title fields are back on Home Assistant 2026.11.

### New Features

- **Day plans**: a new kind of entry ("Create a day plan") that sets out which tasks are meant for which day, and in what order, across native and linked lists. Tasks stay in their lists. A day shows what you planned and what is due on it. Settings cover the lists a plan uses, its workdays (any days from Monday to Sunday, for a part-time week too), and carrying over what was left open.
- **Day plan card** (`custom:home-tasks-day-plan-card`, "Home Tasks: Day plan"): today and the days after it side by side, each with a focus note, and today's progress. Tap a row's number to tick it off, drag rows to reorder or re-plan, plan tasks with a search across the plan's lists, and open the same task details as in the list.
- **Plan for…**: in the list card, a task of a list that a plan uses can be put on a day straight from its details.
- **Day plan services**: `get_day_plan`, `set_day_plan`, `plan_task` and `unplan_task`. `get_tasks` can now read several lists at once.
- **Tools for AI assistants**: conversation agents and Home Assistant's MCP Server can now do with your lists what you can in the cards: read, add, change, complete, move, duplicate, order and delete tasks and sub-tasks, keep sections and list defaults, and fill day plans. One set, **Home Tasks**, reaches everything; each day plan also has its own set that reaches only that plan's lists. Nothing is reachable until you hand a set to an assistant.
- **A sensor per plan** with the open items of the current day.
- **`task_reopened` events** now say whether the recurrence reopened the task (`reopened_by`).
- **Create a list or plan from the editor**: for administrators, the card editors link to the Home Tasks settings page.

### Bug Fixes

- **Card editor on Home Assistant 2026.11**: the card title and column title fields were missing; they are back.
- **Bring! renames**: renaming an item now keeps what Home Tasks stores for it: tags, reminders, recurrence and its place on a day plan.
- **Errors from linked lists**: the card shows the provider's own error message instead of "an internal error".
- **Todoist**: a linked list whose project can't be found now reads as empty and is retried every five minutes. Before, it showed the whole account and created new tasks in the Inbox.
- **Drag & drop in multi-column lists**: dragging takes the row from the column the drag started in.

### Documentation

- **README**: the two cards, day plans, plan services, a new section on AI assistants and a new screenshot.

**Full Changelog**: https://github.com/L3t4l3s/home-tasks/compare/v2.5.3...v3.0.0
