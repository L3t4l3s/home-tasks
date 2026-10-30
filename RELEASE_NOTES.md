## v2.5.0

Tasks can have several assignees, recurring tasks can reopen early and survive "clear completed", and the card gets a draft with all details, multi-column lists, foldable task details and one-tap due dates.

### New Features

- **Reopen early**: a recurring task can come back a set time before it is due, so it shows as an upcoming to-do. The lead can also be set for the whole list under *Defaults* (#74, thanks @RBrNx).
- **Draft with details**: `show_add_details` adds a ✎ button next to + that opens a new task with all its detail fields before it is created. The add field also gets a clear × (#85, thanks @jdiviney).
- **Multi-column list view**: `list_columns` lays a list out in up to 4 columns. `tile_size` sets the tile size: small, medium or large (#79, thanks @jdiviney).
- **updated services**: `add_task` and `update_task` set recurrence, section, picture and position.
- **New services**: `add_sub_task`, `update_sub_task` and `remove_sub_task` (#70).
- **Foldable task details**: tap a field's heading to fold it to a one-line summary. The card remembers this per list (#82, thanks @jdiviney).
- **New Option**: `detail_order` choose the order of the fields in the task details (#84, thanks @jdiviney).
- **Several assignees per task**: tap people on or off in the task details. A shared task shows under each person's filter, and `assigned_persons` is in the services and events (#80, thanks @jdiviney).
- **One-tap due dates**: Today, Tomorrow, In 1 week, In 1 month and In 3 months buttons in the task details (#81, thanks @jdiviney).
- **Selectable people (`hidden_persons`)**: choose which people a card offers for assignment (#83, thanks @jdiviney).
- **Section field in the task details** (#78, thanks @jdiviney).
- **Moving keeps the section**: a moved task goes into the target list's section of the same name; drag & drop puts it into the section it is dropped in, and `move_task` has a `section` field (#89).
- **Due dates by voice and text**: relative dates now understand months, years and spoken numbers up to 999 ("in sixty days") (#73).
- **Ordinals in the recurrence badge**: "1st", "22nd" in English, and the matching forms in Swedish and French (#86, thanks @jdiviney).
- **Brazilian Portuguese**: a new language. Calendar descriptions are now translated and show people by name (#71, #72, thanks @Willyanlz).

### Bug Fixes
- **Recurring tasks survive "clear completed"**: Home Assistant's *clear completed* no longer ends a recurring series. On linked lists, a recurring task deleted in another app is put back when it reopens, and ticking or unticking it in the provider's own app counts too (#88).
- **"End after N times" on linked lists** now counts down. Before, such a series never ended.
- **Undo a tick**: unticking a recurring task puts its due date back and returns an occurrence that "end after N times" had counted off (#87, thanks @RBrNx).

**Full Changelog**: https://github.com/L3t4l3s/home-tasks/compare/v2.4.0...v2.5.0
