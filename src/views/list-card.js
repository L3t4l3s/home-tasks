// The list card (custom:home-tasks-card): lists as columns, with filters,
// sorting, sections, an add-task row and tiles.

import { CURRENT_USER, UNASSIGNED, _assignees, _listColumns, _listMinWidth, _tileMinWidth, listSupportsDue } from "../core/helpers.js";
import { TasksCardBase } from "../core/card-base.js";
import { ConditionWatcher, evaluateLocally, normalizeVisibility, viewerPersonId, withEntity } from "../core/visibility.js";

// A column's visibility conditions as judged, per column object: the list a
// watcher compares stays the same object across hass updates.
const VISIBILITY_CACHE = new WeakMap();

export class HomeTasksCard extends TasksCardBase {
  setConfig(config) {
    // The days of a plan are a card of their own (HomeTasksDayPlanCard,
    // below). Said plainly, for a config written while they were a view of
    // this card.
    if (config.view === "day_plan") {
      throw new Error(
        "The day plan is a card of its own: use type custom:home-tasks-day-plan-card (and drop view)"
      );
    }
    // Normalize old single-list format to columns format
    // Keep HA card-level keys (type, etc.) at root, not inside column objects
    if (config.list_id && !config.columns) {
      const { type, columns: _c, ...colConfig } = config;
      config = { ...(type ? { type } : {}), columns: [colConfig] };
    }
    if (!config.columns || !Array.isArray(config.columns) || config.columns.length === 0) {
      config = { ...config, columns: [{}] };
    }
    // Strip any stray type keys from column objects (e.g. from previously broken saves)
    config = {
      ...config,
      columns: config.columns.map(({ type: _t, ...col }) => col),
    };

    const prevConfig = this._config || { columns: [] };
    this._config = config;

    // Sync _columns array length
    while (this._columns.length < config.columns.length) {
      this._columns.push(this._defaultColState());
    }
    this._columns.length = config.columns.length;
    // Clean up stale expanded/editing state when columns are removed
    if (this._editingTaskId) {
      const taskStillExists = this._columns.some(cs => cs.tasks?.some(t => t.id === this._editingTaskId));
      if (!taskStillExists) this._editingTaskId = null;
    }
    // Clean up expanded task IDs no longer in any column
    const allTaskIds = new Set(this._columns.flatMap(cs => (cs.tasks || []).map(t => t.id)));
    for (const id of this._expandedTasks) {
      if (!allTaskIds.has(id)) this._expandedTasks.delete(id);
    }

    // Reset per-column filter/sort when list or defaults change
    for (let i = 0; i < config.columns.length; i++) {
      const col = config.columns[i];
      const prevCol = prevConfig.columns?.[i];
      const colSourceChanged = col.list_id !== prevCol?.list_id || col.entity_id !== prevCol?.entity_id;
      // A search (and the draft title it mirrors) belongs to the list it was
      // typed against. Carrying it over to a different list would silently
      // filter the new list by text the user never typed for it.
      if (colSourceChanged) {
        this._columns[i].taskSearchQuery = "";
        this._columns[i].newTaskTitle = "";
      }
      if (colSourceChanged || col.default_filter !== prevCol?.default_filter) {
        this._columns[i].filter = col.default_filter || "all";
        if (this._columns[i].filter === "due_soon" && col.show_due_soon_filter !== true) {
          this._columns[i].filter = "all";
        }
        this._columns[i].tagFilters = new Set();
        this._columns[i].personFilters = new Set();
      }
      if (col.show_tags === false && prevCol?.show_tags !== false) {
        this._columns[i].tagFilters = new Set();
      }
      if (col.show_assigned_person === false && prevCol?.show_assigned_person !== false) {
        this._columns[i].personFilters = new Set();
      }
      if (colSourceChanged || col.default_sort !== prevCol?.default_sort) {
        this._columns[i].sortBy = col.default_sort || "manual";
      }
    }

    // Judged before the render below, which shows the visible columns.
    this._syncColumnVisibility(false);
    if (this._initialized) {
      this._loadAllTasks();
    } else {
      this._render();
    }
    this._syncImageGenerationConfig();
    // Config may arrive after we're already connected (editor preview);
    // connectedCallback covers the other order. No-op when not connected.
    this._ensureCardMod();
  }

  _text(str) {
    return document.createTextNode(str);
  }

  // Can tasks in this column carry a due date / a due time? Native lists
  // always; external lists per provider capability (see listSupportsDue /
  // listSupportsDueTime at module level).
  _colSupportsDue(colIdx) {
    if (!this._isExternalCol(colIdx)) return true;
    return listSupportsDue(this._getExternalListInfo(colIdx));
  }

  _colProviderType(colIdx) {
    return this._getExternalListInfo(colIdx)?.provider_type ?? (this._isExternalCol(colIdx) ? "generic" : "native");
  }

  // Enter inside the add-row date/time inputs: _render defers rebuilds while
  // a date/time input has focus (its segment state would be lost), which
  // would swallow the render that shows the new task. Hand focus to the
  // title input first (focus restore after the rebuild targets it anyway).
  _addTaskFromDueRow(colIdx) {
    const titleInput = this.shadowRoot.querySelector(`.add-input[data-focus-key="add_task_col_${colIdx}"]`);
    if (titleInput) {
      try { titleInput.focus(); } catch (_) { /* best-effort */ }
    } else {
      const active = this.shadowRoot.activeElement;
      if (active && active.blur) active.blur();
    }
    return this._addTask(colIdx);
  }

  _nudgeAddInput(colIdx) {
    const el = this.shadowRoot?.querySelector(
      `.add-input[data-focus-key="add_task_col_${colIdx}"]`
    );
    if (!el) return;
    try { el.focus(); } catch (_) { /* focus is a nicety, never a failure */ }
    el.classList.remove("nudge");
    void el.offsetWidth;  // restart the animation if it is already running
    el.classList.add("nudge");
    setTimeout(() => el.classList.remove("nudge"), 700);
  }

  // show_add_details: a new task is drafted under the add row with the same
  // detail fields as an existing one, and only created on Add.
  async _openDraft(colIdx) {
    const cs = this._columns[colIdx];
    // An empty field is fine: the title can follow in it (Add nudges if not).
    const title = (cs.newTaskTitle || "").trim();
    const isExt = this._isExternalCol(colIdx);
    // The list's defaults as they are now, so the draft shows what the task
    // will get (a linked list's cached ones may be stale, or not loaded).
    const r = await this._callWs("home_tasks/get_defaults",
      isExt ? { entity_id: this._colEntityId(colIdx) } : { list_id: this._colListId(colIdx) });
    const defaults = (r && r.defaults) || {};
    if (isExt && r) this._sourceDefaults[this._colEntityId(colIdx)] = r.defaults || null;
    const person = this._autoAssignPerson(colIdx);
    // Left empty where the column keeps new tasks unassigned: Add then clears
    // what the list would fill in (see _saveDraft).
    const people = person ? [person]
      : this._keepsNewTasksUnassigned(colIdx) ? []
      : this._defaultAssignees(defaults);
    const { addDue, addDueTime } = this._addRowDue(colIdx);
    cs.draft = {
      id: `__draft__${colIdx}`, _draft: true, title, completed: false, notes: "", sub_items: [],
      due_date: addDue, due_time: addDueTime, priority: defaults.priority ?? null,
      tags: [...(defaults.tags || [])], reminders: [...(defaults.reminders || [])],
      section_id: defaults.section_id || null, assigned_person: people[0] || null,
      assigned_persons: people,
      recurrence_enabled: false, recurrence_value: 1, recurrence_unit: null, recurrence_type: "interval",
      recurrence_weekdays: [],
      // What the list fills in by itself: a field the draft empties is
      // cleared again once the task exists (see _saveDraft).
      _defaults: defaults,
    };
    cs.newTaskTitle = "";
    cs.newTaskDue = "";
    cs.newTaskDueTime = "";
    cs.taskSearchQuery = "";
    this._render();
    // The field is now the draft's title: ready for typing it. A frame later,
    // as the browser ignores focus() on the freshly rebuilt card.
    requestAnimationFrame(() => {
      const input = this.shadowRoot?.querySelector(`.add-input[data-focus-key="add_task_col_${colIdx}"]`);
      try { input?.focus(); } catch (_) { /* focus is a nicety, never a failure */ }
    });
  }

  // Closes the draft. With giveBack, its title and due date stay in the add
  // row (Cancel, Escape, or the pencil again); without, the draft is dropped
  // (the add row's clear).
  _closeDraft(colIdx, giveBack) {
    const cs = this._columns[colIdx];
    const draft = cs.draft;
    if (!draft) return;
    if (giveBack) {
      cs.newTaskTitle = draft.title || "";
      // Text in the field searches, as typed or dictated text does.
      if (this._config.columns[colIdx].show_task_search !== false) cs.taskSearchQuery = cs.newTaskTitle.trim();
      if (this._config.columns[colIdx].show_add_due === true) {
        cs.newTaskDue = draft.due_date || "";
        cs.newTaskDueTime = draft.due_time || "";
      }
    }
    cs.draft = null;
    this._render();
  }

  // The draft's title is the add row's field (see _buildColumnAddTask); the
  // panel holds its detail fields.
  _buildDraftPanel(cs, colIdx) {
    const draft = cs.draft;
    const addBtn = this._el("button", { className: "add-btn", textContent: this._t("dialog_add") });
    addBtn.addEventListener("click", () => this._saveDraft(colIdx));
    const cancelBtn = this._el("button", { className: "draft-cancel-btn", textContent: this._t("dialog_cancel") });
    cancelBtn.addEventListener("click", () => this._closeDraft(colIdx, true));
    return this._el("div", { className: "task-draft" }, [
      this._buildTaskDetails(draft, colIdx, { draft: true }),
      this._el("div", { className: "draft-actions" }, [cancelBtn, addBtn]),
    ]);
  }

