// The day plan card (custom:home-tasks-day-plan-card): the days of a day
// plan side by side. A row is a task of one of the plan's lists; reading,
// ticking, editing and dragging it is TasksCardBase's.

import { NEW_ENTRY_PATH } from "../core/helpers.js";
import { TasksCardBase } from "../core/card-base.js";

// How many days a new card shows, from the picker or a suggestion.
export const PLAN_DEFAULT_DAYS = 3;

export class HomeTasksDayPlanCard extends TasksCardBase {
  setConfig(config) {
    this._setPlanConfig(config || {});
  }

  static getConfigElement() {
    return document.createElement("home-tasks-day-plan-card-editor");
  }

  // What the picker starts a new card with: the first plan there is. With
  // several plans a card has to name one, so it is named from the start.
  static async getStubConfig(hass) {
    const config = { days: PLAN_DEFAULT_DAYS };
    try {
      const result = await hass.callWS({ type: "home_tasks/get_plans" });
      const first = result && Array.isArray(result.plans) && result.plans[0];
      if (first) config.plan = first.id;
    } catch (_) { /* no plan yet, or not reachable: the card says so */ }
    return config;
  }

  // ── Day plan view ──────────────────────────────────────────────────────────
  //
  // The card shows the days of a plan. A plan only refers to tasks, so the
  // card loads the lists the plan draws from - TasksCardBase's lists, made
  // from the plan (_planCols), never drawn as columns. Every row is a task
  // of one of them, and ticking it off, editing it or opening its details
  // runs through TasksCardBase, as in the list card.

  _setPlanConfig(config) {
    // What a row shows (priority, tags, person, …) is set with the options
    // a list column has for it, at the root of the card config. What only
    // makes sense in a list is not taken over: the row's number is what
    // ticks a task off, and a completed task stays on its day.
    const { type: _type, view: _view, plan, days, title: _title, columns: _c, list_id: _l, entity_id: _e, ...template } = config;
    for (const key of ["tap_to_complete", "auto_delete_completed", "view_mode", "list_columns"]) delete template[key];
    // A first config, or a later one (an edit): a template is there then.
    const wasPlan = this._planTemplate !== undefined;
    this._planTemplate = template;
    const n = parseInt(days, 10);
    this._planDays = Number.isFinite(n) ? Math.min(7, Math.max(1, n)) : 1;
    if (!wasPlan || (plan || null) !== this._planId) {
      this._plan = null;
      this._planError = null;
      this._planLoaded = false;
      this._planSensorId = null;
    }
    this._planId = plan || null;
    // The card's own config. Its lists are not columns of it: they are
    // made from the plan (_applyPlanSources) and reached through _sourceCols.
    this._config = { ...config };
    if (!wasPlan) {
      this._columns = [];
      this._planCols = [];
    }
    this._applyPlanSources();
    if (this._initialized) this._loadAllTasks();
    else this._render();
    this._ensureCardMod();
  }

  _planSourceKey(col) {
    return col.entity_id ? `ext:${col.entity_id}` : `native:${col.list_id}`;
  }

  // The plan's lists as columns (never drawn). A list keeps the tasks it
  // has loaded when the plan is read again.
  _applyPlanSources() {
    const sources = (this._plan && this._plan.sources) || [];
    const kept = new Map(
      (this._sourceCols() || []).map((c, i) => [this._planSourceKey(c), this._columns[i]])
    );
    const columns = sources.map((s) => ({
      ...this._planTemplate,
      ...(s.kind === "external" ? { entity_id: s.entity_id } : { list_id: s.entry_id }),
    }));
    this._planCols = columns;
    this._columns = columns.map((c) => kept.get(this._planSourceKey(c)) || this._defaultColState());
    this._planColByEntry = new Map(sources.map((s, i) => [s.entry_id, i]));
  }

  // What tells a day plan card to look again: the plan's sensor (it changes
  // when the plan reads differently, and only then), and for a linked list
  // its todo entity. Without the sensor - its entity disabled - the sensors
  // of the native lists stand in.
  _watchPlan(prev, hass) {
    const changed = (id) => !!id && prev.states?.[id] !== hass.states?.[id];
    const planSensor = this._planSensorId;
    const sensorThere = !!(planSensor && hass.states?.[planSensor]);
    let reload = changed(planSensor);
    this._sourceCols().forEach((col, i) => {
      const cs = this._columns[i];
      if (!cs) return;
      let watch = null;
      if (col.entity_id) watch = col.entity_id;
      else if (!sensorThere) watch = (this._lists || []).find((l) => l.id === col.list_id)?.sensor_entity_id;
      if (changed(watch)) {
        cs.stale = true;
        reload = true;
      }
    });
    if (!reload) return;
    this._bgUpdates = (this._bgUpdates || 0) + 1;
    this._loadAllTasks(true).finally(() => { this._bgUpdates = Math.max(0, (this._bgUpdates || 0) - 1); });
  }

