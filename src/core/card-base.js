// What every Home Tasks card type is built on: the lists it reads and
// writes, a task's row and details, drag and drop, dialogs, texts and the
// styles of all that. A card type (views/) decides what it draws and fills
// in the hooks at the end.

import { _htText } from "./i18n.js";
import { DETAIL_FOLD_EVENT, DETAIL_FOLD_STORAGE_KEY, MAX_REMINDERS, PERSON_COLORS, PERSON_MODES, REMINDER_OFFSETS, WS_TIMEOUT, _assignees, _detailFieldOn, _detailOrder, _foldedDetailKeys, imageSettingsForLists, listInfoFor, listSupportsDueTime, nextFreeReminderOffset, personEntries, reminderOffsetOptions } from "./helpers.js";

export class TasksCardBase extends HTMLElement {
  // The shortest gap between two occurrences, in minutes — what a reopen
  // lead must stay below.  Must match _recurrence_interval_minutes in
  // __init__.py; tests/fixtures/recurrence_interval_cases.json is checked
  // against both.  A month counts as 28 days, a year as 365, and "weekly on
  // Mon + Thu" as the 3 days from Mon to Thu.
  static recurrenceIntervalMinutes(unit, value, weekdays = []) {
    const n = Math.max(1, value || 1);
    if (unit === "hours") return n * 60;
    const days = { days: 1, weeks: 7, months: 28, years: 365 }[unit];
    if (!days) return null;
    const wd = [...new Set(weekdays)].sort((a, b) => a - b);
    if (unit === "weeks" && wd.length > 1) {
      const gaps = wd.slice(1).map((d, i) => d - wd[i]);
      gaps.push(wd[0] + 7 - wd[wd.length - 1]);
      return Math.min(...gaps) * 1440;
    }
    return n * days * 1440;
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.addEventListener("focusout", () => {
      // After focus leaves all inputs, flush any deferred render — unless a
      // press is still held: then its release flushes (after the click).
      // The timeout lets the field's own blur handling go first (the notes
      // switch back to their read view in one).
      requestAnimationFrame(() => setTimeout(() => {
        if (!this._pendingRender || this.shadowRoot.activeElement) return;
        if (this._pointerIsDown) this._flushOnRelease = true;
        else this._render();
      }, 0));
    });
    // Whether a press inside the card is still held (see _deferRenderUntilBlur).
    this._pointerIsDown = false;
    this.shadowRoot.addEventListener("pointerdown", () => {
      this._pointerIsDown = true;
      const release = () => {
        this._pointerIsDown = false;
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
        if (this._flushOnRelease) {
          this._flushOnRelease = false;
          // After the click that follows this release.
          setTimeout(() => {
            if (this._pendingRender && !this.shadowRoot.activeElement) this._render();
          }, 0);
        }
      };
      window.addEventListener("pointerup", release, true);
      window.addEventListener("pointercancel", release, true);
    }, true);
    this._config = { columns: [{}] };
    this._hass = null;
    this._lists = [];
    this._externalLists = [];
    // Per-column state: [{filter, sortBy, sortOpen, tagFilters, personFilters, tasks, newTaskTitle}]
    this._columns = [];
    this._sourceDefaults = {};    // { entityId: defaults|null } — for the optimistic row
    this._expandedTasks = new Set();
    this._editingTaskId = null;
    this._editingSubTaskId = null;
    this._draggedTaskId = null;
    this._draggedColIdx = null;
    this._draggedTaskElement = null;
    this._touchClone = null;
    this._touchStartTimer = null;
    this._touchOffsetY = 0;
    this._draggedSubTaskId = null;
    this._subTouchClone = null;
    this._subTouchStartTimer = null;
    this._subTouchOffsetY = 0;
    this._lastTitleClick = null;
    this._initialized = false;
    this._extPollTimer = null;
    this._pendingRender = false;
    this._styleEl = null;
    this._justAddedTaskId = null;
    this._addInputRect = null;
    this._justAppearedTaskIds = null;
    this._filterAnimPending = false;
    // Sticky UI state for radios that don't yet have backing data.  When
    // the user picks "Am" but hasn't entered the actual values, we don't
    // save anything (avoids snap-back on reload), so the next render would
    // otherwise re-derive "Ab Erledigung" from the empty data.  These maps
    // remember the user's pick until either real data is entered (which
    // takes over) or they pick "Ab Erledigung" (which clears the override).
    this._weekPatternOverride = new Map();   // task.id → "on"
    this._yearPatternOverride = new Map();   // task.id → "on"
    this._generatingImage = new Set();       // task IDs currently generating
    this._voiceActive = new Map();           // colIdx → cleanup function
  }

  _defaultColState() {
    // taskSearchQuery holds the text currently typed into the add-task
    // field (see _buildColumnAddTask / _buildColumnTaskList).
    return { filter: "all", sortBy: "manual", sortOpen: false, tagFilters: new Set(), personFilters: new Set(), tasks: [], sections: [], newTaskTitle: "", newTaskDue: "", newTaskDueTime: "", taskSearchQuery: "", draft: null };
  }

  _t(key, ...args) {
    return _htText(this._localeCode(), key, args);
  }

  // After the user picks an option in a <select>, drop focus right away.
  // Otherwise the dropdown stays "highlighted" and the very next click
  // on a sibling control is consumed by the implicit focus transition
  // rather than by the new control's own change handler.  Defer to the
  // next microtask so any synchronous change handler runs first against
  // the still-focused element.
  _blurSelectOnChange(select) {
    select.addEventListener("change", () => {
      Promise.resolve().then(() => select.blur());
    });
  }

  // Format an ordinal day-of-month in the user's language: "1." in
  // German/most European, "1st"/"2nd"/"3rd"/"4th" in English.
  _domOrdinal(d) {
    const lang = this._localeCode();
    if (lang === "en" || lang.startsWith("en-") || lang === "en_US" || lang === "en_GB") {
      const mod100 = d % 100;
      if (mod100 >= 11 && mod100 <= 13) return `${d}th`;
      const last = d % 10;
      const suffix = last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
      return `${d}${suffix}`;
    }
    return `${d}.`;
  }