  async _saveDraft(colIdx) {
    const cs = this._columns[colIdx];
    const draft = cs.draft;
    if (!draft || draft._saving) return;
    const title = (draft.title || "").trim();
    if (!title) { this._nudgeAddInput(colIdx); return; }
    const base = {};
    for (const k of ["due_date", "due_time", "notes", "priority", "tags", "reminders", "assigned_persons"]) {
      const v = draft[k];
      if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) base[k] = v;
    }
    if (!base.due_date) delete base.due_time;
    // After creating: what the list would fill in by itself but the draft
    // left empty is cleared again, and recurrence is set - one routed update,
    // which takes every recurrence field on both kinds of list (creating an
    // external task does not).
    const d = draft._defaults || {};
    const after = {};
    if (draft.priority == null && d.priority) after.priority = null;
    if (!draft.tags?.length && d.tags?.length) after.tags = [];
    if (!draft.reminders?.length && d.reminders?.length) after.reminders = [];
    if (!draft.assigned_persons?.length && (d.assignees?.length || d.assignee)) {
      after.assigned_person = null;
      after.assigned_persons = [];
    }
    if (!draft.section_id && d.section_id && !this._isExternalCol(colIdx)) after.section_id = null;
    if (draft.recurrence_enabled) {
      for (const [k, v] of Object.entries(draft)) if (k.startsWith("recurrence_")) after[k] = v;
    }
    const isExt = this._isExternalCol(colIdx);
    draft._saving = true;
    let newId;
    try {
      if (isExt) {
        const res = await this._callWs("home_tasks/create_external_task",
          { entity_id: this._colEntityId(colIdx), title, ...base }, { rethrow: true });
        newId = res?.uid;
      } else {
        const payload = { list_id: this._colListId(colIdx), title, ...base };
        if (draft.section_id) payload.section_id = draft.section_id;
        const res = await this._callWs("home_tasks/add_task", payload, { rethrow: true });
        newId = res?.id;
      }
    } catch (err) {
      // Nothing was created: the draft stays for another try.
      draft._saving = false;
      this._showError(this._t("add_failed"));
      return;
    }
    // The task exists from here on, so the draft closes even if what follows
    // fails - Add again would create it twice. A failure is reported instead.
    try {
      if (newId && isExt && (draft.section_id || d.section_id)) {
        // Sections of an external list live in the overlay only.
        await this._callWs("home_tasks/update_external_overlay",
          { entity_id: this._colEntityId(colIdx), task_uid: newId, section_id: draft.section_id || null },
          { rethrow: true });
      }
      if (newId && Object.keys(after).length) await this._updateTaskRouted(colIdx, newId, after, { rethrow: true });
    } catch (err) {
      this._showError(this._t("draft_details_failed"));
    }
    // Only this draft: one opened while it was saving stays.
    if (cs.draft === draft) cs.draft = null;
    if (this._isExternalCol(colIdx)) this._reloadExternal(colIdx);
    else await this._loadAllTasks();
    this._render();
  }

  // Auto-assign: the one person active in the person filter, or else the
  // column's one preset assignee unless this card doesn't offer them
  // (hidden_persons). null when neither applies - also for a column that
  // only shows unassigned tasks, whose new tasks stay unassigned, and for
  // "current user": a filter says what shows, not who gets new tasks (the
  // list's default assignees take current_user for that).
  _autoAssignPerson(colIdx) {
    const cs = this._columns[colIdx];
    const col = this._config.columns[colIdx];
    if (cs.personFilters.size === 1) return [...cs.personFilters][0];
    const preset = col.filters?.assignees || [];
    if (cs.personFilters.size === 0 && preset.length === 1
        && preset[0] !== UNASSIGNED && preset[0] !== CURRENT_USER
        && !(col.hidden_persons || []).includes(preset[0])) {
      return preset[0];
    }
    return null;
  }

  // A list's default assignees as a task created here gets them: current_user
  // is the viewer's person, or left out (as the backend does on creation).
  _defaultAssignees(defaults) {
    const people = defaults?.assignees || (defaults?.assignee ? [defaults.assignee] : []);
    if (!people.includes(CURRENT_USER)) return [...people];
    const me = viewerPersonId(this._hass);
    return [...new Set(people.flatMap((p) => (p === CURRENT_USER ? (me ? [me] : []) : [p])))];
  }

  // A column that shows unassigned tasks (issue #93) and has no one to give a
  // new task to keeps it unassigned: the list's default assignees would take
  // it straight out of the column it was added in.
  // A preset of people that resolves to no one: only "current user", for a
  // user who has no person. A task added there could never show.
  _presetShowsNobody(col) {
    return (col.filters?.assignees || []).length > 0 && this._presetAssignees(col).length === 0;
  }

  _keepsNewTasksUnassigned(colIdx) {
    const preset = this._config.columns[colIdx].filters?.assignees || [];
    return preset.includes(UNASSIGNED) && !this._autoAssignPerson(colIdx);
  }

  // Due date chosen in the add row (issue #38) — only when the option is
  // on and the column supports due dates; a time without a date is ignored.
  _addRowDue(colIdx) {
    const cs = this._columns[colIdx];
    const col = this._config.columns[colIdx];
    const addDue = (col.show_add_due === true && this._colSupportsDue(colIdx) && cs.newTaskDue) ? cs.newTaskDue : null;
    const addDueTime = (addDue && cs.newTaskDueTime && this._colSupportsDueTime(colIdx)) ? cs.newTaskDueTime : null;
    return { addDue, addDueTime };
  }

  async _addTask(colIdx) {
    const cs = this._columns[colIdx];
    const title = cs.newTaskTitle.trim();
    if (!title) {
      // Pressing + with an empty field used to do nothing at all, which
      // reads as a dead button (issue #59). Put the cursor where the text
      // belongs and nudge the field so the eye follows it.
      this._nudgeAddInput(colIdx);
      return;
    }
    // Adding a task clears any active search.
    cs.taskSearchQuery = "";
    if (!this._colListId(colIdx) && !this._colEntityId(colIdx)) return;

    // Capture add-input position for the entry animation
    const addInput = this.shadowRoot.querySelector(`.add-input[data-focus-key="add_task_col_${colIdx}"]`);
    const addInputRect = addInput ? addInput.getBoundingClientRect() : null;

    // Snapshot existing task positions (they may shift when new task is inserted)
    const before = this._captureListFlip(colIdx);

    const col = this._config.columns[colIdx];
    const autoAssignPerson = this._autoAssignPerson(colIdx);
    const keepUnassigned = this._keepsNewTasksUnassigned(colIdx);
    // Creating fills in the list's default assignees whatever is sent, so
    // such a task is cleared again right after.
    const unassign = (taskId) => this._updateTaskRouted(colIdx, taskId,
      { assigned_person: null, assigned_persons: [] }, { rethrow: true })
      .catch(() => this._showError(this._t("draft_details_failed")));
    const { addDue, addDueTime } = this._addRowDue(colIdx);
    const resetAddDue = () => { cs.newTaskDue = ""; cs.newTaskDueTime = ""; };

    let result;
    if (this._isExternalCol(colIdx)) {
      // Optimistic: insert a placeholder task immediately so the user
      // sees it appear without waiting for the API round-trip.
      const tempId = "_pending_" + Date.now();
      // The list's own defaults, so the row that appears is the row that will
      // be there after the reload rather than a barer version of it.
      const listDefaults = this._sourceDefaults[this._colEntityId(colIdx)] || {};
      cs.tasks.push({
        id: tempId, title, completed: false, notes: "", due_date: addDue,
        due_time: addDueTime, sort_order: cs.tasks.length, sub_items: [],
        priority: listDefaults.priority ?? null,
        tags: [...(listDefaults.tags || [])],
        reminders: [...(listDefaults.reminders || [])],
        section_id: listDefaults.section_id || null,
        assigned_person: autoAssignPerson || (keepUnassigned ? null : this._defaultAssignees(listDefaults)[0]) || null,
        assigned_persons: autoAssignPerson ? [autoAssignPerson]
          : keepUnassigned ? [] : this._defaultAssignees(listDefaults),
        recurrence_enabled: false, _external: true,
      });
      const typed = { title, due: cs.newTaskDue, dueTime: cs.newTaskDueTime };
      cs.newTaskTitle = "";
      resetAddDue();
      this._justAddedTaskId = tempId;
      this._addInputRect = addInputRect;
      this._render();
      this._justAddedTaskId = null;
      this._addInputRect = null;
      this._applyFlip(before, colIdx, 0.25);

      // Send to API in background, then reload to get the real ID
      let addError = null;
      try {
        const payload = { entity_id: this._colEntityId(colIdx), title };
        if (autoAssignPerson) payload.assigned_person = autoAssignPerson;
        if (addDue) { payload.due_date = addDue; if (addDueTime) payload.due_time = addDueTime; }
        result = await this._callWs("home_tasks/create_external_task", payload, { rethrow: true });
      } catch (err) {
        addError = err;
      }
      // Cached defaults not known yet (undefined/null): clear to be safe.
      const cached = this._sourceDefaults[this._colEntityId(colIdx)];
      if (result?.uid && keepUnassigned && (!cached || cached.assignees?.length || cached.assignee)) {
        await unassign(String(result.uid));
      }
      // Refused: say so, take the placeholder row back off and hand the
      // typed text back, so the next attempt is one keypress and not a
      // retype (issue #59). A timeout is not a refusal - the provider may
      // have created the task, and the reload below will show it.
      if (!result && !this._isWsTimeout(addError)) {
        cs.tasks = cs.tasks.filter((t) => t.id !== tempId);
        cs.newTaskTitle = typed.title;
        cs.newTaskDue = typed.due;
        cs.newTaskDueTime = typed.dueTime;
        this._showError(this._t("add_failed"));
        this._render();
      }
      this._reloadExternal(colIdx);
      // C12 for external lists: the provider assigns the uid, and the card
      // only sees the real task after the reload above — the row on screen is
      // still the placeholder with a temporary id. Hand the generation the
      // uid and let it wait for the task to arrive.
      if (result?.uid && col.auto_generate_image && col.show_images === true
          && this._config.image_generation?.entity_id) {
        this._autoGenerateExternalImage(colIdx, String(result.uid));
      }
    } else {
      const payload = { list_id: this._colListId(colIdx), title };
      if (autoAssignPerson) payload.assigned_person = autoAssignPerson;
      if (addDue) { payload.due_date = addDue; if (addDueTime) payload.due_time = addDueTime; }
      let addError = null;
      try {
        result = await this._callWs("home_tasks/add_task", payload, { rethrow: true });
      } catch (err) {
        addError = err;
      }
      if (result) {
        if (keepUnassigned && _assignees(result).length) await unassign(result.id);
        cs.newTaskTitle = "";
        resetAddDue();
        this._justAddedTaskId = result.id ? String(result.id) : null;
        this._addInputRect = addInputRect;
        await this._loadAllTasks();
        this._justAddedTaskId = null;
        this._addInputRect = null;
        this._applyFlip(before, colIdx, 0.25);
        // C12: optionally auto-generate an AI image for the new task.
        if (result && col.auto_generate_image && col.show_images === true
            && this._config.image_generation?.entity_id) {
          this._generateTaskImage(result, colIdx);
        }
      } else if (this._isWsTimeout(addError)) {
        // We stopped waiting, the store may still have it: show what is
        // there rather than claiming a failure. The typed title stays.
        await this._loadAllTasks();
      } else {
        this._showError(this._t("add_failed"));
      }
    }
  }

  // --- Helpers ---

  _getCompletedCount(colIdx) {
    return this._columns[colIdx].tasks.filter((t) => t.completed).length;
  }

  // Per-column max_height (issues #33 / #34): cap only the task body and let
  // it scroll internally. Header, add-task row, filters and chips are
  // siblings above it and therefore stay put. 0 / unset = unlimited.
  // Every path that builds a column body must go through this — a targeted
  // refresh (see _refreshTaskListDOM) replaces that node, and without the cap
  // the list grows out of the card, which clips it in an overflow-hidden or
  // fixed-row layout.
  _applyColumnMaxHeight(body, col) {
    const maxH = this._columnMaxHeight(col);
    if (maxH) {
      body.classList.add("scrollable");
      body.style.maxHeight = `${maxH}px`;
    }
  }

  // Column max_height in px, or 0 when unset/invalid/non-positive.
  _columnMaxHeight(col) {
    const n = Number(col && col.max_height);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }

  _getListName(colIdx) {
    const col = this._config.columns[colIdx];
    if (col.title) return col.title;
    if (col.entity_id) {
      const ext = (this._externalLists || []).find(l => l.entity_id === col.entity_id);
      return ext ? ext.name : col.entity_id;
    }
    const list = this._lists.find((l) => l.id === col.list_id);
    return list ? list.name : this._t("my_tasks");
  }

  _buildCardContent() {
    const cols = this._config.columns;
    // While the dashboard is edited every column shows, the hidden ones
    // dimmed - as Home Assistant shows a hidden card there.
    const preview = this.preview;
    const shown = cols.map((_, i) => i).filter((i) => preview || this._columnVisible(i));
    this._shownVisibilityKey = this._visibilityKey();
    this._setHostHidden(shown.length === 0);
    const build = (i) => {
      const el = this._buildColumn(i);
      if (preview && !this._columnVisible(i)) el.classList.add("visibility-hidden");
      return el;
    };
    if (cols.length === 1) {
      return shown.length ? build(0) : document.createElement("div");
    }
    // One column left for this viewer: drawn as a card of one column, not as
    // one column of several (no column min-width, no row of columns) - a
    // card of a column per person looks to each like a card of their own.
    // A card title stays, above it as with several.
    if (shown.length === 1 && !this._config.title) return build(shown[0]);
    const children = [];
    if (this._config.title) {
      const titleEl = document.createElement("h1");
      titleEl.className = "card-global-title";
      titleEl.textContent = this._config.title;
      children.push(titleEl);
    }
    children.push(this._el("div", { className: "multi-columns" }, shown.map(build)));
    return this._el("div", {}, children);
  }

  // -- Column visibility ------------------------------------------------------
  //
  // A column's `visibility` takes the conditions of a card's own Visibility
  // tab and is judged as Home Assistant judges them (core/visibility.js).
  // A hidden column is not drawn; its tasks still load, so it shows at once
  // when its conditions hold again. With no column left the card hides, and
  // stays connected while hidden (connectedWhileHidden) to notice that.

  // Set by Home Assistant while the dashboard or this card is edited.
  set preview(value) {
    const on = value === true;
    if (on === (this._preview === true)) return;
    this._preview = on;
    if (this._shownVisibilityKey !== undefined) this._render();
  }

  get preview() {
    return this._preview === true;
  }

  // Asks hui-card to keep the card in the page while it is hidden - only
  // when a column has conditions that could show it again. Hidden by its
  // own card conditions alone, it leaves the page and stops loading.
  get connectedWhileHidden() {
    return (this._config?.columns || []).some((col) => col?.visibility != null);
  }

  _colConditions(colIdx) {
    const col = this._config.columns[colIdx];
    if (!col || col.visibility == null) return undefined;
    // A state condition naming no entity reads the column's linked list -
    // filled in here, so the browser and core judge the same entity, and a
    // new list gives new conditions (and a new subscription).
    let entry = VISIBILITY_CACHE.get(col);
    if (!entry || entry.source !== col.visibility || entry.entityId !== col.entity_id) {
      entry = {
        source: col.visibility,
        entityId: col.entity_id,
        list: withEntity(normalizeVisibility(col.visibility), col.entity_id),
      };
      VISIBILITY_CACHE.set(col, entry);
    }
    return entry.list;
  }

  // `view_columns` reads the columns of the sections view the card is in.
  _colConditionContext() {
    return this._maxColumns ? { max_columns: this._maxColumns } : {};
  }

  // The column count of the sections view around the card, which Home
  // Assistant hands its own cards as a Lit context ("lovelace-max-columns").
  // Asked through the context protocol a custom card can speak without Lit;
  // no view answers outside a sections view, and view_columns then holds,
  // as in Home Assistant.
  _requestMaxColumns() {
    if (this._maxColumnsUnsub) return;
    const ev = new Event("context-request", { bubbles: true, composed: true });
    Object.assign(ev, {
      context: "lovelace-max-columns",
      contextTarget: this,
      subscribe: true,
      callback: (value, unsubscribe) => {
        if (typeof unsubscribe === "function") {
          if (this._maxColumnsUnsub && this._maxColumnsUnsub !== unsubscribe) this._maxColumnsUnsub();
          this._maxColumnsUnsub = unsubscribe;
        }
        const n = typeof value === "number" && value > 0 ? value : undefined;
        if (n === this._maxColumns) return;
        this._maxColumns = n;
        if (this.isConnected) this._syncColumnVisibility();
      },
    });
    this.dispatchEvent(ev);
  }

  _columnVisible(colIdx) {
    const conditions = this._colConditions(colIdx);
    if (!conditions) return true;
    const watcher = this._colWatchers?.[colIdx];
    if (watcher) return watcher.visible;
    if (!this._hass) return true;
    return evaluateLocally(conditions, this._hass, this._colConditionContext(colIdx)) === true;
  }

  _visibilityKey() {
    return this._config.columns.map((_, i) => (this._columnVisible(i) ? "1" : "0")).join("")
      + (this.preview ? "p" : "");
  }

  // Watches each column's conditions while the card is in the page (core
  // subscriptions, media queries, time); redraws when what shows changed.
  _syncColumnVisibility(redraw = true) {
    const cols = (this._config && this._config.columns) || [];
    const watchers = this._colWatchers || (this._colWatchers = []);
    for (let i = cols.length; i < watchers.length; i++) watchers[i]?.stop();
    watchers.length = Math.min(watchers.length, cols.length);
    for (let i = 0; i < cols.length; i++) {
      const conditions = this._colConditions(i);
      if (!conditions || !this.isConnected || !this._hass) {
        if (watchers[i]) { watchers[i].stop(); watchers[i] = null; }
        continue;
      }
      if (!watchers[i]) watchers[i] = new ConditionWatcher(() => this._columnVisibilityChanged());
      watchers[i].observe(conditions, this._hass, this._colConditionContext(i));
    }
    if (redraw) this._columnVisibilityChanged();
  }

  _columnVisibilityChanged() {
    if (this._shownVisibilityKey === undefined) return;  // not drawn yet
    if (this._visibilityKey() !== this._shownVisibilityKey) this._render();
  }

  _setHostHidden(hidden) {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.dispatchEvent(new CustomEvent("card-visibility-changed", {
      bubbles: true, composed: true, detail: { value: !hidden },
    }));
  }

  _hassChanged() {
    this._syncColumnVisibility();
  }

  connectedCallback() {
    super.connectedCallback();
    this._requestMaxColumns();
    this._syncColumnVisibility();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const watcher of this._colWatchers || []) watcher?.stop();
    this._colWatchers = [];
    if (this._maxColumnsUnsub) {
      try { this._maxColumnsUnsub(); } catch (_) { /* provider gone */ }
      this._maxColumnsUnsub = null;
    }
    this._maxColumns = undefined;  // asked again where the card is put next
  }

  _buildColumn(colIdx) {
    const col = this._config.columns[colIdx];
    const cs = this._columns[colIdx];
    const filteredTasks = this._filteredTasks(colIdx);
    const completedCount = this._getCompletedCount(colIdx);
    const totalCount = cs.tasks.length;
    // auto_delete_completed makes the All/Open/Done set redundant, but the
    // Due-Soon filter is still meaningful (it filters open tasks by upcoming
    // due date). When both are on, keep a slimmed-down row with just All +
    // Due Soon so the user can still toggle between "everything" and
    // "due soon only".
    const hideFilters = (col.auto_delete_completed === true && col.show_due_soon_filter !== true) || col.show_filters === false;

    const header = this._buildColumnHeader(col, colIdx, completedCount, totalCount);
    const addTask = this._buildColumnAddTask(cs, colIdx);
    const sortBtnWrapper = (col.show_sort !== false) ? this._buildColumnSortControl(col, cs, colIdx) : null;
    const tagChips = col.show_tag_chips === false ? null : this._buildColumnTagChips(col, cs, colIdx);
    const personChips = this._personMode(colIdx, "filter") === "off"
      ? null : this._buildColumnPersonChips(col, cs, colIdx);

    // Sort button placement: move into first available chips row when filters are hidden
    const sortInTagRow = hideFilters && tagChips !== null && sortBtnWrapper !== null;
    const sortInPersonRow = hideFilters && tagChips === null && personChips !== null && sortBtnWrapper !== null;

    const filters = this._buildColumnFilterRow(hideFilters, sortBtnWrapper, sortInTagRow, sortInPersonRow, colIdx);
    const tagChipsEl = (tagChips && sortInTagRow)
      ? this._el("div", { className: "tag-chips-row" }, [tagChips, sortBtnWrapper])
      : tagChips;
    const personChipsEl = (personChips && sortInPersonRow)
      ? this._el("div", { className: "person-chips-row" }, [personChips, sortBtnWrapper])
      : personChips;

    const isTiles = col.view_mode === "tiles";
    const taskList = this._buildColumnBody(filteredTasks, colIdx);
    this._applyColumnMaxHeight(taskList, col);

    const children = [];
    if (header) children.push(header);
    // No add row where no task could show: "current user" for a user
    // without a person, and nothing else in the preset.
    if (col.show_add_task !== false && !this._presetShowsNobody(col)) children.push(addTask);
    if (cs.draft) children.push(this._buildDraftPanel(cs, colIdx));
    if (filters) children.push(filters);
    if (tagChipsEl) children.push(tagChipsEl);
    if (personChipsEl) children.push(personChipsEl);
    children.push(taskList);

    const listCols = _listColumns(col);
    const className = "card-column" + (col.compact === true ? " compact" : "") + (isTiles ? " tiles-mode" : "")
      + (listCols > 1 ? " list-cols" : "");
    const columnEl = this._el("div", { className }, children);
    if (listCols > 1) {
      columnEl.style.setProperty("--ht-list-cols", String(listCols));
      const minW = _listMinWidth(col);
      if (minW) columnEl.style.setProperty("--ht-list-min-width", `${minW}px`);
    }
    const tileMin = _tileMinWidth(col);
    if (tileMin) columnEl.style.setProperty("--ht-tile-min", `${tileMin}px`);
    return columnEl;
  }

  _buildColumnHeader(col, colIdx, completedCount, totalCount) {
    const showTitle = col.show_title !== false;
    const showProgress = col.show_progress !== false;
    const headerChildren = [];
    if (showTitle) {
      const titleEl = document.createElement("h1");
      titleEl.className = "title";
      if (col.icon) {
        const iconEl = document.createElement("ha-icon");
        iconEl.setAttribute("icon", col.icon);
        iconEl.style.cssText = "--mdc-icon-size:1em;width:1em;height:1em;flex-shrink:0;";
        titleEl.appendChild(iconEl);
      }
      titleEl.appendChild(document.createTextNode(this._getListName(colIdx)));
      headerChildren.push(titleEl);
    }
    if (showProgress) {
      headerChildren.push(this._el("span", {
        className: "progress",
        textContent: this._t("progress", completedCount, totalCount),
      }));
    }
    return headerChildren.length > 0
      ? this._el("div", { className: "header" }, headerChildren)
      : null;
  }

  // Start voice input. colIdx identifies the column; inputEl is the <input>
  // element to fill (list-row input or tile-dialog input). If omitted the
  // column's newTaskTitle state is updated instead (legacy path).
  // Voice capture needs a secure context: browser mic (getUserMedia) or the
  // Web Speech API. Neither exists in e.g. the Home Assistant iOS app's webview
  // or plain-HTTP contexts — hide the mic button there instead of showing a
  // button that can only fail.
  _voiceSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ||
           !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  _startVoiceInput(colIdx, inputEl = null) {
    // Toggle off if already recording
    if (this._voiceActive.has(colIdx)) {
      this._voiceActive.get(colIdx)(); // call cleanup
      return;
    }

    // Helper: update the visible input + column state
    const setTranscript = (text) => {
      const cs = this._columns[colIdx];
      // While a task is drafted the add field is its title, without search.
      const draft = !inputEl && cs?.draft;
      if (draft) draft.title = text;
      else if (cs) cs.newTaskTitle = text;
      if (inputEl) {
        inputEl.value = text;
      } else {
        const inp = this.shadowRoot.querySelector(`.add-input[data-focus-key="add_task_col_${colIdx}"]`);
        if (inp) inp.value = text;
      }
      // Dictating a title searches exactly like typing it does — otherwise
      // the same text in the same field would behave differently.
      if (cs && !draft && this._config.columns[colIdx]?.show_task_search !== false) {
        cs.taskSearchQuery = text.trim();
        this._refreshTaskListDOM(colIdx);
      }
    };

    const stopRecording = () => {
      const cleanup = this._voiceActive.get(colIdx);
      if (cleanup) cleanup();
    };

    // Try HA assist_pipeline first, then fall back to Web Speech API
    this._startHAStt(colIdx, inputEl, setTranscript, stopRecording)
      .catch((err) => {
        console.warn("Home Tasks voice: HA Assist STT failed.", err);
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
          this._startWebSpeech(colIdx, inputEl, setTranscript);
        } else {
          const reason = err && err.message ? ": " + err.message : "";
          this._showError(this._t("voice_failed") + reason);
        }
      });
  }

  // Primary: HA assist_pipeline/run STT (streams raw PCM to HA's STT backend)
  async _startHAStt(colIdx, inputEl, setTranscript) {
    if (!this._hass || !this._hass.connection) throw new Error("no hass");

    // Request microphone access early so we can fail fast if denied
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error("mic denied: " + err.message);
    }

    // Mutable refs inside the shared cleanup closure
    let audioRefs = null; // { audioCtx, processor }
    let sttHandlerId = null; // HA binary handler id for routing audio frames
    let unsub = null;
    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (audioRefs) {
        try { audioRefs.processor.disconnect(); } catch (_) {}
        try { audioRefs.audioCtx.close(); } catch (_) {}
        // Signal end-of-audio to HA: a lone handler-id byte (empty payload).
        try {
          if (sttHandlerId != null) {
            this._hass.connection.socket.send(new Uint8Array([sttHandlerId]).buffer);
          }
        } catch (_) {}
        audioRefs = null;
      }
      if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
      if (unsub) { try { unsub(); } catch (_) {} unsub = null; }
      this._voiceActive.delete(colIdx);
      this._updateMicBtn(colIdx, inputEl, false);
    };

    this._voiceActive.set(colIdx, cleanup);
    this._updateMicBtn(colIdx, inputEl, true);

    // Subscribe to pipeline events
    try {
      unsub = await this._hass.connection.subscribeMessage(
        (event) => {
          if (!event || !event.type) return;
          if (event.type === "run-start") {
            // Capture the binary handler id needed to route audio frames.
            sttHandlerId = event.data?.runner_data?.stt_binary_handler_id ?? null;
          } else if (event.type === "stt-start") {
            if (sttHandlerId == null) {
              console.warn("HA STT: missing stt_binary_handler_id, falling back to Web Speech");
              cleanup();
              this._startWebSpeech(colIdx, inputEl, setTranscript);
              return;
            }
            // HA is ready – stream audio, each frame prefixed with the handler id
            audioRefs = this._streamPcmAudio(stream, cleanup, sttHandlerId);
          } else if (event.type === "stt-end") {
            const text = event.data?.stt_output?.text || "";
            if (text) setTranscript(text);
            cleanup();
          } else if (event.type === "error") {
            console.warn("HA STT error:", event.data);
            cleanup();
            // Fall back to Web Speech
            this._startWebSpeech(colIdx, inputEl, setTranscript);
          } else if (event.type === "run-end") {
            cleanup();
          }
        },
        {
          type: "assist_pipeline/run",
          start_stage: "stt",
          end_stage: "stt",
          input: { sample_rate: 16000 },
        }
      );
    } catch (err) {
      cleanup();
      throw err; // triggers fallback in _startVoiceInput
    }
  }

  // Stream PCM audio from the MediaStream to HA via binary WebSocket frames.
  // Returns { audioCtx, processor } for the caller to store and disconnect later.
  _streamPcmAudio(stream, onError, handlerId) {
    const SAMPLE_RATE = 16000;
    const BUFFER_SIZE = 4096;
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32767));
        }
        // HA routes binary audio by a 1-byte handler-id prefix on every frame.
        const frame = new Uint8Array(1 + pcm16.byteLength);
        frame[0] = handlerId;
        frame.set(new Uint8Array(pcm16.buffer), 1);
        try {
          this._hass.connection.socket.send(frame.buffer);
        } catch (err) {
          if (onError) onError(err);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      return { audioCtx, processor };
    } catch (err) {
      console.warn("PCM stream setup failed:", err);
      if (onError) onError(err);
      return null;
    }
  }

  // Fallback: Web Speech API (browser-native, less accurate)
  _startWebSpeech(colIdx, inputEl, setTranscript) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._updateMicBtn(colIdx, inputEl, false);
      console.warn("Home Tasks voice: no browser speech recognition available.");
      this._showError(this._t("voice_failed"));
      return;
    }
    // Don't start if already cancelled (user toggled off)
    if (!this._voiceActive.has(colIdx)) {
      // Was already cleaned up; mark as active again for Web Speech
    }
    const recognition = new SR();
    recognition.lang = this._config.voice_lang || "de-DE";
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.continuous = false;

    const cleanup = () => {
      try { recognition.abort(); } catch (_) {}
      this._voiceActive.delete(colIdx);
      this._updateMicBtn(colIdx, inputEl, false);
    };
    this._voiceActive.set(colIdx, cleanup);
    this._updateMicBtn(colIdx, inputEl, true);

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = result[0].transcript;
      setTranscript(transcript);
      if (result.isFinal) {
        this._voiceActive.delete(colIdx);
        this._updateMicBtn(colIdx, inputEl, false);
      }
    };
    recognition.onerror = (e) => {
      console.warn("Web Speech error:", e.error);
      cleanup();
    };
    recognition.onend = () => {
      if (this._voiceActive.has(colIdx)) cleanup();
    };
    try {
      recognition.start();
    } catch (err) {
      cleanup();
    }
  }

  // Update the mic button state without a full re-render.
  // inputEl: if set, update a mic-btn inside the tile dialog; else find
  // the column-level mic-btn via data attribute.
  _updateMicBtn(colIdx, inputEl, recording) {
    const MIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`;
    const STOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

    let btn;
    if (inputEl) {
      // Tile dialog mic button is a sibling of the input inside the dialog
      btn = inputEl.closest(".tile-dialog")?.querySelector(".mic-btn");
    } else {
      btn = this.shadowRoot.querySelector(`.mic-btn[data-col-idx="${colIdx}"]`);
    }
    if (!btn) {
      // Fall back to full re-render if button not found
      this._render();
      return;
    }
    btn.innerHTML = recording ? STOP_SVG : MIC_SVG;
    btn.title = recording ? this._t("voice_stop") : this._t("voice_input");
    if (recording) {
      btn.classList.add("recording");
    } else {
      btn.classList.remove("recording");
    }
  }

  // The scrollable body of a column: task list or tile grid. Both the full
  // render and the targeted refresh below go through here, so a refresh
  // produces exactly what a re-render would.
  _buildColumnBody(filteredTasks, colIdx) {
    const col = this._config.columns[colIdx];
    if (col.view_mode === "tiles") {
      const query = this._activeSearchQuery(colIdx);
      return this._buildColumnTileGrid(
        query ? this._searchMatches(query, colIdx) : filteredTasks,
        colIdx,
      );
    }
    return this._buildColumnTaskList(filteredTasks, colIdx);
  }

  // Updates only the column body, leaving the add-task <input> untouched.
  //
  // A full this._render() rebuilds the whole card, and even though focus
  // and caret position are restored afterwards via data-focus-key, the
  // <input> DOM node is technically removed and recreated in the process.
  // On mobile this makes the on-screen keyboard flicker closed and open
  // again on every keystroke. Replacing only the body container avoids
  // that, since the <input> is never touched.
  _refreshTaskListDOM(colIdx) {
    const col = this._config.columns[colIdx];
    const selector = col.view_mode === "tiles"
      ? `.tile-grid-wrap[data-col-idx="${colIdx}"]`
      : `.task-list[data-col-idx="${colIdx}"]`;
    const oldBody = this.shadowRoot.querySelector(selector);
    if (!oldBody || !oldBody.parentNode) {
      this._render();
      return;
    }
    // Same FLIP as sorting and filtering: every task that survives the new
    // query slides from where it was to where it now is, instead of the whole
    // body jumping. Tiles reflow in two dimensions, which is where a hard cut
    // is most jarring. Shorter than the sort animation (0.3s) because this
    // runs on every keystroke and must keep up with typing.
    const before = this._captureListFlip(colIdx);
    const newBody = this._buildColumnBody(this._filteredTasks(colIdx), colIdx);
    this._applyColumnMaxHeight(newBody, col);
    oldBody.replaceWith(newBody);
    this._applyFlip(before, colIdx, 0.2);
  }

  _buildColumnAddTask(cs, colIdx) {
    const col = this._config.columns[colIdx];
    // Per-column opt-out via show_task_search (default on); editor switch
    // lives in HomeTasksCardEditor further below.
    const searchEnabled = col.show_task_search !== false;
    // While a task is drafted (show_add_details), the field is its title:
    // no search, Enter or + creates it, Escape closes the draft.
    const draft = cs.draft;

    const addInput = this._el("input", {
      type: "text",
      className: "add-input",
      placeholder: this._t("add_placeholder"),
      value: draft ? draft.title : cs.newTaskTitle,
      "data-focus-key": `add_task_col_${colIdx}`,
      autocomplete: "off",
    });
    addInput.addEventListener("input", (e) => {
      if (draft) { draft.title = e.target.value; return; }
      cs.newTaskTitle = e.target.value;
      if (searchEnabled) {
        // Mirror the search text and refresh only the list (see
        // _refreshTaskListDOM above — no this._render() here, to avoid
        // the mobile keyboard flicker on every keystroke).
        cs.taskSearchQuery = e.target.value.trim();
        this._refreshTaskListDOM(colIdx);
      }
    });
    addInput.addEventListener("keydown", (e) => {
      if (draft) {
        if (e.key === "Enter") this._saveDraft(colIdx);
        else if (e.key === "Escape") { e.preventDefault(); this._closeDraft(colIdx, true); }
        return;
      }
      if (e.key === "Enter") {
        this._addTask(colIdx);
      } else if (searchEnabled && e.key === "Escape" && cs.taskSearchQuery) {
        // Escape cancels the search and restores the section view.
        // Same targeted update as above, for the same reason.
        e.preventDefault();
        addInput.value = "";
        cs.newTaskTitle = "";
        cs.taskSearchQuery = "";
        this._refreshTaskListDOM(colIdx);
      }
    });
    const addBtn = this._el("button", { className: "add-btn", textContent: "+" });
    addBtn.addEventListener("click", () => (draft ? this._saveDraft(colIdx) : this._addTask(colIdx)));

    // Clear (x) inside the field, shown while there is text or a draft:
    // empties the title and any search it was driving, drops the draft, and
    // keeps the cursor there.
    const clearBtn = this._el("button", {
      className: "add-clear-btn", textContent: "\u00D7", title: this._t("add_clear"),
    });
    clearBtn.type = "button";
    clearBtn.setAttribute("aria-label", this._t("add_clear"));
    if (!cs.newTaskTitle && !draft) clearBtn.style.display = "none";
    addInput.addEventListener("input", () => { clearBtn.style.display = (addInput.value || draft) ? "" : "none"; });
    clearBtn.addEventListener("click", () => {
      addInput.value = "";
      cs.newTaskTitle = "";
      clearBtn.style.display = "none";
      if (draft) {
        try { addInput.focus(); } catch (_) { /* best-effort */ }
        this._closeDraft(colIdx, false);
        return;
      }
      if (cs.taskSearchQuery) {
        cs.taskSearchQuery = "";
        this._refreshTaskListDOM(colIdx);
      }
      try { addInput.focus(); } catch (_) { /* best-effort */ }
    });
    const inputWrap = this._el("div", { className: "add-input-wrap" }, [addInput, clearBtn]);

    const children = [inputWrap];
    if (col.show_voice !== false && this._voiceSupported()) {
      const isRecording = this._voiceActive.has(colIdx);
      const micBtn = this._el("button", {
        className: "mic-btn" + (isRecording ? " recording" : ""),
        title: isRecording ? this._t("voice_stop") : this._t("voice_input"),
        "data-col-idx": String(colIdx),
        innerHTML: isRecording
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="15" height="15"><path d="M12 15c1.66 0 3-1.34 3-3V6c0-1.66-1.34-3-3-3S9 4.34 9 6v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V6zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-2.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>`,
      });
      micBtn.addEventListener("click", () => this._startVoiceInput(colIdx));
      children.push(micBtn);
    }
    // Due date at creation (issue #38): opt-in per column. When enabled, a
    // second row with date (+ time) inputs sits under the add-task input;
    // leaving it empty simply creates the task without a due date.
    // A draft has its own due date field among the details.
    const showAddDue = col.show_add_due === true && this._colSupportsDue(colIdx) && !draft;
    let dueRow = null;
    if (showAddDue) {
      const dateInput = this._el("input", {
        type: "date", className: "add-due-date", value: cs.newTaskDue || "",
        "data-focus-key": `add_due_col_${colIdx}`,
        "aria-label": this._t("due_date_lbl"),
      });
      dateInput.addEventListener("change", () => { cs.newTaskDue = dateInput.value || ""; });
      dateInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        cs.newTaskDue = dateInput.value || "";
        this._addTaskFromDueRow(colIdx);
      });
      const rowChildren = [dateInput];
      if (this._colSupportsDueTime(colIdx)) {
        const timeInput = this._el("input", {
          type: "time", className: "add-due-time", value: cs.newTaskDueTime || "",
          "data-focus-key": `add_due_time_col_${colIdx}`,
          "aria-label": this._t("due_time_lbl"),
        });
        timeInput.addEventListener("change", () => { cs.newTaskDueTime = timeInput.value || ""; });
        timeInput.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          cs.newTaskDueTime = timeInput.value || "";
          this._addTaskFromDueRow(colIdx);
        });
        rowChildren.push(timeInput);
      }
      dueRow = this._el("div", { className: "add-due-row" }, rowChildren);
    }
    // show_add_details: a second button that drafts the task with its
    // details under the add row; pressed again, it closes the draft.
    if (col.show_add_details === true) {
      // Pressed, it says what it then does: close the draft, like Cancel.
      const detailsLabel = this._t(draft ? "dialog_cancel" : "add_with_details");
      const detailsBtn = this._el("button", {
        className: "add-btn add-details-btn" + (draft ? " active" : ""),
        textContent: "\u270E", title: detailsLabel,
      });
      detailsBtn.setAttribute("aria-label", detailsLabel);
      detailsBtn.setAttribute("aria-pressed", draft ? "true" : "false");
      detailsBtn.addEventListener("click", () => {
        if (draft) this._closeDraft(colIdx, true);
        else this._openDraft(colIdx);
      });
      children.push(detailsBtn);
    }
    children.push(addBtn);
    const row = this._el("div", { className: "add-task" }, children);
    // Without the option the DOM is exactly as before (single .add-task row).
    if (!dueRow) return row;
    return this._el("div", { className: "add-task-group" }, [row, dueRow]);
  }

  _buildColumnSortControl(col, cs, colIdx) {
    const sortLabels = {
      manual: this._t("sort_manual"), due: this._t("sort_due"),
      priority: this._t("sort_priority"), title: this._t("sort_title"),
      person: this._t("sort_person"),
    };
    const sortKeys = ["manual"];
    if (col.show_due_date !== false) sortKeys.push("due");
    if (col.show_priority !== false) sortKeys.push("priority");
    sortKeys.push("title");
    if (col.show_assigned_person !== false) sortKeys.push("person");
    const effectiveSortBy = sortKeys.includes(cs.sortBy) ? cs.sortBy : "manual";

    const sortDropdown = this._el("div", { className: "sort-dropdown" + (cs.sortOpen ? "" : " hidden") });
    for (const key of sortKeys) {
      const opt = this._el("div", {
        className: "sort-option" + (effectiveSortBy === key ? " active" : ""),
        textContent: sortLabels[key],
      });
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        const before = this._captureListFlip(colIdx);
        cs.sortBy = key;
        cs.sortOpen = false;
        this._render();
        this._applyFlip(before, colIdx, 0.3);
      });
      sortDropdown.appendChild(opt);
    }
    const sortBtnWrapper = this._el("div", { className: "sort-btn-wrapper" });
    const sortBtn = this._el("button", {
      className: "sort-btn" + (effectiveSortBy !== "manual" ? " active" : ""),
      textContent: "\u2191 \u2193",
      title: sortLabels[effectiveSortBy],
    });
    sortBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = cs.sortOpen;
      this._columns.forEach(c => { c.sortOpen = false; });
      cs.sortOpen = !wasOpen;
      this._render();
    });
    sortBtnWrapper.appendChild(sortBtn);
    sortBtnWrapper.appendChild(sortDropdown);
    return sortBtnWrapper;
  }

  _buildColumnTagChips(col, cs, colIdx) {
    if (col.show_tags === false) return null;
    const allTags = new Set();
    const baseTasks = this._preFilteredTasks(colIdx);
    for (const t of baseTasks) {
      for (const tag of (t.tags || [])) allTags.add(tag);
    }
    // Remove preset labels — they are always applied and cannot be toggled by the user
    for (const label of (col.filters?.labels || [])) allTags.delete(label);
    if (allTags.size === 0) return null;
    const chipChildren = [];
    for (const tag of [...allTags].sort()) {
      chipChildren.push(this._buildColumnTagChip(tag, cs, colIdx));
    }
    return this._el("div", { className: "tag-chips" }, chipChildren);
  }

  _buildColumnTagChip(tag, cs, colIdx) {
    const isActive = cs.tagFilters.has(tag);
    const chip = this._el("button", {
      className: "tag-chip" + (isActive ? " active" : ""),
      textContent: "#" + tag,
      "data-tag": tag,
    });
    chip.addEventListener("click", () => {
      this._animateFilterChange(colIdx, () => {
        if (cs.tagFilters.has(tag)) cs.tagFilters.delete(tag);
        else cs.tagFilters.add(tag);
      });
      // chip-pop: delay so render has completed before querying new chips
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.shadowRoot.querySelectorAll(`.tag-chip[data-tag="${CSS.escape(tag)}"]`)
              .forEach(c => {
                c.classList.add("chip-anim");
                c.addEventListener("animationend", () => c.classList.remove("chip-anim"), { once: true });
              });
          });
        });
      }, 0);
    });
    return chip;
  }

  _buildColumnPersonChips(col, cs, colIdx) {
    if (col.show_assigned_person === false) return null;
    const assignedPersons = new Set();
    const baseTasks = this._preFilteredTasks(colIdx);
    for (const t of baseTasks) {
      for (const p of _assignees(t)) assignedPersons.add(p);
    }
    // Remove preset assignees — they are always applied and cannot be toggled by the user
    for (const eid of this._presetAssignees(col)) assignedPersons.delete(eid);
    if (assignedPersons.size === 0) return null;
    const chipChildren = [];
    for (const eid of [...assignedPersons].sort()) {
      chipChildren.push(this._buildColumnPersonChip(eid, cs, colIdx));
    }
    return this._el("div", { className: "person-chips" }, chipChildren);
  }

  _buildColumnPersonChip(eid, cs, colIdx) {
    const isActive = cs.personFilters.has(eid);
    let name = eid;
    if (this._hass && this._hass.states && this._hass.states[eid]) {
      name = this._hass.states[eid].attributes?.friendly_name || eid;
    }
    const mode = this._personMode(colIdx, "filter");
    const withAvatar = mode === "picture" || mode === "both";
    // Picture alone: no pill, at the size the pill was tall.
    const avatarOnly = mode === "picture";
    const chip = this._el("button", {
      className: "person-chip" + (isActive ? " active" : "") + (withAvatar ? " with-avatar" : "")
        + (avatarOnly ? " avatar-only" : ""),
      "data-eid": eid,
      title: name,
    });
    if (avatarOnly) {
      chip.appendChild(this._buildPersonAvatar(eid, name));
    } else if (withAvatar) {
      chip.append(this._buildPersonAvatar(eid, name), this._el("span", { textContent: name }));
    } else {
      chip.textContent = "\uD83D\uDC64 " + name;
    }
    chip.addEventListener("click", () => {
      this._animateFilterChange(colIdx, () => {
        if (cs.personFilters.has(eid)) cs.personFilters.delete(eid);
        else cs.personFilters.add(eid);
      });
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.shadowRoot.querySelectorAll(`.person-chip[data-eid="${CSS.escape(eid)}"]`)
              .forEach(c => {
                c.classList.add("chip-anim");
                c.addEventListener("animationend", () => c.classList.remove("chip-anim"), { once: true });
              });
          });
        });
      }, 0);
    });
    return chip;
  }

  _buildColumnFilterRow(hideFilters, sortBtnWrapper, sortInTagRow, sortInPersonRow, colIdx) {
    const col = this._config.columns[colIdx];
    const autoDelete = col.auto_delete_completed === true;
    const dueSoonEnabled = col.show_due_soon_filter === true;
    const children = [];

    if (hideFilters) {
      // Fully suppressed (auto-delete on AND no due-soon): only the sort
      // button may end up here, when it can't be tucked into the tag/person
      // chip rows.
      if (sortBtnWrapper && !sortInTagRow && !sortInPersonRow) {
        children.push(this._el("div", { className: "filter-spacer" }));
        children.push(sortBtnWrapper);
      }
    } else {
      if (autoDelete) {
        // Auto-delete suppresses Open/Done (Done is always empty, Open ≡ All).
        // Keep All so the user can return after picking Due Soon.
        children.push(this._buildFilterBtn(this._t("filter_all"), "all", colIdx));
      } else {
        children.push(
          this._buildFilterBtn(this._t("filter_all"), "all", colIdx),
          this._buildFilterBtn(this._t("filter_open"), "open", colIdx),
          this._buildFilterBtn(this._t("filter_done"), "done", colIdx),
        );
      }
      if (dueSoonEnabled) {
        children.push(this._buildFilterBtn(this._t("filter_due_soon"), "due_soon", colIdx));
      }
      children.push(this._el("div", { className: "filter-spacer" }));
      if (sortBtnWrapper) children.push(sortBtnWrapper);
    }

    return children.length > 0
      ? this._el("div", { className: "filters" }, children)
      : null;
  }

  // Tasks whose title contains the query, prefix matches first. Deliberately
  // ignores the All/Open/Done filter and the tag/person chips: the point of
  // the search is to find a task you already have, wherever it sits.
  _searchMatches(query, colIdx) {
    const cs = this._columns[colIdx];
    const q = query.toLowerCase();
    return (cs.tasks || [])
      .filter((t) => t.title && t.title.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.title.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.title.toLowerCase().startsWith(q) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.title.localeCompare(b.title);
      });
  }

  // While searching, replaces the normal section-grouped view with a flat
  // list of matches (open + completed, across all sections) so section
  // headers don't eat the whole screen on mobile.
  _buildTaskSearchResults(query, colIdx) {
    const matches = this._searchMatches(query, colIdx);

    const children = matches.length === 0
      ? [this._el("div", { className: "empty-state", textContent: this._t("empty") })]
      : matches.map((task) => this._buildTask(task, colIdx));
    return this._el("div", { className: "task-list", "data-col-idx": String(colIdx) }, children);
  }

  _buildColumnTaskList(filteredTasks, colIdx) {
    const cs = this._columns[colIdx];
    const col = this._config.columns[colIdx];

    // Branch off into the search results view when a search is active
    // (and not disabled via the editor toggle).
    const activeQuery = this._activeSearchQuery(colIdx);
    if (activeQuery) {
      return this._buildTaskSearchResults(activeQuery, colIdx);
    }

    const sections = (cs.sections || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    const taskListChildren = [];
    if (filteredTasks.length === 0) {
      taskListChildren.push(
        this._el("div", { className: "empty-state", textContent: this._t("empty") })
      );
    } else if (sections.length === 0) {
      // Flat rendering — original behavior, plus optional Done header at the
      // bottom for visual consistency when both open and completed are visible.
      const openTasks = filteredTasks.filter((t) => !t.completed);
      const doneTasks = filteredTasks.filter((t) => t.completed);
      for (const task of openTasks) taskListChildren.push(this._buildTask(task, colIdx));
      if (doneTasks.length > 0 && openTasks.length > 0) {
        taskListChildren.push(this._buildDoneHeader(colIdx));
        for (const task of doneTasks) {
          if (!this._isSectionCollapsed(colIdx, "__done__")) {
            taskListChildren.push(this._buildTask(task, colIdx));
          }
        }
      } else {
        for (const task of doneTasks) taskListChildren.push(this._buildTask(task, colIdx));
      }
    } else {
      const knownIds = new Set(sections.map((s) => s.id));
      const openTasks = filteredTasks.filter((t) => !t.completed);
      const doneTasks = filteredTasks.filter((t) => t.completed);
      const unsorted = openTasks.filter((t) => !t.section_id || !knownIds.has(t.section_id));
      const bySection = new Map(sections.map((s) => [s.id, []]));
      for (const t of openTasks) {
        if (t.section_id && knownIds.has(t.section_id)) bySection.get(t.section_id).push(t);
      }

      // Top: unsorted, no header (flat)
      for (const t of unsorted) taskListChildren.push(this._buildTask(t, colIdx));

      // Each section in sort order — header + body wrapper (so the entire
      // body collapses/expands as a single animated unit, including its
      // internal flex gaps).
      for (const section of sections) {
        const tasksIn = bySection.get(section.id) || [];
        const collapsed = this._isSectionCollapsed(colIdx, section.id);
        taskListChildren.push(this._buildSectionHeader(section, colIdx, { collapsed, count: tasksIn.length }));
        taskListChildren.push(this._buildSectionBody(section.id, tasksIn, colIdx, collapsed));
      }

      // Done at end (only if there are completed tasks)
      if (doneTasks.length > 0) {
        const collapsed = this._isSectionCollapsed(colIdx, "__done__");
        taskListChildren.push(this._buildDoneHeader(colIdx, { collapsed, count: doneTasks.length }));
        taskListChildren.push(this._buildSectionBody("__done__", doneTasks, colIdx, collapsed));
      }
    }

    const taskList = this._el("div", {
      className: "task-list",
      "data-col-idx": String(colIdx),
    }, taskListChildren);

    // Allow dropping on empty column
    taskList.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!this._draggedTaskId) return;
      const tgtColIdx = parseInt(taskList.dataset.colIdx);
      if (tgtColIdx !== this._draggedColIdx) {
        const draggedEl = this._taskDragElement();
        if (draggedEl && draggedEl.parentNode !== taskList) {
          if (draggedEl.parentElement) draggedEl.parentElement.removeChild(draggedEl);
          taskList.appendChild(draggedEl);
        }
        taskList.closest(".card-column")?.classList.add("drag-target");
      }
    });
    taskList.addEventListener("drop", (e) => {
      e.preventDefault();
      this._finishDrag();
    });
    return taskList;
  }

  // ── Tile / Kachel view ─────────────────────────────────────────────────────

  _buildColumnTileGrid(filteredTasks, colIdx) {
    // Open tasks first, completed after
    const openTasks = filteredTasks.filter(t => !t.completed);
    const doneTasks = filteredTasks.filter(t => t.completed);
    const ordered = [...openTasks, ...doneTasks];

    const tileEls = ordered.map(task => this._buildTaskTile(task, colIdx));

    if (tileEls.length === 0) {
      const empty = this._el("div", { className: "empty-state", textContent: this._t("empty") });
      return this._el("div", { className: "tile-grid-wrap", "data-col-idx": String(colIdx) }, [empty]);
    }

    const grid = this._el("div", { className: "tile-grid-inner" }, tileEls);
    return this._el("div", { className: "tile-grid-wrap", "data-col-idx": String(colIdx) }, [grid]);
  }

  _buildFilterBtn(label, value, colIdx) {
    const cs = this._columns[colIdx];
    const btn = this._el("button", {
      className: `filter-btn${cs.filter === value ? " active" : ""}`,
      textContent: label,
    });
    btn.addEventListener("click", () => {
      this._animateFilterChange(colIdx, () => { cs.filter = value; });
    });
    return btn;
  }

  _isSectionCollapsed(colIdx, sectionId) {
    try {
      const key = `home_tasks_card:section_collapse:${this._columnStorageKey(colIdx)}:${sectionId}`;
      return window.localStorage.getItem(key) === "1";
    } catch (e) {
      return false;
    }
  }

  _setSectionCollapsed(colIdx, sectionId, collapsed) {
    try {
      const key = `home_tasks_card:section_collapse:${this._columnStorageKey(colIdx)}:${sectionId}`;
      if (collapsed) window.localStorage.setItem(key, "1");
      else window.localStorage.removeItem(key);
    } catch (e) {
      /* localStorage unavailable — collapse state is session-only */
    }
  }

  _toggleSectionCollapsed(colIdx, sectionId) {
    const currentlyCollapsed = this._isSectionCollapsed(colIdx, sectionId);
    if (currentlyCollapsed) {
      // Expanding: render with .expanding class baseline (max-height: 0) so
      // the body never flashes at full height, then animate it to its
      // natural height.
      this._setSectionCollapsed(colIdx, sectionId, false);
      this._expandingSection = sectionId;
      this._render();
      this._expandingSection = null;
      this._animateSectionExpand(colIdx, sectionId);
    } else {
      // Collapsing: animate body's max-height from current to 0, then render
      // to drop the body's collapsed class baseline.
      // Caret rotation: toggle header class immediately for instant feedback.
      const header = this._findSectionHeader(colIdx, sectionId);
      if (header) header.classList.add("collapsed");
      this._animateSectionCollapse(colIdx, sectionId, () => {
        this._setSectionCollapsed(colIdx, sectionId, true);
        this._render();
      });
    }
  }

  _buildSectionBody(sectionId, tasks, colIdx, collapsed) {
    let cls = "section-body";
    if (collapsed) cls += " collapsed";
    if (!collapsed && this._expandingSection === sectionId) cls += " expanding";
    const body = this._el("div", { className: cls });
    body.dataset.sectionId = sectionId;
    for (const t of tasks) body.appendChild(this._buildTask(t, colIdx));
    return body;
  }

  _findSectionHeader(colIdx, sectionId) {
    return this.shadowRoot.querySelector(
      `.task-list[data-col-idx="${CSS.escape(String(colIdx))}"] .section-header[data-section-id="${CSS.escape(String(sectionId))}"]`
    );
  }

  _findSectionBody(colIdx, sectionId) {
    return this.shadowRoot.querySelector(
      `.task-list[data-col-idx="${CSS.escape(String(colIdx))}"] .section-body[data-section-id="${CSS.escape(String(sectionId))}"]`
    );
  }

  _animateSectionCollapse(colIdx, sectionId, done) {
    const body = this._findSectionBody(colIdx, sectionId);
    if (!body) { done(); return; }
    // No animation when the document isn't visible: requestAnimationFrame
    // doesn't fire in hidden tabs / backgrounded apps, and the transition
    // would never run. Commit the end state directly.
    if (document.hidden) { done(); return; }
    // Freeze current height as px so we can transition from a concrete value
    const h = body.scrollHeight;
    body.style.maxHeight = h + "px";
    body.style.opacity = "1";
    body.style.overflow = "hidden";
    // Force layout flush before applying the transition target
    void body.offsetHeight;
    let finished = false;
    const finish = (e) => {
      if (e && e.propertyName !== "max-height") return;
      if (finished) return;
      finished = true;
      body.removeEventListener("transitionend", finish);
      body.style.transition = "";
      body.style.maxHeight = "";
      body.style.opacity = "";
      body.style.overflow = "";
      done();
    };
    body.addEventListener("transitionend", finish);
    // Safety net registered *outside* the rAF: if the frame callback never
    // runs (tab hidden mid-click, throttled WebView), the body must not
    // stay frozen at a fixed max-height with overflow hidden — later content
    // growth would be clipped and the next section headers would visually
    // overlap it.
    setTimeout(() => finish(), 320);
    requestAnimationFrame(() => {
      if (finished) return;
      body.style.transition = "max-height 0.22s ease, opacity 0.18s ease";
      body.style.maxHeight = "0";
      body.style.opacity = "0";
    });
  }

  _animateSectionExpand(colIdx, sectionId) {
    // The body was rendered with .expanding (max-height:0) so there's no
    // flash; whatever happens below, it must end up fully visible. The
    // safety net lives outside the rAF chain for the same reason as in
    // _animateSectionCollapse (hidden tabs never run frame callbacks).
    let cleared = false;
    const clear = (e) => {
      if (e && e.propertyName !== "max-height") return;
      if (cleared) return;
      cleared = true;
      const body = this._findSectionBody(colIdx, sectionId);
      if (!body) return;
      body.removeEventListener("transitionend", clear);
      body.classList.remove("expanding");
      body.style.transition = "";
      body.style.maxHeight = "";
      body.style.opacity = "";
      body.style.overflow = "";
    };
    setTimeout(() => clear(), 360);
    if (document.hidden) { clear(); return; }
    // ha-card commits its layout asynchronously after _render(); waiting one
    // rAF lets scrollHeight return the body's true natural height.
    requestAnimationFrame(() => {
      if (cleared) return;
      const body = this._findSectionBody(colIdx, sectionId);
      if (!body) return;
      // scrollHeight ignores max-height and overflow:hidden — it returns
      // the body's content height even while .expanding is still applied.
      const targetH = body.scrollHeight;
      // Swap the class baseline for inline styles, then transition.
      body.classList.remove("expanding");
      body.style.maxHeight = "0";
      body.style.opacity = "0";
      body.style.overflow = "hidden";
      void body.offsetHeight; // commit baseline before transition
      body.addEventListener("transitionend", clear);
      requestAnimationFrame(() => {
        if (cleared) return;
        body.style.transition = "max-height 0.22s ease, opacity 0.22s ease";
        body.style.maxHeight = targetH + "px";
        body.style.opacity = "1";
      });
    });
  }

  _buildSectionHeader(section, colIdx, opts = {}) {
    const { collapsed = false, count = 0, isDone = false } = opts;
    let className = "section-header";
    if (collapsed) className += " collapsed";
    if (isDone) className += " done-header";
    const header = this._el("div", { className });
    header.dataset.sectionId = section.id;
    if (section.icon) {
      const icon = document.createElement("ha-icon");
      icon.setAttribute("icon", section.icon);
      header.appendChild(icon);
    }
    const name = this._el("span", { className: "section-name", textContent: section.name });
    header.appendChild(name);
    if (count > 0) {
      header.appendChild(this._el("span", { className: "sub-badge", textContent: String(count) }));
    }
    const caret = document.createElement("ha-icon");
    caret.setAttribute("icon", "mdi:chevron-down");
    caret.className = "section-caret";
    header.appendChild(caret);
    header.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggleSectionCollapsed(colIdx, section.id);
    });
    this._attachDragToSectionHeader(header, section.id, colIdx, opts.isDone === true);
    return header;
  }

  _attachDragToSectionHeader(headerEl, sectionId, colIdx, isDoneHeader) {
    const onEnter = () => {
      if (!this._draggedTaskId) return;
      headerEl.classList.add("drop-target");
      // Spring-loaded: open a collapsed section after a short hover so
      // the user can drop into it. Skip for the Done header.
      if (!isDoneHeader && this._isSectionCollapsed(colIdx, sectionId)) {
        if (this._springLoadTimer) clearTimeout(this._springLoadTimer);
        this._springLoadOriginallyCollapsed = sectionId;
        this._springLoadTimer = setTimeout(() => {
          this._setSectionCollapsed(colIdx, sectionId, false);
          this._render();
        }, 600);
      }
    };
    const onLeave = () => {
      headerEl.classList.remove("drop-target");
      if (this._springLoadTimer) {
        clearTimeout(this._springLoadTimer);
        this._springLoadTimer = null;
      }
    };
    const onOver = (e) => {
      if (!this._draggedTaskId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isDoneHeader ? "none" : "move";
      headerEl.classList.add("drop-target");
      if (isDoneHeader) return; // never reposition into Done bucket via drag
      const draggedEl = this.shadowRoot.querySelector(`.task[data-task-id="${CSS.escape(String(this._draggedTaskId))}"]`);
      if (!draggedEl) return;
      // The body wrapper of this section is headerEl's next sibling. Insert
      // the dragged element as the first child of that wrapper so it lands
      // as the first task of the section.
      const body = headerEl.nextElementSibling;
      const target = body && body.classList.contains("section-body") ? body : null;
      if (target && draggedEl.parentNode === target && draggedEl === target.firstChild) return;
      if (target) {
        const list = headerEl.closest(".task-list");
        const siblings = [...list.querySelectorAll(".task:not(.dragging), .section-header, .section-body")];
        const before = new Map(siblings.map((el) => [el, el.getBoundingClientRect().top]));
        target.insertBefore(draggedEl, target.firstChild);
        siblings.forEach((el) => {
          const dy = (before.get(el) ?? el.getBoundingClientRect().top) - el.getBoundingClientRect().top;
          if (Math.abs(dy) < 1) return;
          el.style.transition = "none";
          el.style.transform = `translateY(${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = "transform 0.18s ease";
            el.style.transform = "";
            el.addEventListener("transitionend", () => {
              el.style.transition = "";
              el.style.transform = "";
            }, { once: true });
          });
        });
      }
    };
    headerEl.addEventListener("dragenter", onEnter);
    headerEl.addEventListener("dragleave", onLeave);
    headerEl.addEventListener("dragover", onOver);
    headerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      headerEl.classList.remove("drop-target");
      this._finishDrag();
    });
  }

  _buildDoneHeader(colIdx, opts = {}) {
    return this._buildSectionHeader(
      { id: "__done__", name: this._t("done_section_header"), icon: "mdi:check-circle-outline" },
      colIdx,
      { ...opts, isDone: true }
    );
  }

  _buildTask(task, colIdx) {
    const cs = this._columns[colIdx];
    const col = this._config.columns[colIdx];
    const isExpanded = this._expandedTasks.has(task.id);
    const isEditing = this._editingTaskId === task.id;

    let className = "task";
    if (task.completed) className += " completed";
    if (isExpanded) className += " is-expanded";

    // draggable=false while editing OR while expanded:
    //   - editing: the title input must accept text selection
    //   - expanded: the details container has notes/tag/date inputs that
    //     must accept text selection. The browser blocks ALL cursor and
    //     text-selection inside any draggable=true ancestor, regardless
    //     of dragstart.preventDefault() or mousedown.stopPropagation().
    //     Users can drag a task only when it's collapsed — matching the
    //     UX of Trello, Jira and other card-based interfaces.
    const taskEl = this._el("div", { className, draggable: !isEditing && !isExpanded });
    taskEl.dataset.taskId = task.id;

    // --- main row: checkbox + content + [thumb] + expand button ---
    const checkboxEl = this._buildTaskCheckbox(task, colIdx);
    const contentChildren = this._buildTaskContentChildren(task, colIdx, isEditing);
    const metaBadges = this._buildTaskMetaBadges(task, col, cs, colIdx);
    if (metaBadges.length > 0) {
      contentChildren.push(this._el("div", { className: "task-meta" }, metaBadges));
    }
    const contentEl = this._el("div", { className: "task-content" }, contentChildren);
    const expandBtn = this._buildTaskExpandButton(isExpanded);

    const mainRowChildren = [checkboxEl, contentEl];
    if (task.image_url && !isEditing && col.show_images === true) {
      const _full = task.image_url;
      const _small = this._thumbUrl(_full);
      const thumb = this._el("img", {
        className: "task-thumb",
        src: _small,
        alt: "",
        title: task.title,
      });
      if (_small !== _full) thumb.addEventListener("error", () => { thumb.src = _full; }, { once: true });
      // Click on thumbnail expands the task to show full image
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isExpanded) this._expandedTasks.delete(task.id);
        else this._expandedTasks.add(task.id);
        this._render();
      });
      mainRowChildren.push(thumb);
    }
    mainRowChildren.push(expandBtn);

    const mainRow = this._el("div", { className: "task-main" }, mainRowChildren);
    this._attachTaskExpandClickHandler(mainRow, task, taskEl, colIdx);
    taskEl.appendChild(mainRow);

    // --- expanded details + open/close animation ---
    if (isExpanded) {
      const detailsEl = this._buildTaskDetails(task, colIdx);
      taskEl.appendChild(detailsEl);
      this._animateExpandedDetails(detailsEl, task);
    }

    this._attachDragToTask(taskEl, task.id, colIdx);
    this._attachTaskAppearanceAnimations(task, colIdx);

    return taskEl;
  }

  _buildTaskCheckbox(task, colIdx) {
    const checkbox = this._el("input", { type: "checkbox", checked: task.completed });
    // A touch drag released on the checkbox still ends in a click — cancel it
    // so the drag doesn't tick the task off.
    checkbox.addEventListener("click", (e) => {
      if (Date.now() < (this._suppressRowTapUntil || 0)) e.preventDefault();
    });
    checkbox.addEventListener("change", () => this._toggleTask(task.id, task.completed, colIdx));
    const checkmark = this._el("span", { className: "checkmark" });
    return this._el("label", { className: "checkbox-container" }, [checkbox, checkmark]);
  }

  _attachTaskAppearanceAnimations(task, colIdx) {
    // Filter enter animation: task is newly appearing after a filter change
    if (this._justAppearedTaskIds && this._justAppearedTaskIds.has(String(task.id))) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = this.shadowRoot.querySelector(
            `.task-list[data-col-idx="${colIdx}"] .task[data-task-id="${CSS.escape(String(task.id))}"]`
          );
          if (el) {
            el.classList.add("task-anim-enter");
            el.addEventListener("animationend", () => el.classList.remove("task-anim-enter"), { once: true });
          }
        });
      });
    }

    // Creation animation: task slides in from the add-input field position
    if (this._justAddedTaskId && this._justAddedTaskId === String(task.id)) {
      this._animateTaskEntry(task.id, colIdx);
    }
  }

  // Auto-generation for an external column, waiting for the task the provider
  // just created to reach the card. Polls rather than chaining onto
  // _reloadExternal, which is a fire-and-forget timer. Gives up quietly: an
  // automatic extra is not worth an error popup, and the button in the task
  // details still works.
  async _autoGenerateExternalImage(colIdx, uid) {
    const sourceKey = this._colSourceKey(colIdx);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (!this.isConnected) return;
      // The column may have been re-pointed at another list meanwhile.
      if (this._colSourceKey(colIdx) !== sourceKey) return;
      const task = this._columns[colIdx]?.tasks?.find(t => String(t.id) === uid);
      if (task) {
        if (!task.image_url) await this._generateTaskImage(task, colIdx);
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // --- "Plan for…" in a list ---

  async _loadPlans() {
    const r = await this._callWs("home_tasks/get_plans");
    this._plans = (r && Array.isArray(r.plans)) ? r.plans : [];
  }

  // The plans a column's list belongs to, with the list's id in each.
  _plansForCol(colIdx) {
    const col = this._config.columns[colIdx];
    if (!col) return [];
    const found = [];
    for (const plan of this._plans || []) {
      const src = (plan.sources || []).find(
        (s) => (col.entity_id ? s.entity_id === col.entity_id : s.entry_id === col.list_id)
      );
      if (src) found.push({ plan, entry_id: src.entry_id });
    }
    return found;
  }

  async _planTaskViaDialog(task, colIdx) {
    // Read again: the days a plan covers move on at midnight.
    await this._loadPlans();
    const targets = this._plansForCol(colIdx);
    if (targets.length === 0) return;
    const planSel = this._el("select", { className: "ht-move-select plan-pick" }, targets.map(
      (t, i) => this._el("option", { value: String(i), textContent: t.plan.name })
    ));
    const daySel = this._el("select", { className: "ht-move-select day-pick" });
    const fillDays = () => {
      const plan = targets[Number(planSel.value) || 0].plan;
      const today = plan.today || this._localDateStr(new Date());
      daySel.replaceChildren(...(plan.horizon || []).map(
        (d) => this._el("option", { value: d, textContent: this._planDayLabel(d, today) })
      ));
    };
    planSel.addEventListener("change", fillDays);
    fillDays();
    const choice = await this._modalDialog({
      message: this._t("plan_day_msg", task.title),
      okLabel: this._t("plan_ok"),
      body: targets.length > 1 ? [planSel, daySel] : [daySel],
      resolveOk: () => ({ target: targets[Number(planSel.value) || 0], date: daySel.value }),
    });
    if (!choice || !choice.date) return;
    try {
      await this._callWs("home_tasks/plan_task", {
        plan: choice.target.plan.id,
        task_id: String(task.id),
        entry_id: choice.target.entry_id,
        date: choice.date,
      }, { rethrow: true });
    } catch (err) {
      if (!this._isWsTimeout(err)) this._showError((err && err.message) || String(err));
    }
  }

  static getConfigElement() {
    return document.createElement("home-tasks-card-editor");
  }

  static getStubConfig() {
    return { columns: [{}] };
  }

  // ── TasksCardBase hooks ───────────────────────────────────────────────────

  // The plans this card's lists belong to, for "Plan for…".
  _loadOwnData() {
    return this._loadPlans();
  }

  // During Home Assistant's start: a configured list the backend does not
  // know yet.
  _bootIncomplete() {
    return this._config.columns.some(
      (c) => c.list_id && !this._lists.some((l) => l.id === c.list_id)
    );
  }

  async _afterListsLoaded() {
    // Auto-select first list if no column has a list configured
    const hasAnyList = this._config.columns.some(c => c.list_id || c.entity_id);
    if (!hasAnyList && this._lists.length > 0) {
      const newCols = [...this._config.columns];
      newCols[0] = { ...newCols[0], list_id: this._lists[0].id };
      this._config = { ...this._config, columns: newCols };
      this._columns[0].filter = newCols[0].default_filter || "all";
    }
    await this._loadAllTasks();
  }

  // On a list that a day plan draws from: put the task on one of its days.
  _extraTaskActions(task, colIdx) {
    if (task.completed || this._plansForCol(colIdx).length === 0) return [];
    const planBtn = this._el("button", {
      className: "move-task-btn plan-for-btn",
      textContent: this._t("plan_for"),
    });
    planBtn.addEventListener("click", () => this._planTaskViaDialog(task, colIdx));
    return [planBtn];
  }
}