  // Doubt the card's copy of a list (of every linked list when none is
  // named): the next load asks for it again.
  _planDoubt(colIdx) {
    this._columns.forEach((cs, i) => {
      if (colIdx === undefined ? !!this._sourceCol(i)?.entity_id : i === colIdx) cs.stale = true;
    });
  }

  // The poll of a day plan: a provider can change what Home Assistant's own
  // todo entity does not carry (labels, a priority). Asked only for linked
  // lists that have a row on the days shown.
  _planDoubtShown() {
    const shown = new Set();
    for (const day of (this._plan && this._plan.days) || []) {
      for (const row of day.items || []) shown.add(row.entry_id);
    }
    ((this._plan && this._plan.sources) || []).forEach((src, i) => {
      if (src.kind === "external" && shown.has(src.entry_id) && this._columns[i]) this._columns[i].stale = true;
    });
  }

  async _loadPlan() {
    const msg = { days: this._planDays };
    if (this._planId) msg.plan = this._planId;
    let result = null;
    let refused = null;
    try {
      result = await this._callWs("home_tasks/get_plan", msg, { rethrow: true });
    } catch (err) {
      // Our own timeout says nothing about the plan: keep what is shown.
      if (this._isWsTimeout(err)) return;
      refused = (err && err.message) || String(err);
    }
    if (result && Array.isArray(result.days)) {
      // The same plan as before stays the same objects. The rows on screen
      // were built from them, and a look in the background that finds
      // nothing new does not rebuild the rows: a tick would otherwise be
      // set on a row object nobody draws from any more, and show only once
      // the list has answered.
      const json = JSON.stringify(result);
      if (!this._plan || json !== this._planJson) {
        this._plan = result;
        this._planJson = json;
      }
      this._planError = null;
      // Remembered beyond this answer: see the refusal below.
      if (result.sensor_entity_id) this._planSensorId = result.sensor_entity_id;
    } else {
      this._plan = null;
      this._planJson = null;
      this._planError = refused;
      // The plan may only be away for a moment - its entry reloading, Home
      // Assistant restarting. With the plan gone there are no lists left to
      // watch, so two things bring it back: its sensor, which the hass
      // setter keeps watching, and asking again with the lists' backoff.
      if (refused) this._scheduleListsRetry();
    }
    this._planLoaded = true;
    this._applyPlanSources();
  }

  // A change to the plan itself. A refusal is a rule of the plan and is
  // shown as the backend words it; the plan is read again either way.
  async _planWrite(type, data) {
    const msg = { ...data };
    const planId = (this._plan && this._plan.id) || this._planId;
    if (planId) msg.plan = planId;
    try {
      await this._callWs(type, msg, { rethrow: true });
    } catch (err) {
      if (!this._isWsTimeout(err)) this._showError((err && err.message) || String(err));
      // What the card showed ahead of the answer (a row opened again) did
      // not happen, or nobody knows. The plan as it is read next is the
      // truth - also when it is word for word what was read before, which
      // _loadPlan would otherwise answer by keeping the card's own copy.
      this._planJson = null;
    }
    await this._loadPlan();
    this._render();
  }

  _buildPlanView() {
    const children = [];
    if (this._config.title) {
      children.push(this._el("h1", { className: "card-global-title", textContent: this._config.title }));
    }
    const plan = this._plan;
    if (!plan) {
      // Nothing while the first answer is still out - not a flash of "no plan".
      if (this._planLoaded) {
        const lines = [this._el("div", { textContent: this._t("plan_none") })];
        if (this._planError) {
          lines.push(this._el("div", { className: "plan-missing-detail", textContent: this._planError }));
        }
        // Only an administrator can add one.
        if (this._hass?.user?.is_admin === true) {
          const link = this._el("a", {
            className: "new-entry-link", href: NEW_ENTRY_PATH, textContent: `+ ${this._t("new_entry_link")}`,
          });
          // Within Home Assistant, without loading the page anew.
          link.addEventListener("click", (e) => {
            if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;
            e.preventDefault();
            history.pushState(null, "", NEW_ENTRY_PATH);
            window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
          });
          lines.push(link);
        }
        children.push(this._el("div", { className: "plan-missing" }, lines));
      }
      return this._el("div", { className: "plan-view" }, children);
    }
    const days = plan.days || [];
    children.push(this._el(
      "div",
      { className: "plan-days" + (days.length === 1 ? " single" : "") },
      days.map((day, i) => this._buildPlanDay(day, i === 0)),
    ));
    const compact = this._planTemplate.compact === true ? " compact" : "";
    return this._el("div", { className: "plan-view" + compact }, children);
  }