  set hass(hass) {
    const prev = this._hass;
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._loadLists();
      return;
    }
    // Reload when any watched entity's state object changes (new reference = entity updated).
    // Covers both external todo entities and native-list sensor entities (for cross-device sync).
    if (prev && hass) {
      if (this._watchHass(prev, hass)) return;
    }
    // Start/stop periodic polling for external detail changes (notes, due dates, etc.)
    // that don't update the entity state (which is just the active item count).
    this._syncExtPollTimer();
  }

  // Whether a change Home Assistant reports concerns one of this card's
  // lists - then it is loaded again, and true says so. A card type watches
  // what it shows; this is a card of lists' way (a day plan has its own).
  _watchHass(prev, hass) {
    for (const col of this._sourceCols()) {
      // --- External list: watch the todo entity directly ---
      if (col.entity_id) {
        if (prev.states?.[col.entity_id] !== hass.states?.[col.entity_id]) {
          this._bgUpdates = (this._bgUpdates || 0) + 1;
          this._loadAllTasks().finally(() => { this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1); });
          return true;
        }
      }
      // --- Native list: watch its open-tasks sensor so changes on other
      //     devices/tabs propagate here without manual refresh ---
      if (col.list_id) {
        const list = (this._lists || []).find(l => l.id === col.list_id);
        const seid = list?.sensor_entity_id;
        if (seid && prev.states?.[seid] !== hass.states?.[seid]) {
          this._bgUpdates = (this._bgUpdates || 0) + 1;
          this._loadAllTasks().finally(() => { this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1); });
          return true;
        }
      }
    }
    return false;
  }

  _syncExtPollTimer() {
    const hasExternal = this._sourceCols().some(c => c.entity_id);
    if (hasExternal && !this._extPollTimer) {
      this._extPollTimer = setInterval(async () => {
        this._beforePoll();
        this._bgUpdates = (this._bgUpdates || 0) + 1;
        try { await this._loadAllTasks(true); } finally { this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1); }
      }, 30000);
    } else if (!hasExternal && this._extPollTimer) {
      clearInterval(this._extPollTimer);
      this._extPollTimer = null;
    }
  }

  // --- Safe DOM helpers ---

  _el(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
      if (key === "className") {
        el.className = val;
      } else if (key === "textContent") {
        el.textContent = val;
      } else if (key.startsWith("on")) {
        el.addEventListener(key.slice(2).toLowerCase(), val);
      } else if (key === "checked") {
        el.checked = val;
      } else if (key === "draggable") {
        el.draggable = val;
      } else if (key === "value") {
        el.value = val;
      } else if (key === "disabled") {
        el.disabled = val;
      } else if (key === "rows") {
        el.rows = val;
      } else if (key === "type") {
        el.type = val;
      } else if (key === "placeholder") {
        el.placeholder = val;
      } else if (key === "title") {
        el.title = val;
      } else if (key === "htmlFor") {
        el.htmlFor = val;
      } else if (key === "innerHTML") {
        el.innerHTML = val;
      } else {
        el.setAttribute(key, val);
      }
    }
    for (const child of children) {
      if (typeof child === "string") {
        el.appendChild(document.createTextNode(child));
      } else if (child) {
        el.appendChild(child);
      }
    }
    return el;
  }

  // --- Data methods ---

  // `rethrow` is for callers that have to tell a refusal from our own 5s
  // race: the backend saying no means the action did not happen, a timeout
  // means we stopped waiting and it may well have happened anyway.
  async _callWs(type, data = {}, { rethrow = false } = {}) {
    if (!this._hass) return null;
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(WS_TIMEOUT)), 5000)
      );
      return await Promise.race([
        this._hass.callWS({ type, ...data }),
        timeout,
      ]);
    } catch (err) {
      console.warn(`WS call ${type} failed:`, err.message);
      if (rethrow) throw err;
      return null;
    }
  }

  _isWsTimeout(err) {
    return !!err && err.message === WS_TIMEOUT;
  }

  // --- External entity routing helpers ---

  /**
   * Schedule a delayed reload for an external column.
   * External providers have latency — the entity may not reflect changes
   * immediately after a service call.  Callers should apply optimistic
   * local updates first so the UI responds instantly; this method only
   * schedules a background reload to pick up the confirmed provider state.
   */
  _reloadExternal(colIdx) {
    setTimeout(() => {
      this._beforeExternalReload(colIdx);
      this._loadAllTasks();
    }, 1500);
  }

  _isExternalCol(colIdx) {
    return !!this._sourceCol(colIdx)?.entity_id;
  }

  _colEntityId(colIdx) {
    return this._sourceCol(colIdx)?.entity_id;
  }

  _getExternalListInfo(colIdx) {
    if (!this._isExternalCol(colIdx)) return null;
    const entityId = this._colEntityId(colIdx);
    return (this._externalLists || []).find(l => l.entity_id === entityId) || null;
  }

  _colSupportsDueTime(colIdx) {
    if (!this._isExternalCol(colIdx)) return true;
    return listSupportsDueTime(this._getExternalListInfo(colIdx));
  }

  _colSupportedFeatures(colIdx) {
    if (!this._isExternalCol(colIdx)) return -1; // native: all features
    return this._getExternalListInfo(colIdx)?.supported_features ?? 0;
  }

  _colCapabilities(colIdx) {
    return this._getExternalListInfo(colIdx)?.capabilities ?? (this._isExternalCol(colIdx) ? {} : null);
  }

  /**
   * Route a task update to the correct backend.
   * For native columns: single WS call to home_tasks/update_task.
   * For external columns: routed through the backend adapter (handles
   * provider-specific sync + overlay for unsynced fields).
   */
  async _updateTaskRouted(colIdx, taskId, fields, { rethrow = false } = {}) {
    // A draft (show_add_details) isn't created yet: edits stay on it until Add.
    const draft = this._draftFor(colIdx, taskId);
    if (draft) {
      Object.assign(draft, fields);
      if (Array.isArray(fields.assigned_persons)) draft.assigned_person = fields.assigned_persons[0] || null;
      this._render();
      return;
    }
    if (!this._isExternalCol(colIdx)) {
      return this._callWs("home_tasks/update_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        ...fields,
      }, { rethrow });
    }

    // External: send all fields to the backend — the adapter decides what
    // goes to the provider API and what goes to the overlay.
    await this._callWs("home_tasks/update_external_task", {
      entity_id: this._colEntityId(colIdx),
      task_uid: taskId,
      ...fields,
    }, { rethrow });
  }

  // The column's draft (show_add_details) when taskId is its id, else null.
  // A detail field that saves on its own must keep a draft's edits on it.
  _draftFor(colIdx, taskId) {
    const draft = this._columns[colIdx]?.draft;
    return draft && taskId === draft.id ? draft : null;
  }

  async _deleteTaskCmd(colIdx, taskId) {
    if (this._isExternalCol(colIdx)) {
      try {
        await this._hass.callService("todo", "remove_item", {
          item: taskId,
        }, { entity_id: this._colEntityId(colIdx) });
      } catch (err) {
        console.warn("Failed to delete external task:", err);
        return; // Don't clean up overlay if deletion failed
      }
      // Clean up overlay data only on successful deletion
      await this._callWs("home_tasks/delete_external_overlay", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
      });
    } else {
      await this._callWs("home_tasks/delete_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
      });
    }
  }

  _showError(message) {
    const root = this.shadowRoot;
    if (!root) return;
    const existing = root.querySelector(".toast-error");
    if (existing) existing.remove();
    const toast = this._el("div", { className: "toast-error", textContent: message });
    root.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // A card is the only place auto_generate_image and the ai_task entity are
  // configured, but the background queue has to work without one being open.
  // Whenever a card with the option loads, it hands both to the backend:
  // once card-wide as the fallback, and to every list it shows as that
  // list's own - so a task is always drawn with the prefix of its list,
  // and a second dashboard with another style cannot overwrite it.
  async _syncImageGenerationConfig() {
    if (!this._hass || !this._config) return;
    const wanted = (this._sourceCols() || []).filter(
      c => c.auto_generate_image === true && c.show_images === true && (c.list_id || c.entity_id)
    );
    if (!wanted.length) return;
    const own = imageSettingsForLists(this);
    try {
      if (own) {
        await this._hass.callWS({ type: "home_tasks/sync_image_config", ...own });
      }
      for (const col of wanted) {
        const info = listInfoFor(this, col);
        const change = {};
        if (!(info && info.auto_generate_images === true)) change.auto_generate_images = true;
        if (own && !(info && info.ai_task_entity_id === own.ai_task_entity_id
                     && info.prompt_prefix === own.prompt_prefix)) {
          Object.assign(change, own);
        }
        if (!Object.keys(change).length) continue;  // the list already knows all this
        await this._hass.callWS({
          type: "home_tasks/set_list_settings",
          ...(col.entity_id ? { entity_id: col.entity_id } : { list_id: col.list_id }),
          ...change,
        });
        if (info) Object.assign(info, change);
      }
    } catch (e) {
      console.warn("Could not sync automatic image generation:", e);
    }
  }

  async _loadLists() {
    const [nativeResult, externalResult] = await Promise.all([
      this._callWs("home_tasks/get_lists"),
      this._callWs("home_tasks/get_external_lists"),
      // What the card type needs besides the lists: a day plan its plan,
      // a card of lists the plans it can offer "Plan for…" with.
      this._loadOwnData(),
    ]);
    if (nativeResult && Array.isArray(nativeResult.lists)) {
      this._lists = nativeResult.lists;
    }
    this._externalLists = (externalResult && Array.isArray(externalResult.external_lists))
      ? externalResult.external_lists.filter(l => l.linked)
      : [];

    // Boot-window self-heal (#37 family): during HA startup this card — now
    // served reliably from the browser cache — can initialize before the
    // integration has registered its WS commands or loaded every store. The
    // initial fetch then fails (null) or misses configured lists, and
    // nothing else re-triggers it: the cross-device state watcher needs the
    // very list metadata that just failed to load. Retry with backoff until
    // the backend answers completely.
    if (nativeResult === null || externalResult === null || this._bootIncomplete()) {
      this._scheduleListsRetry();
    } else {
      this._listsRetryCount = 0;
      if (this._listsRetryTimer) {
        clearTimeout(this._listsRetryTimer);
        this._listsRetryTimer = null;
      }
    }

    // The list metadata the sync needs (share/auto flags) is only here now.
    this._syncImageGenerationConfig();

    await this._afterListsLoaded();
  }

  _scheduleListsRetry() {
    // 2s → 5s → 10s → 30s, then once a minute; give up after ~5 minutes
    // (matches the register block's watch horizon). Runs as a background
    // update so a retry never steals focus from an input mid-typing.
    const delays = [2000, 5000, 10000, 30000, 60000, 60000, 60000, 60000];
    const attempt = this._listsRetryCount || 0;
    if (attempt >= delays.length || this._listsRetryTimer) return;
    this._listsRetryCount = attempt + 1;
    this._listsRetryTimer = setTimeout(() => {
      this._listsRetryTimer = null;
      if (!this.isConnected) return;
      this._bgUpdates = (this._bgUpdates || 0) + 1;
      this._loadLists().finally(() => { this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1); });
    }, delays[attempt]);
  }

  // What a new task on this list starts with. Only external columns need it:
  // the native path draws the task the store hands back, while the external
  // one shows a placeholder for a moment and would otherwise show a task
  // without the tags and priority it is about to get.
  async _loadListDefaults(entityId) {
    if (this._sourceDefaults[entityId] !== undefined) return;
    this._sourceDefaults[entityId] = null;  // in flight, ask once
    const r = await this._callWs("home_tasks/get_defaults", { entity_id: entityId });
    this._sourceDefaults[entityId] = (r && r.defaults) || null;
  }

  // Read the tasks of the card's lists again and draw the card. *quiet*: a
  // look in the background (a sensor changed, the poll) - a card type may
  // leave the card as it is when it finds nothing new (the day plan does).
  async _loadAllTasks(quiet = false) {
    await this._loadColumnTasks();
    this._render();
  }

  // Returns how many of a day plan's lists came back different from what
  // the card held (0 for a card of lists, which renders after every load).
  async _loadColumnTasks() {
    // The states as they are now: a day plan swaps the array when its lists
    // change, and an answer must land in the list it was asked for.
    const states = this._columns;
    const sources = this._sourceStamps();
    let changed = 0;
    const content = (cs) => JSON.stringify([cs.tasks, cs.sections, cs.tagCatalog]);
    await Promise.all(this._sourceCols().map(async (col, i) => {
      const cs = states[i];
      if (!cs) return;
      // A day plan can draw from dozens of lists, many of them kept by a
      // provider that takes its time. Each list is loaded again only when
      // the plan says its tasks changed (a stamp per list), or when the card
      // has a reason of its own to doubt its copy (cs.stale).
      const stamp = sources ? (sources[i] && sources[i].stamp) : undefined;
      if (sources && cs.loaded && !cs.stale && stamp !== undefined && cs.stamp === stamp) return;
      cs.stale = false;
      // As the card holds it now - with what it changed on its own ahead of
      // the answer (a tick shown at once), so that a refused change counts
      // as a difference too.
      const held = sources ? content(cs) : null;
      const kept = sources ? { tasks: cs.tasks, sections: cs.sections, tagCatalog: cs.tagCatalog } : null;
      if (col.entity_id) {
        // External column — fetch from external entity + overlay
        this._loadListDefaults(col.entity_id);
        const r = await this._callWs("home_tasks/get_external_tasks", { entity_id: col.entity_id });
        cs.tasks = r?.tasks ?? [];
        cs.sections = r?.sections ?? [];
        cs.tagCatalog = r?.tag_catalog ?? [];
        cs.loaded = !!r;
      } else if (col.list_id) {
        // Native column
        const r = await this._callWs("home_tasks/get_tasks", { list_id: col.list_id });
        cs.tasks = r?.tasks ?? [];
        cs.sections = r?.sections ?? [];
        cs.tagCatalog = r?.tag_catalog ?? [];
        cs.reopenLead = r?.reopen_lead ?? 0;
        cs.loaded = !!r;
      } else {
        cs.tasks = [];
        cs.sections = [];
      }
      if (sources) {
        cs.stamp = stamp;
        // Asked again is not changed: the poll asks a provider every 30 s,
        // and the same tasks back must not rebuild the card under the pointer.
        if (content(cs) !== held) changed += 1;
        // The same tasks again: the objects stay, as with the plan above.
        else Object.assign(cs, kept);
      }
    }));
    return changed;
  }

  _colListId(colIdx) {
    return this._sourceCol(colIdx)?.list_id;
  }

  // Whether the column's list takes part in the cross-list image pool. The
  // backend decides what is actually stored; the card asks the same question
  // so its optimistic update does not show an image that will never arrive.
  _colSharesImages(colIdx) {
    const col = this._sourceCol(colIdx);
    if (!col) return false;
    const info = col.entity_id
      ? (this._externalLists || []).find(l => l.entity_id === col.entity_id)
      : (this._lists || []).find(l => l.id === col.list_id);
    return info ? info.share_images !== false : true;
  }

  // Identity of the list a column shows, for deciding which columns hold the
  // same task. Task ids are only unique within a list — external providers
  // hand out their own uids and two of them can collide — so anything that
  // patches "this task everywhere" must compare source, not just id.
  _colSourceKey(colIdx) {
    const col = this._sourceCol(colIdx);
    if (!col) return null;
    if (col.entity_id) return `ext:${col.entity_id}`;
    if (col.list_id) return `native:${col.list_id}`;
    return null;
  }

  // Wrapper around the toggle logic: ticking off a task you searched for
  // ends the search, so the section view comes back instead of leaving you
  // on a result that is now done. Only when the task was really completed —
  // _toggleTaskCore returns false when the confirm_complete prompt was
  // cancelled, and throwing away what the user typed on a tap they just
  // took back is the opposite of helpful. Reopening keeps the search: the
  // list you were looking through is still the list you want.
  async _toggleTask(taskId, completed, colIdx) {
    const cs = this._columns[colIdx];
    const wasSearching = !!this._activeSearchQuery(colIdx);
    const toggled = await this._toggleTaskCore(taskId, completed, colIdx);
    if (wasSearching && toggled && !completed) {
      cs.taskSearchQuery = "";
      cs.newTaskTitle = "";
      this._render();
    }
  }

  // Returns whether the task actually changed state (false = the user
  // cancelled the confirm_complete prompt).
  async _toggleTaskCore(taskId, completed, colIdx) {
    const col = this._sourceCol(colIdx);
    const cs = this._columns[colIdx];
    const newCompleted = !completed;
    const task = cs.tasks.find(t => t.id === taskId);
    const hasRecurrence = task && task.recurrence_enabled && task.recurrence_unit;

    // Opt-in guard against accidental taps (issue #29). Default off; the
    // checkbox/swipe/long-press paths all funnel through here, so one
    // prompt covers them all. On cancel, re-render to restore the checkbox
    // the click already flipped.
    if (newCompleted && col.confirm_complete === true) {
      const ok = await this._confirmDialog(
        this._t("confirm_complete_msg", task ? task.title : ""),
        this._t("confirm_complete_ok"),
      );
      if (!ok) {
        this._render();
        return false;
      }
    }

    // auto_delete path → route through _deleteTask to reuse exit animation
    if (newCompleted && col.auto_delete_completed && !hasRecurrence) {
      await this._deleteTask(taskId, colIdx);
      return true;
    }

    // Snapshot all visible task positions for FLIP (completion/reopen moves the task)
    const before = this._captureListFlip(colIdx);

    if (this._isExternalCol(colIdx) && task) {
      // Recurring tasks: providers like Todoist DON'T close a recurring task
      // on complete — they advance the due_date to the next occurrence and
      // leave the task open.  Rendering "completed=true" locally would make
      // the task flash as ticked and then jump back to open on the next reload.
      // Skip the optimistic flip and let the post-write reload show the real
      // (advanced) state.
      if (newCompleted && hasRecurrence) {
        await this._updateTaskRouted(colIdx, taskId, { completed: newCompleted });
        await this._reloadExternal(colIdx);
        this._applyFlip(before, colIdx, 0.28);
        return true;
      }

      // Optimistic update for non-recurring external tasks: render new state
      // immediately, then sync to provider.  External service calls have
      // latency; the entity may not reflect the change right away.
      task.completed = newCompleted;
      this._render();
      this._applyFlip(before, colIdx, 0.28);
      await this._updateTaskRouted(colIdx, taskId, { completed: newCompleted });
      this._reloadExternal(colIdx);
    } else {
      await this._updateTaskRouted(colIdx, taskId, { completed: newCompleted });
      await this._loadAllTasks();
      this._applyFlip(before, colIdx, 0.28);
    }
    return true;
  }

  async _updateTaskTitle(taskId, title, colIdx) {
    if (!title.trim()) return;
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    if (task) task.title = title.trim();
    this._editingTaskId = null;
    this._render();
    await this._updateTaskRouted(colIdx, taskId, { title: title.trim() });
    if (this._isExternalCol(colIdx)) this._reloadExternal(colIdx);
  }

  async _updateTaskNotes(taskId, notes, colIdx) {
    // Optimistic local update — must happen before the await so a deferred
    // render (triggered by focusout) picks up the user's value, not stale poll data.
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    if (task) task.notes = notes;
    await this._updateTaskRouted(colIdx, taskId, { notes });
  }

  async _updateTaskDue(taskId, dueDate, dueTime, colIdx) {
    // Optimistic local update
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    if (task) {
      task.due_date = dueDate || null;
      task.due_time = dueDate ? (dueTime || null) : null;
    }
    await this._updateTaskRouted(colIdx, taskId, {
      due_date: dueDate || null,
      due_time: dueDate ? (dueTime || null) : null,
    });
    if (this._isExternalCol(colIdx)) {
      this._reloadExternal();
    }
  }

  async _deleteTask(taskId, colIdx) {
    const taskEl = this.shadowRoot.querySelector(
      `.task[data-task-id="${CSS.escape(String(taskId))}"]`
    );

    if (taskEl) {
      // Snapshot positions of all OTHER tasks (deleted task still occupies layout space)
      const before = this._captureListFlip(colIdx);
      before.delete(String(taskId)); // exclude the task being deleted

      // Animate the task out
      await new Promise(resolve => {
        taskEl.style.transition = "opacity 0.18s ease, transform 0.18s ease";
        taskEl.style.opacity = "0";
        taskEl.style.transform = "scale(0.95)";
        taskEl.addEventListener("transitionend", resolve, { once: true });
        setTimeout(resolve, 250); // safety fallback
      });

      // Optimistic: remove locally so surviving tasks animate up immediately,
      // without waiting for the server round-trip.
      const cs = this._columns[colIdx];
      if (cs?.tasks) cs.tasks = cs.tasks.filter(t => String(t.id) !== String(taskId));
      this._taskGoneLocally(taskId, colIdx);
      this._expandedTasks.delete(taskId);
      this._render();
      this._applyFlip(before, colIdx, 0.22);

      // Sync with server in the background (re-render after reload is harmless
      // since the FLIP animation will have completed by then).
      await this._deleteTaskCmd(colIdx, taskId);
      this._afterDeleteSent();
      await this._loadAllTasks();

    } else {
      // Fallback: task not in DOM, delete without animation
      await this._deleteTaskCmd(colIdx, taskId);
      this._expandedTasks.delete(taskId);
      await this._loadAllTasks();
    }
  }

  async _addSubTask(taskId, colIdx) {
    const title = this._t("new_sub_item");
    const tempId = "_pending_sub_" + Date.now();

    // Optimistic: insert placeholder sub-task immediately
    const cs = this._columns[colIdx];
    const task = cs.tasks.find(t => t.id === taskId);
    if (task) {
      if (!task.sub_items) task.sub_items = [];
      task.sub_items.push({ id: tempId, title, completed: false });
      this._editingSubTaskId = tempId;
      this._render();
    }

    // Send to backend in background, then swap temp ID for real ID
    // without a full reload (which would destroy the active input).
    let result;
    if (this._isExternalCol(colIdx)) {
      result = await this._callWs("home_tasks/add_external_sub_task", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        title,
      });
    } else {
      result = await this._callWs("home_tasks/add_sub_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        title,
      });
    }
    if (result && task) {
      // Replace temp ID with real ID in local data — no DOM rebuild needed
      const sub = task.sub_items.find(s => s.id === tempId);
      if (sub) sub.id = result.id;
      if (this._editingSubTaskId === tempId) {
        this._editingSubTaskId = result.id;
      }
      // Keep DOM identifiers in sync so a later unrelated _render's
      // focus-restore can find the element: data-focus-key on the
      // input (format "sub_title_<id>") and data-sub-task-id on the
      // .sub-task wrapper both carried the temp id.
      const root = this.shadowRoot;
      const editedInput = root?.querySelector(`[data-focus-key="sub_title_${CSS.escape(tempId)}"]`);
      if (editedInput) editedInput.setAttribute("data-focus-key", `sub_title_${result.id}`);
      const subEl = root?.querySelector(`.sub-task[data-sub-task-id="${CSS.escape(tempId)}"]`);
      if (subEl) subEl.dataset.subTaskId = result.id;
    }
  }

  async _toggleSubTask(taskId, subItemId, completed, colIdx) {
    // Optimistic local update
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    const sub = task?.sub_items?.find(s => s.id === subItemId);
    if (sub) sub.completed = !completed;
    this._render();
    if (this._isExternalCol(colIdx)) {
      await this._callWs("home_tasks/update_external_sub_task", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        sub_task_id: subItemId,
        completed: !completed,
      });
    } else {
      await this._callWs("home_tasks/update_sub_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        sub_task_id: subItemId,
        completed: !completed,
      });
    }
  }

  async _updateSubTaskTitle(taskId, subItemId, title, colIdx) {
    if (!title.trim()) return;
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    const sub = task?.sub_items?.find(s => s.id === subItemId);
    if (sub) sub.title = title.trim();
    this._editingSubTaskId = null;
    this._render();
    if (this._isExternalCol(colIdx)) {
      await this._callWs("home_tasks/update_external_sub_task", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        sub_task_id: subItemId,
        title: title.trim(),
      });
    } else {
      await this._callWs("home_tasks/update_sub_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        sub_task_id: subItemId,
        title: title.trim(),
      });
    }
  }

  async _deleteSubTask(taskId, subItemId, colIdx) {
    // Optimistic local update
    const task = this._columns[colIdx]?.tasks?.find(t => t.id === taskId);
    if (task?.sub_items) {
      task.sub_items = task.sub_items.filter(s => s.id !== subItemId);
    }
    this._render();
    if (this._isExternalCol(colIdx)) {
      await this._callWs("home_tasks/delete_external_sub_task", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        sub_task_id: subItemId,
      });
    } else {
      await this._callWs("home_tasks/delete_sub_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        sub_task_id: subItemId,
      });
    }
  }

  async _reorderSubTasks(taskId, subTaskIds, colIdx) {
    if (this._isExternalCol(colIdx)) {
      await this._callWs("home_tasks/reorder_external_sub_tasks", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        sub_task_ids: subTaskIds,
      });
    } else {
      await this._callWs("home_tasks/reorder_sub_tasks", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        sub_task_ids: subTaskIds,
      });
    }
    const tasks = this._columns[colIdx]?.tasks;
    if (tasks) {
      const task = tasks.find(t => t.id === taskId);
      if (task && task.sub_items) {
        const idToSub = Object.fromEntries(task.sub_items.map(s => [s.id, s]));
        task.sub_items = subTaskIds.map(id => idToSub[id]).filter(Boolean);
      }
    }
  }

  // Apply pending section_id changes to tasks that crossed a section header
  // during the drag, then persist the new order. Tasks dropped under the
  // global Done header keep their original section_id so reactivation
  // returns them to the right bucket.
  async _applySectionChangesAndReorder(colIdx, sectionedOrder, draggedId = null) {
    const cs = this._columns[colIdx];
    const tasksById = new Map((cs.tasks || []).map((t) => [t.id, t]));
    const knownSectionIds = new Set((cs.sections || []).map((s) => s.id));
    const isExternal = this._isExternalCol(colIdx);
    const updates = [];
    for (const { taskId, sectionId } of sectionedOrder) {
      const task = tasksById.get(taskId);
      if (!task) continue;
      if (sectionId === "__done__") continue; // dropped onto Done header — leave section_id alone
      const targetSectionId = sectionId && knownSectionIds.has(sectionId) ? sectionId : null;
      const currentSectionId = task.section_id || null;
      if (targetSectionId !== currentSectionId) {
        updates.push({ taskId, section_id: targetSectionId });
      }
    }
    for (const u of updates) {
      try {
        await this._saveSectionId(colIdx, u.taskId, u.section_id);
      } catch (err) {
        this._showError(`Section update failed: ${err.message || err}`);
      }
    }
    const visibleOrder = sectionedOrder.map((p) => p.taskId);
    const fullOrder = this._mergeHiddenTasks(colIdx, visibleOrder, draggedId);
    await this._reorderTasks(fullOrder, colIdx);
  }

  // A task's section: ours alone, so on a linked list it lives in the
  // overlay, never at the provider.
  async _saveSectionId(colIdx, taskId, sectionId) {
    const draft = this._draftFor(colIdx, taskId);
    if (draft) { draft.section_id = sectionId; return; }
    if (this._isExternalCol(colIdx)) {
      await this._callWs("home_tasks/update_external_overlay", {
        entity_id: this._colEntityId(colIdx),
        task_uid: taskId,
        section_id: sectionId,
      });
    } else {
      await this._callWs("home_tasks/update_task", {
        list_id: this._colListId(colIdx),
        task_id: taskId,
        section_id: sectionId,
      });
    }
  }

  async _reorderTasks(taskIds, colIdx) {
    if (this._isExternalCol(colIdx)) {
      // Route through backend adapter — it decides whether to use
      // the provider API, todo/item/move, or overlay sort_order.
      await this._callWs("home_tasks/reorder_external_tasks", {
        entity_id: this._colEntityId(colIdx),
        task_uids: taskIds,
      });
    } else {
      const listId = this._colListId(colIdx);
      if (!listId) return;
      await this._callWs("home_tasks/reorder_tasks", {
        list_id: listId,
        task_ids: taskIds,
      });
    }
    await this._loadAllTasks();
  }

  async _moveTask(srcColIdx, tgtColIdx, taskId, targetTaskIds) {
    const srcIsExternal = this._isExternalCol(srcColIdx);
    const tgtIsExternal = this._isExternalCol(tgtColIdx);

    // Build the move command payload
    const payload = { task_id: taskId };
    if (srcIsExternal) {
      payload.source_entity_id = this._colEntityId(srcColIdx);
    } else {
      payload.source_list_id = this._colListId(srcColIdx);
    }
    if (tgtIsExternal) {
      payload.target_entity_id = this._colEntityId(tgtColIdx);
    } else {
      payload.target_list_id = this._colListId(tgtColIdx);
    }

    if (!payload.source_list_id && !payload.source_entity_id) {
      this._showError("Cannot move task: source list not configured");
      await this._loadAllTasks();
      return;
    }
    if (!payload.target_list_id && !payload.target_entity_id) {
      this._showError("Cannot move task: target list not configured");
      await this._loadAllTasks();
      return;
    }
    // Dropped among the target's tasks: the section it was dropped in wins
    // (null = the unsorted top). Not there, or under Done: the backend keeps
    // a section of the same name.
    const dropped = this._getOrderWithSectionFromDom(tgtColIdx)
      .find((p) => String(p.taskId) === String(taskId));
    if (dropped && dropped.sectionId !== "__done__") payload.section = dropped.sectionId;

    // Shared executor: fast path vs cross routing + error toast. A failed
    // move skips the reorder and just reloads the authoritative state.
    if (!(await this._execMove(payload))) {
      await this._loadAllTasks();
      if (srcIsExternal || tgtIsExternal) this._reloadExternal();
      return;
    }

    // Reorder target list if needed
    if (targetTaskIds.length > 0) {
      if (tgtIsExternal) {
        await this._callWs("home_tasks/reorder_external_tasks", {
          entity_id: this._colEntityId(tgtColIdx),
          task_uids: targetTaskIds,
        });
      } else {
        await this._callWs("home_tasks/reorder_tasks", {
          list_id: this._colListId(tgtColIdx),
          task_ids: targetTaskIds,
        });
      }
    }

    await this._loadAllTasks();
    // External providers need a delayed reload to pick up confirmed state
    if (srcIsExternal || tgtIsExternal) {
      this._reloadExternal();
    }
  }

  // --- Filter & Sort ---

  _preFilteredTasks(colIdx) {
    const cs = this._columns[colIdx];
    const col = this._sourceCol(colIdx);
    let tasks = cs.tasks;
    const preAssignees = col.filters?.assignees;
    const preLabels = col.filters?.labels;
    if (preAssignees && preAssignees.length > 0) {
      const set = new Set(preAssignees);
      tasks = tasks.filter((t) => _assignees(t).some((p) => set.has(p)));
    }
    if (preLabels && preLabels.length > 0) {
      const set = new Set(preLabels);
      tasks = tasks.filter((t) => t.tags && t.tags.some((tag) => set.has(tag)));
    }
    return tasks;
  }

  _filteredTasks(colIdx) {
    const cs = this._columns[colIdx];
    const baseTasks = this._preFilteredTasks(colIdx);
    let tasks;
    switch (cs.filter) {
      case "open":
        tasks = baseTasks.filter((t) => !t.completed);
        break;
      case "done":
        tasks = baseTasks.filter((t) => t.completed);
        break;
      case "due_soon": {
        const col = this._sourceCol(colIdx);
        const days = col.due_soon_days ?? 7;
        const hideOverdue = col.hide_overdue === true;
        tasks = baseTasks.filter((t) =>
          !t.completed && t.due_date &&
          ((!hideOverdue && this._isDueDateOverdue(t.due_date)) || this._isDueDateWithinDays(t.due_date, days))
        );
        break;
      }
      default:
        tasks = baseTasks;
    }
    if (cs.tagFilters.size > 0) {
      tasks = tasks.filter((t) => t.tags && t.tags.some((tag) => cs.tagFilters.has(tag)));
    }
    if (cs.personFilters.size > 0) {
      // A shared task shows under each of its assignees.
      tasks = tasks.filter((t) => _assignees(t).some((p) => cs.personFilters.has(p)));
    }
    const cmp = this._buildSortComparator(colIdx);
    // overdue_first (issue #57): open overdue tasks lead, oldest due date
    // first, whatever the chosen sort — the counterpart of completed tasks
    // sinking to the bottom.  "Overdue" is the card's usual meaning (due
    // date before today, like the red badge and the overdue sensor).
    const overdueFirst = this._sourceCol(colIdx)?.overdue_first === true;
    const overdue = (t) => overdueFirst && !t.completed && this._isDueDateOverdue(t.due_date);
    return tasks.slice().sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const oa = overdue(a), ob = overdue(b);
      if (oa !== ob) return oa ? -1 : 1;
      if (oa) {
        const da = a.due_date + "T" + (a.due_time || "00:00");
        const db = b.due_date + "T" + (b.due_time || "00:00");
        if (da !== db) return da < db ? -1 : 1;
      }
      return cmp(a, b);
    });
  }

  _buildSortComparator(colIdx) {
    const sortBy = this._columns[colIdx].sortBy;
    switch (sortBy) {
      case "due": return (a, b) => {
        const da = a.due_date ? a.due_date + "T" + (a.due_time || "00:00") : null;
        const db = b.due_date ? b.due_date + "T" + (b.due_time || "00:00") : null;
        if (da && db) return da < db ? -1 : da > db ? 1 : 0;
        return da ? -1 : db ? 1 : 0;
      };
      case "priority": return (a, b) => {
        const pa = a.priority ?? 0;
        const pb = b.priority ?? 0;
        return pb - pa;
      };
      case "title": return (a, b) =>
        (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      case "person": return (a, b) => {
        const pa = a.assigned_person || "\uffff";
        const pb = b.assigned_person || "\uffff";
        return pa.localeCompare(pb);
      };
      default: return (a, b) => a.sort_order - b.sort_order;
    }
  }

  // --- FLIP & Filter Animation Helpers ---

  _applyFlip(before, colIdx, duration = 0.3) {
    if (!before || before.size === 0) return;
    // Guard the FLIP window: a background re-render mid-animation would wipe the
    // transforms (intermittent missing animation). _render() defers while this
    // is set; endFlip() clears it and flushes any deferred render afterwards.
    this._flipActive = true;
    const endFlip = () => {
      this._flipActive = false;
      if (this._pendingRender) { this._pendingRender = false; this._render(); }
    };
    // _render() rebuilds the shadow DOM via root.innerHTML="", but ha-card (a LitElement)
    // commits its layout asynchronously. Reading getBoundingClientRect() synchronously
    // after _render() returns 0 for all elements. One rAF is enough for the browser to
    // flush the new layout before we measure positions.
    requestAnimationFrame(() => {
      // Pass 1: read ALL new positions first (relative to list top — no style writes yet)
      const taskListEl = this.shadowRoot.querySelector(`.task-list[data-col-idx="${colIdx}"], .tile-grid-wrap[data-col-idx="${colIdx}"]`);
      if (!taskListEl) { endFlip(); return; }
      const curRect = taskListEl.getBoundingClientRect();
      const newPositions = new Map(); // id → { top, left } relative to container
      const elMap = new Map();        // id → element (reused in Pass 2, avoids N re-queries)
      taskListEl.querySelectorAll(".task[data-task-id], .task-tile[data-task-id]")
        .forEach(el => {
          const id = el.dataset.taskId;
          if (id && before.has(id)) {
            const er = el.getBoundingClientRect();
            newPositions.set(id, { top: er.top - curRect.top, left: er.left - curRect.left });
            elMap.set(id, el);
          }
        });
      // Pass 2: apply transforms — 2D so grid tiles animate their real
      // (diagonal/horizontal) reflow, not just vertical movement.
      const flipEls = [];
      newPositions.forEach((np, id) => {
        const el = elMap.get(id);
        if (!el) return;
        const old = before.get(id);
        const dx = Math.round(old.left - np.left);
        const dy = Math.round(old.top - np.top);
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        flipEls.push(el);
      });
      if (flipEls.length === 0) { endFlip(); return; }
      flipEls[0].getBoundingClientRect(); // single reflow commits all start states
      requestAnimationFrame(() => {
        flipEls.forEach(el => {
          el.style.transition = `transform ${duration}s ease`;
          el.style.transform = "";
          el.addEventListener("transitionend", () => {
            el.style.transition = "";
            el.style.transform = "";
          }, { once: true });
        });
        setTimeout(endFlip, duration * 1000 + 50);
      });
    });
  }

  _captureListFlip(colIdx) {
    const listEl = this.shadowRoot.querySelector(`.task-list[data-col-idx="${colIdx}"], .tile-grid-wrap[data-col-idx="${colIdx}"]`);
    const before = new Map();
    if (!listEl) return before;
    // Cancel any in-progress FLIP transforms before reading — getBoundingClientRect()
    // includes CSS transforms in its result, so a partially-animated transform would
    // corrupt the snapshot and cause the next animation to overshoot.
    const tasks = listEl.querySelectorAll(".task[data-task-id], .task-tile[data-task-id]");
    tasks.forEach(el => {
      if (el.style.transform) { el.style.transition = "none"; el.style.transform = ""; }
    });
    // getBoundingClientRect() here both flushes any cleared transforms (forced layout)
    // and reads the reference top — one reflow serves both purposes.
    const r = listEl.getBoundingClientRect();
    tasks.forEach(el => {
      const er = el.getBoundingClientRect();
      before.set(el.dataset.taskId, { top: er.top - r.top, left: er.left - r.left });
    });
    return before;
  }

  // Slide a newly-added task in from the add-input position. Shared by list
  // rows (.task) and tiles (.task-tile) so both views animate identically.
  _animateTaskEntry(taskId, colIdx) {
    const inputRect = this._addInputRect;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const idEsc = CSS.escape(String(taskId));
        const el = this.shadowRoot.querySelector(
          `.task-list[data-col-idx="${colIdx}"] .task[data-task-id="${idEsc}"], ` +
          `.tile-grid-wrap[data-col-idx="${colIdx}"] .task-tile[data-task-id="${idEsc}"]`
        );
        if (!el) return;
        const taskTop = el.getBoundingClientRect().top;
        const originDy = inputRect ? (inputRect.bottom - taskTop) : -30;
        el.style.transition = "none";
        el.style.opacity = "0";
        el.style.transform = `translateY(${originDy}px)`;
        el.getBoundingClientRect(); // commit start state
        el.style.transition = "opacity 0.25s ease, transform 0.25s ease";
        el.style.opacity = "";
        el.style.transform = "";
        el.addEventListener("transitionend", () => { el.style.transition = ""; }, { once: true });
      });
    });
  }

  _animateFilterChange(colIdx, applyFilterFn) {
    if (this._filterAnimPending) {
      applyFilterFn();
      this._render();
      return;
    }
    const taskList = this.shadowRoot.querySelector(`.task-list[data-col-idx="${colIdx}"]`);
    if (!taskList) { applyFilterFn(); this._render(); return; }

    // Snapshot current visible tasks (clears ongoing transforms for accurate reading)
    const before = this._captureListFlip(colIdx);
    const currentIds = new Set(before.keys());

    // Apply filter change to compute future set
    applyFilterFn();
    const futureIds = new Set(this._filteredTasks(colIdx).map(t => String(t.id)));

    const disappearing = [...currentIds].filter(id => !futureIds.has(id));
    const appearing    = [...futureIds].filter(id => !currentIds.has(id));

    // Animate exit on disappearing tasks
    disappearing.forEach(id => {
      const el = taskList.querySelector(`.task[data-task-id="${CSS.escape(id)}"]`);
      if (el) el.classList.add("task-anim-exit");
    });

    const delay = disappearing.length > 0 ? 175 : 0;
    this._filterAnimPending = true;
    setTimeout(() => {
      this._filterAnimPending = false;
      this._justAppearedTaskIds = new Set(appearing);
      this._render();
      this._justAppearedTaskIds = null;
      this._applyFlip(before, colIdx, 0.25);
    }, delay);
  }

  _getSubTaskProgress(task) {
    if (!task.sub_items || task.sub_items.length === 0) return null;
    const done = task.sub_items.filter((s) => s.completed).length;
    return `${done}/${task.sub_items.length}`;
  }

  _isDueDateOverdue(dueDate) {
    if (!dueDate) return false;
    // dueDate is "YYYY-MM-DD" in the user's local timezone. Parse it as
    // local midnight rather than `new Date(dueDate)` which interprets
    // date-only strings as UTC midnight (causing wrong-day classification
    // for users west of UTC).
    const [y, m, d] = dueDate.split("-").map(Number);
    if (!y || !m || !d) return false;
    const due = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return due < today;
  }

  // Advance a Date by N days/weeks/months/years with month-end clamping:
  // Jan 31 + 1 month must be Feb 28, not Mar 3 (bare setMonth overflows
  // into the next month), and Feb 29 + 1 year must be Feb 28, not Mar 1.
  // "hours" (or any unknown unit) returns the date unchanged.
  _advanceDateClamped(from, unit, val) {
    const next = new Date(from);
    if (unit === "days") next.setDate(next.getDate() + val);
    else if (unit === "weeks") next.setDate(next.getDate() + val * 7);
    else if (unit === "months" || unit === "years") {
      const day = next.getDate();
      next.setDate(1); // avoid overflow while shifting month/year
      if (unit === "months") next.setMonth(next.getMonth() + val);
      else next.setFullYear(next.getFullYear() + val);
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(day, lastDay));
    }
    return next;
  }

  // In-card confirmation dialog. Browsers render window.confirm() as a
  // detached prompt at the top of the window — this renders a modal in the
  // card's own look instead (same shell as the media dialog). Resolves
  // true (confirm) / false (cancel, Esc, backdrop click). Lives in the
  // shadow root, so _render's overlay preservation keeps it open across a
  // background refresh.
  // Shared shell for the in-card modal dialogs (confirm, move): backdrop
  // click, Esc, the close-race guard, and the jsdom fallbacks live here
  // once. `body` nodes go between the message and the action row; `resolveOk`
  // computes the OK button's resolution value; every cancel path resolves
  // null.
  _modalDialog({ message, okLabel, body = [], resolveOk }) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "ht-confirm";
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        try { if (dialog.open) dialog.close(); } catch (_) { /* jsdom */ }
        dialog.remove();
        resolve(val);
      };
      const cancelBtn = this._el("button", { className: "ht-confirm-btn", textContent: this._t("dialog_cancel") });
      const okBtn = this._el("button", { className: "ht-confirm-btn primary", textContent: okLabel });
      cancelBtn.addEventListener("click", () => finish(null));
      okBtn.addEventListener("click", () => finish(resolveOk()));
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); }); // Esc
      dialog.addEventListener("close", () => finish(null));
      // The inner body carries the padding, so a click that lands on the
      // <dialog> itself can only come from the backdrop.
      dialog.addEventListener("click", (e) => { if (e.target === dialog) finish(null); });
      dialog.appendChild(this._el("div", { className: "ht-confirm-body" }, [
        this._el("div", { className: "ht-confirm-msg", textContent: message }),
        ...body,
        this._el("div", { className: "ht-confirm-actions" }, [cancelBtn, okBtn]),
      ]));
      this.shadowRoot.appendChild(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", ""); // test environments without <dialog> support
      try { okBtn.focus(); } catch (_) { /* best-effort */ }
    });
  }

  _confirmDialog(message, okLabel) {
    return this._modalDialog({ message, okLabel, resolveOk: () => true }).then((v) => !!v);
  }

  // Grow a textarea to fit its content (issue #32): reset to auto so it can
  // also shrink, then take the scroll height plus the border (the field is
  // box-sizing: border-box, scrollHeight excludes borders). The CSS
  // min-height still applies. If the user dragged the resize handle — the
  // browser then writes its own inline height that differs from ours — stop
  // auto-sizing that element so the manual size sticks.
  _autoGrowTextarea(el) {
    if (!el) return;
    if (el.style.height && el.dataset.autoH && el.style.height !== el.dataset.autoH) return;
    el.style.height = "auto";
    const border = Math.max(0, (el.offsetHeight || 0) - (el.clientHeight || 0));
    const h = el.scrollHeight + border;
    el.style.height = h + "px";
    el.dataset.autoH = h + "px";
  }

  // Format a Date as its *local* YYYY-MM-DD calendar date. Never use
  // toISOString() for this: it returns the UTC date, which differs from
  // the local date for several hours each day in any non-UTC timezone.
  _localDateStr(d) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  _isDueDateToday(dueDate) {
    if (!dueDate) return false;
    return dueDate === this._localDateStr(new Date());
  }

  _isDueDateWithinDays(dueDate, days) {
    if (!dueDate) return false;
    const [y, m, d] = dueDate.split("-").map(Number);
    if (!y || !m || !d) return false;
    const due = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const future = new Date(today);
    future.setDate(future.getDate() + days);
    future.setHours(23, 59, 59, 999);
    return due >= today && due <= future;
  }

  // ---- Locale helpers (issue #30) -----------------------------------
  // HA exposes the user's profile settings on hass.locale:
  //   language     UI language (falls back to hass.language)
  //   date_format  "language" | "system" | "DMY" | "MDY" | "YMD"
  //   time_format  "language" | "system" | "am_pm" | "24"
  // "system" is the only case where the browser locale is intentionally
  // used; everything else must follow the HA profile, not the browser.
  // Day of month for the recurrence badge: "24th" style suffixes. English
  // needs the real ordinal (1st, 2nd, 3rd, 11th-13th, 21st ...), Swedish
  // too (1:a, 2:a, 3:e, 11:e, 21:a), and French writes the first as 1er;
  // the other languages use one suffix for every day (24., 24º, 24e ...).
  // By the base language, so en-GB counts as English.
  _dayOrdinal(day) {
    const n = Number(day);
    if (Number.isInteger(n)) {
      const lang = this._localeCode().split("-")[0];
      const tens = n % 100;
      if (lang === "en") {
        const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
        return `${n}${suffix}`;
      }
      if (lang === "sv") return `${n}${(n % 10 === 1 || n % 10 === 2) && tens !== 11 && tens !== 12 ? ":a" : ":e"}`;
      if (lang === "fr" && n === 1) return "1er";
    }
    return `${day}${this._t("rec_dom_short")}`;
  }

  _localeCode() {
    const loc = this._hass?.locale;
    return (loc && loc.language) || this._hass?.language || "en";
  }

  // Format an absolute timestamp (Date) per the HA profile settings.
  // Mirrors HA frontend's format_date/format_time: the explicit numeric
  // date formats are produced by borrowing a locale that natively uses
  // that ordering (DMY -> en-GB, MDY -> en-US, YMD -> en-CA).
  _fmtTimestamp(ts) {
    const loc = this._hass?.locale || {};
    const lang = this._localeCode();
    const dateLang = { DMY: "en-GB", MDY: "en-US", YMD: "en-CA" }[loc.date_format]
      || (loc.date_format === "system" ? undefined : lang);
    const dateStr = ts.toLocaleDateString(dateLang, { day: "numeric", month: "numeric", year: "numeric" });
    const timeOpts = { hour: "numeric", minute: "2-digit" };
    if (loc.time_format === "am_pm") timeOpts.hour12 = true;
    else if (loc.time_format === "24") timeOpts.hour12 = false;
    const timeStr = ts.toLocaleTimeString(loc.time_format === "system" ? undefined : lang, timeOpts);
    return `${dateStr}, ${timeStr}`;
  }

  _formatDueDate(dueDate, dueTime) {
    if (!dueDate) return "";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(dueDate + "T00:00:00");
    const diffDays = Math.round((target - today) / 86400000);
    const lang = this._localeCode();

    // Near dates: relative labels
    if (diffDays >= -2 && diffDays <= 2) {
      if (diffDays === 0 && dueTime) {
        // Today with time: show relative hours/minutes
        const [h, m] = dueTime.split(":").map(Number);
        const dueMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime();
        const diffMs = dueMs - now.getTime();
        const absDiffMs = Math.abs(diffMs);
        const mins = Math.floor(absDiffMs / 60000);
        const hrs = Math.floor(mins / 60);
        const remMins = mins % 60;
        if (diffMs >= 0) {
          if (hrs > 0) return this._t("due_in_hours", hrs, remMins);
          if (mins > 0) return this._t("due_in_minutes", mins);
          return this._t("due_in_seconds");
        } else {
          if (hrs > 0) return this._t("due_ago_hours", hrs, remMins);
          if (mins > 0) return this._t("due_ago_minutes", mins);
          return this._t("due_ago_seconds");
        }
      }
      const relKey = { "-2": "due_day_before_yesterday", "-1": "due_yesterday", 0: "due_today", 1: "due_tomorrow", 2: "due_day_after_tomorrow" }[diffDays];
      return this._t(relKey);
    }

    // Further dates: "6. Apr" (de) / "Apr 6" (en-US) — day/month order
    // follows the HA profile language via Intl instead of a hardcoded
    // European "D. Mon" (issue #30).
    const opts = { day: "numeric", month: "short" };
    if (target.getFullYear() !== now.getFullYear()) opts.year = "2-digit";
    return target.toLocaleDateString(lang, opts);
  }

  // --- Render ---

  // Hold a render back until the focused field is left, then run it —
  // as a background render again when it was one (`background`).
  _deferRenderUntilBlur(el, background) {
    this._pendingRender = true;
    // Rebind when the field changed: a rebuild can replace the focused field
    // with a fresh copy, and not every browser fires blur on the removed one
    // — a listener left on it would never flush.
    if (this._deferredRenderBoundBlur === el) return;
    this._deferredRenderBoundBlur = el;
    el.addEventListener("blur", () => {
      if (this._deferredRenderBoundBlur === el) this._deferredRenderBoundBlur = null;
      const flush = () => {
        window.removeEventListener("pointerup", flush, true);
        window.removeEventListener("pointercancel", flush, true);
        setTimeout(run, 0);
      };
      const run = () => {
        if (!this._pendingRender) return;
        // A held-back background update stays one: if focus went straight
        // into another field that defers, it waits for that one too. The
        // user's own change (date, select) goes through right away.
        if (!background) { this._render(); return; }
        this._bgUpdates = (this._bgUpdates || 0) + 1;
        try { this._render(); } finally { this._bgUpdates = Math.max(0, this._bgUpdates - 1); }
      };
      // The timeout lets the field's own blur handling go first (the notes
      // switch back to their read view in one). If the blur came from
      // pressing a button, wait for the release as well — rebuilding
      // between press and release would drop the click.
      if (this._pointerIsDown) {
        window.addEventListener("pointerup", flush, true);
        window.addEventListener("pointercancel", flush, true);
      } else {
        flush();
      }
    }, { once: true });
  }

  _render() {
    // Don't tear down DOM while the user is interacting — but only for
    // background updates (polling, state changes). User-initiated renders
    // (clicks, edits, saves) must always go through.
    // Counter, not a boolean: several background loaders (state watcher,
    // external poll, lists retry) can overlap, and one finishing must not
    // reclassify the others\u2019 still-running loads as foreground.
    if (this._bgUpdates > 0) {
      // A FLIP animation is mid-flight — rebuilding now would wipe the in-flight
      // transforms (intermittent missing animation). Defer; _applyFlip flushes.
      if (this._flipActive) { this._pendingRender = true; return; }
      if (this._draggedTaskId !== null || this._draggedSubTaskId !== null
          || this._editingTaskId || this._editingSubTaskId || this._planNoteEditing) {
        this._pendingRender = true;
        return;
      }
      // Only defer for inputs that lose internal state on a DOM rebuild
      // (date/time pickers, open <select>). Text/textarea rebuild fine —
      // focus + caret are restored from focusSnap — so a background update
      // (e.g. the user's own add, which fires a store event) must not be
      // swallowed here, or the initiating card never reflects the change.
      const active = this.shadowRoot?.activeElement;
      const activeStateful = active && (
        (active.tagName === "INPUT" &&
          ["date", "time", "datetime-local", "month", "week"].includes(active.type)) ||
        active.tagName === "SELECT"
      );
      // The notes are typed into while their own auto-save fires store
      // events. Rebuilding under them restores the caret, but on iOS the
      // blur + refocus closes and reopens the keyboard on every save — so
      // wait until the user leaves the field. (Only the notes: other task
      // fields save on Enter/change, not while typing, and some — the tag
      // input — hold the task object the reload is about to replace.)
      const activeNotes = active && active.tagName === "TEXTAREA"
        && active.dataset?.focusKey === "notes";
      if (activeStateful || activeNotes) {
        this._deferRenderUntilBlur(active, true);
        return;
      }
    }

    // Foreground-render guard:
    //   - <input type="date|time|...">: internal segments (day/month/year,
    //     hour/minute) reset to the first segment on any DOM rebuild
    //     because these inputs have no selectionStart API.
    //   - <select>: loses its open dropdown state on DOM rebuild, so
    //     picking an option while a background save is in flight would
    //     snap the menu closed.
    // In both cases the render is deferred until blur (the user leaves
    // the field or picks an option).  Other inputs (text, number, radio,
    // checkbox) MUST rebuild immediately — the tag autocomplete relies on
    // a synchronous render to insert the new chip while the input is
    // still focused.
    const activeNow = this.shadowRoot?.activeElement;
    const isStatefulInput = activeNow && (
      (activeNow.tagName === "INPUT" &&
        ["date", "time", "datetime-local", "month", "week"].includes(activeNow.type)) ||
      activeNow.tagName === "SELECT"
    );
    if (isStatefulInput) {
      this._deferRenderUntilBlur(activeNow, false);
      return;
    }
    this._pendingRender = false;

    // Snapshot focus before tearing down the DOM so we can restore it
    // after the rebuild.  A focused input marked with data-focus-key is
    // re-queried by (taskId, key) once the new DOM is in place — this
    // keeps the user's caret put when a save during editing triggers a
    // foreground re-render (e.g. toggling the recurrence switch while
    // the cursor is already in a time/date field).
    let focusSnap = null;
    const activeForSnap = this.shadowRoot?.activeElement;
    if (activeForSnap && activeForSnap.dataset && activeForSnap.dataset.focusKey) {
      const taskEl = activeForSnap.closest?.("[data-task-id]");
      focusSnap = {
        taskId: taskEl?.dataset?.taskId ?? null,
        key: activeForSnap.dataset.focusKey,
        selStart: activeForSnap.selectionStart ?? null,
        selEnd: activeForSnap.selectionEnd ?? null,
      };
    }

    // Remove any stale sort close handler before rebuilding DOM
    if (this._sortCloseHandler) {
      document.removeEventListener("click", this._sortCloseHandler);
      this._sortCloseHandler = null;
    }

    const root = this.shadowRoot;
    // Rebuild only what this card owns. Long-lived nodes that other code put
    // into the shadow root stay in place, untouched: an open modal <dialog>
    // (confirm prompt, media picker — detaching a modal dialog drops it out of
    // the top layer and showModal() can't re-open it), the tile detail sheet
    // + backdrop, card-mod's <card-mod> node (issue #31/#34) and error
    // toasts. Everything else (ha-card, drag clones) is removed and rebuilt;
    // the <style> element is reused.
    const KEEP = ".task-detail-backdrop, .task-detail-sheet, dialog, card-mod, .toast-error";
    this._clearTileLp(); // a rebuild removes the pressed tile → cancel its long-press
    for (const child of [...root.children]) {
      if (child === this._styleEl) continue;
      if (child.matches && child.matches(KEEP)) continue;
      child.remove();
    }
    // Stash for use after the rebuild
    this._pendingFocusRestore = focusSnap;
    this._updateFitRows();

    if (!this._styleEl) {
      this._styleEl = document.createElement("style");
      this._styleEl.textContent = this._getStyles();
    }
    if (!this._styleEl.isConnected) root.insertBefore(this._styleEl, root.firstChild);

    const card = this._el("ha-card", {}, [
      this._buildCardContent(),
    ]);
    // Right after the style, i.e. before any kept overlay, so the sheet /
    // backdrop / dialogs keep painting above the card (DOM order).
    root.insertBefore(card, this._styleEl.nextSibling);

    // Restore focus to the element that had it before the DOM rebuild,
    // if it still exists in the new tree.  Fields tagged with
    // data-focus-key are identified by (task-id, focus-key); caret
    // position is restored when the element supports selection ranges.
    //
    // Defer via rAF: right after root.appendChild(card) the browser has
    // not yet done layout, so the target's offsetHeight is still 0 and
    // Chrome refuses to focus invisible elements.  Waiting two frames
    // lets CSS transitions settle and makes the focus call stick.
    const fs = this._pendingFocusRestore;
    this._pendingFocusRestore = null;
    if (fs && fs.key) {
      const selector = fs.taskId
        ? `[data-task-id="${CSS.escape(String(fs.taskId))}"] [data-focus-key="${fs.key}"]`
        : `[data-focus-key="${fs.key}"]`;
      const restore = () => {
        const target = root.querySelector(selector);
        if (target && typeof target.focus === "function") {
          target.focus();
          if (fs.selStart != null && typeof target.setSelectionRange === "function") {
            try { target.setSelectionRange(fs.selStart, fs.selEnd ?? fs.selStart); } catch { /* noop */ }
          }
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(restore));
    }

    // Close any open sort dropdowns on next outside click
    if (this._columns.some(c => c.sortOpen)) {
      this._sortCloseHandler = () => {
        this._sortCloseHandler = null;
        this._columns.forEach(c => { c.sortOpen = false; });
        this._render();
      };
      setTimeout(() => document.addEventListener("click", this._sortCloseHandler, { once: true }), 0);
    }
  }

  // The trimmed search query in effect for a column — "" when nothing is
  // typed or the column opted out via show_task_search: false.
  _activeSearchQuery(colIdx) {
    const col = this._sourceCol(colIdx);
    if (!col || col.show_task_search === false) return "";
    return (this._columns[colIdx]?.taskSearchQuery || "").trim();
  }

  // Derive the small WebP thumbnail URL for one of our public images
  // (/local/home_tasks/<base>.<ext> -> <base>_thumb.webp). Other URLs unchanged.
  _thumbUrl(url) {
    if (!url) return url;
    const i = url.indexOf("?");
    const path = i === -1 ? url : url.slice(0, i);
    const q = i === -1 ? "" : url.slice(i);
    if (!path.startsWith("/local/home_tasks/")) return url;
    return path.replace(/\.[^/.]+$/, "") + "_thumb.webp" + q;
  }

  _buildTaskTile(task, colIdx) {
    const col = this._sourceCol(colIdx);
    const showImages = col.show_images === true;
    const thumbUrl = showImages ? (task.image_url || null) : null;

    const cls = [
      "task-tile",
      task.completed ? "completed" : "",
      thumbUrl ? "has-image" : "",
    ].filter(Boolean).join(" ");

    const tile = this._el("div", { className: cls, "data-task-id": String(task.id), draggable: true });

    // Background image (only when show_images is enabled)
    if (thumbUrl) {
      const small = this._thumbUrl(thumbUrl);
      const img = this._el("img", { className: "tile-bg", src: small, alt: "", draggable: false });
      // Fall back to the full image if the thumbnail isn't available yet.
      if (small !== thumbUrl) img.addEventListener("error", () => { img.src = thumbUrl; }, { once: true });
      tile.appendChild(img);
    } else {
      // Placeholder: first letter on gradient background
      const placeholder = this._el("div", {
        className: "tile-placeholder",
        textContent: (task.title || "?").charAt(0).toUpperCase(),
      });
      tile.appendChild(placeholder);
    }

    // Bottom overlay: title (optional) + done badge
    const showTitle = col.show_tile_title !== false;
    if (showTitle || task.completed) {
      const overlay = this._el("div", { className: "tile-overlay" });
      if (showTitle) {
        const titleEl = this._el("div", { className: "tile-title", textContent: task.title || "" });
        overlay.appendChild(titleEl);
      }
      if (task.completed) {
        const badge = this._el("div", { className: "tile-done-badge", textContent: "✓" });
        overlay.appendChild(badge);
      }
      tile.appendChild(overlay);
    }

    // Gestures — same mechanism as list rows so both views feel identical.
    //  • click / tap (no move) → toggle complete
    //  • hold in place         → open detail sheet (500 ms)
    //  • drag                  → reorder. Desktop = native HTML5 drag (the
    //    browser ghost follows the cursor); touch = a clone that follows the
    //    finger. Displaced tiles animate to their new slot via FLIP
    //    (_liveMoveTile). Touch arms on a 400 ms hold so a swipe still scrolls.

    // --- Mouse (pointer events for click/hold; HTML5 drag for the move) ---
    let _mDown = null, _mDetail = false, _mDrag = false;
    tile.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      _mDown = { x: e.clientX, y: e.clientY }; _mDetail = false; _mDrag = false;
      this._clearTileLp();
      this._tileLpTimer = setTimeout(() => { this._tileLpTimer = null; _mDetail = true; this._openTaskDetailSheet(task, colIdx); }, 500);
    });
    tile.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse" || !_mDown) return;
      if (this._tileLpTimer && (Math.abs(e.clientX - _mDown.x) > 6 || Math.abs(e.clientY - _mDown.y) > 6)) this._clearTileLp();
    });
    tile.addEventListener("pointerup", () => { this._clearTileLp(); _mDown = null; });
    tile.addEventListener("click", () => {
      if (_mDetail || _mDrag) { _mDetail = false; _mDrag = false; return; }
      this._toggleTask(task.id, task.completed, colIdx);
    });
    tile.addEventListener("dragstart", (e) => {
      this._clearTileLp();
      _mDrag = true;
      this._draggedTileId = task.id;
      this._draggedTileCol = colIdx;
      this._dragPrevX = null; this._dragPrevY = null;
      try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
      tile.classList.add("dragging");
    });
    tile.addEventListener("dragend", () => this._finishTileDrag(colIdx));
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
      if (this._draggedTileId == null || this._draggedTileCol !== colIdx || String(this._draggedTileId) === String(task.id)) return;
      const draggedEl = tile.parentNode.querySelector(`.task-tile[data-task-id="${CSS.escape(String(this._draggedTileId))}"]`);
      this._liveMoveTile(draggedEl, tile, e.clientX, e.clientY);
    });
    tile.addEventListener("drop", (e) => { e.preventDefault(); this._finishTileDrag(colIdx); });

    // --- Touch (tap = complete; 400 ms hold arms drag; clone follows finger) ---
    let _t = null;
    tile.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      _t = { x: e.touches[0].clientX, y: e.touches[0].clientY, armed: false, dragging: false };
      this._clearTileLp();
      this._tileLpTimer = setTimeout(() => { this._tileLpTimer = null; if (_t) { _t.armed = true; tile.classList.add("armed"); } }, 400);
    }, { passive: true });
    tile.addEventListener("touchmove", (e) => {
      const tt = e.touches[0];
      if (!tt || !_t) return;
      if (!_t.armed) {
        if (Math.abs(tt.clientX - _t.x) > 8 || Math.abs(tt.clientY - _t.y) > 8) { this._clearTileLp(); _t = null; }
        return;
      }
      e.preventDefault();
      if (!_t.dragging) { _t.dragging = true; tile.classList.remove("armed"); this._startTileTouchDrag(tile, colIdx, tt.clientX, tt.clientY); }
      this._moveTileTouchDrag(tt.clientX, tt.clientY);
    }, { passive: false });
    const _tEnd = () => {
      this._clearTileLp();
      if (_t && _t.dragging) this._finishTileDrag(colIdx);
      else if (_t && _t.armed) { tile.classList.remove("armed"); this._openTaskDetailSheet(task, colIdx); }
      else if (_t) this._toggleTask(task.id, task.completed, colIdx);
      _t = null;
    };
    tile.addEventListener("touchend", _tEnd);
    tile.addEventListener("touchcancel", _tEnd);

    // Same creation animation as list rows.
    if (this._justAddedTaskId && this._justAddedTaskId === String(task.id)) {
      this._animateTaskEntry(task.id, colIdx);
    }

    return tile;
  }

  // Live-reorder during a tile drag. Whole-tile catch + direction gate: hovering
  // a tile takes over its slot, but only in the pointer's travel direction; the
  // displaced tiles then FLIP (translate x+y) to their new grid slots.
  _liveMoveTile(draggedEl, targetEl, clientX, clientY) {
    if (!draggedEl || !targetEl || draggedEl === targetEl) return;
    const grid = targetEl.parentNode;
    if (!grid) return;
    // Direction of travel since the last event. dragover/touchmove keep firing
    // even when the pointer is still (and an in-flight FLIP shifts tiles under
    // it), so "no movement" must mean "no change" — that is what stops the two
    // tiles from flickering back and forth on their own.
    const mx = clientX - (this._dragPrevX == null ? clientX : this._dragPrevX);
    const my = clientY - (this._dragPrevY == null ? clientY : this._dragPrevY);
    this._dragPrevX = clientX;
    this._dragPrevY = clientY;
    if (Math.abs(mx) <= 1 && Math.abs(my) <= 1) return; // sub-pixel/idle: treat as no movement
    // Whole-tile catch + direction gate: hovering anywhere on a tile takes over
    // its slot, but only reorder in the direction the pointer is actually
    // travelling (vertical weighted higher since it changes the whole row). This
    // gives the full-tile catch, lets you push a tile back the way it came, and
    // stops diagonal / row-change flicker — a swap and its reverse can't both
    // fire while the pointer moves one way.
    const all = [...grid.querySelectorAll(".task-tile")];
    const draggedBefore = all.indexOf(draggedEl) < all.indexOf(targetEl);
    if (draggedBefore !== ((my * 2 + mx) > 0)) return;
    const ref = draggedBefore ? targetEl.nextSibling : targetEl;
    if (ref === draggedEl || draggedEl.nextSibling === ref) return; // already there
    const siblings = [...grid.querySelectorAll(".task-tile:not(.dragging)")];
    const before = new Map(siblings.map(el => [el, el.getBoundingClientRect()]));
    grid.insertBefore(draggedEl, ref);
    siblings.forEach(el => {
      const b = before.get(el);
      const now = el.getBoundingClientRect();
      const dx = (b ? b.left : now.left) - now.left;
      const dy = (b ? b.top : now.top) - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        el.style.transition = "transform 0.18s ease";
        el.style.transform = "";
        el.addEventListener("transitionend", () => { el.style.transition = ""; el.style.transform = ""; }, { once: true });
      });
    });
  }

  // Touch drag: a clone follows the finger while the real tile (dimmed) is
  // reordered in place — same approach as the list's row touch drag.
  _startTileTouchDrag(tile, colIdx, clientX, clientY) {
    this._draggedTileId = tile.dataset.taskId;
    this._draggedTileCol = colIdx;
    this._dragPrevX = null; this._dragPrevY = null;
    tile.classList.add("dragging");
    const rect = tile.getBoundingClientRect();
    const clone = tile.cloneNode(true);
    clone.classList.remove("dragging");
    clone.classList.add("drag-clone");
    clone.style.cssText = `position:fixed; top:${rect.top}px; left:${rect.left}px; width:${rect.width}px; height:${rect.height}px; z-index:1000; opacity:0.92; pointer-events:none; margin:0; box-shadow:0 10px 26px rgba(0,0,0,0.4);`;
    this.shadowRoot.appendChild(clone);
    this._tileClone = clone;
    this._tileCloneOffX = clientX - rect.left;
    this._tileCloneOffY = clientY - rect.top;
  }

  _moveTileTouchDrag(clientX, clientY) {
    if (this._tileClone) {
      this._tileClone.style.left = `${clientX - this._tileCloneOffX}px`;
      this._tileClone.style.top = `${clientY - this._tileCloneOffY}px`;
      this._tileClone.style.display = "none";
    }
    const el = this.shadowRoot.elementFromPoint(clientX, clientY);
    if (this._tileClone) this._tileClone.style.display = "";
    const target = el ? el.closest(".task-tile") : null;
    if (target && target.dataset.taskId && target.dataset.taskId !== String(this._draggedTileId) && !target.classList.contains("drag-clone")) {
      const draggedEl = this.shadowRoot.querySelector(`.task-tile[data-task-id="${CSS.escape(String(this._draggedTileId))}"]`);
      this._liveMoveTile(draggedEl, target, clientX, clientY);
    }
  }

  _finishTileDrag(colIdx) {
    const draggedId = this._draggedTileId;
    this._draggedTileId = null;
    this._draggedTileCol = null;
    if (this._tileClone) { this._tileClone.remove(); this._tileClone = null; }
    this.shadowRoot.querySelectorAll(".task-tile.dragging").forEach(el => el.classList.remove("dragging"));
    if (draggedId == null) return;
    const grid = this.shadowRoot.querySelector(`.tile-grid-wrap[data-col-idx="${colIdx}"] .tile-grid-inner`);
    if (!grid) return;
    const order = [...grid.querySelectorAll(".task-tile[data-task-id]")].map(el => el.dataset.taskId);
    // Merge back tasks hidden by a filter (person/tag chips) so they keep their
    // relative position — otherwise reorder_tasks renumbers only the visible
    // subset and the hidden tasks' sort_order collides (same as the list path).
    if (order.length > 1) this._reorderTasks(this._mergeHiddenTasks(colIdx, order, draggedId), colIdx);
  }

  // Cancel a pending tile long-press (detail) timer. Centralised so a re-render
  // (e.g. from a rapid complete/uncomplete) reliably clears it — otherwise the
  // pressed tile gets replaced, its pointerup never fires, and the timer would
  // pop the detail sheet open.
  _clearTileLp() {
    if (this._tileLpTimer) { clearTimeout(this._tileLpTimer); this._tileLpTimer = null; }
  }

  // Remove the detail sheet + backdrop immediately (no slide-out). Used by the
  // action buttons and before opening a new sheet; the animated dismissal is the
  // close() closure inside _openTaskDetailSheet.
  _closeTaskDetailSheet() {
    this.shadowRoot.querySelector(".task-detail-sheet")?.remove();
    this.shadowRoot.querySelector(".task-detail-backdrop")?.remove();
  }

  _openTaskDetailSheet(task, colIdx) {
    this._closeTaskDetailSheet();

    const backdrop = this._el("div", { className: "task-detail-backdrop" });
    const sheet = this._el("div", { className: "task-detail-sheet" });
    // Match the sheet width/position to the card itself rather than spanning
    // the full viewport width.
    const cardRect = this.getBoundingClientRect();
    if (cardRect.width) {
      sheet.style.left = `${Math.round(cardRect.left)}px`;
      sheet.style.right = "auto";
      sheet.style.width = `${Math.round(cardRect.width)}px`;
    }

    const close = () => {
      sheet.classList.remove("open");
      sheet.addEventListener("transitionend", () => { sheet.remove(); backdrop.remove(); }, { once: true });
      setTimeout(() => { sheet.remove(); backdrop.remove(); }, 350);
    };

    backdrop.addEventListener("click", close);

    const handle = this._el("div", { className: "sheet-handle" });
    const titleEl = this._el("input", { className: "sheet-title", type: "text", value: task.title });
    titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } });
    titleEl.addEventListener("change", () => {
      const v = titleEl.value.trim();
      if (v && v !== task.title) this._updateTaskTitle(task.id, v, colIdx);
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "sheet-close";
    const closeIco = document.createElement("ha-icon");
    closeIco.setAttribute("icon", "mdi:close");
    closeIco.style.cssText = "--mdc-icon-size:20px;";
    closeBtn.appendChild(closeIco);
    closeBtn.addEventListener("click", close);
    const header = this._el("div", { className: "sheet-header" }, [titleEl, closeBtn]);

    const body = this._el("div", { className: "sheet-body" });
    body.appendChild(this._buildTaskDetails(task, colIdx));

    sheet.append(handle, header, body);
    this.shadowRoot.append(backdrop, sheet);
    requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add("open")));
  }

  _columnStorageKey(colIdx) {
    const col = this._sourceCol(colIdx) || {};
    return col.list_id || col.entity_id || `col_${colIdx}`;
  }

  _buildTaskContentChildren(task, colIdx, isEditing) {
    const children = [];
    // Show the title as a bordered text field whenever the task is expanded (not
    // only on the hidden double-click) so users can see the title is editable —
    // matching the other detail input fields.
    if (isEditing || this._expandedTasks.has(task.id)) {
      const editInput = this._el("input", {
        type: "text",
        className: "edit-title-input",
        value: task.title,
        "data-focus-key": "task_title",
      });
      // Stop mousedown from reaching the draggable taskEl — otherwise the browser's
      // drag-detection system intercepts mousedown and prevents cursor positioning.
      editInput.addEventListener("mousedown", (e) => { e.stopPropagation(); });
      // Mark as actively editing on focus so a background re-render defers — else
      // a poll mid-typing would rebuild this text input and revert the title.
      editInput.addEventListener("focus", () => { this._editingTaskId = task.id; });
      const saveTitle = () => {
        this._editingTaskId = null;
        const v = editInput.value.trim();
        if (v && v !== task.title) this._updateTaskTitle(task.id, v, colIdx);
        else if (!v) editInput.value = task.title;  // never store a blank title
      };
      editInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); saveTitle(); editInput.blur(); }
        else if (e.key === "Escape") { this._editingTaskId = null; editInput.value = task.title; editInput.blur(); }
      });
      editInput.addEventListener("blur", saveTitle);
      children.push(editInput);
      // Only grab focus for the explicit double-click edit, not on plain expand.
      if (isEditing) setTimeout(() => { editInput.focus(); editInput.select(); }, 0);
    } else {
      const titleSpan = this._el("span", { className: "task-title", textContent: task.title });
      // With tap_to_complete the first click of a double-click already ticks
      // the task off; the title is edited from the expanded details instead.
      if (this._sourceCol(colIdx)?.tap_to_complete !== true) titleSpan.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this._expandedTasks.add(task.id);
        this._editingTaskId = task.id;
        this._render();
      });
      children.push(titleSpan);
    }
    return children;
  }

  _buildTaskExpandButton(isExpanded) {
    const expandBtn = this._el("button", { className: "expand-btn" + (isExpanded ? " expanded" : "") });
    const expandIcon = document.createElement("ha-icon");
    expandIcon.setAttribute("icon", "mdi:chevron-down");
    expandBtn.appendChild(expandIcon);
    return expandBtn;
  }

  _buildTaskMetaBadges(task, col, cs, colIdx) {
    const meta = [];
    // Each chip needs BOTH switches (issue #45): the feature switch
    // ("Task features" section, also gates the detail editor) and its
    // display switch ("Display" section). Both default to on, so hiding a
    // chip no longer requires disabling the feature itself.
    if (task.priority && col.show_priority !== false && col.badge_priority !== false) {
      meta.push(this._buildPriorityBadge(task));
    }
    const subProgress = this._getSubTaskProgress(task);
    if (subProgress && _detailFieldOn(col, "sub_tasks") && col.badge_progress !== false) {
      meta.push(this._el("span", { className: "sub-badge", textContent: subProgress }));
    }
    if (task.due_date && col.show_due_date !== false && col.badge_due !== false) {
      meta.push(this._buildDueDateBadge(task));
    }
    if (task.recurrence_enabled && col.show_recurrence !== false && col.badge_recurrence !== false) {
      const badge = this._buildRecurrenceBadge(task);
      if (badge) meta.push(badge);
    }
    if ((task.assigned_person || task.assigned_name) && col.show_assigned_person !== false
        && this._personMode(colIdx, "badge") !== "off") {
      const people = _assignees(task);
      if (people.length) for (const eid of people) meta.push(this._buildAssignedPersonBadge(task, cs, colIdx, eid));
      else meta.push(this._buildAssignedPersonBadge(task, cs, colIdx));
    }
    if (task.tags && task.tags.length > 0 && col.show_tags !== false && col.badge_tags !== false) {
      for (const tag of task.tags) {
        meta.push(this._buildTagBadge(tag, cs, colIdx));
      }
    }
    if (task.reminders && task.reminders.length > 0 && col.show_reminders !== false && col.badge_reminders !== false) {
      meta.push(this._buildReminderBadge(task));
    }
    return meta;
  }

  _priorityLabel(priority) {
    return { 1: this._t("pri_low"), 2: this._t("pri_medium"), 3: this._t("pri_high") }[priority];
  }

  _buildPriorityBadge(task) {
    const priClass = { 1: "pri-low", 2: "pri-medium", 3: "pri-high" };
    return this._el("span", {
      className: `priority-badge ${priClass[task.priority] || ""}`,
      textContent: this._priorityLabel(task.priority),
    });
  }

  _buildDueDateBadge(task) {
    let dueCls = "due-date";
    if (this._isDueDateOverdue(task.due_date)) dueCls += " overdue";
    else if (this._isDueDateToday(task.due_date)) dueCls += " today";
    return this._el("span", {
      className: dueCls,
      textContent: this._formatDueDate(task.due_date, task.due_time),
    });
  }

  _buildRecurrenceBadge(task) {
    let recLabel = null;
    const unit = task.recurrence_unit;
    const val = task.recurrence_value || 1;
    const unitLabels = { hours: this._t("rec_short_h"), days: this._t("rec_short_d"), weeks: this._t("rec_short_w"), months: this._t("rec_short_m"), years: this._t("rec_short_y") };
    const singleLabels = { hours: this._t("rec_hourly"), days: this._t("rec_daily"), weeks: this._t("rec_weekly"), months: this._t("rec_monthly"), years: this._t("rec_yearly") };

    if (task.recurrence_type === "weekdays" && task.recurrence_weekdays && task.recurrence_weekdays.length) {
      // Legacy mode (pre-migration): show weekdays.
      recLabel = task.recurrence_weekdays.map(d => this._t(`rec_wd_${d}`)).join(" ");
    } else if (unit === "weeks" && task.recurrence_weekdays && task.recurrence_weekdays.length) {
      // Weekly with weekday filter — "Mo Mi" or "alle 2 Wo: Mo Mi".
      const days = task.recurrence_weekdays.map(d => this._t(`rec_wd_${d}`)).join(" ");
      recLabel = val === 1 ? days : `${val} ${unitLabels.weeks} ${days}`;
    } else if (unit === "months" && task.recurrence_month_pattern === "day_of_month" && task.recurrence_day_of_month != null) {
      const dom = task.recurrence_day_of_month;
      const dayPart = dom === "last" ? this._t("rec_last_short") : this._dayOrdinal(dom);
      recLabel = val === 1 ? dayPart : `${dayPart} \u00b7 ${val} ${unitLabels.months}`;
    } else if (unit === "months" && task.recurrence_month_pattern === "nth_weekday" && task.recurrence_nth_week != null && task.recurrence_weekdays && task.recurrence_weekdays.length) {
      const nth = task.recurrence_nth_week;
      const wdShort = this._t(`rec_wd_${task.recurrence_weekdays[0]}`);
      const nthLbl = nth === "last" ? this._t("rec_last_short") : `${nth}.`;
      const head = `${nthLbl} ${wdShort}`;
      recLabel = val === 1 ? head : `${head} \u00b7 ${val} ${unitLabels.months}`;
    } else if (unit === "years" && task.recurrence_anniversary && /^\d{2}-\d{2}$/.test(task.recurrence_anniversary)) {
      const m = task.recurrence_anniversary.slice(0, 2);
      const d = task.recurrence_anniversary.slice(3, 5);
      const head = `${parseInt(d, 10)}.${parseInt(m, 10)}.`;
      recLabel = val === 1 ? head : `${head} \u00b7 ${val} ${unitLabels.years}`;
    } else if (unit) {
      recLabel = val === 1 ? singleLabels[unit] : `${val} ${unitLabels[unit] || unit}`;
    }
    // Fallback for complex Todoist recurrence patterns
    if (!recLabel && task._todoist_recurrence_string) {
      recLabel = task._todoist_recurrence_string;
    }
    if (!recLabel) return null;
    let badgeText = "\u21BB " + recLabel;
    if (task.recurrence_end_type === "count" && task.recurrence_remaining_count != null) {
      badgeText += " \u00b7 " + this._t("rec_remaining", task.recurrence_remaining_count);
    }
    return this._el("span", { className: "recurrence-badge", textContent: badgeText });
  }

  // Only Home Assistant's own person picture is ever shown. entity_picture
  // may hold whatever the person's config puts there; an absolute URL points
  // at a host we do not control, so it is treated like no picture at all.
  // HA serves uploaded pictures at 256 and 512 only (image_upload's
  // VALID_SIZES) - the small one is plenty for an 18px circle.
  _personPictureUrl(entityId) {
    const url = this._hass?.states?.[entityId]?.attributes?.entity_picture;
    if (typeof url !== "string" || !url.startsWith("/")) return null;
    // Only the size that image_upload itself serves is swapped. A picture
    // that merely has "512x512" somewhere in its path (a folder named after
    // a size, say) would turn into a URL that does not exist.
    if (!url.startsWith("/api/image/serve/")) return url;
    return url.replace("/512x512", "/256x256");
  }

  // `which` is "badge" (in the task row) or "filter" (the row above it).
  // Configs written before the dropdown existed are read through their old
  // keys, so an update changes nothing on screen.
  _personMode(colIdx, which) {
    const col = this._sourceCol(colIdx) || {};
    const chosen = which === "badge" ? col.person_badge : col.person_filter;
    if (PERSON_MODES.includes(chosen)) return chosen;
    const chipOn = which === "badge" ? col.badge_person !== false : col.show_person_chips !== false;
    const picture = col.show_person_avatar === true;
    if (!chipOn) return picture ? "picture" : "off";
    return picture ? "both" : "name";
  }

  _personInitials(name) {
    // The first *letter* of a word: display names are not always plain
    // first-and-last, and "Unknown (Alice)" must not put a bracket in the
    // circle. Words without a letter or digit drop out entirely.
    const letters = String(name || "")
      .trim()
      .split(/\s+/)
      .map((w) => (w.match(/[\p{L}\p{N}]/u) || [""])[0])
      .filter(Boolean);
    if (!letters.length) return "?";
    const last = letters.length > 1 ? letters[letters.length - 1] : "";
    return (letters[0] + last).toUpperCase();
  }

  _personColor(key) {
    const s = String(key || "");
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return PERSON_COLORS[Math.abs(hash) % PERSON_COLORS.length];
  }

  _buildInitialsAvatar(key, name) {
    const el = this._el("span", {
      className: "person-avatar initials",
      textContent: this._personInitials(name),
    });
    el.style.background = this._personColor(key);
    return el;
  }

  // A picture when the person has one, initials otherwise (issue #48).
  _buildPersonAvatar(entityId, name) {
    const url = this._personPictureUrl(entityId);
    if (!url) return this._buildInitialsAvatar(entityId || name, name);
    const img = this._el("img", { className: "person-avatar", src: url, alt: "" });
    // A picture that has gone missing must not leave a hole in the row.
    img.addEventListener(
      "error",
      () => img.replaceWith(this._buildInitialsAvatar(entityId || name, name)),
      { once: true },
    );
    return img;
  }

  _buildAssignedPersonBadge(task, cs, colIdx, eid = task.assigned_person) {
    let personName;
    if (eid && this._hass && this._hass.states && this._hass.states[eid]) {
      const attrs = this._hass.states[eid].attributes;
      personName = (attrs && attrs.friendly_name) || eid;
    } else if (task.assigned_name) {
      // Todoist collaborator with no HA person match
      personName = this._t("assigned_unknown").replace("%s", task.assigned_name);
    } else {
      personName = eid;
    }
    const isActivePerson = cs.personFilters.has(eid);
    const mode = this._personMode(colIdx, "badge");
    const withAvatar = mode === "picture" || mode === "both";
    const avatarOnly = mode === "picture";
    const assignedBadge = this._el("span", {
      className: "assigned-badge" + (isActivePerson ? " active" : "") + (withAvatar ? " with-avatar" : "")
        + (avatarOnly ? " avatar-only" : ""),
      "data-eid": eid,
      title: personName,
    });
    if (avatarOnly) {
      assignedBadge.appendChild(this._buildPersonAvatar(eid, personName));
    } else if (withAvatar) {
      assignedBadge.append(
        this._buildPersonAvatar(eid, personName),
        this._el("span", { textContent: personName }),
      );
    } else {
      assignedBadge.textContent = "\uD83D\uDC64 " + personName;
    }
    assignedBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      this._animateFilterChange(colIdx, () => {
        if (cs.personFilters.has(eid)) cs.personFilters.delete(eid);
        else cs.personFilters.add(eid);
      });
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.shadowRoot.querySelectorAll(`.assigned-badge[data-eid="${CSS.escape(eid)}"]`)
              .forEach(b => { b.classList.add("chip-anim"); b.addEventListener("animationend", () => b.classList.remove("chip-anim"), { once: true }); });
          });
        });
      }, 0);
    });
    return assignedBadge;
  }

  _buildTagBadge(tag, cs, colIdx) {
    const isActive = cs.tagFilters.has(tag);
    const tagBadge = this._el("span", {
      className: "tag-badge" + (isActive ? " active" : ""),
      textContent: "#" + tag,
      "data-tag": tag,
    });
    tagBadge.addEventListener("click", (e) => {
      e.stopPropagation();
      this._animateFilterChange(colIdx, () => {
        if (cs.tagFilters.has(tag)) cs.tagFilters.delete(tag);
        else cs.tagFilters.add(tag);
      });
      setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this.shadowRoot.querySelectorAll(`.tag-badge[data-tag="${CSS.escape(tag)}"]`)
              .forEach(b => { b.classList.add("chip-anim"); b.addEventListener("animationend", () => b.classList.remove("chip-anim"), { once: true }); });
          });
        });
      }, 0);
    });
    return tagBadge;
  }

  // A reminder offset (minutes before due) as its label, e.g. "1 day before".
  _reminderLabel(minutes) {
    const entry = REMINDER_OFFSETS.find(([v]) => v === minutes);
    return entry ? this._t(entry[1]) : minutes + " min";
  }

  _buildReminderBadge(task) {
    let remText;
    if (task.reminders.length === 1) {
      remText = "\u23F0 " + this._reminderLabel(task.reminders[0]);
    } else {
      remText = "\u23F0 " + task.reminders.length;
    }
    return this._el("span", { className: "reminder-badge", textContent: remText });
  }

  _attachTaskExpandClickHandler(mainRow, task, taskEl, colIdx) {
    const tapToComplete = this._sourceCol(colIdx)?.tap_to_complete === true;
    mainRow.addEventListener("click", (e) => {
      if (e.detail > 1) return;
      if (e.target.closest(".checkbox-container")) return;
      if (e.target.closest(".tag-badge")) return;
      if (e.target.closest(".assigned-badge")) return;
      if (e.target.closest(".edit-title-input")) return;
      // tap_to_complete (issue #69): the whole row ticks the task off, like
      // a tile; only the chevron opens the details.  confirm_complete still
      // asks first — _toggleTask handles that.
      if (tapToComplete && !e.target.closest(".expand-btn")) {
        if (Date.now() < (this._suppressRowTapUntil || 0)) return;  // end of a drag
        this._toggleTask(task.id, task.completed, colIdx);
        return;
      }

      // If an animation is in progress, skip animation and just toggle + render
      if (this._animatingTaskIds?.has(task.id)) {
        this._animatingTaskIds.delete(task.id);
        if (this._expandedTasks.has(task.id)) {
          this._expandedTasks.delete(task.id);
        } else {
          this._expandedTasks.add(task.id);
        }
        this._render();
        return;
      }

      if (this._expandedTasks.has(task.id)) {
        this._collapseExpandedTask(task, taskEl);
      } else {
        if (!this._animatingTaskIds) this._animatingTaskIds = new Set();
        this._animatingTaskIds.add(task.id);
        this._justExpandedTaskId = task.id;
        this._expandedTasks.add(task.id);
        this._render();
        this._justExpandedTaskId = null;
      }
    });
  }

  _collapseExpandedTask(task, taskEl) {
    this._expandedTasks.delete(task.id);
    const detailsEl = taskEl.querySelector(".task-details");
    if (!detailsEl) {
      this._render();
      return;
    }
    const h = detailsEl.offsetHeight;
    if (!h) { this._render(); return; }
    detailsEl.style.height = h + "px";
    if (!this._animatingTaskIds) this._animatingTaskIds = new Set();
    this._animatingTaskIds.add(task.id);
    const finish = () => {
      if (!this._animatingTaskIds?.delete(task.id)) return;
      this._render();
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        detailsEl.style.height = "0";
        detailsEl.addEventListener("transitionend", finish, { once: true });
        setTimeout(finish, 300);
      });
    });
  }

  _animateExpandedDetails(detailsEl, task) {
    if (this._justExpandedTaskId === task.id) {
      // .task-details starts at height:0 (CSS default). Animate to full height.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          detailsEl.style.height = detailsEl.scrollHeight + "px";
          detailsEl.addEventListener("transitionend", () => {
            this._animatingTaskIds?.delete(task.id);
            detailsEl.style.height = "auto"; // release constraint once fully open
          }, { once: true });
        });
      });
    } else {
      // Already open (after re-render): show without animation
      detailsEl.style.height = "auto";
    }
  }

  _buildTaskDetails(task, colIdx, { draft = false } = {}) {
    const col = this._sourceCol(colIdx);

    // detail_order picks the order; fields it doesn't name follow in the
    // default order. The action row stays last.
    const build = {
      notes: () => this._buildNotesSection(task, colIdx),
      sub_tasks: () => this._buildSubTasksSection(task, colIdx),
      person: () => this._buildAssignedPersonSection(task, colIdx),
      section: () => this._buildSectionPickerSection(task, colIdx),
      priority: () => this._buildPrioritySection(task, colIdx),
      tags: () => this._buildTagsSection(task, colIdx),
      due_date: () => this._buildDateSection(task, colIdx),
      reminders: () => this._buildRemindersSection(task, colIdx),
      recurrence: () => this._buildRecurrenceSection(task, colIdx),
      history: () => this._buildHistorySection(task),
      images: () => this._buildImageSection(task, colIdx),
    };
    const hasSections = (this._columns[colIdx].sections || []).length > 0;
    const details = [];
    for (const key of _detailOrder(col)) {
      // A draft has no id the backend knows yet: sub-tasks, images and the
      // history need the task to exist.
      if (draft && (key === "sub_tasks" || key === "images" || key === "history")) continue;
      if (_detailFieldOn(col, key) && (key !== "section" || hasSections)) {
        details.push(this._foldableDetail(build[key](), key, task, colIdx));
      }
    }
    if (!draft) details.push(this._buildActionsSection(task, colIdx));

    const inner = this._el("div", { className: "task-details-inner" }, details);
    const wrapper = this._el("div", { className: "task-details" }, [inner]);

    // Stop mousedown on text inputs from reaching the draggable parent task.
    // Without this, the browser's drag detection intercepts mousedown and
    // prevents text selection / cursor positioning inside notes, due date,
    // tag, and reminder inputs.
    wrapper.addEventListener("mousedown", (e) => {
      if (this._isInteractiveTarget(e.target)) e.stopPropagation();
    });

    return wrapper;
  }

  // Fields of the task details folded by the user in this column's list,
  // by key: one choice for every task of the list (see _foldedDetailKeys).
  _foldedDetails(colIdx) {
    return _foldedDetailKeys(this._columnStorageKey(colIdx));
  }

  // Folds or opens a field of a column's list everywhere it shows: in this
  // card's open task details at once, in other cards on the page with the
  // same list through an event (each listens while connected), and in
  // localStorage for the next visit.
  _setDetailFolded(colIdx, key, folded) {
    const list = this._columnStorageKey(colIdx);
    const keys = _foldedDetailKeys(list);
    if (folded) keys.add(key);
    else keys.delete(key);
    try {
      window.localStorage.setItem(`${DETAIL_FOLD_STORAGE_KEY}:${list}`, JSON.stringify([...keys]));
    } catch (e) { /* storage blocked: folding lasts this session */ }
    this._applyDetailFold(list, key, folded);
    window.dispatchEvent(new CustomEvent(DETAIL_FOLD_EVENT, { detail: { list, key, folded, source: this } }));
  }

  _applyDetailFold(list, key, folded) {
    for (const s of this.shadowRoot?.querySelectorAll(`.detail-section[data-detail-key="${key}"]`) || []) {
      if (s.dataset.foldList === list) s._applyFold?.(folded);
    }
  }

  // A one-line summary of what a field holds, shown next to its heading
  // while it is folded; "" when nothing is set (then nothing is shown).
  _detailSummary(key, task, colIdx) {
    const nameOf = (eid) => this._hass?.states?.[eid]?.attributes?.friendly_name || eid;
    switch (key) {
      case "notes": return (task.notes || "").trim().split("\n")[0];
      case "sub_tasks": return this._getSubTaskProgress(task) || "";
      case "person": {
        const names = _assignees(task).map(nameOf);
        if (!names.length && task.assigned_name) names.push(task.assigned_name);
        return names.join(", ");
      }
      case "section":
        return (this._columns[colIdx].sections || []).find((x) => x.id === task.section_id)?.name || "";
      case "priority": return task.priority ? this._priorityLabel(task.priority) : "";
      case "tags": return (task.tags || []).map((t) => "#" + t).join(" ");
      case "due_date": return task.due_date ? this._formatDueDate(task.due_date, task.due_time) : "";
      case "reminders": return (task.reminders || []).map((m) => this._reminderLabel(m)).join(", ");
      case "recurrence": {
        // Its switch stays in the heading; the rule follows when it is on.
        const badge = task.recurrence_enabled ? this._buildRecurrenceBadge(task) : null;
        return badge ? badge.textContent.replace(/^↻\s*/, "").trim() : "";
      }
      default: return "";  // history, images: nothing short to say
    }
  }

  // Makes a task-details field foldable: a tap on its heading folds it to
  // that heading (plus the summary of what is set), and the choice is
  // remembered per field. The heading is the field's label - for the
  // recurrence its switch row, so the switch stays usable while folded.
  _foldableDetail(section, key, task, colIdx) {
    const head = section.firstElementChild;
    const label = head && (head.classList.contains("detail-label") ? head : head.querySelector(".detail-label"));
    if (!label) return section;
    section.dataset.detailKey = key;
    section.dataset.foldList = this._columnStorageKey(colIdx);
    head.classList.add("detail-fold-head");
    const caret = document.createElement("ha-icon");
    caret.className = "detail-fold-caret";
    caret.setAttribute("icon", "mdi:chevron-down");
    head.insertBefore(caret, head.firstChild);
    // Inside the heading, so folding (which hides all but the heading)
    // leaves it in view.
    const summary = this._el("span", { className: "detail-fold-summary" });
    if (head === label) head.appendChild(summary);
    else label.after(summary);
    label.tabIndex = 0;
    label.setAttribute("role", "button");
    let shown = task;
    const apply = (folded) => {
      section.classList.toggle("folded", folded);
      label.setAttribute("aria-expanded", String(!folded));
      summary.textContent = folded ? this._detailSummary(key, shown, colIdx) : "";
    };
    section._applyFold = apply;
    apply(this._foldedDetails(colIdx).has(key));
    const toggle = () => {
      const folded = !section.classList.contains("folded");
      this._setDetailFolded(colIdx, key, folded);
      apply(folded);  // also when this section is not (yet) in the card
    };
    // The recurrence switch works while folded: the summary follows it
    // straight away, not only once the saved task comes back.
    head.addEventListener("change", (e) => {
      if (!e.target.matches?.("ha-switch")) return;
      shown = { ...shown, recurrence_enabled: e.target.checked };
      apply(section.classList.contains("folded"));
    });
    head.addEventListener("click", (e) => {
      // The recurrence switch (and anything else interactive in the
      // heading) does its own job.
      if (e.target.closest("ha-switch, input, button, select, a")) return;
      e.preventDefault();
      toggle();
    });
    label.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      toggle();
    });
    return section;
  }

  _buildDateSection(task, colIdx) {
    const dateInput = this._el("input", { type: "date", value: task.due_date || "" });
    // Check if external provider supports due time (SET_DUE_DATETIME_ON_ITEM = 32)
    const features = this._colSupportedFeatures(colIdx);
    const supportsTime = this._colSupportsDueTime(colIdx);

    const timeInput = this._el("input", { type: "time", value: task.due_time || "" });
    if (!task.due_date) timeInput.disabled = true;

    const saveDueDate = () => {
      if (!dateInput.value) timeInput.value = "";
      timeInput.disabled = !dateInput.value;
      this._updateTaskDue(task.id, dateInput.value, supportsTime ? timeInput.value : "", colIdx);
    };
    const saveDueTime = () =>
      this._updateTaskDue(task.id, dateInput.value, timeInput.value, colIdx);
    // One-tap due dates (buttons added below). Each date is worked out when
    // it is needed, so details left open past midnight stay right.
    const quickRow = this._el("div", { className: "due-quick-row" });
    const quickDate = (b) =>
      this._localDateStr(this._advanceDateClamped(new Date(), b.dataset.unit, Number(b.dataset.val)));
    const markQuickPick = () => quickRow.querySelectorAll(".due-quick-btn").forEach((b) => {
      const on = quickDate(b) === dateInput.value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });

    const dateClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    const timeClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    if (!dateInput.value) dateClearBtn.style.display = "none";
    if (!timeInput.value) timeClearBtn.style.display = "none";

    dateInput.addEventListener("change", () => {
      saveDueDate();
      dateClearBtn.style.display = dateInput.value ? "" : "none";
      markQuickPick();
    });
    dateInput.addEventListener("keydown", (e) => { if (e.key === "Enter") dateInput.blur(); });
    timeInput.addEventListener("change", () => {
      saveDueTime();
      timeClearBtn.style.display = timeInput.value ? "" : "none";
    });
    timeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") timeInput.blur(); });

    dateClearBtn.addEventListener("click", () => {
      dateInput.value = "";
      timeInput.value = "";
      timeInput.disabled = true;
      saveDueDate();
      dateClearBtn.style.display = "none";
      timeClearBtn.style.display = "none";
      markQuickPick();
    });
    timeClearBtn.addEventListener("click", () => {
      timeInput.value = "";
      saveDueTime();
      timeClearBtn.style.display = "none";
    });

    const dateFieldWrap = this._el("div", { className: "field-wrap" }, [
      dateInput,
      this._el("span", { textContent: this._t("due_date_lbl") }),
    ]);
    const dateWrap = this._el("div", { className: "field-with-clear" }, [dateFieldWrap, dateClearBtn]);
    const timeFieldWrap = this._el("div", { className: "field-wrap" }, [
      timeInput,
      this._el("span", { textContent: this._t("due_time_lbl") }),
    ]);
    const timeWrap = this._el("div", { className: "field-with-clear" }, [timeFieldWrap, timeClearBtn]);
    if (!supportsTime) timeWrap.style.display = "none";

    // Today, tomorrow, a week, a month, three months out. A set due time is
    // kept; the button for the current date is highlighted.
    for (const [key, unit, val] of [
      ["due_today", "days", 0], ["due_tomorrow", "days", 1], ["due_quick_week", "days", 7],
      ["due_quick_month", "months", 1], ["due_quick_3months", "months", 3],
    ]) {
      const btn = this._el("button", { className: "due-quick-btn", textContent: this._t(key) });
      btn.dataset.unit = unit;
      btn.dataset.val = val;
      btn.addEventListener("click", () => {
        const iso = quickDate(btn);
        if (dateInput.value === iso) { markQuickPick(); return; }
        dateInput.value = iso;
        dateClearBtn.style.display = "";
        timeInput.disabled = false;
        markQuickPick();
        this._updateTaskDue(task.id, iso, supportsTime ? timeInput.value : "", colIdx);
      });
      quickRow.appendChild(btn);
    }
    markQuickPick();
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("due_date") }),
      this._el("div", { className: "due-input-row" }, [dateWrap, timeWrap]),
      quickRow,
    ]);
  }

  // http(s) URLs in *text*, as [start, end) ranges.  Trailing punctuation
  // that closes the sentence ("see https://x.y/z.") is not part of the link,
  // and a closing bracket only is when the URL opened one ("(…/wiki/Foo_(bar))").
  _findUrls(text) {
    const found = [];
    const re = /\bhttps?:\/\/[^\s<>"'`]+/gi;
    let m;
    while ((m = re.exec(text || "")) !== null) {
      let url = m[0];
      for (;;) {
        const last = url.slice(-1);
        if (/[.,;:!?'"]/.test(last)) { url = url.slice(0, -1); continue; }
        const opener = { ")": "(", "]": "[", "}": "{" }[last];
        const count = (ch) => url.split(ch).length - 1;
        if (opener && count(last) > count(opener)) { url = url.slice(0, -1); continue; }
        break;
      }
      if (url.length > "https://".length) found.push({ start: m.index, end: m.index + url.length, url });
    }
    return found;
  }

  // Fill *container* with *text* as text nodes and <a> elements for its
  // URLs.  Only text nodes and hrefs from _findUrls — notes can come from
  // anywhere (services, synced providers), so no markup is ever parsed.
  _renderLinkified(container, text) {
    let pos = 0;
    for (const { start, end, url } of this._findUrls(text)) {
      if (start > pos) container.appendChild(document.createTextNode(text.slice(pos, start)));
      const a = this._el("a", { href: url, textContent: url, target: "_blank", rel: "noopener noreferrer" });
      container.appendChild(a);
      pos = end;
    }
    if (pos < text.length) container.appendChild(document.createTextNode(text.slice(pos)));
  }

  _buildNotesSection(task, colIdx) {
    // Notes are shown as text with clickable links; a click (or Enter)
    // switches to the textarea.  Empty notes go straight to the textarea so
    // they can be typed into.  The editing state lives on the card, not the
    // DOM, so a re-render while typing brings the textarea (and, through
    // data-focus-key, the caret) back instead of the read view.
    if (!this._notesEditing) this._notesEditing = new Set();
    // The tile detail sheet outlives re-renders while a reload replaces the
    // task objects, so always read the notes from the current one.
    const currentNotes = () =>
      (this._columns[colIdx]?.tasks?.find(t => t.id === task.id) || task).notes || "";
    const notesWrap = this._el("div", { className: "field-wrap no-label" });
    const section = this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("notes") }),
      notesWrap,
    ]);

    const showView = () => {
      const text = currentNotes();
      const view = this._el("div", {
        className: "notes-view",
        tabIndex: 0,
        role: "button",
        title: this._t("notes_edit_hint"),
      });
      this._renderLinkified(view, text);
      // Selecting text to copy it is not a request to edit it: the pointer
      // moved between press and release, or a selection sits in the view.
      // (Inside a shadow root, window.getSelection() reports the host in
      // Chrome/Safari — ask the shadow root where it can answer.)
      let downAt = null;
      view.addEventListener("pointerdown", (e) => { downAt = { x: e.clientX, y: e.clientY }; });
      const selecting = (e) => {
        if (downAt && e && e.clientX != null &&
            Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return true;
        const root = this.shadowRoot;
        const sel = (root && typeof root.getSelection === "function" && root.getSelection())
          || (window.getSelection && window.getSelection());
        return !!(sel && !sel.isCollapsed && sel.anchorNode && view.contains(sel.anchorNode));
      };
      const edit = () => {
        this._notesEditing.add(task.id);
        showEditor(true);
      };
      view.addEventListener("click", (e) => {
        if (e.target.closest && e.target.closest("a")) return;  // a link opens, it doesn't edit
        const skip = selecting(e);
        downAt = null;
        if (!skip) edit();
      });
      view.addEventListener("keydown", (e) => {
        if (e.target !== view) return;  // Enter on a focused link opens the link
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); }
      });
      notesWrap.replaceChildren(view);
    };

    const showEditor = (focus) => {
      const notesInput = this._el("textarea", {
        placeholder: this._t("notes_placeholder"),
        rows: 2,
        value: currentNotes(),
        "data-focus-key": "notes",
      });
      let debounceTimer;
      const saveNotes = () => {
        clearTimeout(debounceTimer);
        debounceTimer = null;
        this._updateTaskNotes(task.id, notesInput.value, colIdx);
      };
      // Focus is what marks the notes as being edited — also when they start
      // out empty, where no click on the view came first; otherwise the
      // re-render after the first auto-save would swap in the read view
      // mid-typing.
      notesInput.addEventListener("focus", () => this._notesEditing.add(task.id));
      notesInput.addEventListener("input", () => {
        this._autoGrowTextarea(notesInput);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(saveNotes, 500);
      });
      notesInput.addEventListener("blur", () => {
        saveNotes();
        // A blur from the card tearing its DOM down for a re-render is not
        // the user leaving the field — stay in editing, the rebuild restores
        // the textarea.  Only a real blur (still attached) goes back to the view.
        setTimeout(() => {
          if (!notesInput.isConnected) return;
          this._notesEditing.delete(task.id);
          if ((notesInput.value || "").trim()) showView();
        }, 0);
      });
      notesWrap.replaceChildren(notesInput);
      // Fit to content once attached (scrollHeight is 0 while detached).
      requestAnimationFrame(() => this._autoGrowTextarea(notesInput));
      if (focus) {
        notesInput.focus();
        const end = notesInput.value.length;
        try { notesInput.setSelectionRange(end, end); } catch { /* noop */ }
      }
    };

    if (currentNotes().trim() && !this._notesEditing.has(task.id)) showView();
    else showEditor(false);
    return section;
  }

  _buildSubTasksSection(task, colIdx) {
    const subList = this._el("div", { className: "sub-task-list" });
    subList.dataset.taskId = task.id;
    for (const sub of (task.sub_items || [])) {
      subList.appendChild(this._buildSubTask(task.id, sub, colIdx));
    }
    subList.addEventListener("dragover", (e) => { e.preventDefault(); });
    subList.addEventListener("drop", (e) => { e.preventDefault(); this._finishSubDrag(task.id, colIdx); });
    const addSubBtn = this._el("button", {
      className: "add-sub-btn",
      textContent: this._t("add_sub_item"),
    });
    addSubBtn.addEventListener("click", () => this._addSubTask(task.id, colIdx));
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("sub_items") }),
      subList,
      addSubBtn,
    ]);
  }

  _buildPrioritySection(task, colIdx) {
    const currentPriority = task.priority || null;
    const priorityBtnRow = this._el("div", { className: "priority-btn-row" });
    for (const [val, key] of [[1, "pri_low"], [2, "pri_medium"], [3, "pri_high"]]) {
      const btn = this._el("button", {
        className: `priority-btn pri-${val}${currentPriority === val ? " active" : ""}`,
        textContent: this._t(key),
      });
      btn.addEventListener("click", () => {
        const newPri = currentPriority === val ? null : val;
        task.priority = newPri;
        this._render();
        this._updateTaskRouted(colIdx, task.id, { priority: newPri });
      });
      priorityBtnRow.appendChild(btn);
    }
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("priority") }),
      priorityBtnRow,
    ]);
  }

  _buildRecurrenceSection(task, colIdx) {
    const recurrenceEnabled = task.recurrence_enabled || false;
    const listLead = this._columns[colIdx]?.reopenLead || 0;
    // Never set up yet: start the interval a day longer than the list's
    // reopen lead, so switching it on keeps the lead (issue #77).
    const leadDays = !task.recurrence_unit && listLead >= 1440 ? Math.floor(listLead / 1440) + 1 : 0;
    const recurrenceValue = leadDays > 365 ? 2 : (leadDays || task.recurrence_value || 1);
    // Default unit "days"; legacy "weekdays" mode (unmigrated overlay) is
    // mapped to weeks+weekday-filter for UI purposes.
    const legacyWeekdaysMode = task.recurrence_type === "weekdays";
    const recurrenceUnit = legacyWeekdaysMode ? "weeks"
      : leadDays > 365 ? "years" : (task.recurrence_unit || "days");
    const recurrenceWeekdays = task.recurrence_weekdays || [];
    const recurrenceStartDate = task.recurrence_start_date || "";
    const recurrenceTime = task.recurrence_time || "00:00";
    const recurrenceEndType = task.recurrence_end_type === "count" ? "count" : "date";
    const recurrenceEndDate = task.recurrence_end_date || "";
    const recurrenceMaxCount = task.recurrence_max_count ?? null;
    const recurrenceRemainingCount = task.recurrence_remaining_count ?? task.recurrence_max_count ?? null;
    const recurrenceMonthPattern = task.recurrence_month_pattern || "none";
    const recurrenceDayOfMonth = task.recurrence_day_of_month;
    const recurrenceNthWeek = task.recurrence_nth_week;
    const recurrenceAnniversary = task.recurrence_anniversary || "";
    // What a late completion counts from: "completion" ("Ab Erledigung",
    // default) or "due" ("Ab Fälligkeit").  A calendar pattern (weekdays,
    // day of month, …) always follows the due date, so this only matters
    // while no pattern is picked.
    // A provider that runs the recurrence itself (Todoist) gets no anchor
    // choice, so a stray "due" there must not leave its row unselected.
    const _anchorCaps = this._colCapabilities(colIdx);
    const recurrenceAnchor = (task.recurrence_anchor === "due" && !(_anchorCaps && _anchorCaps.can_sync_recurrence))
      ? "due" : "completion";

    const recSwitch = document.createElement("ha-switch");
    recSwitch.checked = recurrenceEnabled;
    const recurrenceToggleRow = this._el("div", { className: "recurrence-toggle-row" }, [
      this._el("label", { className: "detail-label", style: "margin: 0;" }, [
        document.createTextNode(this._t("recurrence"))
      ]),
      recSwitch,
    ]);

    const recurrenceValueInput = this._el("input", {
      type: "number", value: recurrenceValue,
      "data-focus-key": "recurrence_value",
    });
    recurrenceValueInput.min = 1;
    recurrenceValueInput.max = 365;

    const recurrenceUnitSelect = this._el("select", {});
    for (const opt of [
      { value: "hours", label: this._t("rec_hours") },
      { value: "days", label: this._t("rec_days") },
      { value: "weeks", label: this._t("rec_weeks") },
      { value: "months", label: this._t("rec_months") },
      { value: "years", label: this._t("rec_years") },
    ]) {
      const optEl = this._el("option", { value: opt.value, textContent: opt.label });
      if (opt.value === recurrenceUnit) optEl.selected = true;
      recurrenceUnitSelect.appendChild(optEl);
    }

    const spinUp = this._el("button", { className: "spin-btn spin-up", textContent: "\u25b4", type: "button" });
    const spinDown = this._el("button", { className: "spin-btn spin-down", textContent: "\u25be", type: "button" });
    spinUp.addEventListener("click", () => {
      const v = Math.min(365, (parseInt(recurrenceValueInput.value) || 1) + 1);
      recurrenceValueInput.value = v;
      recurrenceValueInput.dispatchEvent(new Event("change"));
    });
    spinDown.addEventListener("click", () => {
      const v = Math.max(1, (parseInt(recurrenceValueInput.value) || 1) - 1);
      recurrenceValueInput.value = v;
      recurrenceValueInput.dispatchEvent(new Event("change"));
    });
    const recValueWrap = this._el("div", { className: "field-wrap inline" }, [
      recurrenceValueInput,
      this._el("span", { textContent: this._t("rec_value_lbl") }),
      this._el("div", { className: "spin-btns" }, [spinUp, spinDown]),
    ]);
    const recUnitWrap = this._el("div", { className: "sel-wrap inline" }, [
      recurrenceUnitSelect,
      this._el("span", { textContent: this._t("rec_unit_lbl") }),
    ]);
    const recurrenceIntervalRow = this._el("div", { className: "recurrence-input-row" }, [recValueWrap, recUnitWrap]);

    // ---- Hourly/daily sub-section (radios: Ab Erledigung / Ab Fälligkeit) -
    const _basicPatName = `rec_basic_pattern_${task.id}`;
    const _mkBasicRadio = (val) => {
      const r = this._el("input", { type: "radio", name: _basicPatName, value: val });
      if (recurrenceAnchor === val) r.checked = true;
      return r;
    };
    const basicPatNoneRadio = _mkBasicRadio("completion");
    const basicPatDueRadio = _mkBasicRadio("due");
    const recurrenceBasicRadioRow = this._el("div", { className: "recurrence-radio-row" }, [
      this._el("label", { className: "weekday-label" }, [
        basicPatNoneRadio, this._el("span", { textContent: this._t("rec_pattern_none") }),
      ]),
      this._el("label", { className: "weekday-label" }, [
        basicPatDueRadio, this._el("span", { textContent: this._t("rec_pattern_due") }),
      ]),
    ]);

    // ---- Weekly sub-section (radios: Ab Erledigung / Am + weekday filter) -
    const _weekPatName = `rec_week_pattern_${task.id}`;
    const weekHasFilter = (recurrenceWeekdays && recurrenceWeekdays.length > 0)
      || this._weekPatternOverride.get(task.id) === "on";
    const _mkWeekRadio = (val, checked) => {
      const r = this._el("input", { type: "radio", name: _weekPatName, value: val });
      if (checked) r.checked = true;
      return r;
    };
    const weekPatNoneRadio = _mkWeekRadio("none", !weekHasFilter && recurrenceAnchor !== "due");
    const weekPatDueRadio = _mkWeekRadio("due", !weekHasFilter && recurrenceAnchor === "due");
    const weekPatOnRadio = _mkWeekRadio("on", weekHasFilter);
    const weekPatNoneLabel = this._el("label", { className: "weekday-label" }, [
      weekPatNoneRadio, this._el("span", { textContent: this._t("rec_pattern_none") }),
    ]);
    const weekPatDueLabel = this._el("label", { className: "weekday-label" }, [
      weekPatDueRadio, this._el("span", { textContent: this._t("rec_pattern_due") }),
    ]);
    const weekPatOnLabel = this._el("label", { className: "weekday-label" }, [
      weekPatOnRadio, this._el("span", { textContent: this._t("rec_anniversary_lbl") }),
    ]);
    const recurrenceWeekRadioRow = this._el("div", { className: "recurrence-radio-row" }, [
      weekPatNoneLabel, weekPatDueLabel, weekPatOnLabel,
    ]);
    const weekdayCheckboxes = [];
    const recurrenceWeekdayCheckboxRow = this._el("div", { className: "recurrence-weekday-row" });
    for (let d = 0; d < 7; d++) {
      const cb = this._el("input", { type: "checkbox", checked: recurrenceWeekdays.includes(d) });
      const lbl = this._el("label", { className: "weekday-label" }, [
        cb,
        this._el("span", { textContent: this._t(`rec_wd_${d}`) }),
      ]);
      weekdayCheckboxes.push(cb);
      recurrenceWeekdayCheckboxRow.appendChild(lbl);
    }
    const recurrenceWeekSection = this._el("div", { className: "recurrence-week-section" }, [
      recurrenceWeekRadioRow, recurrenceWeekdayCheckboxRow,
    ]);

    // ---- Monthly sub-section (pattern picker + dom + nth/weekday) ---------
    // Radios use the same .weekday-label pill styling as the weekday picker
    // so both rows feel like one consistent control.
    const _patternName = `rec_month_pattern_${task.id}`;
    const _monthChecked = recurrenceMonthPattern !== "none"
      ? recurrenceMonthPattern
      : (recurrenceAnchor === "due" ? "due" : "none");
    const _mkPatternRadio = (val) => {
      const r = this._el("input", { type: "radio", name: _patternName, value: val });
      if (_monthChecked === val) r.checked = true;
      return r;
    };
    const monthPatNoneRadio = _mkPatternRadio("none");
    const monthPatDueRadio = _mkPatternRadio("due");
    const monthPatDomRadio = _mkPatternRadio("day_of_month");
    const monthPatNthRadio = _mkPatternRadio("nth_weekday");

    // Day-of-month options: "1. Tag", "2. Tag", ..., plus "Letzter Tag".
    // Ordinals are language-aware ("1." in German/most European, "1st"
    // in English).  Default to day 1 so the dropdown shows a sensible
    // value as soon as the user picks "Tag im Monat".
    const monthDomSelect = this._el("select", {});
    const _domEffective = recurrenceDayOfMonth ?? 1;
    for (let d = 1; d <= 31; d++) {
      const opt = this._el("option", {
        value: String(d),
        textContent: `${this._domOrdinal(d)} ${this._t("rec_dom_lbl")}`,
      });
      if (_domEffective === d) opt.selected = true;
      monthDomSelect.appendChild(opt);
    }
    const lastOpt = this._el("option", { value: "last", textContent: this._t("rec_dom_last") });
    if (recurrenceDayOfMonth === "last") lastOpt.selected = true;
    monthDomSelect.appendChild(lastOpt);
    const monthDomWrap = this._el("div", { className: "sel-wrap" }, [
      monthDomSelect,
      this._el("span", { textContent: this._t("rec_anniversary_lbl") }),
    ]);

    const monthNthSelect = this._el("select", {});
    for (const [val, key] of [[1, "rec_nth_1"], [2, "rec_nth_2"], [3, "rec_nth_3"], [4, "rec_nth_4"], ["last", "rec_nth_last"]]) {
      const opt = this._el("option", { value: String(val), textContent: this._t(key) });
      if (recurrenceNthWeek === val) opt.selected = true;
      monthNthSelect.appendChild(opt);
    }
    const monthNthWrap = this._el("div", { className: "sel-wrap" }, [
      monthNthSelect,
      this._el("span", { textContent: this._t("rec_nth_lbl") }),
    ]);

    // Weekday dropdown: spell out the names ("Montag, Dienstag, …") via
    // Intl, so the user-facing text is the full word — the abbreviated
    // forms (rec_wd_0..6) are still used elsewhere (badges, weekly
    // checkboxes).  Our weekday convention is 0=Mon..6=Sun; 2024-01-01
    // happens to be a Monday, which lets us index dates 1..7 directly.
    const monthWeekdaySelect = this._el("select", {});
    const monthWeekdayInitial = (recurrenceWeekdays && recurrenceWeekdays.length) ? recurrenceWeekdays[0] : 0;
    const _wdLang = this._localeCode();
    for (let d = 0; d < 7; d++) {
      const fullName = new Date(2024, 0, d + 1).toLocaleString(_wdLang, { weekday: "long" });
      const opt = this._el("option", { value: String(d), textContent: fullName });
      if (d === monthWeekdayInitial) opt.selected = true;
      monthWeekdaySelect.appendChild(opt);
    }
    const monthWeekdayWrap = this._el("div", { className: "sel-wrap" }, [
      monthWeekdaySelect,
      this._el("span", { textContent: this._t("rec_wd_lbl") }),
    ]);

    const monthPatNoneLabel = this._el("label", { className: "weekday-label" }, [
      monthPatNoneRadio, this._el("span", { textContent: this._t("rec_pattern_none") }),
    ]);
    const monthPatDueLabel = this._el("label", { className: "weekday-label" }, [
      monthPatDueRadio, this._el("span", { textContent: this._t("rec_pattern_due") }),
    ]);
    const monthPatDomLabel = this._el("label", { className: "weekday-label" }, [
      monthPatDomRadio, this._el("span", { textContent: this._t("rec_pattern_dom") }),
    ]);
    const monthPatNthLabel = this._el("label", { className: "weekday-label" }, [
      monthPatNthRadio, this._el("span", { textContent: this._t("rec_pattern_nth") }),
    ]);
    const recurrenceMonthRadioRow = this._el("div", { className: "recurrence-radio-row" }, [
      monthPatNoneLabel, monthPatDueLabel, monthPatDomLabel, monthPatNthLabel,
    ]);
    // The selects appear under the radios — only one set is visible at a time.
    const recurrenceMonthDomRow = this._el("div", { className: "recurrence-sub-row" }, [
      monthDomWrap,
    ]);
    const recurrenceMonthNthRow = this._el("div", { className: "recurrence-sub-row" }, [
      monthNthWrap, monthWeekdayWrap,
    ]);
    const recurrenceTodoistMonthNote = this._el("div", {
      className: "recurrence-todoist-note",
      textContent: this._t("rec_todoist_pattern_unsupported"),
    });
    recurrenceTodoistMonthNote.style.display = "none";
    const recurrenceMonthSection = this._el("div", { className: "recurrence-month-section" }, [
      recurrenceMonthRadioRow, recurrenceMonthDomRow, recurrenceMonthNthRow,
      recurrenceTodoistMonthNote,
    ]);

    // ---- Yearly sub-section (radios: Ab Erledigung / Am + TT.MM) ----------
    const _yearPatName = `rec_year_pattern_${task.id}`;
    const yearHasAnchor = !!(recurrenceAnniversary && /^\d{2}-\d{2}$/.test(recurrenceAnniversary))
      || this._yearPatternOverride.get(task.id) === "on";
    const _mkYearRadio = (val, checked) => {
      const r = this._el("input", { type: "radio", name: _yearPatName, value: val });
      if (checked) r.checked = true;
      return r;
    };
    const yearPatNoneRadio = _mkYearRadio("none", !yearHasAnchor && recurrenceAnchor !== "due");
    const yearPatDueRadio = _mkYearRadio("due", !yearHasAnchor && recurrenceAnchor === "due");
    const yearPatOnRadio = _mkYearRadio("on", yearHasAnchor);
    const yearPatNoneLabel = this._el("label", { className: "weekday-label" }, [
      yearPatNoneRadio, this._el("span", { textContent: this._t("rec_pattern_none") }),
    ]);
    const yearPatDueLabel = this._el("label", { className: "weekday-label" }, [
      yearPatDueRadio, this._el("span", { textContent: this._t("rec_pattern_due") }),
    ]);
    const yearPatOnLabel = this._el("label", { className: "weekday-label" }, [
      yearPatOnRadio, this._el("span", { textContent: this._t("rec_anniversary_lbl") }),
    ]);
    const recurrenceYearRadioRow = this._el("div", { className: "recurrence-radio-row" }, [
      yearPatNoneLabel, yearPatDueLabel, yearPatOnLabel,
    ]);

    // TT input: same custom spin-btn pattern as the value/anzahl fields so
    // the up/down arrows look consistent.  Native browser spinners are
    // suppressed by .field-wrap.inline CSS rules.
    const annDayInput = this._el("input", { type: "number" });
    annDayInput.min = 1; annDayInput.max = 31; annDayInput.placeholder = "TT";
    const annDaySpinUp = this._el("button", { className: "spin-btn spin-up", textContent: "\u25b4", type: "button" });
    const annDaySpinDown = this._el("button", { className: "spin-btn spin-down", textContent: "\u25be", type: "button" });
    annDaySpinUp.addEventListener("click", () => {
      const v = Math.min(31, (parseInt(annDayInput.value) || 0) + 1);
      annDayInput.value = v;
      annDayInput.dispatchEvent(new Event("change"));
    });
    annDaySpinDown.addEventListener("click", () => {
      const cur = parseInt(annDayInput.value);
      const v = isNaN(cur) ? 1 : Math.max(1, cur - 1);
      annDayInput.value = v;
      annDayInput.dispatchEvent(new Event("change"));
    });

    // MM as a localized dropdown — Januar, Februar, ... in the user's
    // language via Intl, so we don't need a translated month-name table.
    const annMonthSelect = this._el("select", {});
    const _lang = this._localeCode();
    for (let i = 1; i <= 12; i++) {
      const name = new Date(2024, i - 1, 1).toLocaleString(_lang, { month: "long" });
      annMonthSelect.appendChild(this._el("option", { value: String(i), textContent: name }));
    }
    if (yearHasAnchor) {
      annMonthSelect.value = String(parseInt(recurrenceAnniversary.slice(0, 2), 10));
      annDayInput.value = parseInt(recurrenceAnniversary.slice(3, 5), 10);
    } else {
      // Sensible default when the user just picked "Am" — January 1st.
      // The values are only saved once the partial-input guard sees a
      // complete (TT+MM) pair, so showing them pre-filled is fine.
      annDayInput.value = "1";
      annMonthSelect.value = "1";
    }
    // The period rendered right after the typed number is drawn via a
    // ::after pseudo on the wrapper (CSS).  The wrapper toggles the
    // ``has-value`` class so the dot only shows when the input actually
    // has a number — empty TT shouldn't read "." next to the placeholder.
    const annDayWrap = this._el("div", { className: "field-wrap inline year-day" }, [
      annDayInput,
      this._el("span", { textContent: this._t("rec_dd") }),
      this._el("div", { className: "spin-btns" }, [annDaySpinUp, annDaySpinDown]),
    ]);
    const _syncDotVisibility = () => {
      const v = annDayInput.value || "";
      annDayWrap.classList.toggle("has-value", !!v);
      // The dot's left offset is left-padding + (digit count) * 1ch.
      annDayWrap.style.setProperty("--day-len", String(v.length));
    };
    annDayInput.addEventListener("input", _syncDotVisibility);
    annDayInput.addEventListener("change", _syncDotVisibility);
    _syncDotVisibility();

    const annMonthWrap = this._el("div", { className: "sel-wrap" }, [
      annMonthSelect, this._el("span", { textContent: this._t("rec_mm") }),
    ]);
    const recurrenceTodoistYearNote = this._el("div", {
      className: "recurrence-todoist-note",
      textContent: this._t("rec_todoist_pattern_unsupported"),
    });
    recurrenceTodoistYearNote.style.display = "none";
    const recurrenceYearInputs = this._el("div", { className: "recurrence-year-row" }, [
      annDayWrap,
      annMonthWrap,
    ]);
    const recurrenceYearRow = this._el("div", { className: "recurrence-year-section" }, [
      recurrenceYearRadioRow, recurrenceYearInputs, recurrenceTodoistYearNote,
    ]);

    // Start date + reactivation time — now on separate rows so the time
    // input is read as "time of each occurrence" rather than "starts at".
    const _todayStr = this._localDateStr(new Date());
    const recurrenceStartDateInput = this._el("input", {
      type: "date", value: recurrenceStartDate, min: _todayStr,
      "data-focus-key": "recurrence_start_date",
    });
    const recStartClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    recStartClearBtn.addEventListener("click", () => {
      recurrenceStartDateInput.value = "";
      saveStartDate();
      recStartClearBtn.style.display = "none";
    });
    if (!recurrenceStartDate) recStartClearBtn.style.display = "none";
    recurrenceStartDateInput.addEventListener("change", () => { recStartClearBtn.style.display = recurrenceStartDateInput.value ? "" : "none"; });

    const recStartFieldWrap = this._el("div", { className: "field-wrap" }, [
      recurrenceStartDateInput,
      this._el("span", { textContent: this._t("rec_start_date_lbl") }),
    ]);
    const recurrenceStartDateWrap = this._el("div", { className: "field-with-clear" }, [recStartFieldWrap, recStartClearBtn]);

    const recurrenceTimeInput = this._el("input", {
      type: "time", value: recurrenceTime,
      "data-focus-key": "recurrence_time",
    });
    const recTimeClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    recTimeClearBtn.addEventListener("click", () => {
      recurrenceTimeInput.value = "";
      saveRecurrenceTime();
      recTimeClearBtn.style.display = "none";
    });
    if (!recurrenceTime) recTimeClearBtn.style.display = "none";
    recurrenceTimeInput.addEventListener("change", () => { recTimeClearBtn.style.display = recurrenceTimeInput.value ? "" : "none"; });

    const recTimeFieldWrap = this._el("div", { className: "field-wrap" }, [
      recurrenceTimeInput,
      this._el("span", { textContent: this._t("rec_at_lbl") }),
    ]);
    const recurrenceTimeWrap = this._el("div", { className: "field-with-clear" }, [recTimeFieldWrap, recTimeClearBtn]);

    // Each on its own single-column row — the time row sits above "Beginn"
    // so the user reads "happens at HH:MM" rather than "starts at HH:MM".
    const recurrenceTimeRow = this._el("div", { className: "due-input-row single" }, [
      recurrenceTimeWrap,
    ]);
    const recurrenceStartDateRow = this._el("div", { className: "due-input-row single" }, [
      recurrenceStartDateWrap,
    ]);

    // End condition — two radio pills: "Bis" (date, default) and "X mal"
    // (count, native lists only).  "Bis" with an empty date input means
    // "no end" — same semantics as Beginn: leave it blank to never end.
    // The "Nie" radio was dropped because the empty-date case already
    // covers it and the extra option just added noise.
    const caps = this._colCapabilities(colIdx);
    const providerSupportsCount = !this._isExternalCol(colIdx) || !caps || !caps.can_sync_recurrence;

    const initialEndType = (recurrenceEndType === "count" && providerSupportsCount)
      ? "count" : "date";
    const _endName = `rec_end_${task.id}`;
    const _mkEndRadio = (val) => {
      const r = this._el("input", { type: "radio", name: _endName, value: val });
      if (initialEndType === val) r.checked = true;
      return r;
    };
    const endDateRadio = _mkEndRadio("date");
    const endCountRadio = _mkEndRadio("count");
    const endDateLabel = this._el("label", { className: "weekday-label" }, [
      endDateRadio, this._el("span", { textContent: this._t("rec_end_date") }),
    ]);
    const endCountLabel = this._el("label", { className: "weekday-label" }, [
      endCountRadio, this._el("span", { textContent: this._t("rec_end_count") }),
    ]);
    const recurrenceEndRow = this._el("div", { className: "recurrence-radio-row" });
    recurrenceEndRow.appendChild(endDateLabel);
    if (providerSupportsCount) recurrenceEndRow.appendChild(endCountLabel);

    // Compute the minimum allowed end date based on recurrence interval.
    const _computeMinEndDate = () => {
      const unit = recurrenceUnitSelect.value || "days";
      const val = parseInt(recurrenceValueInput.value) || 1;
      // Hours: multiple occurrences fit in one day, so today is a valid end
      // date (_advanceDateClamped leaves the date unchanged for "hours").
      return this._localDateStr(this._advanceDateClamped(new Date(), unit, val));
    };
    const _updateEndDateMin = () => {
      const minEnd = _computeMinEndDate();
      recurrenceEndDateInput.min = minEnd;
      // If the current value is before the new min, clear it
      if (recurrenceEndDateInput.value && recurrenceEndDateInput.value < minEnd) {
        recurrenceEndDateInput.value = "";
      }
    };
    const recurrenceEndDateInput = this._el("input", {
      type: "date", value: recurrenceEndDate, min: _computeMinEndDate(),
      "data-focus-key": "recurrence_end_date",
    });
    const recEndClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    recEndClearBtn.addEventListener("click", () => {
      recurrenceEndDateInput.value = "";
      saveEndCondition();
      recEndClearBtn.style.display = "none";
    });
    if (!recurrenceEndDate) recEndClearBtn.style.display = "none";
    recurrenceEndDateInput.addEventListener("change", () => { recEndClearBtn.style.display = recurrenceEndDateInput.value ? "" : "none"; });

    const recEndFieldWrap = this._el("div", { className: "field-wrap" }, [
      recurrenceEndDateInput,
      this._el("span", { textContent: this._t("rec_end_date_lbl") }),
    ]);
    const recurrenceEndDateWrap = this._el("div", { className: "due-input-row single" }, [
      this._el("div", { className: "field-with-clear" }, [recEndFieldWrap, recEndClearBtn]),
    ]);

    const recurrenceMaxCountInput = this._el("input", {
      type: "number", value: recurrenceMaxCount !== null ? recurrenceMaxCount : "",
      "data-focus-key": "recurrence_max_count",
    });
    recurrenceMaxCountInput.min = 1;
    recurrenceMaxCountInput.max = 999;
    const spinUp2 = this._el("button", { className: "spin-btn spin-up", textContent: "\u25b4", type: "button" });
    const spinDown2 = this._el("button", { className: "spin-btn spin-down", textContent: "\u25be", type: "button" });
    spinUp2.addEventListener("click", () => {
      const v = Math.min(999, (parseInt(recurrenceMaxCountInput.value) || 1) + 1);
      recurrenceMaxCountInput.value = v;
      recurrenceMaxCountInput.dispatchEvent(new Event("change"));
    });
    spinDown2.addEventListener("click", () => {
      const v = Math.max(1, (parseInt(recurrenceMaxCountInput.value) || 1) - 1);
      recurrenceMaxCountInput.value = v;
      recurrenceMaxCountInput.dispatchEvent(new Event("change"));
    });
    const recRemainingSpan = this._el("span", { className: "rec-remaining" });
    if (recurrenceRemainingCount !== null) {
      recRemainingSpan.textContent = this._t("rec_remaining", recurrenceRemainingCount);
    }
    const recMaxCountWrap = this._el("div", { className: "field-wrap inline" }, [
      recurrenceMaxCountInput,
      this._el("span", { textContent: this._t("rec_max_count_lbl") }),
      this._el("div", { className: "spin-btns" }, [spinUp2, spinDown2]),
    ]);
    const recMaxCountClearBtn = this._el("button", { className: "field-clear-btn", textContent: "\u00D7" });
    recMaxCountClearBtn.addEventListener("click", () => {
      recurrenceMaxCountInput.value = "";
      saveEndCondition();
      recMaxCountClearBtn.style.display = "none";
    });
    if (recurrenceMaxCount === null || recurrenceMaxCount === undefined) recMaxCountClearBtn.style.display = "none";
    recurrenceMaxCountInput.addEventListener("change", () => {
      recMaxCountClearBtn.style.display = recurrenceMaxCountInput.value ? "" : "none";
    });
    const recMaxCountWithClear = this._el("div", { className: "field-with-clear" }, [recMaxCountWrap, recMaxCountClearBtn]);
    const recurrenceCountRow = this._el("div", { className: "recurrence-input-row" }, [recMaxCountWithClear, recRemainingSpan]);

    // ---- Reopen ahead (PR #74) --------------------------------------------
    // Show the task as open this long before its next due moment, as an
    // upcoming to-do.  Stored in minutes; the unit picker offers what fits the
    // interval (minutes/hours for hourly, hours/days otherwise).  A lead as
    // long as the interval is never offered — the backend would ignore it.
    // Native lists only: a linked list's reopen runs without it.
    // Until recurrence is switched on the task has no lead of its own: it
    // shows the list's (issue #77), which it takes over with the switch
    // where the interval can hold it.
    const leadSupported = !this._isExternalCol(colIdx);
    const LEAD_FACTORS = { minutes: 1, hours: 60, days: 1440 };
    // A recurring task without one (from before reopen early, or moved in)
    // reopens when due, like the backend's `or 0`.
    let leadMinutes = recurrenceEnabled
      ? (Number.isInteger(task.recurrence_reopen_lead) ? task.recurrence_reopen_lead : 0) : null;
    const _intervalMinutes = () => {
      const unit = recurrenceUnitSelect.value || "days";
      // Weekdays only count while "On" is picked — otherwise they aren't saved.
      const weekdays = (unit === "weeks" && weekPatOnRadio.checked)
        ? weekdayCheckboxes.map((cb, i) => cb.checked ? i : -1).filter(i => i >= 0)
        : [];
      return TasksCardBase.recurrenceIntervalMinutes(
        unit, parseInt(recurrenceValueInput.value) || 1, weekdays,
      ) || 1440;
    };
    const _leadMaxIn = (unit) => Math.floor((_intervalMinutes() - 1) / LEAD_FACTORS[unit]);
    const _shownLead = () => leadMinutes ?? (listLead < _intervalMinutes() ? listLead : 0);

    const leadInput = this._el("input", {
      type: "number", "data-focus-key": "recurrence_reopen_lead",
    });
    leadInput.min = 0;
    const leadUnitSelect = this._el("select", {});
    const leadSpinUp = this._el("button", { className: "spin-btn spin-up", textContent: "\u25b4", type: "button" });
    const leadSpinDown = this._el("button", { className: "spin-btn spin-down", textContent: "\u25be", type: "button" });
    const _fillLeadUnits = () => {
      const base = recurrenceUnitSelect.value === "hours" ? ["minutes", "hours"] : ["hours", "days"];
      // Only units that can hold at least 1 below the interval: "days" on a
      // daily task (or "hours" on an hourly one) could only ever be 0.
      const units = base.filter((u, i) => i === 0 || _leadMaxIn(u) >= 1);
      // A stored lead only minutes can express (90 min on a daily task)
      // keeps its unit rather than being shown rounded.
      const shown = _shownLead();
      if (shown % LEAD_FACTORS[units[0]] !== 0) units.unshift("minutes");
      const pick = [...units].reverse().find(u => shown % LEAD_FACTORS[u] === 0) || units[0];
      leadUnitSelect.replaceChildren(...units.map(u => {
        const opt = this._el("option", { value: u, textContent: this._t(`rec_${u}`) });
        if (u === pick) opt.selected = true;
        return opt;
      }));
      leadInput.value = String(shown / LEAD_FACTORS[pick]);
      leadInput.max = String(_leadMaxIn(pick));
    };
    const saveLead = () => {
      const unit = leadUnitSelect.value;
      const n = Math.min(Math.max(0, parseInt(leadInput.value) || 0), _leadMaxIn(unit));
      leadInput.value = String(n);
      leadInput.max = String(_leadMaxIn(unit));
      if (n * LEAD_FACTORS[unit] === leadMinutes) return;
      leadMinutes = n * LEAD_FACTORS[unit];
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, { recurrence_reopen_lead: leadMinutes }));
    };
    // A shorter interval can leave the lead as long as the interval itself;
    // drop it with the same save rather than keep a value that does nothing.
    const _leadFieldsAfterIntervalChange = () => {
      if (!leadSupported) return {};
      _fillLeadUnits();
      if (leadMinutes > 0 && leadMinutes >= _intervalMinutes()) {
        leadMinutes = 0;
        _fillLeadUnits();
        return { recurrence_reopen_lead: 0 };
      }
      return {};
    };
    leadSpinUp.addEventListener("click", () => {
      leadInput.value = Math.min(_leadMaxIn(leadUnitSelect.value), (parseInt(leadInput.value) || 0) + 1);
      leadInput.dispatchEvent(new Event("change"));
    });
    leadSpinDown.addEventListener("click", () => {
      leadInput.value = Math.max(0, (parseInt(leadInput.value) || 0) - 1);
      leadInput.dispatchEvent(new Event("change"));
    });
    const recurrenceLeadSection = this._el("div", { className: "recurrence-lead-section" }, [
      this._el("div", { className: "recurrence-input-row" }, [
        this._el("div", { className: "field-wrap inline" }, [
          leadInput,
          this._el("span", { textContent: this._t("rec_lead_lbl") }),
          this._el("div", { className: "spin-btns" }, [leadSpinUp, leadSpinDown]),
        ]),
        this._el("div", { className: "sel-wrap inline" }, [
          leadUnitSelect,
          this._el("span", { textContent: this._t("rec_unit_lbl") }),
        ]),
      ]),
      this._el("div", { className: "recurrence-note", textContent: this._t("rec_lead_hint") }),
    ]);
    if (!leadSupported) recurrenceLeadSection.style.display = "none";

    // For Todoist: hide start date + recurrence time row entirely —
    // the due date/time fields already control when the recurrence starts.
    const providerSyncsRecurrence = caps && caps.can_sync_recurrence;

    // Todoist's natural-language parser can't model "every N months on the
    // <pattern>" or "every N years on TT.MM" — match Todoist's web UI by
    // hiding the pattern picker entirely whenever value > 1 + months/years
    // on a Todoist list.  Forces the data to stay on "no pattern".
    const todoistPatternBlocked = (unit, value) => (
      providerSyncsRecurrence && value > 1 && (unit === "months" || unit === "years")
    );

    const applyRowVisibility = (unit, value) => {
      recurrenceIntervalRow.style.display = "";
      // Hours/days: only the anchor choice.  A provider that runs the
      // recurrence itself (Todoist) decides that on its own, so the
      // "Ab Fälligkeit" option is ours to offer only on other lists.
      recurrenceBasicRadioRow.style.display =
        ((unit === "hours" || unit === "days") && !providerSyncsRecurrence) ? "" : "none";
      for (const lbl of [weekPatDueLabel, monthPatDueLabel, yearPatDueLabel]) {
        lbl.style.display = providerSyncsRecurrence ? "none" : "";
      }
      // Weekly: radios always visible when unit=weeks; the checkbox row only
      // when "Am" is selected.
      recurrenceWeekSection.style.display = unit === "weeks" ? "" : "none";
      recurrenceWeekdayCheckboxRow.style.display = (unit === "weeks" && weekPatOnRadio.checked) ? "" : "none";
      const blockMonthly = todoistPatternBlocked(unit, value);
      recurrenceMonthSection.style.display = unit === "months" ? "" : "none";
      recurrenceMonthRadioRow.style.display = (unit === "months" && !blockMonthly) ? "" : "none";
      recurrenceMonthDomRow.style.display = (unit === "months" && !blockMonthly && monthPatDomRadio.checked) ? "" : "none";
      recurrenceMonthNthRow.style.display = (unit === "months" && !blockMonthly && monthPatNthRadio.checked) ? "" : "none";
      recurrenceTodoistMonthNote.style.display = (unit === "months" && blockMonthly) ? "" : "none";
      recurrenceYearRow.style.display = unit === "years" ? "" : "none";
      const blockYearly = todoistPatternBlocked(unit, value);
      // Yearly: radios visible (when not Todoist-blocked); TT.MM only when "Am".
      recurrenceYearRadioRow.style.display = (unit === "years" && !blockYearly) ? "" : "none";
      recurrenceYearInputs.style.display = (unit === "years" && !blockYearly && yearPatOnRadio.checked) ? "" : "none";
      recurrenceTodoistYearNote.style.display = (unit === "years" && blockYearly) ? "" : "none";
      // Time row: only meaningful when the recurrence triggers on a calendar
      // day (so hours mode hides it).  For Todoist we still show it so the
      // user can set "happens at HH:MM".
      const hideTime = unit === "hours";
      recurrenceTimeRow.style.display = hideTime ? "none" : "";
      // Start date: hidden for Todoist (due_date drives the anchor).
      recurrenceStartDateRow.style.display = providerSyncsRecurrence ? "none" : "";
      if (leadSupported) _fillLeadUnits();
    };
    applyRowVisibility(recurrenceUnit, recurrenceValue);

    const applyEndTypeVisibility = (endType) => {
      recurrenceEndDateWrap.style.display = endType === "date" ? "" : "none";
      recurrenceCountRow.style.display = endType === "count" ? "" : "none";
    };
    applyEndTypeVisibility(initialEndType);

    const applyMonthPatternState = () => {
      const isDom = monthPatDomRadio.checked;
      const isNth = monthPatNthRadio.checked;
      monthDomSelect.disabled = !recSwitch.checked || !isDom;
      monthNthSelect.disabled = !recSwitch.checked || !isNth;
      monthWeekdaySelect.disabled = !recSwitch.checked || !isNth;
    };
    const applyWeekPatternState = () => {
      const isOn = weekPatOnRadio.checked;
      weekdayCheckboxes.forEach(cb => { cb.disabled = !recSwitch.checked || !isOn; });
    };
    const applyYearPatternState = () => {
      const isOn = yearPatOnRadio.checked;
      const off = !recSwitch.checked || !isOn;
      annDayInput.disabled = off;
      annDaySpinUp.disabled = off;
      annDaySpinDown.disabled = off;
      annMonthSelect.disabled = off;
    };

    const applyEnabledState = (enabled) => {
      recurrenceValueInput.disabled = !enabled;
      recurrenceUnitSelect.disabled = !enabled;
      spinUp.disabled = !enabled;
      spinDown.disabled = !enabled;
      basicPatNoneRadio.disabled = !enabled;
      basicPatDueRadio.disabled = !enabled;
      weekPatNoneRadio.disabled = !enabled;
      weekPatDueRadio.disabled = !enabled;
      weekPatOnRadio.disabled = !enabled;
      monthPatNoneRadio.disabled = !enabled;
      monthPatDueRadio.disabled = !enabled;
      monthPatDomRadio.disabled = !enabled;
      monthPatNthRadio.disabled = !enabled;
      yearPatNoneRadio.disabled = !enabled;
      yearPatDueRadio.disabled = !enabled;
      yearPatOnRadio.disabled = !enabled;
      recurrenceStartDateInput.disabled = !enabled;
      recurrenceTimeInput.disabled = !enabled;
      endDateRadio.disabled = !enabled;
      endCountRadio.disabled = !enabled;
      recurrenceEndDateInput.disabled = !enabled;
      recurrenceMaxCountInput.disabled = !enabled;
      spinUp2.disabled = !enabled;
      spinDown2.disabled = !enabled;
      leadInput.disabled = !enabled;
      leadUnitSelect.disabled = !enabled;
      leadSpinUp.disabled = !enabled;
      leadSpinDown.disabled = !enabled;
      applyMonthPatternState();
      applyWeekPatternState();
      applyYearPatternState();
    };
    applyEnabledState(recurrenceEnabled);

    // ---- Helpers: collect current sub-pattern fields into a payload -------
    const _normaliseDom = () => {
      const v = monthDomSelect.value;
      return v === "last" ? "last" : parseInt(v, 10);
    };
    const _normaliseNth = () => {
      const v = monthNthSelect.value;
      return v === "last" ? "last" : parseInt(v, 10);
    };
    const _collectMonthlyFields = () => {
      // Returns the four monthly-specific fields based on which radio is set.
      // Unused fields are explicitly null so the backend clears stale data.
      if (monthPatDomRadio.checked) {
        return {
          recurrence_month_pattern: "day_of_month",
          recurrence_day_of_month: _normaliseDom(),
          recurrence_nth_week: null,
        };
      }
      if (monthPatNthRadio.checked) {
        return {
          recurrence_month_pattern: "nth_weekday",
          recurrence_day_of_month: null,
          recurrence_nth_week: _normaliseNth(),
        };
      }
      return {
        recurrence_month_pattern: null,
        recurrence_day_of_month: null,
        recurrence_nth_week: null,
      };
    };
    // Returns:
    //   "MM-DD"      → both fields filled and valid
    //   null         → both fields empty (= clear the anchor)
    //   undefined    → partial / invalid input — caller should NOT save yet,
    //                  otherwise the round-trip reload wipes the user's
    //                  half-typed value (the bug behind "TT loses on blur").
    const _collectAnniversary = () => {
      const dStr = annDayInput.value;
      const mStr = annMonthSelect.value;
      if (!dStr && !mStr) return null;
      if (!dStr || !mStr) return undefined;
      const d = parseInt(dStr, 10);
      const m = parseInt(mStr, 10);
      if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return undefined;
      return `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    const _collectWeekdaysSelected = () => weekdayCheckboxes
      .map((cb, i) => cb.checked ? i : -1).filter(i => i >= 0);

    const _activeWeekdaysForUnit = (unit) => {
      // For weekly mode: only when "Am" is selected — the checkboxes drive it.
      // For monthly nth-weekday mode: the single weekday picker.
      // Otherwise: empty (we don't want stale weekday data lingering).
      if (unit === "weeks" && weekPatOnRadio.checked) return _collectWeekdaysSelected();
      if (unit === "months" && monthPatNthRadio.checked) {
        return [parseInt(monthWeekdaySelect.value, 10)];
      }
      return [];
    };

    // The anchor is one setting shown in every unit's radio row.  Picking it
    // in one row mirrors it into the others, so switching the unit keeps it
    // (a row whose calendar pattern is picked keeps showing the pattern).
    let currentAnchor = recurrenceAnchor;
    const syncAnchorRadios = () => {
      const due = currentAnchor === "due";
      basicPatDueRadio.checked = due;
      basicPatNoneRadio.checked = !due;
      if (!weekPatOnRadio.checked) {
        weekPatDueRadio.checked = due;
        weekPatNoneRadio.checked = !due;
      }
      if (!monthPatDomRadio.checked && !monthPatNthRadio.checked) {
        monthPatDueRadio.checked = due;
        monthPatNoneRadio.checked = !due;
      }
      if (!yearPatOnRadio.checked) {
        yearPatDueRadio.checked = due;
        yearPatNoneRadio.checked = !due;
      }
    };
    const _setAnchor = (dueChecked) => {
      currentAnchor = dueChecked ? "due" : "completion";
      syncAnchorRadios();
      return currentAnchor;
    };

    const saveBasicPattern = () => {
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_anchor: _setAnchor(basicPatDueRadio.checked),
      }));
    };

    const saveWeekdays = () => {
      // If the user toggled a checkbox while "Ab Erledigung" was selected,
      // auto-flip to "Am" so the picker stays consistent (unlikely path —
      // checkboxes are disabled in that mode — but a keyboard shortcut
      // could still hit it).
      if (recurrenceUnitSelect.value === "weeks" && !weekPatOnRadio.checked) {
        const any = weekdayCheckboxes.some(cb => cb.checked);
        if (any) {
          weekPatOnRadio.checked = true;
          applyRowVisibility("weeks", parseInt(recurrenceValueInput.value) || 1);
          applyWeekPatternState();
        }
      }
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_weekdays: _activeWeekdaysForUnit(recurrenceUnitSelect.value),
        ..._leadFieldsAfterIntervalChange(),
      }));
    };

    const saveMonthlyPattern = () => {
      applyRowVisibility(recurrenceUnitSelect.value, parseInt(recurrenceValueInput.value) || 1);
      applyMonthPatternState();
      const monthly = _collectMonthlyFields();
      const fields = { ...monthly };
      if (monthPatNoneRadio.checked || monthPatDueRadio.checked) {
        fields.recurrence_anchor = _setAnchor(monthPatDueRadio.checked);
      }
      // Keep recurrence_weekdays in sync with the nth-weekday picker.
      if (recurrenceUnitSelect.value === "months") {
        fields.recurrence_weekdays = _activeWeekdaysForUnit("months");
      }
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, fields));
    };

    const saveAnniversary = () => {
      const ann = _collectAnniversary();
      if (ann === undefined) return;  // partial input; wait for the second field
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_anniversary: ann,
      }));
    };

    const saveWeekPattern = () => {
      applyRowVisibility(recurrenceUnitSelect.value, parseInt(recurrenceValueInput.value) || 1);
      applyWeekPatternState();
      if (!weekPatOnRadio.checked) {
        // Picked "Ab Erledigung" / "Ab Fälligkeit" — clear weekdays AND
        // drop the override so a future reload renders the radio purely
        // from data.
        this._weekPatternOverride.delete(task.id);
        _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
          recurrence_weekdays: [],
          recurrence_anchor: _setAnchor(weekPatDueRadio.checked),
        }));
      } else {
        // Picked "Am" without any checkboxes yet — remember the choice
        // locally so an unrelated reload (e.g. from a still-pending
        // saveInterval) doesn't snap the radio back to "Ab Erledigung".
        // Once the user actually picks a weekday, saveWeekdays writes
        // the data and the override becomes redundant.
        this._weekPatternOverride.set(task.id, "on");
      }
    };

    const saveYearPattern = () => {
      applyRowVisibility(recurrenceUnitSelect.value, parseInt(recurrenceValueInput.value) || 1);
      applyYearPatternState();
      if (!yearPatOnRadio.checked) {
        this._yearPatternOverride.delete(task.id);
        _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
          recurrence_anniversary: null,
          recurrence_anchor: _setAnchor(yearPatDueRadio.checked),
        }));
      } else {
        // Same sticky-UI rule as the weekly radio.
        this._yearPatternOverride.set(task.id, "on");
        const ann = _collectAnniversary();
        if (!ann) return;  // wait for the user to fill in TT and the month
        _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
          recurrence_anniversary: ann,
        }));
      }
    };

    const saveInterval = () => {
      const val = Math.max(1, Math.min(365, parseInt(recurrenceValueInput.value) || 1));
      recurrenceValueInput.value = val;
      const newUnit = recurrenceUnitSelect.value;
      // Switching unit clears any sticky-UI overrides for the OTHER unit
      // dimensions — picking "Am" under "Wochen", switching to "Jahre",
      // then back to "Wochen" should give a fresh derivation from the
      // saved data rather than a leftover override from the earlier
      // session.  Same idea for Year ↔ Month transitions.
      if (newUnit !== "weeks") this._weekPatternOverride.delete(task.id);
      if (newUnit !== "years") this._yearPatternOverride.delete(task.id);
      syncAnchorRadios();
      applyRowVisibility(newUnit, val);
      // Update end-date min; auto-clear if it became invalid
      const oldEndVal = recurrenceEndDateInput.value;
      _updateEndDateMin();
      const fields = {
        recurrence_type: "interval",  // legacy "weekdays" mode is gone
        recurrence_value: val,
        recurrence_unit: newUnit,
        // Re-sync weekdays so switching unit clears stale selections
        recurrence_weekdays: _activeWeekdaysForUnit(newUnit),
      };
      // Sub-pattern fields: only meaningful for the active unit; clear the rest.
      // Todoist + value > 1 also forces "no pattern" — match Todoist web UI.
      const todoistBlocks = todoistPatternBlocked(newUnit, val);
      if (newUnit === "months" && !todoistBlocks) {
        Object.assign(fields, _collectMonthlyFields());
        fields.recurrence_anniversary = null;
      } else if (newUnit === "years" && !todoistBlocks) {
        fields.recurrence_anniversary = _collectAnniversary();
        fields.recurrence_month_pattern = null;
        fields.recurrence_day_of_month = null;
        fields.recurrence_nth_week = null;
      } else {
        fields.recurrence_month_pattern = null;
        fields.recurrence_day_of_month = null;
        fields.recurrence_nth_week = null;
        fields.recurrence_anniversary = null;
      }
      // If end date was cleared because it's now invalid, tell the server
      if (oldEndVal && !recurrenceEndDateInput.value) {
        fields.recurrence_end_date = null;
        fields.recurrence_end_type = "none";
      }
      Object.assign(fields, _leadFieldsAfterIntervalChange());
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, fields));
    };

    const _saveAndReload = (promise) => {
      // After a recurrence field is saved, make sure the local task state is
      // refreshed so the next render shows the new value.  External columns
      // need _reloadExternal(); native ones need _loadAllTasks() — without
      // this, fields like recurrence_time appeared to snap back to "00:00"
      // on re-expand until an unrelated state event rewrote the cached task.
      //
      // Mark the reload as a background update so _render() defers if the
      // user has already moved focus to another field — otherwise picking
      // an option, then clicking the next field, would tear down the DOM
      // mid-click and the click would be lost.
      promise?.then(async () => {
        this._bgUpdates = (this._bgUpdates || 0) + 1;
        try {
          if (this._isExternalCol(colIdx)) await this._reloadExternal();
          else await this._loadAllTasks();
        } finally {
          this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1);
        }
      });
    };

    const saveStartDate = () => {
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_start_date: recurrenceStartDateInput.value || null,
      }));
    };

    const saveRecurrenceTime = () => {
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_time: recurrenceTimeInput.value || null,
      }));
    };

    const _selectedEndType = () => endCountRadio.checked ? "count" : "date";
    const saveEndCondition = () => {
      const endType = _selectedEndType();
      applyEndTypeVisibility(endType);
      // Clamp manually entered end date to the minimum allowed
      if (endType === "date" && recurrenceEndDateInput.value) {
        const minEnd = _computeMinEndDate();
        if (recurrenceEndDateInput.value < minEnd) {
          recurrenceEndDateInput.value = minEnd;
        }
      }
      // "Bis" with an empty date = no end (same idea as an empty Beginn).
      // The radio stays on "Bis" — that's now the default — but the saved
      // end_type is "none" so the backend doesn't try to clamp on a
      // missing date.  Reload doesn't snap the radio back because empty
      // "Bis" + count-not-selected → initialEndType === "date" still wins.
      const effectiveEndType = (endType === "date" && !recurrenceEndDateInput.value) ? "none" : endType;
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, {
        recurrence_end_type: effectiveEndType,
        recurrence_end_date: endType === "date" ? (recurrenceEndDateInput.value || null) : null,
        recurrence_max_count: endType === "count" ? (parseInt(recurrenceMaxCountInput.value) || null) : null,
      }));
    };

    recSwitch.addEventListener("change", () => {
      const enabled = recSwitch.checked;
      applyEnabledState(enabled);
      const newUnit = recurrenceUnitSelect.value;
      const val = Math.max(1, Math.min(365, parseInt(recurrenceValueInput.value) || 1));
      const endType = _selectedEndType();
      const todoistBlocks = todoistPatternBlocked(newUnit, val);
      const fields = {
        recurrence_enabled: enabled,
        recurrence_type: "interval",
        recurrence_value: val,
        recurrence_unit: newUnit,
        recurrence_weekdays: _activeWeekdaysForUnit(newUnit),
        recurrence_start_date: recurrenceStartDateInput.value || null,
        recurrence_time: recurrenceTimeInput.value || null,
        recurrence_end_type: endType,
        recurrence_end_date: endType === "date" ? (recurrenceEndDateInput.value || null) : null,
        recurrence_max_count: endType === "count" ? (parseInt(recurrenceMaxCountInput.value) || null) : null,
        recurrence_anchor: currentAnchor,
        // Include current reminders — Todoist deletes them when due changes,
        // so the backend needs to re-create them after the update.
        reminders: task.reminders || [],
      };
      if (newUnit === "months" && !todoistBlocks) {
        Object.assign(fields, _collectMonthlyFields());
        fields.recurrence_anniversary = null;
      } else if (newUnit === "years" && !todoistBlocks) {
        fields.recurrence_anniversary = _collectAnniversary();
        fields.recurrence_month_pattern = null;
        fields.recurrence_day_of_month = null;
        fields.recurrence_nth_week = null;
      } else {
        fields.recurrence_month_pattern = null;
        fields.recurrence_day_of_month = null;
        fields.recurrence_nth_week = null;
        fields.recurrence_anniversary = null;
      }
      // Switched on: the list's lead, as shown; switched off: shown again
      // as the one a later switch takes over.
      leadMinutes = enabled ? _shownLead() : null;
      if (enabled && leadSupported) fields.recurrence_reopen_lead = leadMinutes;
      _fillLeadUnits();
      _saveAndReload(this._updateTaskRouted(colIdx, task.id, fields));
    });

    recurrenceValueInput.addEventListener("change", saveInterval);
    recurrenceValueInput.addEventListener("keydown", (e) => { if (e.key === "Enter") recurrenceValueInput.blur(); });
    const _blurAfterChange = (el) => this._blurSelectOnChange(el);
    recurrenceUnitSelect.addEventListener("change", saveInterval);
    _blurAfterChange(recurrenceUnitSelect);
    weekdayCheckboxes.forEach(cb => cb.addEventListener("change", saveWeekdays));
    [basicPatNoneRadio, basicPatDueRadio].forEach(r =>
      r.addEventListener("change", saveBasicPattern));
    [monthPatNoneRadio, monthPatDueRadio, monthPatDomRadio, monthPatNthRadio].forEach(r =>
      r.addEventListener("change", saveMonthlyPattern));
    monthDomSelect.addEventListener("change", saveMonthlyPattern);
    monthNthSelect.addEventListener("change", saveMonthlyPattern);
    monthWeekdaySelect.addEventListener("change", saveMonthlyPattern);
    _blurAfterChange(monthDomSelect);
    _blurAfterChange(monthNthSelect);
    _blurAfterChange(monthWeekdaySelect);
    annDayInput.addEventListener("blur", saveAnniversary);
    annDayInput.addEventListener("keydown", (e) => { if (e.key === "Enter") annDayInput.blur(); });
    annMonthSelect.addEventListener("change", saveAnniversary);
    _blurAfterChange(annMonthSelect);
    [weekPatNoneRadio, weekPatDueRadio, weekPatOnRadio].forEach(r =>
      r.addEventListener("change", saveWeekPattern));
    [yearPatNoneRadio, yearPatDueRadio, yearPatOnRadio].forEach(r =>
      r.addEventListener("change", saveYearPattern));
    [endDateRadio, endCountRadio].forEach(r =>
      r.addEventListener("change", saveEndCondition));
    // Use "blur" instead of "change" for the time/date inputs: type="time"
    // fires change the moment the hour alone becomes a valid time ("20:00"),
    // which would trigger a save + re-render and yank the focus out before
    // the user can type the minutes.  Blur triggers on Enter (via the keydown
    // handler below) and when the user tabs or clicks away, which is the
    // natural commit moment.
    recurrenceStartDateInput.addEventListener("blur", saveStartDate);
    recurrenceStartDateInput.addEventListener("keydown", (e) => { if (e.key === "Enter") recurrenceStartDateInput.blur(); });
    recurrenceTimeInput.addEventListener("blur", saveRecurrenceTime);
    recurrenceTimeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") recurrenceTimeInput.blur(); });
    recurrenceEndDateInput.addEventListener("blur", saveEndCondition);
    recurrenceEndDateInput.addEventListener("keydown", (e) => { if (e.key === "Enter") recurrenceEndDateInput.blur(); });
    recurrenceMaxCountInput.addEventListener("change", saveEndCondition);
    recurrenceMaxCountInput.addEventListener("keydown", (e) => { if (e.key === "Enter") recurrenceMaxCountInput.blur(); });
    leadInput.addEventListener("change", saveLead);
    leadInput.addEventListener("keydown", (e) => { if (e.key === "Enter") leadInput.blur(); });
    leadUnitSelect.addEventListener("change", saveLead);
    _blurAfterChange(leadUnitSelect);

    return this._el("div", { className: "detail-section" }, [
      recurrenceToggleRow,
      recurrenceIntervalRow,
      recurrenceBasicRadioRow,
      recurrenceWeekSection,
      recurrenceMonthSection,
      recurrenceYearRow,
      recurrenceTimeRow,
      recurrenceStartDateRow,
      recurrenceLeadSection,
      recurrenceEndRow,
      recurrenceEndDateWrap,
      recurrenceCountRow,
    ]);
  }

  _buildAssignedPersonSection(task, colIdx) {
    // One chip per person; any number can be on (issue #75). The first one
    // switched on is the primary assignee - what older automations and
    // single-assignee providers see as assigned_person.
    // hidden_persons: people never offered for assignment in this card (system
    // or visiting persons). Someone already assigned stays visible.
    const hiddenPersons = (this._sourceCol(colIdx) || {}).hidden_persons || [];
    const assigned = _assignees(task);
    const offered = personEntries(this._hass, hiddenPersons.filter((p) => !assigned.includes(p)));
    const row = this._el("div", { className: "assignee-chip-row" });
    for (const { value, label } of offered) {
      const on = assigned.includes(value);
      const chip = this._el("button", {
        className: "assignee-chip" + (on ? " active" : ""),
        textContent: label,
        title: label,
      });
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", () => {
        const now = _assignees(task);
        const next = now.includes(value) ? now.filter((p) => p !== value) : [...now, value];
        task.assigned_persons = next;
        task.assigned_person = next[0] || null;
        this._render();
        this._updateTaskRouted(colIdx, task.id, { assigned_persons: next });
      });
      row.appendChild(chip);
    }
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("assigned_to") }),
      row,
    ]);
  }

  // Section picker in the task details: the same section_id update a drag
  // across a section header makes, without needing to drag (hard on phones,
  // and impossible to discover for tasks added outside a section).
  _buildSectionPickerSection(task, colIdx) {
    const sections = (this._columns[colIdx].sections || [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const sectionSelect = this._el("select", {});
    const noneOpt = this._el("option", { value: "", textContent: this._t("ed_default_none") });
    const current = sections.some((x) => x.id === task.section_id) ? task.section_id : "";
    if (!current) noneOpt.selected = true;
    sectionSelect.appendChild(noneOpt);
    for (const sec of sections) {
      const opt = this._el("option", { value: sec.id, textContent: sec.name });
      if (sec.id === current) opt.selected = true;
      sectionSelect.appendChild(opt);
    }
    sectionSelect.addEventListener("change", async () => {
      const sectionId = sectionSelect.value || null;
      task.section_id = sectionId;
      this._render();
      try {
        await this._saveSectionId(colIdx, task.id, sectionId);
      } catch (err) {
        this._showError(`Section update failed: ${err.message || err}`);
        // Put the task back where the server still has it.
        if (this._isExternalCol(colIdx)) await this._reloadExternal();
        else await this._loadAllTasks();
      }
    });
    this._blurSelectOnChange(sectionSelect);
    const sectionWrap = this._el("div", { className: "sel-wrap no-label" }, [sectionSelect]);
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("section_label") }),
      sectionWrap,
    ]);
  }

  _buildTagsSection(task, colIdx) {
    const tagSectionChildren = [
      this._el("label", { className: "detail-label", textContent: this._t("tags") }),
    ];
    const taskTags = task.tags || [];
    if (taskTags.length > 0) {
      const tagListEl = this._el("div", { className: "tag-list" });
      for (const tag of taskTags) {
        const removeBtn = this._el("button", {
          className: "remove-tag-btn",
          title: this._t("remove_tag"),
          textContent: "\u00D7",
        });
        removeBtn.addEventListener("click", () => {
          const newTags = taskTags.filter((t) => t !== tag);
          task.tags = newTags;
          this._render();
          this._updateTaskRouted(colIdx, task.id, { tags: newTags });
        });
        tagListEl.appendChild(
          this._el("span", { className: "tag-item" }, [
            this._el("span", { textContent: "#" + tag }),
            removeBtn,
          ])
        );
      }
      tagSectionChildren.push(tagListEl);
    }
    const tagInput = this._el("input", {
      type: "text",
      placeholder: this._t("tag_placeholder"),
      "data-focus-key": "tag_input",
      autocomplete: "off",
    });
    const tagInputWrap = this._el("div", { className: "field-wrap" }, [
      tagInput,
      this._el("span", { textContent: this._t("add_tag").replace("+ ", "") }),
    ]);
    const dropdown = this._el("div", {
      className: "tag-autocomplete-dropdown",
      role: "listbox",
      "aria-label": this._t("tag_suggestions_label"),
    });
    dropdown.hidden = true;

    // Popover state lives on a closure shared by the handlers below.
    // activeIndex = -1 means "user has not navigated into the list yet",
    // so Enter commits the raw input value instead of the first match —
    // this lets the user type e.g. "hau" and add it as a new tag even
    // when "haus" is in the suggestion list.
    const state = { activeIndex: -1, items: [] };

    const applyHighlight = () => {
      for (let i = 0; i < state.items.length; i++) {
        state.items[i].classList.toggle("highlighted", i === state.activeIndex);
      }
    };

    const refresh = () => {
      const q = tagInput.value.trim().replace(/^#/, "").toLowerCase();
      // The list's fixed tags (issue #61) come first and are always offered;
      // then whatever else is in use on the loaded tasks.
      const catalog = this._columns[colIdx]?.tagCatalog || [];
      const known = [...new Set([...catalog, ...this._collectAllKnownTags()])];
      const taken = new Set(task.tags || []);
      const suggestions = known.filter(t => !taken.has(t) && (q === "" || t.startsWith(q)));
      // A new tag one or two letters away from a fixed one is most likely a
      // typo that would split the category in two — offer the fixed one.
      const typoFixes = (q && !catalog.includes(q))
        ? catalog.filter(t => !taken.has(t) && !suggestions.includes(t) && this._isNearMiss(q, t))
        : [];
      dropdown.innerHTML = "";
      state.items = [];
      state.activeIndex = -1;
      for (const tag of typoFixes) {
        const item = this._el("div", {
          className: "tag-autocomplete-item did-you-mean",
          role: "option",
          "data-tag": tag,
          textContent: this._t("tag_did_you_mean", "#" + tag),
        });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this._addTagFromSuggestion(task, colIdx, tagInput, tag);
        });
        dropdown.appendChild(item);
        state.items.push(item);
      }
      if (suggestions.length === 0 && typoFixes.length === 0) {
        dropdown.appendChild(this._el("div", {
          className: "tag-autocomplete-empty",
          textContent: this._t("tag_no_matches"),
        }));
        return;
      }
      for (const tag of suggestions) {
        const item = this._el("div", {
          className: "tag-autocomplete-item" + (catalog.includes(tag) ? " catalog" : ""),
          role: "option",
          "data-tag": tag,
          textContent: "#" + tag,
        });
        // mousedown (not click) — click would fire after the input's blur,
        // which closes the popover before the pick can register.
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this._addTagFromSuggestion(task, colIdx, tagInput, tag);
        });
        dropdown.appendChild(item);
        state.items.push(item);
      }
    };

    tagInput.addEventListener("focus", () => {
      dropdown.hidden = false;
      refresh();
    });
    tagInput.addEventListener("input", () => {
      dropdown.hidden = false;
      refresh();
    });
    tagInput.addEventListener("blur", () => {
      setTimeout(() => {
        dropdown.hidden = true;
        state.activeIndex = -1;
      }, 120);
    });
    tagInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!dropdown.hidden) {
          e.preventDefault();
          dropdown.hidden = true;
          state.activeIndex = -1;
        }
        return;
      }
      const n = state.items.length;
      const listOpen = !dropdown.hidden && n > 0;
      const tabForward = e.key === "Tab" && !e.shiftKey;
      const tabBackward = e.key === "Tab" && e.shiftKey;
      if (listOpen && (e.key === "ArrowDown" || tabForward)) {
        e.preventDefault();
        state.activeIndex = state.activeIndex < 0 ? 0 : (state.activeIndex + 1) % n;
        applyHighlight();
        state.items[state.activeIndex].scrollIntoView({ block: "nearest" });
        return;
      }
      if (listOpen && (e.key === "ArrowUp" || tabBackward)) {
        e.preventDefault();
        state.activeIndex = state.activeIndex < 0 ? n - 1 : (state.activeIndex - 1 + n) % n;
        applyHighlight();
        state.items[state.activeIndex].scrollIntoView({ block: "nearest" });
        return;
      }
      if (e.key === "Enter") {
        if (listOpen && state.activeIndex >= 0) {
          e.preventDefault();
          const pick = state.items[state.activeIndex].dataset.tag;
          this._addTagFromSuggestion(task, colIdx, tagInput, pick);
        } else {
          this._commitNewTag(task, colIdx, tagInput);
        }
      }
    });

    const anchor = this._el("div", { className: "tag-autocomplete-anchor" }, [
      tagInputWrap,
      dropdown,
    ]);
    tagSectionChildren.push(anchor);
    return this._el("div", { className: "detail-section" }, tagSectionChildren);
  }

  // Damerau-free edit distance ≤ 1 (short tags) or ≤ 2, early-exit: good
  // enough to catch "kitchn" / "kichen" for "kitchen" without flagging
  // unrelated short words.
  _isNearMiss(a, b) {
    if (a === b) return false;
    const max = Math.min(a.length, b.length) <= 4 ? 1 : 2;
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        rowMin = Math.min(rowMin, cur[j]);
      }
      if (rowMin > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }

  _collectAllKnownTags() {
    const all = new Set();
    for (const cs of (this._columns || [])) {
      for (const t of (cs?.tasks || [])) {
        for (const tag of (t.tags || [])) all.add(tag);
      }
    }
    return [...all].sort();
  }

  _commitNewTag(task, colIdx, tagInput) {
    const val = tagInput.value.trim().toLowerCase();
    const taskTags = task.tags || [];
    if (val && !taskTags.includes(val)) {
      const newTags = [...taskTags, val];
      task.tags = newTags;
      tagInput.value = "";
      this._render();
      this._updateTaskRouted(colIdx, task.id, { tags: newTags });
    } else {
      tagInput.value = "";
    }
  }

  _addTagFromSuggestion(task, colIdx, tagInput, tag) {
    const taskTags = task.tags || [];
    tagInput.value = "";
    if (taskTags.includes(tag)) return;
    const newTags = [...taskTags, tag];
    task.tags = newTags;
    this._render();
    this._updateTaskRouted(colIdx, task.id, { tags: newTags });
  }

  _buildRemindersSection(task, colIdx) {
    const taskReminders = task.reminders || [];
    const reminderSectionChildren = [
      this._el("label", { className: "detail-label", textContent: this._t("reminder") }),
    ];
    const _rebuildReminders = (newReminders) => {
      task.reminders = newReminders;
      this._render();
      this._updateTaskRouted(colIdx, task.id, { reminders: newReminders });
    };
    for (let ri = 0; ri < taskReminders.length; ri++) {
      const offset = taskReminders[ri];
      const sel = this._el("select", {});
      for (const opt of reminderOffsetOptions(this, offset)) sel.appendChild(opt);
      sel.addEventListener("change", () => {
        const updated = [...taskReminders];
        updated[ri] = parseInt(sel.value, 10);
        _rebuildReminders(updated);
      });
      this._blurSelectOnChange(sel);
      const removeBtn = this._el("button", {
        className: "reminder-remove",
        textContent: "\u00D7",
        title: this._t("remove_reminder"),
      });
      removeBtn.addEventListener("click", () => {
        const updated = taskReminders.filter((_, i) => i !== ri);
        _rebuildReminders(updated);
      });
      const remSelWrap = this._el("div", { className: "sel-wrap" }, [
        sel,
        this._el("span", { textContent: this._t("reminder") }),
      ]);
      reminderSectionChildren.push(this._el("div", { className: "reminder-row" }, [remSelWrap, removeBtn]));
    }
    if (taskReminders.length < MAX_REMINDERS) {
      const addReminderBtn = this._el("button", {
        className: "add-reminder-btn",
        textContent: this._t("rem_add"),
      });
      addReminderBtn.addEventListener("click", () => {
        const used = new Set(taskReminders);
        _rebuildReminders([...taskReminders, nextFreeReminderOffset(used)]);
      });
      reminderSectionChildren.push(addReminderBtn);
    }
    return this._el("div", { className: "detail-section" }, reminderSectionChildren);
  }

  _buildActionsSection(task, colIdx) {
    const col = this._sourceCol(colIdx);
    const children = [];

    // What the card type adds first ("Plan for…" on a card of lists).
    children.push(...this._extraTaskActions(task, colIdx));

    // Move to another list (issue #47): opens an in-card dialog listing the
    // possible targets and routes through the same WS commands as
    // cross-column drag, so external lists work as source and target too.
    const moveTargets = this._moveTargets(colIdx);
    if (col.show_move !== false && moveTargets.length > 0) {
      const moveBtn = this._el("button", {
        className: "move-task-btn",
        textContent: this._t("move_task"),
      });
      moveBtn.addEventListener("click", () => this._moveTaskViaDialog(task, colIdx, moveTargets));
      children.push(moveBtn);
    }

    // Duplicate: create an identical copy (same assignee, recurrence, tags,
    // notes, due date — everything). Linked lists too: the provider gets the
    // copy, the overlay keeps what the provider cannot.
    {
      const dupBtn = this._el("button", {
        className: "duplicate-task-btn",
        textContent: this._t("duplicate_task"),
      });
      dupBtn.addEventListener("click", () => {
        // Close the tile detail sheet (no-op in the inline list view) so repeated
        // clicks don't silently pile up copies behind the popup.
        this._closeTaskDetailSheet();
        this._duplicateTask(task, colIdx);
      });
      children.push(dupBtn);
    }

    const deleteBtn = this._el("button", {
      className: "delete-task-btn",
      textContent: this._t("delete_task"),
    });
    deleteBtn.addEventListener("click", () => {
      // Close the sheet first (no-op for the inline list view) so the popup
      // doesn't linger showing a task being deleted; synchronous so the delete's
      // re-render can't re-attach it.
      this._closeTaskDetailSheet();
      this._deleteTask(task.id, colIdx);
    });
    children.push(deleteBtn);

    return this._el("div", { className: "detail-actions" }, children);
  }

  async _duplicateTask(task, colIdx) {
    if (this._isExternalCol(colIdx)) {
      // A linked list refuses far more often than a native one (read-only
      // calendar, provider rate limit), so a failure has to be said out
      // loud. A timeout is not a refusal: the provider may hold the copy,
      // and the reload will show it either way.
      let err = null;
      try {
        await this._callWs("home_tasks/duplicate_external_task", {
          entity_id: this._colEntityId(colIdx),
          task_uid: task.id,
          assigned_person: task.assigned_person ?? null,
        }, { rethrow: true });
      } catch (e) {
        err = e;
      }
      if (err && !this._isWsTimeout(err)) this._showError(this._t("duplicate_failed"));
      // The provider decides where the copy lands and when its entity
      // reflects it - same delayed reload as every other linked-list edit.
      this._reloadExternal(colIdx);
      return;
    }
    const newTask = await this._callWs("home_tasks/duplicate_task", {
      list_id: this._colListId(colIdx),
      task_id: task.id,
      assigned_person: task.assigned_person ?? null,
    });
    if (!newTask) return;
    // Reload once — the backend placed the copy right after the source and
    // renumbered, so we fetch the authoritative order with a single render
    // instead of an optimistic insert + render followed by a second reload render.
    await this._loadAllTasks();
  }

  // Possible move targets for a task in colIdx (issue #47): every native
  // list except the source list, plus the external lists shown as other
  // columns of this card (a cross move needs an entity_id, which the card
  // only knows for configured columns).
  _moveTargets(colIdx) {
    const targets = [];
    const srcIsExternal = this._isExternalCol(colIdx);
    const srcListId = srcIsExternal ? null : this._colListId(colIdx);
    for (const list of this._lists || []) {
      if (list.id !== srcListId) targets.push({ label: list.name, list_id: list.id });
    }
    const srcEntityId = srcIsExternal ? this._colEntityId(colIdx) : null;
    const seen = new Set();
    for (let i = 0; i < (this._sourceCols() || []).length; i++) {
      if (!this._isExternalCol(i)) continue;
      const eid = this._colEntityId(i);
      if (!eid || eid === srcEntityId || seen.has(eid)) continue;
      seen.add(eid);
      const st = this._hass && this._hass.states ? this._hass.states[eid] : null;
      targets.push({ label: (st && st.attributes && st.attributes.friendly_name) || eid, entity_id: eid });
    }
    return targets;
  }

  async _moveTaskViaDialog(task, colIdx, targets) {
    const choice = await this._moveDialog(task, targets);
    if (!choice) return;
    // Close the sheet before the move (no-op in the inline list view) so the
    // popup doesn't linger showing a task that just left this list.
    this._closeTaskDetailSheet();
    const payload = { task_id: task.id };
    if (this._isExternalCol(colIdx)) payload.source_entity_id = this._colEntityId(colIdx);
    else payload.source_list_id = this._colListId(colIdx);
    if (choice.entity_id) payload.target_entity_id = choice.entity_id;
    else payload.target_list_id = choice.list_id;
    await this._execMove(payload);
    await this._loadAllTasks();
    if (payload.source_entity_id || payload.target_entity_id) this._reloadExternal();
  }

  // Single move executor shared by cross-column drag & drop and the detail
  // sheet's Move dialog: native→native goes through the move_task fast path,
  // anything external through move_task_cross. Failures (backend errors,
  // disconnects) surface as the in-card error toast instead of vanishing in
  // _callWs's silent catch. Returns true on success.
  async _execMove(payload) {
    const bothNative = !!(payload.source_list_id && payload.target_list_id);
    const msg = {
      type: bothNative ? "home_tasks/move_task" : "home_tasks/move_task_cross",
      ...payload,
    };
    try {
      // No artificial timeout: cross moves against slow external providers
      // legitimately take longer than any fixed budget (adapter create,
      // per-sub-task calls, reminder sync), and a false "failed" makes users
      // retry into duplicates. WS errors and disconnects reject on their own.
      await this._hass.callWS(msg);
      return true;
    } catch (err) {
      this._showError("Move failed: " + ((err && err.message) || err));
      return false;
    }
  }

  // The confirm dialog plus a target <select>; resolves with the chosen
  // target object, or null on cancel/Esc/backdrop click.
  _moveDialog(task, targets) {
    const sel = this._el("select", { className: "ht-move-select" },
      targets.map((t, i) => this._el("option", { value: String(i), textContent: t.label })));
    return this._modalDialog({
      message: this._t("move_task_msg", task.title),
      okLabel: this._t("move_task"),
      body: [sel],
      resolveOk: () => targets[sel.value],
    });
  }

  _buildImageSection(task, colIdx) {
    const col = this._sourceCol(colIdx);
    const isGenerating = this._generatingImage.has(task.id);

    const children = [];

    // --- Show existing image ---
    if (task.image_url) {
      const imgWrap = this._el("div", { className: "task-image-wrap" });

      const img = this._el("img", { className: "task-image", src: task.image_url, alt: task.title });
      imgWrap.appendChild(img);

      // Remove image button (×)
      const removeBtn = this._el("button", { className: "task-image-remove", title: this._t("img_remove") });
      removeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
      // Reuse _saveImageUrl(null): it clears the image in the source column and
      // refreshes the open sheet + visible tiles without a full render.
      removeBtn.addEventListener("click", () => this._saveImageUrl(task, colIdx, null));
      imgWrap.appendChild(removeBtn);
      children.push(imgWrap);
    }

    // --- Action buttons row ---
    const busy = isGenerating;

    // Generate button
    const genBtn = this._el("button", {
      className: "generate-image-btn" + (busy ? " generating" : ""),
      disabled: busy,
    });
    if (isGenerating) {
      genBtn.innerHTML = `<span class="spinner"></span> ${this._t("img_generating")}`;
    } else {
      genBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:6px;vertical-align:-3px"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-1 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>${task.image_url ? this._t("img_regenerate") : "✨ " + this._t("img_generate")}`;
    }
    genBtn.addEventListener("click", () => this._generateTaskImage(task, colIdx, !!task.image_url));
    children.push(genBtn);

    // "Aus Mediathek" button — opens HA's native media browser dialog
    const selectBtn = this._el("button", {
      className: "generate-image-btn",
      disabled: busy,
    });
    selectBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right:6px;vertical-align:-3px"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"/></svg>${this._t("img_from_media")}`;
    selectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this._openMediaPicker(task, colIdx);
    });
    children.push(selectBtn);

    return this._el("div", { className: "detail-section detail-section--image" }, [
      this._el("label", { className: "detail-label", textContent: this._t("img_label") }),
      this._el("div", { className: "image-section-body" }, children),
    ]);
  }

  async _openMediaPicker(task, colIdx) {
    const navStack = []; // { id, title }

    const dialog = document.createElement("dialog");
    dialog.className = "mb-dialog";

    const header = this._el("div", { className: "mb-header" }, [
      this._el("span", { className: "mb-title", textContent: this._t("mb_title") }),
    ]);
    const closeBtn = document.createElement("button");
    closeBtn.className = "mb-close";
    const closeIco = document.createElement("ha-icon");
    closeIco.setAttribute("icon", "mdi:close");
    closeIco.style.cssText = "--mdc-icon-size:20px;";
    closeBtn.appendChild(closeIco);
    closeBtn.addEventListener("click", () => { dialog.close(); dialog.remove(); });
    header.appendChild(closeBtn);

    const list = this._el("div", { className: "mb-list" });

    const load = async (id) => {
      list.innerHTML = `<div class="mb-status">${this._t("mb_loading")}</div>`;
      try {
        const data = await this._hass.callWS({
          type: "media_source/browse_media",
          media_content_id: id,
        });
        list.innerHTML = "";

        if (navStack.length > 0) {
          const prev = navStack[navStack.length - 1];
          const backBtn = document.createElement("button");
          backBtn.className = "mb-item mb-back";
          const backIco = document.createElement("ha-icon");
          backIco.setAttribute("icon", "mdi:arrow-left");
          backIco.style.cssText = "--mdc-icon-size:20px;flex-shrink:0;";
          backBtn.append(backIco, prev.title);
          backBtn.addEventListener("click", () => { navStack.pop(); load(prev.id); });
          list.appendChild(backBtn);
        }

        const crumb = this._el("div", { className: "mb-crumb", textContent: data.title || this._t("mb_root") });
        list.appendChild(crumb);

        const children = data.children || [];
        const folders = children.filter(i => i.can_expand);
        const files = children.filter(i => !i.can_expand);

        const pickFile = async (item) => {
          // Save the media-source:// id, not a resolved (signed, expiring) URL —
          // the backend re-publishes it into the public www dir by copying the
          // file off disk, so it loads without auth and never expires.
          await this._saveImageUrl(task, colIdx, item.media_content_id || item.thumbnail);
          dialog.close();
          dialog.remove();
        };

        for (const item of folders) {
          const row = document.createElement("button");
          row.className = "mb-item mb-folder";
          const ico = document.createElement("ha-icon");
          const iconMap = { directory: "mdi:folder", image: "mdi:folder-image", music: "mdi:folder-music", video: "mdi:folder-play" };
          ico.setAttribute("icon", iconMap[item.media_class] || "mdi:folder");
          ico.style.cssText = "--mdc-icon-size:24px;flex-shrink:0;color:var(--secondary-text-color);";
          row.appendChild(ico);
          row.appendChild(this._el("span", { className: "mb-item-title", textContent: item.title }));
          const chev = document.createElement("ha-icon");
          chev.setAttribute("icon", "mdi:chevron-right");
          chev.style.cssText = "--mdc-icon-size:18px;flex-shrink:0;color:var(--secondary-text-color);";
          row.appendChild(chev);
          row.addEventListener("click", () => { navStack.push({ id, title: data.title || this._t("mb_back") }); load(item.media_content_id); });
          list.appendChild(row);
        }

        if (files.length > 0) {
          const grid = this._el("div", { className: "mb-grid" });
          for (const item of files) {
            const cell = document.createElement("button");
            cell.className = "mb-grid-item";
            const isImage = item.media_class === "image" || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.title || "");
            if (item.thumbnail) {
              const img = this._el("img", { className: "mb-grid-thumb", alt: item.title });
              this._fetchAuthThumb(item.thumbnail).then(src => { img.src = src; });
              cell.appendChild(img);
            } else if (isImage) {
              // No thumbnail provided — resolve the media to a URL and preview it.
              const img = this._el("img", { className: "mb-grid-thumb", alt: item.title });
              cell.appendChild(img);
              this._hass.callWS({ type: "media_source/resolve_media", media_content_id: item.media_content_id })
                .then((r) => this._fetchAuthThumb(r.url))
                .then((src) => { img.src = src; })
                .catch(() => {
                  img.remove();
                  const ico = document.createElement("ha-icon");
                  ico.setAttribute("icon", "mdi:image");
                  ico.style.cssText = "--mdc-icon-size:40px;color:var(--secondary-text-color);";
                  cell.insertBefore(ico, cell.firstChild);
                });
            } else {
              const ico = document.createElement("ha-icon");
              ico.setAttribute("icon", "mdi:image");
              ico.style.cssText = "--mdc-icon-size:40px;color:var(--secondary-text-color);";
              cell.appendChild(ico);
            }
            cell.appendChild(this._el("span", { className: "mb-grid-title", textContent: item.title }));
            cell.addEventListener("click", () => pickFile(item));
            grid.appendChild(cell);
          }
          list.appendChild(grid);
        }

        if (!data.children?.length) {
          list.appendChild(this._el("div", { className: "mb-status", textContent: this._t("mb_empty") }));
        }
      } catch (e) {
        list.innerHTML = `<div class="mb-status mb-error">${this._t("mb_error")}${e.message || e}</div>`;
      }
    };

    dialog.append(header, list);
    dialog.addEventListener("close", () => { dialog.remove(); this._revokeThumbCache(); });
    this.shadowRoot.appendChild(dialog);
    dialog.showModal();
    await load("media-source://media_source");
  }

  // Replace a task's tile(s) in place (any column) so an image change shows
  // without a full _render() — which would reset the page scroll ("jump").
  _refreshTaskTileEverywhere(taskId) {
    this.shadowRoot.querySelectorAll(`.task-tile[data-task-id="${CSS.escape(String(taskId))}"]`).forEach(el => {
      const wrap = el.closest(".tile-grid-wrap");
      const ci = wrap ? parseInt(wrap.dataset.colIdx, 10) : NaN;
      if (Number.isNaN(ci)) return;
      const cs = this._columns[ci];
      const t = cs && cs.tasks ? cs.tasks.find(x => x.id === taskId) : null;
      if (t) el.replaceWith(this._buildTaskTile(t, ci));
    });
  }

  // Refresh only the image section inside an open detail sheet (so the spinner
  // and the finished image appear without rebuilding the body or scrolling it).
  _refreshOpenSheetImage(taskId, colIdx) {
    const oldSec = this.shadowRoot.querySelector(".task-detail-sheet .detail-section--image");
    if (!oldSec) return;
    const cs = this._columns[colIdx];
    const task = cs && cs.tasks ? cs.tasks.find(t => t.id === taskId) : null;
    if (!task) return;
    // Keep the sheet's scroll position steady across the swap.
    const body = this.shadowRoot.querySelector(".task-detail-sheet .sheet-body");
    const st = body ? body.scrollTop : 0;
    oldSec.replaceWith(this._buildImageSection(task, colIdx));
    if (body) body.scrollTop = st;
  }

  async _generateTaskImage(task, colIdx, force = false) {
    const col = this._sourceCol(colIdx);
    const imgCfg = this._config.image_generation || {};

    this._generatingImage.add(task.id);
    this._refreshOpenSheetImage(task.id, colIdx);

    const payload = {
      type: "home_tasks/generate_task_image",
      task_id: task.id,
      force: force,
    };
    if (col.entity_id) payload.todo_entity_id = col.entity_id;
    else payload.entry_id = col.list_id;
    if (imgCfg.prompt_prefix) payload.prompt_prefix = imgCfg.prompt_prefix;
    if (imgCfg.entity_id) payload.entity_id = imgCfg.entity_id;

    try {
      const result = await this._hass.callWS(payload);
      // Update every column immediately.
      // • Exact ID match in the source column → full task replacement.
      // • Same title, different ID → image_url-only patch (same-title tasks in
      //   other lists that the backend also updated — they share the image but
      //   have their own task objects).
      // An id match only counts within the same list — external providers can
      // hand out colliding uids, so replacing a foreign column's task object
      // by id would corrupt it. Same list in two columns (open | done) still
      // gets the full replacement in both.
      const newImageUrl = result.task?.image_url;
      const titleKey = (task.title || "").trim().toLowerCase();
      const sourceKey = this._colSourceKey(colIdx);
      // A list that keeps its images to itself only shares within itself.
      const sourceShares = this._colSharesImages(colIdx);
      for (let ci = 0; ci < this._columns.length; ci++) {
        const cs = this._columns[ci];
        if (!cs || !cs.tasks) continue;
        const sameSource = this._colSourceKey(ci) === sourceKey;
        const sharesWithSource = sameSource
          || (sourceShares && this._colSharesImages(ci));
        for (let i = 0; i < cs.tasks.length; i++) {
          const t = cs.tasks[i];
          if (sameSource && t.id === task.id) {
            cs.tasks[i] = result.task;
          } else if (sharesWithSource && newImageUrl && titleKey
                     && (t.title || "").trim().toLowerCase() === titleKey) {
            cs.tasks[i] = { ...t, image_url: newImageUrl };
          }
        }
      }
    } catch (err) {
      console.error("Image generation failed:", err);
      alert(this._t("img_generate_failed") + (err.message || err));
    } finally {
      this._generatingImage.delete(task.id);
      this._refreshOpenSheetImage(task.id, colIdx);
      this._refreshTaskTileEverywhere(task.id);
    }
  }

  async _fetchAuthThumb(url) {
    if (!url || !url.startsWith("/")) return url;
    this._thumbCache = this._thumbCache || new Map();
    if (this._thumbCache.has(url)) return this._thumbCache.get(url);
    try {
      const token = this._hass.auth?.data?.access_token;
      if (!token) return url;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) return url;
      const blobUrl = URL.createObjectURL(await resp.blob());
      this._thumbCache.set(url, blobUrl);
      return blobUrl;
    } catch { return url; }
  }

  // Revoke + drop cached blob: thumbnail URLs (called when the media picker
  // closes) so browsing large libraries repeatedly doesn't leak blob memory.
  _revokeThumbCache() {
    if (!this._thumbCache) return;
    for (const v of this._thumbCache.values()) {
      if (typeof v === "string" && v.startsWith("blob:")) URL.revokeObjectURL(v);
    }
    this._thumbCache.clear();
  }

  async _saveImageUrl(task, colIdx, url) {
    const col = this._sourceCol(colIdx);
    try {
      let result;
      if (col.entity_id) {
        const overlay = await this._hass.callWS({
          type: "home_tasks/update_external_overlay",
          entity_id: col.entity_id,
          task_uid: task.id,
          image_url: url,
        });
        // Take ONLY the image from the response. The overlay always comes back
        // complete (every field, defaults included), so spreading it over the
        // task would reset everything the provider owns — a Todoist task would
        // lose its due date, notes, priority, tags and sub-items until the next
        // reload.
        result = { ...task, image_url: overlay?.image_url ?? url };
      } else {
        result = await this._hass.callWS({
          type: "home_tasks/update_task",
          list_id: col.list_id,
          task_id: task.id,
          image_url: url,
        });
      }
      // Update the task in every column showing the SAME list — the same list
      // can legitimately appear twice on one card (e.g. open | done), and
      // leaving the second copy behind means it keeps showing the old image.
      // Matching by task id alone is not enough: two providers can hand out
      // the same uid, and patching a foreign list by id would corrupt it.
      const sourceKey = this._colSourceKey(colIdx);
      for (let ci = 0; ci < this._columns.length; ci++) {
        if (this._colSourceKey(ci) !== sourceKey) continue;
        const cs = this._columns[ci];
        const idx = cs?.tasks?.findIndex(t => t.id === task.id) ?? -1;
        if (idx >= 0) cs.tasks[idx] = result;
      }
      // Update the open sheet + tiles in place (a full _render() would keep the
      // old sheet DOM — showing the old image — and reset the scroll position).
      this._refreshOpenSheetImage(task.id, colIdx);
      this._refreshTaskTileEverywhere(task.id);
    } catch (err) {
      console.error("Failed to save image URL:", err);
      alert(this._t("img_save_failed") + (err.message || err));
    }
  }

  _buildHistorySection(task) {
    const taskHistory = (task.history || []).slice().reverse();
    const histContent = this._el("div", { className: "history-list" });
    if (taskHistory.length === 0) {
      histContent.appendChild(this._el("p", { className: "history-empty", textContent: this._t("history_empty") }));
    } else {
      for (const entry of taskHistory) {
        histContent.appendChild(this._buildHistoryEntry(entry));
      }
    }
    return this._el("div", { className: "detail-section" }, [
      this._el("label", { className: "detail-label", textContent: this._t("history") }),
      histContent,
    ]);
  }

  _buildHistoryEntry(entry) {
    const row = this._el("div", { className: "history-entry" });
    const ts = new Date(entry.ts);
    const tsStr = this._fmtTimestamp(ts);
    const { icon, text } = this._formatHistoryEntry(entry);
    const byLabel = entry.by && entry.by !== "recurrence"
      ? ` \u00b7 ${entry.by === "user" ? this._t("hist_by_user") : entry.by}`
      : "";
    row.appendChild(this._el("span", { className: "history-icon", textContent: icon }));
    row.appendChild(this._el("span", { className: "history-text", textContent: text + byLabel }));
    row.appendChild(this._el("span", { className: "history-ts", textContent: tsStr }));
    return row;
  }

  _formatHistoryEntry(entry) {
    if (entry.action === "created") {
      return { icon: "\u2605", text: this._t("history_created") };
    }
    if (entry.action === "completed") {
      return { icon: "\u2713", text: this._t("history_completed") };
    }
    if (entry.action === "reopened") {
      const text = entry.by === "recurrence" ? this._t("history_reset") : this._t("history_reopened");
      return { icon: "\u21BA", text };
    }
    if (entry.action === "updated") {
      return { icon: "\u270e", text: this._formatHistoryUpdateText(entry) };
    }
    return { icon: "\u2022", text: "" };
  }

  _formatHistoryUpdateText(entry) {
    const fieldNames = {
      title: this._t("hist_title"),
      due_date: this._t("due_date"),
      due_time: this._t("due_time_lbl"),
      priority: this._t("priority"),
      assigned_person: this._t("assigned_to"),
      assigned_persons: this._t("assigned_to"),
      tags: this._t("tags"),
      notes: this._t("notes"),
      recurrence_enabled: this._t("recurrence"),
    };
    const lbl = fieldNames[entry.field] || entry.field;
    if (entry.field === "recurrence_enabled") {
      return `${lbl}: ${entry.to ? this._t("recurrence_enabled") : this._t("history_disabled")}`;
    }
    if (entry.from !== undefined || entry.to !== undefined) {
      return `${lbl}: ${this._formatHistoryValue(entry.from, entry.field)} \u2192 ${this._formatHistoryValue(entry.to, entry.field)}`;
    }
    return `${lbl} ${this._t("history_changed")}`;
  }

  _formatHistoryValue(v, field) {
    if (v == null) return "\u2013";
    if (field === "priority") {
      return [this._t("pri_low"), this._t("pri_medium"), this._t("pri_high")][v - 1] || String(v);
    }
    if (field === "assigned_person") {
      return this._hass?.states?.[v]?.attributes?.friendly_name || v;
    }
    if (field === "assigned_persons") {
      const names = (Array.isArray(v) ? v : []).map((p) => this._hass?.states?.[p]?.attributes?.friendly_name || p);
      return names.join(", ") || "\u2013";
    }
    if (field === "tags") {
      return Array.isArray(v) ? (v.join(", ") || "\u2013") : String(v);
    }
    return String(v);
  }

  _isInteractiveTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
        || el.isContentEditable === true
        // The notes read view: selecting its text or tapping a link in it
        // must not start dragging the task.
        || (typeof el.closest === "function" && !!el.closest(".notes-view"));
  }

  _buildSubTask(taskId, sub, colIdx) {
    const isEditing = this._editingSubTaskId === sub.id;

    const handle = this._el("span", {
      className: "sub-drag-handle",
      textContent: "\u2237",
      title: this._t("drag_handle"),
    });

    const checkbox = this._el("input", { type: "checkbox", checked: sub.completed });
    checkbox.addEventListener("change", () =>
      this._toggleSubTask(taskId, sub.id, sub.completed, colIdx)
    );
    const checkmark = this._el("span", { className: "checkmark" });
    const label = this._el("label", { className: "checkbox-container small" }, [
      checkbox, checkmark,
    ]);

    let titleEl;
    if (isEditing) {
      titleEl = this._el("input", {
        type: "text",
        className: "edit-sub-input",
        value: sub.title,
        "data-focus-key": `sub_title_${sub.id}`,
      });
      titleEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._editingSubTaskId = null;  // clear BEFORE calling so blur skips
          this._updateSubTaskTitle(taskId, sub.id, titleEl.value, colIdx);
        } else if (e.key === "Escape") { this._editingSubTaskId = null; this._render(); }
      });
      titleEl.addEventListener("blur", () => {
        if (this._editingSubTaskId === sub.id) this._updateSubTaskTitle(taskId, sub.id, titleEl.value, colIdx);
      });
      setTimeout(() => { titleEl.focus(); titleEl.select(); }, 0);
    } else {
      let subCls = "sub-title";
      if (sub.completed) subCls += " completed";
      titleEl = this._el("span", { className: subCls, textContent: sub.title });
      titleEl.addEventListener("dblclick", () => {
        this._editingSubTaskId = sub.id;
        this._render();
      });
    }

    const deleteBtn = this._el("button", {
      className: "delete-sub-btn",
      title: this._t("delete_sub"),
      textContent: "\u00D7",
    });
    deleteBtn.addEventListener("click", () => this._deleteSubTask(taskId, sub.id, colIdx));

    const subEl = this._el("div", { className: "sub-task" }, [handle, label, titleEl, deleteBtn]);
    subEl.draggable = true;
    subEl.dataset.subTaskId = sub.id;

    subEl.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      this._draggedSubTaskId = sub.id;
      e.dataTransfer.effectAllowed = "move";
      subEl.classList.add("dragging");
    });
    subEl.addEventListener("dragend", (e) => { e.stopPropagation(); this._finishSubDrag(taskId, colIdx); });
    subEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (!this._draggedSubTaskId || this._draggedSubTaskId === sub.id) return;
      const draggedEl = this.shadowRoot.querySelector(`.sub-task[data-sub-task-id="${CSS.escape(this._draggedSubTaskId)}"]`);
      this._liveMoveSubTask(draggedEl, subEl, e.clientY);
    });
    subEl.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); this._finishSubDrag(taskId, colIdx); });

    handle.addEventListener("touchstart", (e) => {
      e.stopPropagation();
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      this._subTouchStartTimer = setTimeout(() => {
        this._draggedSubTaskId = sub.id;
        subEl.classList.add("dragging");
        const rect = subEl.getBoundingClientRect();
        const clone = subEl.cloneNode(true);
        clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;z-index:1000;opacity:0.85;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,0.3);background:var(--todo-bg,#fff);border-radius:4px;border:1px solid var(--todo-primary,#03a9f4);`;
        this.shadowRoot.appendChild(clone);
        this._subTouchClone = clone;
        this._subTouchOffsetY = touch.clientY - rect.top;
      }, 150);
    }, { passive: true });

    const onSubTouchMove = (e) => {
      if (!this._draggedSubTaskId) {
        clearTimeout(this._subTouchStartTimer);
        this._subTouchStartTimer = null;
        return;
      }
      e.preventDefault();
      const touch = e.touches[0];
      if (this._subTouchClone) this._subTouchClone.style.top = `${touch.clientY - this._subTouchOffsetY}px`;
      if (this._subTouchClone) this._subTouchClone.style.display = "none";
      const shadowEl = this.shadowRoot.elementFromPoint(touch.clientX, touch.clientY);
      if (this._subTouchClone) this._subTouchClone.style.display = "";
      const target = shadowEl?.closest(".sub-task");
      if (target && target.dataset.subTaskId && target.dataset.subTaskId !== this._draggedSubTaskId) {
        const draggedEl = this.shadowRoot.querySelector(`.sub-task[data-sub-task-id="${CSS.escape(this._draggedSubTaskId)}"]`);
        this._liveMoveSubTask(draggedEl, target, touch.clientY);
      }
    };
    const onSubTouchEnd = () => {
      clearTimeout(this._subTouchStartTimer);
      this._subTouchStartTimer = null;
      if (this._draggedSubTaskId) this._finishSubDrag(taskId, colIdx);
    };
    handle.addEventListener("touchmove", onSubTouchMove, { passive: false });
    handle.addEventListener("touchend", onSubTouchEnd);
    handle.addEventListener("touchcancel", onSubTouchEnd);

    return subEl;
  }

  // --- Drag & Drop ---

  _getOrderFromDom(colIdx) {
    const taskList = this.shadowRoot.querySelector(`.task-list[data-col-idx="${CSS.escape(String(colIdx))}"]`);
    if (!taskList) return [];
    return Array.from(taskList.querySelectorAll(".task")).map((el) => el.dataset.taskId);
  }

  // Walks the rendered list in order and returns [{taskId, sectionId}] pairs
  // where sectionId is the id of the most recent section header (or null if
  // the task sits in the unsorted top bucket / "__done__" for the Done bucket).
  // Tasks inside a section live in a .section-body wrapper; tasks in the
  // unsorted top bucket are direct children of the task-list.
  _getOrderWithSectionFromDom(colIdx) {
    const taskList = this.shadowRoot.querySelector(`.task-list[data-col-idx="${CSS.escape(String(colIdx))}"]`);
    if (!taskList) return [];
    const result = [];
    let currentSection = null;
    for (const el of taskList.children) {
      if (el.classList.contains("section-header")) {
        currentSection = el.dataset.sectionId || null;
      } else if (el.classList.contains("section-body")) {
        for (const inner of el.children) {
          if (inner.classList.contains("task")) {
            result.push({ taskId: inner.dataset.taskId, sectionId: currentSection });
          }
        }
      } else if (el.classList.contains("task")) {
        // Top unsorted bucket — flat children of .task-list
        result.push({ taskId: el.dataset.taskId, sectionId: null });
      }
    }
    return result;
  }

  _mergeHiddenTasks(colIdx, visibleOrder, draggedId = null) {
    const cs = this._columns[colIdx];
    // With overdue_first the overdue tasks are drawn on top, not where their
    // manual order puts them; saving the drawn order would store every one
    // of them first for good.  Treat them like filtered-out tasks: they go
    // back after their original predecessor.  The task actually dragged
    // keeps the place it was dropped at.
    if (this._sourceCol(colIdx)?.overdue_first === true) {
      const pinned = new Set(
        (cs.tasks || [])
          .filter((t) => !t.completed && this._isDueDateOverdue(t.due_date) && String(t.id) !== String(draggedId))
          .map((t) => t.id),
      );
      visibleOrder = visibleOrder.filter((id) => !pinned.has(id));
    }
    const filteredIds = new Set(visibleOrder);
    const hiddenIds = cs.tasks.map((t) => t.id).filter((id) => !filteredIds.has(id));
    const fullOrder = [...visibleOrder];
    const origOrder = cs.tasks.map((t) => t.id);
    for (const hid of hiddenIds) {
      const origIdx = origOrder.indexOf(hid);
      let insertIdx = fullOrder.length;
      for (let i = origIdx - 1; i >= 0; i--) {
        const prevId = origOrder[i];
        const posInNew = fullOrder.indexOf(prevId);
        if (posInNew !== -1) { insertIdx = posInNew + 1; break; }
      }
      fullOrder.splice(insertIdx, 0, hid);
    }
    return fullOrder;
  }

  _liveMoveTask(draggedEl, targetEl, clientX, clientY) {
    if (!draggedEl || !targetEl || draggedEl === targetEl) return;
    const targetList = targetEl.parentNode;
    if (!targetList) return;

    const siblings = [...targetList.querySelectorAll(".task:not(.dragging), .section-header")];
    const before = new Map(siblings.map(el => [el, el.getBoundingClientRect()]));

    // One column: the upper half of the target means "before it". Side by
    // side (list_columns) the reading order runs across, so the left half
    // does - otherwise a task dragged onto its right-hand neighbour only
    // moves once the pointer drops into that neighbour's lower half.
    const targetRect = targetEl.getBoundingClientRect();
    const sideBySide = getComputedStyle(targetList).display === "grid";
    const inFirstHalf = sideBySide
      ? clientX < targetRect.left + targetRect.width / 2
      : clientY < targetRect.top + targetRect.height / 2;
    if (inFirstHalf) {
      targetList.insertBefore(draggedEl, targetEl);
    } else {
      targetList.insertBefore(draggedEl, targetEl.nextSibling);
    }

    // FLIP: animate siblings from their previous position to the new one
    siblings.forEach(el => {
      const was = before.get(el);
      const now = el.getBoundingClientRect();
      const dx = was ? was.left - now.left : 0;
      const dy = was ? was.top - now.top : 0;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
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

  _liveMoveSubTask(draggedEl, targetEl, clientY) {
    if (!draggedEl || !targetEl || draggedEl === targetEl) return;
    const list = targetEl.parentNode;
    if (!list) return;

    const siblings = [...list.querySelectorAll(".sub-task:not(.dragging)")];
    const before = new Map(siblings.map(el => [el, el.getBoundingClientRect().top]));

    const r2 = targetEl.getBoundingClientRect();
    if (clientY < r2.top + r2.height / 2) {
      list.insertBefore(draggedEl, targetEl);
    } else {
      list.insertBefore(draggedEl, targetEl.nextSibling);
    }

    siblings.forEach(el => {
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

  _finishSubDrag(taskId, colIdx) {
    const draggedId = this._draggedSubTaskId;
    this._draggedSubTaskId = null;
    this.shadowRoot.querySelectorAll(".sub-task").forEach(el => el.classList.remove("dragging"));
    if (this._subTouchClone) { this._subTouchClone.remove(); this._subTouchClone = null; }
    if (this._subTouchStartTimer) { clearTimeout(this._subTouchStartTimer); this._subTouchStartTimer = null; }
    if (!draggedId) return;
    const subList = this.shadowRoot.querySelector(`.sub-task-list[data-task-id="${CSS.escape(taskId)}"]`);
    if (!subList) return;
    const order = [...subList.querySelectorAll(".sub-task")].map(el => el.dataset.subTaskId).filter(Boolean);
    if (order.length > 1) this._reorderSubTasks(taskId, order, colIdx);
  }

  _finishDrag() {
    const draggedId = this._draggedTaskId;
    const srcColIdx = this._draggedColIdx;

    // Determine which column the dragged element ended up in
    const draggedEl = draggedId
      ? this._taskDragElement(draggedId, srcColIdx)
      : null;
    const currentTaskList = draggedEl?.closest(".task-list");
    const tgtColIdx = currentTaskList !== null && currentTaskList !== undefined && currentTaskList.dataset.colIdx !== undefined
      ? parseInt(currentTaskList.dataset.colIdx, 10)
      : srcColIdx;

    // Clean up
    this._draggedTaskId = null;
    this._draggedColIdx = null;
    this._draggedTaskElement = null;
    this.shadowRoot.querySelectorAll(".task").forEach((el) => {
      el.classList.remove("dragging", "drag-over");
    });
    this.shadowRoot.querySelectorAll(".card-column").forEach((el) => {
      el.classList.remove("drag-target");
    });
    this.shadowRoot.querySelectorAll(".section-header.drop-target").forEach((el) => {
      el.classList.remove("drop-target");
    });
    if (this._springLoadTimer) {
      clearTimeout(this._springLoadTimer);
      this._springLoadTimer = null;
    }
    this._springLoadOriginallyCollapsed = null;
    if (this._touchClone) { this._touchClone.remove(); this._touchClone = null; }
    if (this._touchStartTimer) { clearTimeout(this._touchStartTimer); this._touchStartTimer = null; }

    if (!draggedId || srcColIdx === null) return;

    this._dropDragged(draggedEl, draggedId, srcColIdx, tgtColIdx);
  }

  // Where a dragged row was let go: a card of lists moves it to the column
  // and section it lies in now (a day plan re-plans its day instead).
  _dropDragged(draggedEl, draggedId, srcColIdx, tgtColIdx) {
    if (!isNaN(tgtColIdx) && tgtColIdx !== srcColIdx) {
      // Cross-column move
      const targetTaskIds = this._getOrderFromDom(tgtColIdx);
      this._moveTask(srcColIdx, tgtColIdx, draggedId, targetTaskIds);
    } else {
      // Same-column reorder — also detect cross-section changes
      const idx = srcColIdx ?? 0;
      const sectionedOrder = this._getOrderWithSectionFromDom(idx);
      if (sectionedOrder.length > 0) {
        this._applySectionChangesAndReorder(idx, sectionedOrder, draggedId);
      }
    }

    if (this._pendingRender) this._render();
  }

  _collapseAllForDrag() {
    if (this._expandedTasks.size === 0) return;
    // Invalidate any in-flight expand/collapse animations
    if (this._animatingTaskIds) this._animatingTaskIds.clear();
    this._expandedTasks.clear();
    const details = this.shadowRoot.querySelectorAll(".task-details");
    // Freeze current heights as px (CSS can't transition from "auto")
    for (const det of details) {
      det.style.height = det.offsetHeight + "px";
    }
    for (const btn of this.shadowRoot.querySelectorAll(".expand-btn.expanded")) {
      btn.classList.remove("expanded");
    }
    // Animate to 0 on next frame
    requestAnimationFrame(() => {
      for (const det of details) {
        det.style.height = "0";
      }
    });
  }

  _attachDragToTask(taskEl, taskId, colIdx) {
    // HTML5 Drag & Drop (Desktop)
    taskEl.addEventListener("dragstart", (e) => {
      // The whole .task is draggable=true so the browser starts a drag
      // detection on mousedown anywhere inside it — including text inputs.
      // Cancel the drag at the dragstart hook (which fires before any move)
      // when the user is interacting with a text field.
      if (this._isInteractiveTarget(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      this._draggedTaskId = taskId;
      this._draggedColIdx = colIdx;
      this._draggedTaskElement = taskEl;
      e.dataTransfer.effectAllowed = "move";
      // Collapse all expanded tasks for a cleaner drag experience
      this._collapseAllForDrag();
      taskEl.classList.add("dragging");
    });

    taskEl.addEventListener("dragend", () => {
      this._finishDrag();
    });

    taskEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!this._draggedTaskId) return;
      const draggedEl = this._taskDragElement();
      if (draggedEl === taskEl) return;
      this._liveMoveTask(draggedEl, taskEl, e.clientX, e.clientY);
      // Visual feedback for cross-column target
      const tgtList = taskEl.closest(".task-list");
      const tgtColIdx = tgtList ? parseInt(tgtList.dataset.colIdx) : colIdx;
      if (tgtColIdx !== this._draggedColIdx) {
        this.shadowRoot.querySelectorAll(".card-column").forEach(el => el.classList.remove("drag-target"));
        taskEl.closest(".card-column")?.classList.add("drag-target");
      }
    });

    taskEl.addEventListener("drop", (e) => {
      e.preventDefault();
      this._finishDrag();
    });

    // Touch Events (Mobile) — long-press anywhere on the task row to drag
    taskEl.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      // Don't arm the long-press drag when the user taps a text input —
      // they want to focus / select / scroll the field, not drag the task.
      if (this._isInteractiveTarget(e.target)) return;
      const touch = e.touches[0];
      // List rows show their details inline on tap; the detail sheet is a
      // tiles-only gesture. A long-press here only arms the drag below — opening
      // the sheet here too fought the drag (stationary hold flashed a drag +
      // sheet, and the trailing tap toggled expand under the sheet).
      this._touchStartTimer = setTimeout(() => {
        this._draggedTaskId = taskId;
        this._draggedColIdx = colIdx;
        this._draggedTaskElement = taskEl;
        this._touchDragStartedAt = Date.now();
        this._touchDragMoved = false;
        // Collapse all expanded tasks for a cleaner drag experience
        this._collapseAllForDrag();
        taskEl = this._taskDragElement();
        if (taskEl) taskEl.classList.add("dragging");

        const rect = taskEl.getBoundingClientRect();
        const clone = taskEl.cloneNode(true);
        // Remove expanded details from clone so it shows collapsed during drag
        const cloneDetails = clone.querySelector(".task-details");
        if (cloneDetails) cloneDetails.remove();
        clone.className = "task drag-clone";
        clone.style.cssText = `
          position: fixed; top: ${rect.top}px; left: ${rect.left}px;
          width: ${rect.width}px; z-index: 1000; opacity: 0.85;
          pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          background: var(--todo-bg, #fff);
          border-radius: var(--todo-radius, 8px);
          border: 1px solid var(--todo-primary, #03a9f4);
        `;
        this.shadowRoot.appendChild(clone);
        this._touchClone = clone;
        this._touchOffsetY = touch.clientY - rect.top;
      }, 150);
      // (A scroll cancels the pending drag via onTouchMove below, which clears
      // _touchStartTimer on the first move while no drag is active.)
    }, { passive: true });

    const onTouchMove = (e) => {
      if (!this._draggedTaskId) {
        if (this._touchStartTimer) {
          clearTimeout(this._touchStartTimer);
          this._touchStartTimer = null;
        }
        return;
      }
      e.preventDefault();
      this._touchDragMoved = true;
      const touch = e.touches[0];

      if (this._touchClone) {
        this._touchClone.style.top = `${touch.clientY - this._touchOffsetY}px`;
      }

      if (this._touchClone) this._touchClone.style.display = "none";
      const shadowEl = this.shadowRoot.elementFromPoint(touch.clientX, touch.clientY);
      if (this._touchClone) this._touchClone.style.display = "";

      const target = shadowEl ? shadowEl.closest(".task") : null;
      const sectionHeader = shadowEl ? shadowEl.closest(".section-header") : null;
      if (target && target.dataset.taskId && target !== this._taskDragElement() && !target.classList.contains("drag-clone")) {
        const draggedEl = this._taskDragElement();
        this._liveMoveTask(draggedEl, target, touch.clientX, touch.clientY);
      } else if (sectionHeader && sectionHeader.dataset.sectionId !== "__done__") {
        const draggedEl = this._taskDragElement();
        const body = sectionHeader.nextElementSibling;
        if (draggedEl && body && body.classList.contains("section-body") && draggedEl.parentNode !== body) {
          body.insertBefore(draggedEl, body.firstChild);
        }
      } else if (shadowEl) {
        // Over the card but not over a row: the card type decides.
        this._touchOverNothing(shadowEl);
      }
    };

    const onTouchEnd = () => {
      if (this._touchStartTimer) {
        clearTimeout(this._touchStartTimer);
        this._touchStartTimer = null;
      }
      if (this._draggedTaskId) {
        // The browser still sends a click for a hold released in place. After
        // a real drag (moved, or held on purpose) neither the checkbox nor
        // (tap_to_complete) the row may tick the task off; a tap that merely
        // ran past the 150 ms drag threshold still counts as a tap.
        if (this._touchDragMoved || Date.now() - (this._touchDragStartedAt || 0) >= 300) {
          this._suppressRowTapUntil = Date.now() + 500;
        }
        this._finishDrag();
      }
    };

    taskEl.addEventListener("touchmove", onTouchMove, { passive: false });
    taskEl.addEventListener("touchend", onTouchEnd);
    taskEl.addEventListener("touchcancel", onTouchEnd);
  }

  _planDate(str) {
    const [y, m, d] = String(str).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  // "Today", "Tomorrow" or the weekday, seen from *today* (an ISO date).
  _planDayName(dateStr, today) {
    if (dateStr === today) return this._t("due_today");
    const next = this._planDate(today);
    next.setDate(next.getDate() + 1);
    if (this._localDateStr(next) === dateStr) return this._t("due_tomorrow");
    return this._planDate(dateStr).toLocaleDateString(this._localeCode(), { weekday: "long" });
  }

  _planShortDate(dateStr) {
    return this._planDate(dateStr).toLocaleDateString(this._localeCode(), { day: "numeric", month: "short" });
  }

  _planDayLabel(dateStr, today) {
    return `${this._planDayName(dateStr, today)}, ${this._planShortDate(dateStr)}`;
  }

  _taskDragElement(taskId = this._draggedTaskId, colIdx = this._draggedColIdx) {
    // A recurring task can have a done row today and an open row tomorrow.
    // Keep the actual dragged node, including after it moves to another day.
    if (this._draggedTaskElement?.isConnected
        && String(taskId) === String(this._draggedTaskId) && colIdx === this._draggedColIdx) {
      return this._draggedTaskElement;
    }
    return this._findTaskRow(taskId, colIdx);
  }

  // The row of a task of the card's list *colIdx*.
  _findTaskRow(taskId, colIdx) {
    const selector = `.task[data-task-id="${CSS.escape(String(taskId))}"]`;
    // A card can show one list in two columns: the id then names two rows.
    // The one being dragged carries "dragging" wherever the drag has taken
    // it; before that it is the one in the column the drag started in.
    const found = [...this.shadowRoot.querySelectorAll(selector)];
    if (found.length < 2) return found[0] || null;
    return found.find((el) => el.classList.contains("dragging"))
      || found.find((el) => el.closest(".task-list")?.dataset.colIdx === String(colIdx))
      || found[0];
  }

  // --- Styles ---

  _getStyles() {
    return `
      :host {
        --todo-primary: var(--primary-color, #03a9f4);
        --todo-bg: var(--card-background-color, #fff);
        --todo-text: var(--primary-text-color, #212121);
        --todo-secondary-text: var(--secondary-text-color, #727272);
        --todo-divider: var(--divider-color, #e0e0e0);
        --todo-surface: var(--secondary-background-color, #f5f5f5);
        --todo-disabled: var(--disabled-text-color, #bdbdbd);
        --todo-error: var(--error-color, #db4437);
        --todo-success: var(--success-color, #43a047);
        --todo-radius: 8px;
      }
      ha-card { overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; }
      ha-card > div { display: flex; flex-direction: column; min-height: 0; }
      /* Fixed-height contract of HA's sections view (issue #33): when the
         Layout tab sets a fixed number of rows, HA sizes the card's grid
         cell and exposes --row-size. We then fill the cell (like core cards
         do via ha-card { height: 100% }) but scroll only the task body, so
         title, add-task row and filters stay put (issue #34). Detection and
         the .fit-rows class live in _updateFitRows(). */
      :host(.fit-rows) { display: block; height: 100%; }
      :host(.fit-rows) ha-card { height: 100%; }
      :host(.fit-rows) ha-card > div,
      :host(.fit-rows) .multi-columns { flex: 1 1 auto; min-height: 0; }
      /* .card-column is deliberately NOT in that list: inside .multi-columns
         the flex axis is horizontal and ".multi-columns .card-column { flex: 1 }"
         keeps the kanban columns equal-width; vertical fill comes from
         align-items: stretch plus the column's own min-height: 0. */
      .multi-columns { display: flex; gap: 0; align-items: stretch; }
      .multi-columns .card-column { flex: 1; min-width: 240px; border-right: 1px solid var(--todo-divider); }
      .multi-columns .card-column:last-child { border-right: none; }
      @media (max-width: 600px) { .multi-columns { flex-direction: column; } .multi-columns .card-column { border-right: none; border-bottom: 1px solid var(--todo-divider); } .multi-columns .card-column:last-child { border-bottom: none; } :host(.fit-rows) .multi-columns .card-column { flex: 1 1 0%; } }
      .card-column.drag-target { outline: 2px dashed var(--todo-primary); outline-offset: -2px; border-radius: var(--todo-radius); }
      .card-column { padding: 16px; display: flex; flex-direction: column; min-height: 0; }
      .header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
      .card-global-title { font-size: 1.25rem; font-weight: 500; color: var(--ha-card-header-color, var(--todo-text)); margin: 0; padding: 16px 16px 0; line-height: 1.2; }
      .title { font-size: 1.25rem; font-weight: 500; color: var(--ha-card-header-color, var(--todo-text)); margin: 0; line-height: 1.2; display: flex; align-items: center; gap: 6px; }
      .progress { font-size: 14px; color: var(--todo-secondary-text); }
      .add-task { display: flex; gap: 8px; margin-bottom: 16px; }
      .add-input {
        flex: 1; padding: 10px 14px; border: 1px solid var(--todo-divider);
        border-radius: var(--todo-radius); background: var(--todo-bg);
        color: var(--todo-text); font-size: 14px; outline: none; font-family: inherit;
      }
      .add-input:focus { border-color: var(--todo-primary); }
      .add-input.nudge { animation: ht-add-nudge 0.6s ease; }
      @keyframes ht-add-nudge {
        0%, 100% { border-color: var(--todo-divider); }
        25%, 75% { border-color: var(--todo-primary); }
      }
      @media (prefers-reduced-motion: reduce) {
        .add-input.nudge { animation: none; border-color: var(--todo-primary); }
      }
      .add-input::placeholder { color: var(--todo-disabled); }
      .add-btn {
        padding: 10px 20px; background: var(--todo-primary); color: #fff;
        border: none; border-radius: var(--todo-radius); font-size: 14px;
        font-weight: 500; cursor: pointer; white-space: nowrap; font-family: inherit;
      }
      .add-btn:hover { opacity: 0.9; }
      .add-details-btn { padding: 10px 14px; }
      .add-details-btn.active {
        background: none; color: var(--todo-primary); box-shadow: inset 0 0 0 2px var(--todo-primary);
      }
      .task-draft {
        border: 1px solid var(--todo-primary); border-radius: var(--todo-radius);
        padding: 10px; margin: -8px 0 16px; display: flex; flex-direction: column; gap: 8px;
      }
      /* the details normally open via a height animation on the task row */
      .task-draft .task-details { height: auto; border-top: none; }
      .draft-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .draft-cancel-btn {
        padding: 10px 16px; background: none; color: var(--todo-secondary-text);
        border: 1px solid var(--todo-divider); border-radius: var(--todo-radius); cursor: pointer; font-family: inherit;
      }
      .add-input-wrap { position: relative; flex: 1; display: flex; min-width: 0; }
      .add-input-wrap .add-input { padding-right: 34px; min-width: 0; }
      .add-clear-btn {
        position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
        width: 24px; height: 24px; border: none; border-radius: 50%; background: none;
        color: var(--todo-secondary-text); font-size: 18px; line-height: 1; cursor: pointer; padding: 0;
      }
      .add-clear-btn:hover { background: var(--todo-surface); }
      .mic-btn {
        flex-shrink: 0; width: 38px; height: 38px; padding: 0;
        border: none; border-radius: var(--todo-radius);
        background: var(--todo-primary); color: #fff;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        transition: opacity 0.2s, background 0.2s;
      }
      .mic-btn:hover { opacity: 0.9; }
      /* Due-at-creation row (issue #38) */
      .add-task-group { margin-bottom: 16px; }
      .add-task-group .add-task { margin-bottom: 0; }
      .add-due-row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
      .add-due-row input {
        flex: 1 1 0; min-width: 0; padding: 8px 10px; font: inherit; font-size: 13px;
        border: 1px solid var(--todo-divider); border-radius: var(--todo-radius);
        background: transparent; color: var(--todo-text); color-scheme: light dark;
      }
      .add-due-row input:focus { outline: none; border-color: var(--todo-primary); }
      .compact .add-task-group { margin-bottom: 10px; }
      .compact .add-due-row input { padding: 5px 8px; font-size: 12px; }
      .mic-btn svg { width: 18px; height: 18px; fill: currentColor; }
      .mic-btn.recording {
        background: #e53935; color: #fff;
        animation: mic-pulse 1s ease-in-out infinite;
      }
      @keyframes mic-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(229, 57, 53, 0.4); }
        50% { box-shadow: 0 0 0 6px rgba(229, 57, 53, 0); }
      }
      .filters { display: flex; gap: 4px; margin-bottom: 12px; align-items: center; }
      .filter-spacer { flex: 1; }
      .filter-btn {
        padding: 6px 16px; border: none; border-radius: 20px; background: transparent;
        color: var(--todo-secondary-text); font-size: 13px; cursor: pointer;
        font-family: inherit; transition: all 0.2s;
      }
      .filter-btn.active { background: var(--todo-primary); color: #fff; }
      .filter-btn:not(.active):hover { background: var(--todo-surface); }
      .sort-btn-wrapper { position: relative; }
      .sort-btn {
        padding: 5px 10px; border: 1px solid var(--todo-divider); border-radius: 20px;
        background: transparent; color: var(--todo-secondary-text); font-size: 12px;
        cursor: pointer; font-family: inherit; transition: all 0.2s; white-space: nowrap;
      }
      .sort-btn.active { border-color: var(--todo-primary); color: var(--todo-primary); }
      .sort-btn:hover { background: var(--todo-surface); }
      .sort-dropdown {
        position: absolute; right: 0; top: calc(100% + 4px); z-index: 20;
        background: var(--card-background-color, var(--todo-bg)); border: 1px solid var(--todo-divider);
        border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); min-width: 150px; overflow: hidden;
      }
      .sort-dropdown.hidden { display: none; }
      .sort-option {
        padding: 9px 14px; cursor: pointer; font-size: 13px;
        color: var(--todo-text); transition: background 0.15s;
      }
      .sort-option:hover { background: var(--todo-surface); }
      .sort-option.active { color: var(--todo-primary); font-weight: 500; }
      .task-list { display: flex; flex-direction: column; gap: 6px; min-height: 40px; }
      /* When the list is height-constrained (max_height / fit-rows / card-mod),
         flex would first *shrink* its children before overflowing into the
         scrollbar — section headers (min-height: 0) collapsed to 0px and their
         text/icon overlapped the neighbouring task. Children must keep their
         natural height and let the container scroll instead. */
      .task-list > *, .tile-grid-wrap > * { flex-shrink: 0; }
      /* max_height column option: body scrolls, chrome above stays fixed. The
         1px inset padding keeps the focus ring / box-shadow of the first and
         last task from being clipped by the overflow box. */
      .task-list.scrollable, .tile-grid-wrap.scrollable,
      :host(.fit-rows) .task-list, :host(.fit-rows) .tile-grid-wrap {
        overflow-y: auto; overscroll-behavior: contain;
        padding: 1px 2px 1px 1px; scrollbar-gutter: stable;
      }
      :host(.fit-rows) .task-list, :host(.fit-rows) .tile-grid-wrap { flex: 1 1 auto; min-height: 40px; }
      .empty-state { text-align: center; padding: 24px; color: var(--todo-disabled); font-size: 14px; }
      .section-header {
        display: flex; align-items: center; gap: 6px;
        padding: 2px 4px; min-height: 0;
        background: transparent; border: none; border-radius: 0;
        cursor: pointer; user-select: none;
        font-size: 14px; font-weight: 500;
        color: var(--todo-secondary-text);
        transition: color 0.15s, opacity 0.15s;
      }
      .section-header:hover { color: var(--todo-text); }
      .section-header.drop-target { color: var(--todo-primary); }
      .section-header ha-icon { --mdc-icon-size: 16px; color: inherit; flex-shrink: 0; }
      .section-header .section-name { flex: 1; min-width: 0; word-break: break-word; line-height: 1.2; }
      .section-header .sub-badge { background: transparent; padding: 0; font-size: 11px; color: inherit; opacity: 0.8; }
      .section-header .section-caret {
        --mdc-icon-size: 16px; color: inherit;
        transition: transform 0.2s; flex-shrink: 0; opacity: 0.7;
      }
      .section-header.collapsed .section-caret { transform: rotate(-90deg); }
      .section-body { display: flex; flex-direction: column; gap: 6px; }
      .section-body.collapsed,
      .section-body.expanding { max-height: 0; opacity: 0; overflow: hidden; pointer-events: none; }
      .section-body:empty { display: none; }
      /* list_columns: tasks flow into N columns (sections keep full-width
         headers). Each column is at least --ht-list-min-width (160px) wide, so a
         narrow card falls back to fewer columns instead of squashing. An
         expanded task keeps its column: its details open in place. */
      .list-cols .task-list,
      .list-cols .section-body:not(.collapsed):not(.expanding):not(:empty) {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(
          max(var(--ht-list-min-width, 160px), calc((100% - (var(--ht-list-cols, 1) - 1) * 8px) / var(--ht-list-cols, 1))),
          1fr));
        column-gap: 8px;
        align-items: start;
      }
      .list-cols .task-list > :not(.task) { grid-column: 1 / -1; }
      .list-cols .task { min-width: 0; }
      .task {
        border: 1px solid var(--todo-divider); border-radius: var(--todo-radius);
        background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.06);
        transition: box-shadow 0.2s, border-color 0.2s;
      }
      .task.dragging { opacity: 0.4; }
      .task-main { display: flex; align-items: center; padding: 10px 12px; gap: 8px; min-height: 44px; cursor: pointer; }
      .task-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .checkbox-container {
        position: relative; display: inline-flex; align-items: center;
        cursor: pointer; flex-shrink: 0;
      }
      .checkbox-container input { position: absolute; opacity: 0; cursor: pointer; height: 0; width: 0; }
      .checkmark {
        height: 20px; width: 20px; border: 2px solid var(--todo-divider);
        border-radius: 4px; transition: all 0.2s; display: flex;
        align-items: center; justify-content: center;
      }
      .checkbox-container:hover .checkmark { border-color: var(--todo-primary); }
      .checkbox-container input:checked ~ .checkmark { background: var(--todo-primary); border-color: var(--todo-primary); }
      .checkbox-container input:checked ~ .checkmark::after {
        content: ""; display: block; width: 5px; height: 9px;
        border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); margin-top: -1px;
      }
      .checkbox-container.small .checkmark { height: 16px; width: 16px; }
      .checkbox-container.small input:checked ~ .checkmark::after { width: 4px; height: 7px; }
      /* Theme hooks (issue #31): card-mod can't reach into this card's
         shadow root, so the task title exposes CSS custom properties that
         can be set in an HA theme. Fallbacks equal the previous fixed values. */
      .task-title {
        font-family: var(--ht-task-title-font-family, inherit);
        font-size: var(--ht-task-title-font-size, 14px);
        font-weight: var(--ht-task-title-font-weight, inherit);
        color: var(--ht-task-title-color, var(--todo-text)); cursor: pointer;
        line-height: 1.3; word-break: break-word;
      }
      .task.completed .task-title { text-decoration: line-through; color: var(--todo-disabled); }
      .edit-title-input, .edit-sub-input {
        flex: 1; padding: 7px 10px;
        border: 1px solid var(--outline-color, var(--divider-color, rgba(127,127,127,0.4)));
        border-radius: 4px; font-size: 14px;
        background: var(--mdc-text-field-fill-color, var(--input-fill-color, var(--todo-bg)));
        color: var(--todo-text); outline: none; font-family: inherit; min-width: 0;
      }
      .edit-title-input:focus, .edit-sub-input:focus { border-color: var(--todo-primary); border-width: 2px; padding: 6px 9px; }
      .task-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .sub-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: var(--todo-surface); color: var(--todo-secondary-text); font-weight: 500;
      }
      .due-date {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: var(--todo-surface); color: var(--todo-secondary-text);
      }
      .due-date.today { background: rgba(255, 152, 0, 0.15); color: var(--warning-color, #ff9800); }
      .due-date.overdue { background: rgba(244, 67, 54, 0.15); color: var(--todo-error); font-weight: 500; }
      .priority-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
      }
      .priority-badge.pri-high { background: rgba(244, 67, 54, 0.15); color: var(--todo-error, #f44336); }
      .priority-badge.pri-medium { background: rgba(255, 152, 0, 0.15); color: var(--warning-color, #ff9800); }
      .priority-badge.pri-low { background: rgba(3, 169, 244, 0.15); color: var(--info-color, #03a9f4); }
      .priority-btn-row { display: flex; gap: 6px; }
      .assignee-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .assignee-chip, .due-quick-btn {
        padding: 5px 10px; border-radius: 14px; font-size: 12px; font-family: inherit;
        border: 1px solid var(--todo-divider); background: var(--todo-bg);
        color: var(--todo-secondary-text); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .assignee-chip.active, .due-quick-btn.active {
        background: color-mix(in srgb, var(--todo-primary) 18%, transparent);
        color: var(--todo-primary); border-color: var(--todo-primary);
      }
      .due-quick-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      /* Folding a task-details field: its heading stays, with a caret and,
         while folded, a one-line summary of what is set. */
      .detail-fold-head { cursor: pointer; display: flex; align-items: center; gap: 6px; min-width: 0; }
      .detail-fold-caret {
        --mdc-icon-size: 16px; flex-shrink: 0; color: var(--todo-secondary-text);
        transition: transform 0.15s;
      }
      .detail-section.folded .detail-fold-caret { transform: rotate(-90deg); }
      .detail-fold-summary {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-weight: normal; text-transform: none; letter-spacing: normal;
        color: var(--todo-secondary-text);
      }
      .detail-section.folded > :not(.detail-fold-head) { display: none !important; }
      .priority-btn {
        flex: 1; padding: 5px 8px; border-radius: 4px; font-size: 12px; font-family: inherit;
        border: 1px solid var(--todo-divider); background: var(--todo-bg);
        color: var(--todo-secondary-text); cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s;
      }
      .priority-btn.pri-3.active { background: rgba(244, 67, 54, 0.2); color: var(--todo-error, #f44336); border-color: var(--todo-error, #f44336); }
      .priority-btn.pri-2.active { background: rgba(255, 152, 0, 0.2); color: var(--warning-color, #ff9800); border-color: var(--warning-color, #ff9800); }
      .priority-btn.pri-1.active { background: rgba(3, 169, 244, 0.2); color: var(--info-color, #03a9f4); border-color: var(--info-color, #03a9f4); }
      .recurrence-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: rgba(3, 169, 244, 0.15); color: var(--info-color, #03a9f4);
      }
      .assigned-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: rgba(33, 150, 243, 0.15); color: var(--primary-color, #2196f3);
        cursor: pointer; transition: all 0.2s;
      }
      .assigned-badge.with-avatar { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 3px; }
      .person-chip.with-avatar { display: inline-flex; align-items: center; gap: 6px; padding: 3px 12px 3px 4px; }
      .person-avatar {
        flex-shrink: 0; border-radius: 50%; object-fit: cover; overflow: hidden;
        display: inline-flex; align-items: center; justify-content: center;
        color: #fff; font-weight: 500; line-height: 1;
      }
      .assigned-badge.avatar-only, .person-chip.avatar-only {
        background: none; border: none; padding: 0; border-radius: 50%;
      }
      .assigned-badge.avatar-only .person-avatar { width: 20px; height: 20px; font-size: 10px; }
      .person-chip.avatar-only .person-avatar { width: 24px; height: 24px; font-size: 11px; }
      .assigned-badge.avatar-only.active .person-avatar,
      .person-chip.avatar-only.active .person-avatar {
        box-shadow: 0 0 0 2px var(--todo-primary);
      }
      .assigned-badge .person-avatar { width: 16px; height: 16px; font-size: 9px; }
      .person-chip .person-avatar { width: 18px; height: 18px; font-size: 10px; }
      .compact .assigned-badge .person-avatar { width: 14px; height: 14px; font-size: 8px; }
      .assigned-badge:hover { opacity: 0.8; }
      .assigned-badge.active { background: var(--primary-color, #2196f3); color: #fff; }
      .tag-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: rgba(76, 175, 80, 0.15); color: var(--success-color, #4caf50);
        cursor: pointer; transition: all 0.2s;
      }
      .tag-badge:hover { opacity: 0.8; }
      .tag-badge.active { background: var(--success-color, #4caf50); color: #fff; }
      .reminder-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px;
        background: rgba(255, 152, 0, 0.15); color: var(--warning-color, #ff9800);
      }
      .tag-chips { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
      .tag-chips-row { display: flex; align-items: flex-start; gap: 4px; margin-bottom: 12px; }
      .tag-chips-row .tag-chips { flex: 1; margin-bottom: 0; }
      .tag-chip {
        padding: 4px 12px; border: 1px solid rgba(76, 175, 80, 0.3); border-radius: 16px;
        background: transparent; color: var(--success-color, #4caf50); font-size: 12px;
        cursor: pointer; font-family: inherit; transition: background-color 0.2s, color 0.2s, border-color 0.2s;
      }
      .tag-chip:hover { background: rgba(76, 175, 80, 0.1); }
      .tag-chip.active { background: var(--success-color, #4caf50); color: #fff; border-color: var(--success-color, #4caf50); }
      @keyframes chip-pop {
        0%   { transform: scale(0.78); }
        55%  { transform: scale(1.16); }
        100% { transform: scale(1); }
      }
      .chip-anim { animation: chip-pop 0.22s ease-out; }
      .person-chips { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
      .person-chips-row { display: flex; align-items: flex-start; gap: 4px; margin-bottom: 12px; }
      .person-chips-row .person-chips { flex: 1; margin-bottom: 0; }
      .person-chip {
        padding: 4px 12px; border: 1px solid var(--primary-color, #2196f3); border-radius: 16px;
        background: transparent; color: var(--primary-color, #2196f3); font-size: 12px;
        cursor: pointer; font-family: inherit; transition: background-color 0.2s, color 0.2s, border-color 0.2s;
      }
      .person-chip:hover { background: var(--todo-surface); }
      .person-chip.active { background: var(--primary-color, #2196f3); color: #fff; }
      .tag-list { display: flex; gap: 6px; flex-wrap: wrap; }
      .tag-item {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px; border-radius: 10px;
        background: rgba(76, 175, 80, 0.15); color: var(--success-color, #4caf50);
        font-size: 12px;
      }
      .remove-tag-btn {
        background: none; border: none; color: var(--success-color, #4caf50);
        cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1; opacity: 0.7;
      }
      .remove-tag-btn:hover { opacity: 1; }
      .tag-autocomplete-anchor { position: relative; width: 100%; }
      .tag-autocomplete-dropdown {
        position: absolute; top: calc(100% + 2px); left: 0; right: 0; z-index: 20;
        background: var(--card-background-color, var(--todo-bg));
        border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12)));
        border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        max-height: 240px; overflow-y: auto; padding: 4px 0;
      }
      .tag-autocomplete-dropdown[hidden] { display: none; }
      .tag-autocomplete-item {
        padding: 8px 14px; cursor: pointer; font-size: 13px;
        color: var(--todo-text); user-select: none;
      }
      .tag-autocomplete-item.did-you-mean { font-style: italic; color: var(--primary-color, #03a9f4); }
      .tag-autocomplete-item:hover,
      .tag-autocomplete-item.highlighted {
        background: rgba(76, 175, 80, 0.15); color: var(--success-color, #4caf50);
      }
      .tag-autocomplete-empty {
        padding: 8px 14px; font-size: 12px; font-style: italic;
        color: var(--todo-secondary-text);
      }
      .recurrence-toggle-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
      .recurrence-input-row { display: flex; align-items: flex-end; gap: 8px; }
      .rec-remaining { font-size: 12px; color: var(--secondary-text-color); align-self: center; flex-shrink: 0; }
      .recurrence-prefix { font-size: 13px; color: var(--todo-secondary-text); white-space: nowrap; }
      .recurrence-weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 6px; margin-top: 6px; }
      .weekday-label {
        display: block; font-size: 12px; color: var(--todo-secondary-text); cursor: pointer; user-select: none;
      }
      .weekday-label input[type="checkbox"], .weekday-label input[type="radio"] { display: none; }
      .weekday-label span {
        display: block; text-align: center; padding: 4px 2px; border-radius: 4px; border: 1px solid var(--todo-divider);
        background: var(--todo-bg); transition: background 0.15s, color 0.15s;
      }
      .weekday-label input[type="checkbox"]:checked + span,
      .weekday-label input[type="radio"]:checked + span {
        background: var(--primary-color, #03a9f4); color: #fff; border-color: var(--primary-color, #03a9f4);
      }
      .weekday-label input[type="checkbox"]:disabled + span,
      .weekday-label input[type="radio"]:disabled + span { opacity: 0.5; cursor: default; }
      /* Generic radio-pill row used for the monthly pattern + end-mode toggles. */
      .recurrence-radio-row { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; margin-top: 6px; }
      /* Inline rows where a labeled select sits below a pill-toggle. */
      .recurrence-sub-row { display: flex; gap: 8px; align-items: stretch; margin-top: 6px; }
      .recurrence-sub-row .sel-wrap { flex: 1; min-width: 0; }
      /* Yearly TT.MM input: 50/50 split between TT field and the month
         dropdown.  Spacing under the radio row matches .recurrence-sub-row. */
      .recurrence-year-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
      .recurrence-year-row > .field-wrap,
      .recurrence-year-row > .sel-wrap { flex: 1 1 0; min-width: 0; }
      .recurrence-year-row .field-wrap input { padding: 18px 4px 4px 8px; font-size: 13px; }
      .recurrence-year-row .field-wrap > span { left: 8px; font-size: 10px; }
      /* TT field special-cases: left-aligned number (matches the rest of
         the card) with a "." rendered inside the field immediately after
         the typed value.  We can't style the input's value content
         directly, so we read the value's length via a CSS custom
         property and place the dot at left = padding + len * 1ch.
         tabular-nums keeps digit widths uniform so the offset is stable
         when the user types or spins. */
      .field-wrap.year-day input[type="number"] {
        text-align: left;
        padding-right: 30px;  /* reserve room for spin buttons */
        font-variant-numeric: tabular-nums;
      }
      .field-wrap.year-day::after {
        content: ".";
        position: absolute;
        left: calc(8px + var(--day-len, 1) * 1ch + 1px);
        bottom: 6px;
        color: var(--primary-text-color);
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }
      .field-wrap.year-day:not(.has-value)::after { display: none; }
      .recurrence-todoist-note, .recurrence-note {
        font-size: 11px; color: var(--secondary-text-color);
        font-style: italic; margin-top: 4px;
      }
      .reminder-row { display: flex; gap: 6px; align-items: center; }
      .reminder-remove {
        background: none; border: none; color: var(--todo-secondary-text);
        cursor: pointer; font-size: 16px; padding: 2px 6px; border-radius: 4px; line-height: 1;
      }
      .reminder-remove:hover { color: var(--todo-error); background: rgba(244, 67, 54, 0.15); }
      .add-reminder-btn {
        background: none; border: none; color: var(--warning-color, #ff9800); cursor: pointer;
        font-size: 13px; padding: 6px 0; text-align: left; font-family: inherit;
      }
      .add-reminder-btn:hover { text-decoration: underline; }
      .expand-btn {
        background: none; border: none; color: var(--todo-secondary-text);
        cursor: pointer; padding: 4px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .expand-btn:hover { background: var(--todo-surface); }
      .expand-btn ha-icon { --mdc-icon-size: 18px; transition: transform 0.2s; }
      .expand-btn.expanded ha-icon { transform: rotate(180deg); }
      .task-details {
        border-top: 1px solid var(--todo-divider);
        overflow: hidden; box-sizing: border-box;
        height: 0; transition: height 0.25s ease;
      }
      .task-details-inner {
        padding: 8px 12px 12px 12px; display: flex; flex-direction: column; gap: 12px;
        overflow-x: hidden;
      }
      .detail-section { display: flex; flex-direction: column; gap: 6px; }
      .detail-label {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        color: var(--todo-secondary-text); letter-spacing: 0.5px;
      }
      /* Date and time side by side while both fit (date with its clear
         button needs ~145px); in a narrow column (list_columns) the time
         goes below the date instead of being pushed out on the right. */
      .due-input-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 6px; overflow: hidden; }
      .due-input-row .field-wrap { min-width: 0; overflow: hidden; }
      .due-input-row .field-wrap input { padding: 18px 4px 4px 8px; font-size: 13px; }
      .due-input-row .field-wrap input:focus { padding: 17px 3px 3px 7px; }
      .due-input-row .field-wrap > span { left: 8px; font-size: 10px; }
      .field-wrap input[type="date"], .field-wrap input[type="time"] { text-align: left; padding-right: 6px; max-width: 100%; -webkit-appearance: none; appearance: none; }
      .field-wrap { position: relative; width: 100%; overflow: hidden; }
      .due-input-row.single { grid-template-columns: 1fr; }
      .field-wrap input, .field-wrap textarea { width: 100%; box-sizing: border-box; padding: 20px 12px 6px; height: 48px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); color: var(--primary-text-color); font-size: 0.875rem; font-family: inherit; outline: none; color-scheme: light dark; }
      .field-wrap textarea { height: auto; }
      .field-wrap input:focus, .field-wrap textarea:focus { border: 2px solid var(--primary-color); padding: 19px 11px 5px; }
      .field-wrap input:disabled, .field-wrap textarea:disabled { opacity: 0.4; }
      .field-wrap textarea { resize: vertical; min-height: 60px; }
      .notes-view { box-sizing: border-box; width: 100%; min-height: 40px; padding: 10px 12px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); color: var(--primary-text-color); font-size: 0.875rem; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; }
      .notes-view:focus-visible { outline: none; border: 2px solid var(--primary-color); padding: 9px 11px; }
      .notes-view a { color: var(--primary-color, #03a9f4); text-decoration: underline; cursor: pointer; }
      .field-wrap > span { position: absolute; top: 6px; left: 12px; font-size: 11px; font-weight: 400; color: var(--secondary-text-color); text-transform: none; letter-spacing: 0; pointer-events: none; }
      .field-with-clear { display: flex; align-items: center; gap: 2px; min-width: 0; }
      .field-with-clear .field-wrap { flex: 1; min-width: 0; }
      .field-clear-btn {
        flex-shrink: 0; background: none; border: none; color: var(--secondary-text-color);
        cursor: pointer; font-size: 16px; padding: 2px 4px; border-radius: 4px; line-height: 1;
      }
      .field-clear-btn:hover { color: var(--error-color, #f44336); background: rgba(244, 67, 54, 0.15); }
      .field-wrap input:focus ~ span, .field-wrap textarea:focus ~ span { color: var(--primary-color); }
      .field-wrap.inline { flex: 1; width: auto; }
      .field-wrap.inline input { height: 48px; padding: 20px 8px 4px; box-sizing: border-box; }
      .field-wrap.inline input[type="number"] { padding-right: 28px; -moz-appearance: textfield; }
      .field-wrap.inline input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }
      .field-wrap.inline > span { top: 4px; left: 8px; }
      .spin-btns { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; }
      .spin-btn { background: none; border: none; padding: 2px 4px; cursor: pointer; color: var(--secondary-text-color); line-height: 1; font-size: 12px; }
      .spin-btn:hover { color: var(--primary-color); }
      .spin-btn:disabled { opacity: 0.4; cursor: default; }
      .sel-wrap { position: relative; width: 100%; }
      .sel-wrap select { width: 100%; height: 48px; padding: 18px 32px 4px 12px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); color: var(--primary-text-color); font-size: 0.875rem; font-family: inherit; appearance: none; -webkit-appearance: none; cursor: pointer; outline: none; box-sizing: border-box; color-scheme: light dark; }
      .sel-wrap select:focus { border: 2px solid var(--primary-color); padding: 17px 31px 3px 11px; }
      .sel-wrap select:disabled { opacity: 0.4; cursor: default; }
      /* The native options panel ignores the page palette unless we set
         these explicitly — without them HA's dark theme falls back to the
         browser's white default. */
      .sel-wrap select option {
        background: var(--card-background-color, var(--ha-card-background, var(--primary-background-color, #fff)));
        color: var(--primary-text-color);
      }
      .sel-wrap > span { position: absolute; top: 6px; left: 12px; font-size: 11px; font-weight: 400; color: var(--secondary-text-color); text-transform: none; letter-spacing: 0; pointer-events: none; }
      .sel-wrap::after { content: "▾"; position: absolute; right: 10px; top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--secondary-text-color); font-size: 16px; line-height: 1; }
      .sel-wrap.inline { flex: 1; width: auto; }
      .sel-wrap.inline select { height: 48px; padding: 18px 28px 4px 10px; }
      .sel-wrap.inline > span { top: 4px; left: 10px; font-size: 10px; }
      .field-wrap.no-label input, .field-wrap.no-label textarea { padding: 10px 12px; }
      .field-wrap.no-label input:focus, .field-wrap.no-label textarea:focus { padding: 9px 11px; }
      .sel-wrap.no-label select { padding: 12px 32px 12px 12px; height: 44px; }
      .sel-wrap.no-label select:focus { padding: 11px 31px 11px 11px; }
      .sub-task-list { display: flex; flex-direction: column; }
      .sub-task { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
      .sub-task.dragging { opacity: 0.4; }
      .sub-drag-handle { cursor: grab; color: var(--todo-disabled); font-size: 14px; padding: 0 2px 0 0; user-select: none; flex-shrink: 0; }
      .sub-drag-handle:active { cursor: grabbing; }
      @media (pointer: coarse) { .sub-drag-handle { padding: 4px 4px 4px 0; font-size: 16px; } }
      .sub-title {
        flex: 1; font-size: 13px; color: var(--todo-text); cursor: default;
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .sub-title.completed { text-decoration: line-through; color: var(--todo-disabled); }
      .delete-sub-btn {
        background: none; border: none; color: var(--todo-disabled); cursor: pointer;
        font-size: 16px; padding: 2px 6px; border-radius: 4px; line-height: 1; flex-shrink: 0;
      }
      .delete-sub-btn:hover { color: var(--todo-error); background: rgba(244, 67, 54, 0.15); }
      .add-sub-btn {
        background: none; border: none; color: var(--todo-primary); cursor: pointer;
        font-size: 13px; padding: 6px 0; text-align: left; font-family: inherit;
      }
      .add-sub-btn:hover { text-decoration: underline; }
      .history-list { display: flex; flex-direction: column; gap: 0; max-height: 220px; overflow-y: auto; }
      .history-entry { display: grid; grid-template-columns: 18px 1fr auto; align-items: baseline; gap: 6px; padding: 5px 14px 5px 0; border-bottom: 1px solid var(--divider-color, rgba(128,128,128,0.15)); font-size: 12px; }
      .history-entry:last-child { border-bottom: none; }
      .history-icon { color: var(--secondary-text-color); text-align: center; font-size: 11px; }
      .history-text { color: var(--primary-text-color); }
      .history-ts { color: var(--secondary-text-color); white-space: nowrap; font-size: 11px; }
      .history-empty { margin: 0; font-size: 12px; color: var(--secondary-text-color); }
      /* In a narrow column (list_columns) the buttons wrap - Delete goes
         below the others - instead of squeezing their labels. */
      .detail-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; padding-top: 4px; gap: 8px; }
      .detail-actions > button { white-space: nowrap; }
      .delete-task-btn {
        background: none; border: 1px solid var(--todo-error); color: var(--todo-error);
        padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .delete-task-btn:hover { background: rgba(244, 67, 54, 0.15); }
      .duplicate-task-btn {
        background: none; border: 1px solid var(--todo-primary); color: var(--todo-primary);
        padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .duplicate-task-btn:hover { background: color-mix(in srgb, var(--todo-primary) 15%, transparent); }
      .move-task-btn {
        background: none; border: 1px solid var(--todo-primary); color: var(--todo-primary);
        padding: 6px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; font-family: inherit;
      }
      .move-task-btn:hover { background: color-mix(in srgb, var(--todo-primary) 15%, transparent); }
      .ht-move-select {
        width: 100%; box-sizing: border-box; margin-top: 12px; padding: 8px 10px;
        border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12)));
        border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent));
        color: var(--primary-text-color); font-size: 0.875rem; font-family: inherit;
        cursor: pointer; outline: none; color-scheme: light dark;
      }
      /* --- Task image --- */
      .task-thumb {
        width: 40px; height: 40px; border-radius: 6px; object-fit: cover;
        flex-shrink: 0; opacity: 0.88; transition: opacity 0.2s, transform 0.15s;
        cursor: pointer; border: 1px solid var(--todo-divider);
      }
      .task-thumb:hover { opacity: 1; transform: scale(1.05); }
      .task.completed .task-thumb { opacity: 0.45; }
      .detail-section--image .image-section-body { display: flex; flex-direction: column; gap: 10px; }
      .image-section-body { gap: 6px; }
      .image-section-body .generate-image-btn { flex: 1; }
      .task-image-wrap {
        position: relative; display: inline-block; width: 100%;
        border-radius: 8px; overflow: hidden;
        max-height: 300px;
      }
      .task-image {
        width: 100%; max-height: 300px; object-fit: contain;
        border-radius: 8px; display: block;
      }
      .task-image-remove {
        position: absolute; top: 6px; right: 6px; width: 24px; height: 24px;
        border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff;
        border: none; font-size: 16px; line-height: 1; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s;
      }
      .task-image-remove:hover { background: rgba(0,0,0,0.8); }
      .generate-image-btn {
        display: inline-flex; align-items: center; padding: 7px 14px;
        border: 1px solid var(--todo-primary); background: transparent;
        color: var(--todo-primary); border-radius: var(--todo-radius);
        font-size: 13px; cursor: pointer; font-family: inherit;
        transition: background 0.15s, opacity 0.15s;
      }
      .generate-image-btn:hover:not(:disabled) { background: rgba(var(--rgb-primary-color, 33,150,243), 0.1); }
      .generate-image-btn:disabled { opacity: 0.6; cursor: default; }
      .generate-image-btn.generating { border-style: dashed; }
      .spinner {
        display: inline-block; width: 14px; height: 14px;
        border: 2px solid currentColor; border-top-color: transparent;
        border-radius: 50%; animation: spin 0.7s linear infinite;
        margin-right: 6px; flex-shrink: 0;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      .toast-error {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        background: var(--todo-error, #db4437); color: #fff; padding: 10px 20px;
        border-radius: 8px; font-size: 13px; z-index: 999; animation: fadeIn 0.3s;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

      /* Compact mode overrides */
      .compact { padding: 10px; }
      .compact .header { margin-bottom: 10px; }
      .compact .title { font-size: 1rem; }
      .compact .progress { font-size: 12px; }
      .compact .add-task { margin-bottom: 10px; }
      .compact .add-input { padding: 6px 10px; font-size: 13px; }
      .compact .add-btn { padding: 6px 14px; font-size: 13px; }
      .compact .mic-btn { width: 32px; height: 32px; }
      .compact .mic-btn svg { width: 15px; height: 15px; }
      .compact .filters { margin-bottom: 8px; }
      .compact .filter-btn { padding: 4px 12px; font-size: 12px; }
      .compact .tag-chips { margin-bottom: 8px; gap: 3px; }
      .compact .tag-chips-row { margin-bottom: 8px; }
      .compact .tag-chips-row .tag-chips { margin-bottom: 0; }
      .compact .tag-chip { padding: 2px 8px; font-size: 11px; }
      .compact .person-chips { margin-bottom: 8px; gap: 3px; }
      .compact .person-chips-row { margin-bottom: 8px; }
      .compact .person-chips-row .person-chips { margin-bottom: 0; }
      .compact .person-chip { padding: 2px 8px; font-size: 11px; }
      .compact .task-list { gap: 3px; }
      .compact .task-main { padding: 6px 8px; gap: 6px; min-height: 32px; }
      .compact .task-title { font-size: 13px; }
      .compact .task-meta { gap: 4px; }
      .compact .task-thumb { width: 30px; height: 30px; border-radius: 4px; }
      .compact .sub-badge, .compact .due-date, .compact .priority-badge, .compact .recurrence-badge,
      .compact .assigned-badge, .compact .tag-badge, .compact .reminder-badge { font-size: 10px; padding: 1px 6px; }
      .compact .checkmark { height: 16px; width: 16px; }
      .compact .checkbox-container input:checked ~ .checkmark::after { width: 4px; height: 7px; }
      .compact .expand-btn { padding: 2px; }
      .compact .expand-btn ha-icon { --mdc-icon-size: 16px; }
      .compact .empty-state { padding: 16px; font-size: 13px; }
      .compact .task-details-inner { padding: 8px 10px; }

      /* ── Tile / Kachel view ──────────────────────────────────── */
      .tile-grid-wrap { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
      .tile-grid-inner {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--ht-tile-min, 140px), 1fr));
        gap: 10px;
      }
      .task-tile {
        position: relative; border-radius: 14px; overflow: hidden;
        aspect-ratio: 1 / 1; cursor: pointer;
        background: var(--todo-surface);
        border: 1px solid var(--todo-divider);
        transition: transform 0.18s ease, box-shadow 0.18s ease;
        user-select: none; -webkit-user-select: none;
        /* Stop iOS Safari from hijacking a long-press on the tile image with
           its native "save/copy image" callout instead of our detail gesture. */
        -webkit-touch-callout: none;
      }
      .task-tile:hover { transform: scale(1.04); box-shadow: 0 6px 18px rgba(0,0,0,0.15); }
      .task-tile.selected { outline: 2.5px solid var(--todo-primary); outline-offset: 2px; }
      .task-tile.completed { opacity: 0.50; }
      .task-tile.dragging { opacity: 0.4; }
      .task-tile.dragging:hover { transform: none; box-shadow: none; }
      .task-tile.armed { transform: scale(1.08); box-shadow: 0 8px 22px rgba(0,0,0,0.28); z-index: 2; }
      .tile-bg {
        width: 100%; height: 100%; object-fit: cover; display: block;
        position: absolute; inset: 0;
        /* Decorative only: never intercept touches, never offer iOS image
           actions / drag-save — all gestures belong to the parent tile. */
        pointer-events: none; -webkit-touch-callout: none; -webkit-user-drag: none;
      }
      .tile-placeholder {
        width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
        font-size: 2.8rem; font-weight: 700; color: var(--todo-disabled);
        background: linear-gradient(135deg, var(--todo-surface) 0%, var(--todo-divider) 100%);
        position: absolute; inset: 0;
      }
      .tile-overlay {
        position: absolute; bottom: 0; left: 0; right: 0; z-index: 2;
        padding: 24px 9px 9px;
        background: linear-gradient(transparent, rgba(0,0,0,0.68));
        display: flex; align-items: flex-end; justify-content: space-between; gap: 4px;
      }
      .task-tile:not(.has-image) .tile-overlay {
        background: linear-gradient(transparent, rgba(0,0,0,0.25));
      }

      /* Task detail bottom sheet (tile long-press) */
      .task-detail-backdrop {
        position: fixed; inset: 0; z-index: 998;
        background: rgba(0,0,0,0.32);
      }
      .task-detail-sheet {
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 999;
        /* Composite the (possibly translucent) themed card colour over an
           opaque page-background base so frosted-glass themes don't make the
           popup see-through and unreadable. */
        background-color: var(--primary-background-color, #1c1c1c);
        background-image: linear-gradient(var(--ha-card-background, var(--card-background-color, transparent)), var(--ha-card-background, var(--card-background-color, transparent)));
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -4px 24px rgba(0,0,0,0.28);
        transform: translateY(100%);
        transition: transform 0.28s cubic-bezier(0.32, 0.72, 0, 1);
        max-height: 85vh;
        display: flex; flex-direction: column;
        padding-bottom: env(safe-area-inset-bottom, 0);
      }
      .task-detail-sheet.open { transform: translateY(0); }
      .sheet-handle {
        width: 40px; height: 4px; border-radius: 2px;
        background: var(--divider-color, rgba(255,255,255,0.2));
        margin: 10px auto 4px; flex-shrink: 0;
      }
      .sheet-header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 8px 12px 20px; flex-shrink: 0;
        border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.08));
      }
      .sheet-title {
        flex: 1; min-width: 0; font-size: 16px; font-weight: 500; color: var(--primary-text-color);
        background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent));
        border: 1px solid var(--outline-color, var(--divider-color, rgba(127,127,127,0.4)));
        border-radius: 4px; outline: none; font-family: inherit; padding: 8px 12px;
      }
      .sheet-title:focus { border-color: var(--todo-primary); border-width: 2px; padding: 7px 11px; }
      .sheet-close {
        background: none; border: none; cursor: pointer; border-radius: 50%;
        color: var(--secondary-text-color); padding: 8px; display: flex; align-items: center;
      }
      .sheet-close:hover { background: var(--secondary-background-color); }
      .sheet-body { overflow-y: auto; flex: 1; padding: 12px 0 8px; }
      .sheet-body .task-details { height: auto; border-top: none; }
      .sheet-body .task-details-inner { padding: 0 16px 16px; }
      .tile-title {
        color: #fff; font-size: 12px; font-weight: 600; line-height: 1.3;
        text-shadow: 0 1px 4px rgba(0,0,0,0.5);
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        flex: 1;
      }
      .task-tile:not(.has-image) .tile-title { color: var(--todo-text); text-shadow: none; }
      .tile-done-badge {
        color: #fff; font-weight: 700; flex-shrink: 0;
        background: rgba(67,160,71,0.85); border-radius: 50%;
        width: 20px; height: 20px; display: flex; align-items: center; justify-content: center;
        font-size: 11px;
      }
      .tiles-mode { padding: 12px; }

      /* Media browser dialog */
      dialog.mb-dialog {
        padding: 0; border: none; border-radius: 12px;
        width: min(480px, 95vw); max-height: 70vh;
        background-color: var(--primary-background-color, #1c1c1c);
        background-image: linear-gradient(var(--ha-card-background, var(--card-background-color, transparent)), var(--ha-card-background, var(--card-background-color, transparent)));
        color: var(--primary-text-color);
        box-shadow: 0 8px 32px rgba(0,0,0,0.32);
        overflow: hidden;
      }
      dialog.mb-dialog::backdrop { background: rgba(0,0,0,0.5); }
      /* In-card confirmation dialog (see _confirmDialog) */
      dialog.ht-confirm {
        padding: 0; border: none; border-radius: 12px;
        width: min(360px, 92vw);
        background-color: var(--primary-background-color, #1c1c1c);
        background-image: linear-gradient(var(--ha-card-background, var(--card-background-color, transparent)), var(--ha-card-background, var(--card-background-color, transparent)));
        color: var(--primary-text-color);
        box-shadow: 0 8px 32px rgba(0,0,0,0.32);
      }
      dialog.ht-confirm::backdrop { background: rgba(0,0,0,0.5); }
      .ht-confirm-body { padding: 20px; }
      .ht-confirm-msg { font-size: 15px; line-height: 1.4; word-break: break-word; }
      .ht-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
      .ht-confirm-btn {
        padding: 8px 16px; border-radius: 8px; font-size: 14px; font-family: inherit; cursor: pointer;
        border: 1px solid var(--divider-color, rgba(0,0,0,0.12));
        background: transparent; color: var(--primary-text-color);
      }
      .ht-confirm-btn:hover { background: var(--secondary-background-color); }
      .ht-confirm-btn.primary {
        background: var(--todo-primary); border-color: var(--todo-primary);
        color: var(--text-primary-color, #fff);
      }
      .ht-confirm-btn.primary:hover { filter: brightness(1.08); }
      .mb-header {
        display: flex; align-items: center; gap: 8px;
        padding: 16px 8px 16px 20px; flex-shrink: 0;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.12));
      }
      .mb-title { flex: 1; font-size: 18px; font-weight: 500; }
      .mb-close {
        background: none; border: none; cursor: pointer;
        color: var(--secondary-text-color); padding: 8px; border-radius: 50%;
        display: flex; align-items: center;
      }
      .mb-close:hover { background: var(--secondary-background-color); }
      .mb-list { overflow-y: auto; max-height: calc(70vh - 64px); }
      .mb-status { padding: 32px; text-align: center; color: var(--secondary-text-color); font-size: 14px; }
      .mb-error { color: var(--error-color, #db4437); }
      .mb-crumb {
        padding: 8px 16px 4px; font-size: 11px; font-weight: 600;
        color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.6px;
      }
      .mb-item {
        display: flex; align-items: center; gap: 12px;
        width: 100%; padding: 10px 16px;
        background: none; border: none; border-bottom: 1px solid var(--divider-color, rgba(0,0,0,0.06));
        cursor: pointer; color: var(--primary-text-color);
        font-family: inherit; font-size: 14px; text-align: left;
      }
      .mb-item:hover { background: var(--secondary-background-color, rgba(0,0,0,0.04)); }
      .mb-back {
        color: var(--primary-color); font-weight: 500;
        border-bottom: 2px solid var(--divider-color, rgba(0,0,0,0.12));
      }
      .mb-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .mb-grid {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
        gap: 8px; padding: 8px;
      }
      .mb-grid-item {
        display: flex; flex-direction: column; align-items: center; gap: 5px;
        background: none; border: none; cursor: pointer; padding: 6px; border-radius: 8px;
        font-family: inherit;
      }
      .mb-grid-item:hover { background: var(--secondary-background-color, rgba(0,0,0,0.06)); }
      .mb-grid-thumb {
        width: 100%; aspect-ratio: 1 / 1; object-fit: cover; border-radius: 6px;
        display: block;
      }
      .mb-grid-title {
        font-size: 11px; color: var(--secondary-text-color); width: 100%;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center;
      }

      /* Compact tile variant */
      /* No tile width here: the size is tile_size's alone (100px is "compact"). */
      .compact .tile-grid-inner { gap: 7px; }
      .compact .task-tile { border-radius: 10px; }
      .compact .tile-title { font-size: 11px; }

      @keyframes task-exit {
        0%   { opacity: 1; transform: translateY(0); }
        100% { opacity: 0; transform: translateY(-8px); }
      }
      @keyframes task-enter {
        0%   { opacity: 0; transform: translateY(10px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      .task-anim-exit {
        animation: task-exit 0.17s ease-out forwards;
        pointer-events: none;
        overflow: hidden;
      }
      .task-anim-enter {
        animation: task-enter 0.22s ease-out;
      }
    `;
  }

  // --- Card config ---

  connectedCallback() {
    this._ensureCardMod();
    if (!this._detailFoldHandler) {
      this._detailFoldHandler = (e) => {
        if (e.detail.source !== this) this._applyDetailFold(e.detail.list, e.detail.key, e.detail.folded);
      };
      window.addEventListener(DETAIL_FOLD_EVENT, this._detailFoldHandler);
    }
    this._updateFitRows();
    // A pending lists retry is cancelled on disconnect — resume the ladder
    // when the card is re-attached (dashboard view switch during startup),
    // repeating the cancelled attempt instead of skipping it.
    if (this._initialized && this._listsRetryCount > 0 && !this._listsRetryTimer) {
      this._listsRetryCount--;
      this._scheduleListsRetry();
    }
  }

  // HA's sections view sets --row-size on the card's grid cell wrapper when
  // the Layout tab uses a fixed number of rows (inherited into our shadow
  // DOM); it is empty/"auto" otherwise and in masonry views. Toggle a host
  // class so the CSS can switch to fill-and-scroll mode (see ha-card rules).
  _updateFitRows() {
    let rows = "";
    try { rows = (getComputedStyle(this).getPropertyValue("--row-size") || "").trim(); } catch (_) { /* detached */ }
    this.classList.toggle("fit-rows", rows !== "" && rows !== "auto");
  }

  // card-mod compatibility (issues #31 / #34). card-mod normally styles us
  // through its hui-card hook, but on a cold page load — while this (large)
  // module is still being fetched — HA mounts a placeholder first and
  // card-mod's application can get lost in the swap. card-mod's developer
  // API exists for exactly this: ask it to apply to this element ourselves.
  // apply_card_mod reuses an existing <card-mod> node of the same type, so
  // calling it when the hook already ran is a no-op, and the node survives
  // our re-renders (see _render's overlay preservation).
  _ensureCardMod() {
    if (!(this._config && this._config.card_mod)) return;
    if (!("customElements" in window) || !customElements.whenDefined) return;
    // At most one pending waiter per element: when card-mod is not installed
    // whenDefined() never settles, and every extra .then would keep this
    // element (and its config) alive for the page lifetime.
    if (this._cardModPending) return;
    this._cardModPending = true;
    customElements.whenDefined("card-mod").then((cm) => {
      this._cardModPending = false;
      cm = cm || customElements.get("card-mod"); // older engines resolve with undefined
      const cur = this._config && this._config.card_mod; // always the latest config
      if (!this.isConnected || !cur) return;
      if (!cm || typeof cm.applyToElement !== "function") return;
      try {
        cm.applyToElement(this, "card", cur, { config: this._config }, true, "type-custom-home-tasks-card");
      } catch (_) { /* never let a styling add-on break the card */ }
    });
  }

  disconnectedCallback() {
    if (this._detailFoldHandler) {
      window.removeEventListener(DETAIL_FOLD_EVENT, this._detailFoldHandler);
      this._detailFoldHandler = null;
    }
    if (this._sortCloseHandler) {
      document.removeEventListener("click", this._sortCloseHandler);
      this._sortCloseHandler = null;
    }
    if (this._touchStartTimer) { clearTimeout(this._touchStartTimer); this._touchStartTimer = null; }
    if (this._subTouchStartTimer) { clearTimeout(this._subTouchStartTimer); this._subTouchStartTimer = null; }
    if (this._extPollTimer) { clearInterval(this._extPollTimer); this._extPollTimer = null; }
    if (this._listsRetryTimer) { clearTimeout(this._listsRetryTimer); this._listsRetryTimer = null; }
    // Stop any active voice recording so the mic stream, AudioContext and
    // pipeline subscription are released when the card is removed mid-recording.
    if (this._voiceActive) {
      for (const cleanup of this._voiceActive.values()) {
        try { cleanup(); } catch (_) { /* best-effort */ }
      }
      this._voiceActive.clear();
    }
  }

  getCardSize() {
    return 3 + this._columns.reduce((sum, cs) => sum + cs.tasks.length, 0);
  }

  getLayoutOptions() {
    return {
      grid_columns: "full",
      grid_min_columns: 4,
      grid_rows: "auto",
      grid_min_rows: 2,
    };
  }

  // Current HA API (sections view Layout tab, 12-column grid — the legacy
  // getLayoutOptions above speaks the old 4-column grid, HA migrates ×3).
  // Rows default to "auto"; a fixed number makes the card fill the cell and
  // scroll its body.
  getGridOptions() {
    return {
      columns: "full",
      min_columns: 12,
      rows: "auto",
      min_rows: 2,
    };
  }

  // ── What a card type fills in ─────────────────────────────────────────────
  //
  // The shared code above knows a card's lists by their index ("colIdx")
  // and reaches their settings through _sourceCols()/_sourceCol(i): the
  // columns a card of lists is configured with, the lists a day plan draws
  // from. The rest are the points where card types differ.

  // The lists the card shows tasks of, as column options.
  _sourceCols() {
    return this._config.columns;
  }

  _sourceCol(i) {
    return this._config.columns[i];
  }

  // What the card draws in its ha-card.
  _buildCardContent() {
    return document.createElement("div");
  }

  // Loaded together with the lists when the card starts.
  _loadOwnData() {
    return null;
  }

  // Whether what the backend answered at start is not all there yet (it is
  // still starting): the lists are asked for again then.
  _bootIncomplete() {
    return false;
  }

  // The lists are known: load their tasks.
  async _afterListsLoaded() {
    await this._loadAllTasks();
  }

  // Per list, what says whether its tasks changed since the card read them
  // ({stamp}), or null when the card reads every list every time.
  _sourceStamps() {
    return null;
  }

  // Before the 30 s poll of linked lists.
  _beforePoll() {}

  // Before a linked list is read again after a write to it.
  _beforeExternalReload(_colIdx) {}

  // A task was deleted on the card, ahead of the backend's answer.
  _taskGoneLocally(_taskId, _colIdx) {}

  // ... and the backend has been told.
  _afterDeleteSent() {}

  // Buttons the card type puts first among a task's actions.
  _extraTaskActions(_task, _colIdx) {
    return [];
  }

  // A touch drag over the card but over no row.
  _touchOverNothing(_el) {}
}