  _buildPlanDay(day, isCurrent) {
    const plan = this._plan;
    const rows = day.items || [];
    const done = rows.filter((r) => r.completed).length;

    // The date, the focus line and the progress bar are there unless the
    // card config switches them off (show_date, show_focus, show_progress).
    const opts = this._planTemplate || {};
    const headLine = [
      this._el("span", { className: "plan-day-name", textContent: this._planDayName(day.date, plan.today) }),
    ];
    if (opts.show_date !== false) {
      headLine.push(this._el("span", { className: "plan-day-date", textContent: this._planShortDate(day.date) }));
    }
    if (!isCurrent) {
      headLine.push(this._el("span", { className: "plan-count", textContent: String(rows.length) }));
    }
    const head = [this._el("div", { className: "plan-head-line" }, headLine)];
    if (opts.show_focus !== false) head.push(this._buildPlanNote(day));
    if (isCurrent && opts.show_progress !== false) {
      const fill = this._el("div", { className: "plan-bar-fill" });
      fill.style.width = rows.length ? `${Math.round((done / rows.length) * 100)}%` : "0%";
      head.push(this._el("div", { className: "plan-progress" }, [
        this._el("span", { className: "plan-progress-text", textContent: this._t("progress", done, rows.length) }),
        this._el("div", { className: "plan-bar" }, [fill]),
      ]));
    }

    const showList = (plan.sources || []).length > 1;
    const list = this._el("div", { className: "task-list plan-day-list", "data-plan-date": day.date }, [
      ...rows.map((row, i) => this._buildPlanRow(row, i + 1, showList, day)),
      // Hidden by CSS as soon as the day holds a row - also one dragged in.
      this._el("div", { className: "plan-empty", textContent: this._t("plan_empty") }),
    ]);
    // A task dragged over the day itself rather than over one of its rows:
    // an empty day, or the space below the last row.
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!this._draggedTaskId || (e.target.closest && e.target.closest(".task"))) return;
      this._planDropInto(list);
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      this._finishDrag();
    });

    const children = [this._el("div", { className: "plan-day-head" }, head), list];
    const offer = day.carry_over;
    if (offer && (offer.items || []).length) children.push(this._buildPlanCarryOver(day, offer));
    children.push(this._buildPlanAdd(day));
    return this._el("div", { className: "plan-day" + (isCurrent ? " plan-current" : "") }, children);
  }

  _planDropInto(list) {
    const el = this._taskDragElement();
    if (el && el.parentNode !== list) list.insertBefore(el, list.querySelector(".plan-empty"));
  }

  // The day's focus: a line of text, edited in place.
  _buildPlanNote(day) {
    if (this._planNoteEditing === day.date) {
      const input = this._el("input", {
        type: "text",
        className: "plan-note-input",
        value: day.note || "",
        maxlength: "255",
        placeholder: this._t("plan_note_placeholder"),
      });
      let finished = false;
      const finish = (save) => {
        if (finished) return;
        finished = true;
        this._planNoteEditing = null;
        const value = input.value.trim();
        if (save && value !== (day.note || "")) {
          this._planWrite("home_tasks/set_plan_day", { date: day.date, note: value || null });
        } else {
          this._render();
        }
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
      return input;
    }
    const note = this._el("div", {
      className: "plan-note" + (day.note ? "" : " empty"),
      textContent: day.note || this._t("plan_note_placeholder"),
    });
    note.addEventListener("click", () => {
      this._planNoteEditing = day.date;
      this._render();
    });
    return note;
  }

  _buildPlanCarryOver(day, offer) {
    const btn = this._el("button", {
      className: "plan-carry",
      textContent: this._t("plan_carry_over", this._planShortDate(offer.date), offer.items.length),
    });
    btn.addEventListener("click", () => this._planWrite("home_tasks/set_plan_day", {
      date: day.date,
      items: offer.items.map((r) => ({ task_id: r.task_id, entry_id: r.entry_id })),
    }));
    return btn;
  }

  // One row of a day: a task of one of the plan's lists, with its place in
  // the day's order where a list has the checkbox.
  _buildPlanRow(row, number, showList, day) {
    const colIdx = this._planColByEntry ? this._planColByEntry.get(row.entry_id) : undefined;
    const cs = colIdx !== undefined ? this._columns[colIdx] : null;
    const task = cs ? (cs.tasks || []).find((t) => String(t.id) === String(row.task_id)) : null;
    const listBadge = showList
      ? this._el("span", { className: "plan-list-badge", textContent: row.list_name })
      : null;
    const done = !!row.completed;
    let className = `task plan-row plan-kind-${row.kind}`;
    if (done) className += " completed";

    if (!task) {
      // The row's list has not answered yet: show what the plan knows.
      const meta = listBadge ? [this._el("div", { className: "task-meta" }, [listBadge])] : [];
      return this._el("div", { className }, [
        this._el("div", { className: "task-main" }, [
          this._el("span", { className: "plan-num" + (done ? " done" : ""), textContent: done ? "✓" : String(number) }),
          this._el("div", { className: "task-content" }, [
            this._el("span", { className: "task-title", textContent: row.title }),
            ...meta,
          ]),
        ]),
      ]);
    }

    const col = this._sourceCol(colIdx);
    const stateKey = this._taskStateKey(task.id, colIdx);
    const isExpanded = this._expandedTasks.has(stateKey);
    const isEditing = this._editingTaskId === stateKey;
    if (isExpanded) className += " is-expanded";
    // A done row keeps its place: what is done on a day is that day's record.
    const taskEl = this._el("div", { className, draggable: !done && !isEditing && !isExpanded });
    taskEl.dataset.taskId = task.id;
    taskEl.dataset.planEntry = row.entry_id;

    const contentChildren = this._buildTaskContentChildren(task, colIdx, isEditing);
    const meta = this._buildTaskMetaBadges(task, col, cs, colIdx);
    if (listBadge) meta.unshift(listBadge);
    if (meta.length > 0) contentChildren.push(this._el("div", { className: "task-meta" }, meta));

    const mainRow = this._el("div", { className: "task-main" }, [
      this._buildPlanNumber(row, task, colIdx, number),
      this._el("div", { className: "task-content" }, contentChildren),
      this._buildTaskExpandButton(isExpanded),
    ]);
    this._attachTaskExpandClickHandler(mainRow, task, taskEl, colIdx);
    taskEl.appendChild(mainRow);

    if (isExpanded) {
      // What one does to a row of a plan first: move it to another day.
      const actions = this._buildPlanActions(task, day, row);
      if (actions.length > 0) taskEl.appendChild(this._el("div", { className: "plan-actions" }, actions));
      const detailsEl = this._buildTaskDetails(task, colIdx);
      taskEl.appendChild(detailsEl);
      this._animateExpandedDetails(detailsEl, task, colIdx);
    }
    if (!done) this._attachDragToTask(taskEl, task.id, colIdx);
    return taskEl;
  }

  _buildPlanNumber(row, task, colIdx, number) {
    const done = !!row.completed;
    const btn = this._el("button", { className: "plan-num" + (done ? " done" : ""), title: task.title });
    if (done) {
      const icon = document.createElement("ha-icon");
      icon.setAttribute("icon", "mdi:check");
      btn.appendChild(icon);
    } else {
      btn.textContent = String(number);
    }
    const rowKey = `${row.entry_id}|${task.id}`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Date.now() < (this._suppressRowTapUntil || 0)) return;   // end of a drag
      // The second click of a double-click on this row (see below).
      const guard = this._planUntickGuard;
      if (guard && guard.key === rowKey && Date.now() < guard.until) return;
      if (done && !task.completed) {
        // Done today, open again: a recurring task that has moved on to its
        // next round. There is no tick on the task to take back, and
        // toggling would complete that next round - so the tap takes back
        // the day's "done" only, and the row is open on the day again.
        row.completed = false;
        // The row is rebuilt at once, and its number then completes the
        // task: the second click of a double-click must not land on it.
        // This row's taps only - another row can be ticked right away.
        this._planUntickGuard = { key: rowKey, until: Date.now() + 700 };
        this._render();
        this._planWrite("home_tasks/untick_plan_task", { task_id: String(task.id), entry_id: row.entry_id });
        return;
      }
      this._planToggle(row, task, colIdx);
    });
    return btn;
  }

  // Tick a row off (or take the tick back). The row shows it at once; the
  // task's list and the plan follow.
  async _planToggle(row, task, colIdx) {
    const col = this._sourceCol(colIdx);
    const done = !task.completed;
    if (done && col.confirm_complete === true) {
      const ok = await this._confirmDialog(
        this._t("confirm_complete_msg", task.title), this._t("confirm_complete_ok"),
      );
      if (!ok) return;
    }
    const was = { row: row.completed, task: task.completed };
    row.completed = done;
    // A provider does not close a recurring task, it moves it on: on the
    // plan it is done for today, in its list it stays as it comes back.
    const recurring = task.recurrence_enabled && task.recurrence_unit;
    if (!(this._isExternalCol(colIdx) && recurring)) task.completed = done;
    this._render();
    try {
      await this._updateTaskRouted(colIdx, task.id, { completed: done }, { rethrow: true });
    } catch (err) {
      // Not done after all. The plan will not say that the list changed -
      // it did not - so the card takes its own tick back and reads the list
      // again, instead of keeping a task it only believes to be done.
      row.completed = was.row;
      task.completed = was.task;
      if (this._columns[colIdx]) this._columns[colIdx].stale = true;
      if (!this._isWsTimeout(err)) this._showError((err && err.message) || String(err));
    }
    if (this._isExternalCol(colIdx)) this._reloadExternal(colIdx);
    await this._loadAllTasks();
  }

  // "Plan a task" under a day: a search across the plan's lists.
  _buildPlanAdd(day) {
    const state = this._planAdd;
    if (!state || state.date !== day.date) {
      const icon = document.createElement("ha-icon");
      icon.setAttribute("icon", "mdi:plus");
      const btn = this._el("button", { className: "plan-add-btn" }, [icon, this._t("plan_add")]);
      btn.addEventListener("click", () => {
        this._planAdd = { date: day.date, query: "", fresh: true };
        this._render();
      });
      return btn;
    }
    const input = this._el("input", {
      type: "text",
      className: "plan-add-input",
      value: state.query,
      placeholder: this._t("plan_search_placeholder"),
      "data-focus-key": "plan_add",
    });
    const results = this._el("div", { className: "plan-add-results" });
    if (!state.lists) state.lists = new Set();
    // Typing refills the results in place: a rebuild of the card on every
    // key would drop the field mid-word.
    const fill = () => results.replaceChildren(...this._buildPlanCandidates(day, state.query, state.lists));
    // The lists that have something to plan, as a filter: none picked = all.
    const withTasks = this._planCandidateLists(day);
    for (const entryId of [...state.lists]) {
      if (!withTasks.some((src) => src.entry_id === entryId)) state.lists.delete(entryId);
    }
    const chips = withTasks.length > 1
      ? this._el("div", { className: "plan-add-lists" }, withTasks.map((src) => {
        const chip = this._el("button", {
          className: "plan-list-chip" + (state.lists.has(src.entry_id) ? " active" : ""),
          textContent: src.name,
        });
        chip.dataset.planEntry = src.entry_id;
        chip.addEventListener("click", () => {
          if (state.lists.has(src.entry_id)) state.lists.delete(src.entry_id);
          else state.lists.add(src.entry_id);
          chip.classList.toggle("active", state.lists.has(src.entry_id));
          fill();
        });
        return chip;
      }))
      : null;
    input.addEventListener("input", () => {
      state.query = input.value;
      fill();
    });
    const close = () => {
      this._planAdd = null;
      this._render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    fill();
    if (state.fresh) {
      state.fresh = false;
      setTimeout(() => { if (input.isConnected) input.focus(); }, 0);
    }
    const closeIcon = document.createElement("ha-icon");
    closeIcon.setAttribute("icon", "mdi:close");
    const closeBtn = this._el("button", { className: "plan-add-close", title: this._t("dialog_cancel") }, [closeIcon]);
    closeBtn.addEventListener("click", close);
    return this._el("div", { className: "plan-add" }, [
      this._el("div", { className: "plan-add-row" }, [input, closeBtn]),
      chips,
      results,
    ]);
  }

  // The plan's lists that hold an open task not on *day* yet.
  _planCandidateLists(day) {
    const onDay = new Set((day.items || []).map((r) => `${r.entry_id}|${r.task_id}`));
    return (this._plan.sources || []).filter((src, i) =>
      ((this._columns[i] && this._columns[i].tasks) || []).some(
        (task) => !task.completed && !onDay.has(`${src.entry_id}|${task.id}`)
      ));
  }

  // Open tasks of the plan's lists that are not on *day* yet.
  _buildPlanCandidates(day, query, lists = new Set()) {
    const onDay = new Set((day.items || []).map((r) => `${r.entry_id}|${r.task_id}`));
    const q = String(query || "").trim().toLowerCase();
    const sources = this._plan.sources || [];
    const showList = sources.length > 1;
    const found = [];
    sources.forEach((src, i) => {
      if (lists.size > 0 && !lists.has(src.entry_id)) return;
      for (const task of (this._columns[i] && this._columns[i].tasks) || []) {
        if (task.completed || onDay.has(`${src.entry_id}|${task.id}`)) continue;
        if (q && !String(task.title || "").toLowerCase().includes(q)) continue;
        found.push({ task, src });
      }
    });
    if (found.length === 0) {
      return [this._el("div", { className: "plan-no-results", textContent: this._t("plan_no_results") })];
    }
    return found.slice(0, 8).map(({ task, src }) => {
      const children = [this._el("span", { className: "plan-candidate-title", textContent: task.title })];
      if (task.due_date) children.push(this._buildDueDateBadge(task));
      if (showList) children.push(this._el("span", { className: "plan-list-badge", textContent: src.name }));
      const btn = this._el("button", { className: "plan-candidate" }, children);
      btn.addEventListener("click", () => this._planWrite("home_tasks/plan_task", {
        task_id: String(task.id), entry_id: src.entry_id, date: day.date,
      }));
      return btn;
    });
  }

  // Take a task's rows out of the plan as it is shown, ahead of the backend
  // (which drops the reference to a deleted task on its own).
  _planForget(taskId, colIdx) {
    const src = this._plan && (this._plan.sources || [])[colIdx];
    if (!src) return;
    for (const day of this._plan.days || []) {
      day.items = (day.items || []).filter(
        (r) => !(r.entry_id === src.entry_id && String(r.task_id) === String(taskId))
      );
    }
  }

  // At the top of an open row: to the next day, to another day, off the
  // plan. A task that is there through its due date can only be moved.
  _buildPlanActions(task, day, row) {
    if (row.completed) return [];
    const plan = this._plan;
    const ref = { task_id: String(task.id), entry_id: row.entry_id };
    const others = (plan.horizon || []).filter((d) => d !== day.date);
    const next = (plan.horizon || [])[(plan.horizon || []).indexOf(day.date) + 1];
    const buttons = [];
    const button = (cls, label, onClick) => {
      const btn = this._el("button", { className: `move-task-btn ${cls}`, textContent: label });
      btn.addEventListener("click", onClick);
      buttons.push(btn);
    };
    if (next) {
      button("plan-next-btn", `→ ${this._planDayName(next, plan.today)}`, () =>
        this._planWrite("home_tasks/plan_task", { ...ref, date: next }));
    }
    if (others.length > 1) {
      button("plan-move-btn", `→ ${this._t("plan_move_day")}`, async () => {
        const date = await this._planDayDialog(task, others, plan.today, this._t("move_task"));
        if (date) this._planWrite("home_tasks/plan_task", { ...ref, date });
      });
    }
    if (row.kind === "planned") {
      button("plan-remove-btn", this._t("plan_remove"), () =>
        this._planWrite("home_tasks/unplan_task", { ...ref }));
    } else {
      // There through its due date: it can be moved, not taken off. Say so
      // where the button would be, instead of leaving it out without a word.
      buttons.push(this._el("span", { className: "plan-due-hint", textContent: this._t("plan_due_hint") }));
    }
    return buttons;
  }

  // Resolves with the day picked (an ISO date), or null.
  _planDayDialog(task, dates, today, okLabel) {
    const sel = this._el("select", { className: "ht-move-select" }, dates.map(
      (d) => this._el("option", { value: d, textContent: this._planDayLabel(d, today) })
    ));
    return this._modalDialog({
      message: this._t("plan_day_msg", task.title),
      okLabel,
      body: [sel],
      resolveOk: () => sel.value,
    });
  }

  // A drag ended: the day the row lies in now gets its rows in the order
  // they stand. That re-plans a row that came from another day.
  async _finishPlanDrag(el) {
    const list = el && el.closest(".plan-day-list");
    if (!list) {
      this._render();
      return;
    }
    const date = list.dataset.planDate;
    const items = [...list.querySelectorAll(".task[data-task-id]")].map((n) => ({
      task_id: n.dataset.taskId,
      entry_id: n.dataset.planEntry,
    }));
    const day = ((this._plan && this._plan.days) || []).find((d) => d.date === date);
    const was = ((day && day.items) || []).map((r) => `${r.entry_id}|${r.task_id}`).join("\n");
    if (items.map((r) => `${r.entry_id}|${r.task_id}`).join("\n") === was) {
      this._render();   // dropped where it was
      return;
    }
    await this._planWrite("home_tasks/set_plan_day", { date, items });
  }

  // ── TasksCardBase hooks ───────────────────────────────────────────────────

  _taskStateKey(taskId, colIdx) {
    const entryId = this._plan?.sources?.[colIdx]?.entry_id;
    return JSON.stringify([entryId, String(taskId)]);
  }

  // The lists of the plan, as columns made from it - not columns of the
  // card's config.
  _sourceCols() {
    return this._planCols || [];
  }

  _sourceCol(i) {
    return (this._planCols || [])[i];
  }

  _buildCardContent() {
    return this._buildPlanView();
  }

  // The plan names the lists it draws from.
  _loadOwnData() {
    return this._loadPlan();
  }

  // During Home Assistant's start: the plan's entry may not be loaded yet.
  _bootIncomplete() {
    return !this._plan;
  }

  // The plan is read; now the tasks of its lists.
  async _afterListsLoaded() {
    await this._loadColumnTasks();
    this._render();
  }

  // *quiet*: a look in the background (a sensor changed, the poll). One
  // that finds nothing new leaves the card as it is - a rebuild under the
  // pointer or mid-scroll for no change is only a flicker.
  async _loadAllTasks(quiet = false) {
    // A day plan first reads the plan: it says which lists there are, and
    // which of them changed.
    const before = this._planJson;
    await this._loadPlan();
    const changed = await this._loadColumnTasks();
    if (quiet && changed === 0 && before !== undefined && this._planJson === before) return;
    this._render();
  }

  // A list is loaded again only when the plan says its tasks changed.
  _sourceStamps() {
    return (this._plan && this._plan.sources) || [];
  }

  // Its sensor changes whenever the plan reads differently (a row planned,
  // a task of one of its lists changed, midnight).
  _watchHass(prev, hass) {
    this._watchPlan(prev, hass);
    return false;
  }

  // A day plan asks the providers only about the lists it shows rows of.
  _beforePoll() {
    this._planDoubtShown();
  }

  // A day plan keeps its lists until they change; after a write to a linked
  // list the provider's answer is what counts.
  _beforeExternalReload(colIdx) {
    this._planDoubt(colIdx);
  }

  // The row goes with the task; otherwise it would show for a moment as a
  // row whose list has not answered.
  _taskGoneLocally(taskId, colIdx) {
    this._planForget(taskId, colIdx);
  }

  // The backend moved the task's places on the plan to its new id; the
  // card's copy follows until the plan is read again.
  _onTaskIdChanged(colIdx, oldId, newId) {
    const entryId = ((this._plan && this._plan.sources) || [])[colIdx]?.entry_id;
    for (const day of (this._plan && this._plan.days) || []) {
      for (const row of day.items || []) {
        if (row.entry_id === entryId && String(row.task_id) === String(oldId)) row.task_id = newId;
      }
    }
    this._planJson = null;
  }

  // The row was taken out of the card's copy of the plan. Deleted or not,
  // the plan as it reads now replaces that copy.
  _afterDeleteSent() {
    this._planJson = null;
  }

  // Days, not lists: the row's new place is a place on the plan.
  _dropDragged(draggedEl) {
    this._finishPlanDrag(draggedEl);
  }

  // A day of the plan without a row under the finger.
  _touchOverNothing(el) {
    const dayList = el.closest(".plan-day-list");
    if (dayList) this._planDropInto(dayList);
  }

  // A task can be on the plan twice (done today, open again tomorrow): the
  // row is the one of the list *colIdx*.
  _findTaskRow(taskId, colIdx) {
    const src = this._plan?.sources?.[colIdx];
    if (!src) return null;
    return this.shadowRoot.querySelector(
      `.task[data-task-id="${CSS.escape(String(taskId))}"][data-plan-entry="${CSS.escape(String(src.entry_id))}"]`
    );
  }

  getCardSize() {
    const days = (this._plan && this._plan.days) || [];
    return 4 + Math.max(0, ...days.map((day) => (day.items || []).length));
  }

  _getStyles() {
    return super._getStyles() + `
      /* ── Day plan view ── */
      .plan-view { display: flex; flex-direction: column; min-height: 0; }
      .plan-view.compact { padding: 0; }
      .plan-days { display: flex; align-items: stretch; overflow-x: auto; min-height: 0; }
      .plan-day {
        flex: 1 1 0; min-width: 260px; display: flex; flex-direction: column;
        padding-bottom: 12px; border-right: 1px solid var(--todo-divider); box-sizing: border-box;
      }
      .plan-day:last-child { border-right: none; }
      .plan-days.single .plan-day { min-width: 0; }
      .plan-day-head {
        display: flex; flex-direction: column; gap: 6px; padding: 14px 16px 12px;
        border-bottom: 1px solid var(--todo-divider);
      }
      /* The current day is what the card is about: its head is tinted, so a
         plan never reads as one more list. */
      .plan-current .plan-day-head {
        background: color-mix(in srgb, var(--todo-primary) 14%, var(--todo-bg));
        border-bottom-color: color-mix(in srgb, var(--todo-primary) 40%, transparent);
        padding-top: 16px;
      }
      /* A card title is the plan's heading: it gets the tint of the current
         day's head over the whole width. Left plain, it was a bare line
         above a coloured box. */
      .plan-view > .card-global-title {
        padding: 14px 16px 12px;
        background: color-mix(in srgb, var(--todo-primary) 14%, var(--todo-bg));
        border-bottom: 1px solid color-mix(in srgb, var(--todo-primary) 40%, transparent);
      }
      .plan-head-line { display: flex; align-items: baseline; gap: 8px; }
      .plan-day-name { font-size: 1rem; font-weight: 600; color: var(--todo-text); line-height: 1.2; }
      .plan-current .plan-day-name { font-size: 1.35rem; color: var(--todo-primary); }
      .plan-day-date { font-size: 13px; color: var(--todo-secondary-text); }
      .plan-count {
        margin-left: auto; font-size: 12px; min-width: 20px; text-align: center; padding: 1px 6px;
        border-radius: 10px; background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08);
        color: var(--todo-secondary-text);
      }
      .plan-note {
        font-size: 14px; line-height: 1.4; color: var(--todo-text); cursor: text;
        padding: 2px 6px; margin: 0 -6px; border-radius: 4px; word-break: break-word;
      }
      .plan-note:hover { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.06); }
      .plan-note.empty { color: var(--todo-disabled); font-style: italic; }
      .plan-note-input {
        font: inherit; font-size: 14px; padding: 3px 6px; margin: 0 -6px; box-sizing: border-box;
        width: calc(100% + 12px); border: 1px solid var(--todo-primary); border-radius: 4px;
        background: var(--todo-bg); color: var(--todo-text); outline: none;
      }
      .plan-progress { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--todo-secondary-text); }
      .plan-progress-text { white-space: nowrap; }
      .plan-bar {
        flex: 1; height: 4px; border-radius: 2px; overflow: hidden;
        background: color-mix(in srgb, var(--todo-primary) 22%, transparent);
      }
      .plan-bar-fill { height: 100%; border-radius: 2px; background: var(--todo-primary); transition: width 0.3s ease; }
      .plan-day-list { padding: 12px 12px 0; }
      .plan-empty { text-align: center; padding: 14px 8px; color: var(--todo-disabled); font-size: 13px; }
      .plan-day-list:has(.task) .plan-empty { display: none; }
      .plan-num {
        flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border-radius: 50%;
        border: 2px solid var(--todo-primary); background: transparent; color: var(--todo-primary);
        font: inherit; font-size: 12px; font-weight: 600; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        /* No transition: a row rebuilt under the pointer would fade in its
           hover colour again each time, which reads as a flicker. */
        cursor: pointer; font-variant-numeric: tabular-nums;
      }
      button.plan-num:hover:not(:disabled) { background: var(--todo-primary); color: var(--text-primary-color, #fff); }
      .plan-num.done {
        background: var(--todo-primary); border-color: var(--todo-primary);
        color: var(--text-primary-color, #fff); opacity: 0.55;
      }
      .plan-num:disabled { cursor: default; }
      .plan-num ha-icon { --mdc-icon-size: 16px; display: flex; }
      .plan-kind-overdue .plan-num:not(.done) { border-color: var(--todo-error); color: var(--todo-error); }
      .plan-kind-overdue button.plan-num:hover:not(:disabled) { background: var(--todo-error); }
      .plan-list-badge {
        font-size: 11px; padding: 2px 8px; border-radius: 10px; white-space: nowrap;
        background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); color: var(--todo-secondary-text);
      }
      .plan-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 12px 10px 46px; }
      .plan-actions > button { white-space: nowrap; }
      .plan-due-hint {
        flex: 1 1 160px; align-self: center; font-size: 12px; line-height: 1.3;
        color: var(--todo-secondary-text);
      }
      .plan-add-lists { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .plan-list-chip {
        font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 12px; cursor: pointer;
        border: 1px solid var(--todo-divider); background: transparent; color: var(--todo-secondary-text);
      }
      .plan-list-chip:hover { border-color: var(--todo-primary); color: var(--todo-primary); }
      .plan-list-chip.active {
        background: color-mix(in srgb, var(--todo-primary) 18%, transparent);
        border-color: var(--todo-primary); color: var(--todo-primary);
      }
      /* Compact: the same day in less height. */
      .plan-view.compact .plan-day-head { padding: 8px 12px 8px; gap: 3px; }
      .plan-view.compact .plan-current .plan-day-head { padding-top: 10px; }
      .plan-view.compact .plan-current .plan-day-name { font-size: 1.1rem; }
      .plan-view.compact > .card-global-title { padding: 10px 12px 8px; font-size: 1.1rem; }
      .plan-view.compact .plan-day-list { padding: 8px 8px 0; gap: 4px; }
      .plan-view.compact .plan-num { width: 22px; height: 22px; font-size: 11px; }
      .plan-view.compact .plan-num ha-icon { --mdc-icon-size: 14px; }
      .plan-view.compact .plan-actions { padding: 0 8px 6px 38px; gap: 6px; }
      .plan-view.compact .plan-carry, .plan-view.compact .plan-add-btn { margin: 6px 8px 0; padding: 5px 8px; }
      .plan-view.compact .plan-add { margin: 6px 8px 0; }
      .plan-view.compact .plan-day { padding-bottom: 8px; }
      .plan-carry, .plan-add-btn {
        display: flex; align-items: center; justify-content: center; gap: 6px;
        margin: 8px 12px 0; padding: 8px 10px; border-radius: var(--todo-radius);
        border: 1px dashed var(--todo-divider); background: transparent;
        color: var(--todo-secondary-text); font: inherit; font-size: 13px; cursor: pointer;
      }
      .plan-carry { border-color: var(--todo-primary); color: var(--todo-primary); }
      .plan-carry:hover, .plan-add-btn:hover {
        border-color: var(--todo-primary); color: var(--todo-primary);
        background: color-mix(in srgb, var(--todo-primary) 8%, transparent);
      }
      .plan-add-btn ha-icon { --mdc-icon-size: 18px; display: flex; }
      .plan-add { margin: 8px 12px 0; }
      .plan-add-row { display: flex; gap: 6px; align-items: center; }
      .plan-add-input {
        flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--todo-divider);
        border-radius: var(--todo-radius); background: var(--todo-bg); color: var(--todo-text);
        font: inherit; font-size: 14px; outline: none; box-sizing: border-box;
      }
      .plan-add-input:focus { border-color: var(--todo-primary); }
      .plan-add-close {
        flex: 0 0 auto; width: 32px; height: 32px; padding: 0; border: none; border-radius: 50%;
        background: transparent; color: var(--todo-secondary-text); cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .plan-add-close:hover { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); }
      .plan-add-close ha-icon { --mdc-icon-size: 18px; display: flex; }
      .plan-add-results { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      .plan-candidate {
        display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
        padding: 8px 10px; border: 1px solid var(--todo-divider); border-radius: var(--todo-radius);
        background: transparent; color: var(--todo-text); font: inherit; font-size: 14px; cursor: pointer;
      }
      .plan-candidate:hover { border-color: var(--todo-primary); }
      .plan-candidate-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .plan-no-results { padding: 8px 4px; font-size: 13px; color: var(--todo-disabled); }
      .plan-missing { padding: 24px 16px; text-align: center; color: var(--todo-secondary-text); font-size: 14px; }
      .plan-missing-detail { margin-top: 6px; font-size: 12px; color: var(--todo-disabled); }
      .plan-missing .new-entry-link {
        display: inline-block; margin-top: 12px; color: var(--todo-primary); text-decoration: none;
      }
      .plan-missing .new-entry-link:hover { text-decoration: underline; }
      /* On a phone a day takes most of the width and the next one peeks in. */
      @media (max-width: 600px) {
        .plan-days { scroll-snap-type: x proximity; }
        .plan-day { min-width: 86%; scroll-snap-align: start; }
        .plan-days.single .plan-day { min-width: 0; }
      }
    `;
  }
}
