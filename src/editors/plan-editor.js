// The editor of the day plan card: the plan, what is shown, the plan's lists.

import { EditorBase } from "./editor-base.js";

export class HomeTasksDayPlanCardEditor extends EditorBase {
  setConfig(config) {
    // Left over from a config written when the plan was a view of the list
    // card: neither key means anything here.
    const { columns: _c, view: _v, ...rest } = config || {};
    this._config = rest;
    // Skip re-render if this setConfig is the echo of our own _fireChanged call
    if (this._ignoreNextSetConfig) {
      this._ignoreNextSetConfig = false;
      return;
    }
    if (this._listsLoaded) this._render();
  }

  // The day plan's settings, laid out like a list column's: the plan where a
  // column has its list, then sections that open - what is shown, grouped by
  // card and day header, the fields of an open task, and the lists the plan
  // draws from.
  _buildPlanEditor(plans) {
    const set = (updates) => {
      const next = { ...this._config };
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      this._config = next;
      this._fireChanged();
    };
    const groupLabel = (key) =>
      this._el("div", { className: "group-label" }, [this._el("span", { textContent: this._t(key) })]);
    // Only the state that differs from the default is written, so a card
    // that changes nothing keeps a config of three lines.
    const toggle = (cls, labelKey, key, defaultOn) => {
      const sw = document.createElement("ha-switch");
      sw.className = cls;
      const now = this._config[key];
      sw.checked = defaultOn ? now !== false : now === true;
      sw.setAttribute("aria-label", this._t(labelKey));
      sw.addEventListener("change", () => set({ [key]: sw.checked === defaultOn ? undefined : sw.checked }));
      return this._el("div", { className: "toggle-row" }, [
        this._el("span", { className: "toggle-label", textContent: this._t(labelKey) }),
        sw,
      ]);
    };

    const known = plans.some((p) => p.id === this._config.plan);
    const planOptions = plans.map((p) => [p.id, p.name]);
    // A plan the config names but that is not there (yet) stays selectable.
    if (this._config.plan && !known) planOptions.unshift([this._config.plan, this._config.plan]);
    const planSelect = this._editorSelect("ed_view_day_plan", "plan-select", planOptions,
      this._config.plan || (plans[0] && plans[0].id) || "", (value) => {
        set({ plan: value });
        this._render();                       // the lists below are the chosen plan's
      });

    const days = Math.min(7, Math.max(1, parseInt(this._config.days, 10) || 1));
    const daysSelect = this._editorSelect("ed_plan_days", "days-select",
      [1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), String(n)]), String(days),
      (value) => set({ days: Number(value) }));

    // The days the plan has, Monday to Sunday - for a part-time week as much
    // as for Monday to Friday. That is one of the plan's own settings (its
    // workdays), written to the plan right away like its lists: every card
    // showing the plan and its assistants follow.
    const planInfo = plans.find((p) => p.id === (this._config.plan || (plans[0] && plans[0].id)));
    const workdayNodes = [];
    if (planInfo) {
      const ALL = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
      const current = new Set((planInfo.workdays || []).length ? planInfo.workdays : ALL);
      const chips = ALL.map((day, index) => {
        const on = current.has(day);
        const btn = this._el("button", {
          className: "assignee-chip plan-workday" + (on ? " active" : ""),
          textContent: this._t(`rec_wd_${index}`),
        });
        btn.type = "button";
        btn.dataset.day = day;
        btn.setAttribute("aria-pressed", String(on));
        // A plan needs at least one day: the last one cannot be taken out.
        if (on && current.size === 1) btn.disabled = true;
        btn.addEventListener("click", () => {
          // From the days as shown now, not as they were when this chip was
          // drawn: a second tap before the first write is back builds on it.
          const next = new Set((planInfo.workdays || []).length ? planInfo.workdays : ALL);
          if (next.has(day)) next.delete(day);
          else next.add(day);
          if (!next.size) return;
          const workdays = ALL.filter((d) => next.has(d));
          if (planInfo._savedWorkdays === undefined) planInfo._savedWorkdays = planInfo.workdays || [];
          planInfo.workdays = workdays.length === ALL.length ? [] : workdays;   // shown at once
          const seq = (planInfo._workdaysSeq = (planInfo._workdaysSeq || 0) + 1);
          planInfo._daysError = null;
          this._render();
          // One write after the other, in the order of the taps.
          this._workdaysWrite = (this._workdaysWrite || Promise.resolve()).then(() =>
            this._hass.callWS({ type: "home_tasks/set_plan_workdays", plan: planInfo.id, workdays })
              .then((info) => {
                planInfo._savedWorkdays = (info && info.workdays) || (workdays.length === ALL.length ? [] : workdays);
                // A later tap is on its way: what it shows stays.
                if (seq === planInfo._workdaysSeq) {
                  planInfo.workdays = planInfo._savedWorkdays;
                  this._render();
                }
              })
              .catch((err) => {
                // As the lists: a later tap's write holds the whole newer
                // choice, so only the last one's failure goes back to what
                // the plan has - the last write that went through.
                if (seq === planInfo._workdaysSeq) {
                  planInfo.workdays = planInfo._savedWorkdays;
                  planInfo._daysError = (err && err.message) || String(err);
                  this._render();
                }
              }));
        });
        return btn;
      });
      workdayNodes.push(
        groupLabel("ed_plan_workdays"),
        this._el("div", { className: "assignee-chip-row plan-workdays" }, chips),
      );
    }

    const sections = [
      this._buildEditorSection("plan_view", "mdi:eye", "ed_sec_view", [
        groupLabel("ed_group_card"),
        daysSelect,
        this._el("div", { className: "toggle-grid" }, [
          toggle("compact-switch", "ed_compact", "compact", false),
        ]),
        ...workdayNodes,
        ...(planInfo && planInfo._daysError
          ? [this._el("div", { className: "hint plan-lists-error plan-days-error", textContent: planInfo._daysError })]
          : []),
        groupLabel("ed_group_header"),
        this._el("div", { className: "toggle-grid" }, [
          toggle("date-switch", "due_date_lbl", "show_date", true),
          toggle("progress-switch", "ed_show_progress", "show_progress", true),
          toggle("focus-switch", "plan_note_placeholder", "show_focus", true),
        ]),
      ]),
      // What an open row shows, and in which order: the options a column
      // has for it, at the root of the card config - a plan's rows come
      // from several lists and all follow the one setting.
      this._buildEditorSection("plan_features", "mdi:tune", "ed_sec_display", [
        this._buildDetailFieldList({ get: () => this._config, update: set }),
        toggle("move-switch", "ed_show_move", "show_move", true),
      ]),
    ];

    // The lists the plan draws from. That is a setting of the plan, not of
    // this card - every card showing the plan and the plan's tools for
    // assistants follow it - but this is where one looks for it.
    const allLists = this._planLists || [];
    if (planInfo && allLists.length > 0) {
      // The whole choice, also lists that are not there right now (deleted,
      // or their entry not loaded): they keep limiting the plan, so they
      // show - as chips of their own - and are saved along. Dropping them
      // without a word could leave nothing chosen, which means every list,
      // for the plan's assistants too.
      const chosen = new Set(planInfo.source_lists || []);
      const missing = [...chosen].filter((id) => !allLists.some((l) => l.entry_id === id));
      const ordered = (ids) => [
        ...allLists.map((x) => x.entry_id).filter((id) => ids.has(id)),
        ...missing.filter((id) => ids.has(id)),
      ];
      // As the workdays: shown at once, written one after the other in the
      // order of the taps, and back to the last saved choice when refused.
      const save = (ids) => {
        if (planInfo._savedLists === undefined) planInfo._savedLists = planInfo.source_lists || [];
        planInfo.source_lists = ids;
        const seq = (planInfo._listsSeq = (planInfo._listsSeq || 0) + 1);
        planInfo._listsError = null;
        this._render();
        this._listsWrite = (this._listsWrite || Promise.resolve()).then(() =>
          this._hass.callWS({ type: "home_tasks/set_plan_lists", plan: planInfo.id, source_lists: ids })
            .then((info) => {
              planInfo._savedLists = (info && info.source_lists) || ids;
              // A later tap is on its way: what it shows stays.
              if (seq === planInfo._listsSeq) {
                planInfo.source_lists = planInfo._savedLists;
                this._render();
              }
            })
            .catch((err) => {
              // Later queued writes contain the full newer choice. An
              // earlier failure must not replace that choice mid-tap.
              if (seq === planInfo._listsSeq) {
                planInfo.source_lists = planInfo._savedLists;
                planInfo._listsError = (err && err.message) || String(err);
                this._render();
              }
            }));
      };
      // From the choice as shown now, not as it was when the chip was drawn:
      // a second tap before the first write is back builds on it.
      const shown = () => new Set(planInfo.source_lists || []);
      const chip = (label, active, cls, onClick) => {
        const btn = this._el("button", { className: `assignee-chip ${cls}` + (active ? " active" : ""), textContent: label });
        btn.type = "button";
        btn.setAttribute("aria-pressed", String(active));
        btn.addEventListener("click", onClick);
        return btn;
      };
      const chips = [
        chip(this._t("ed_plan_all_lists"), chosen.size === 0, "plan-all-lists", () => save([])),
        ...allLists.map((l) => {
          const btn = chip(l.name, chosen.has(l.entry_id), "plan-list", () => {
            const next = shown();
            if (next.has(l.entry_id)) next.delete(l.entry_id);
            else next.add(l.entry_id);
            save(ordered(next));
          });
          btn.dataset.entryId = l.entry_id;
          return btn;
        }),
        // Chosen, but not there: a tap takes it out of the choice.
        ...missing.map((id) => {
          const btn = chip(this._t("ed_plan_list_missing"), true, "plan-list plan-list-missing", () => {
            const next = shown();
            next.delete(id);
            save(ordered(next));
          });
          btn.dataset.entryId = id;
          return btn;
        }),
      ];
      const nodes = [this._el("div", { className: "assignee-chip-row plan-lists" }, chips)];
      if (planInfo._listsError) {
        nodes.push(this._el("div", { className: "hint plan-lists-error", textContent: planInfo._listsError }));
      }
      sections.push(this._buildEditorSection("plan_lists", "mdi:format-list-checks", "ed_view_lists", nodes));
    }

    return this._el("div", { className: "visual-editor plan-editor" }, [
      this._el("div", { className: "field" }, [planSelect, this._newEntryLink()]),
      ...sections,
    ]);
  }

  // ── EditorBase hooks ──────────────────────────────────────────────────────

  // A day plan has no columns to set up: its rows come from the plan.
  _buildEditorBody() {
    return [this._buildPlanEditor(this._plans || [])];
  }

  // A new card names its plan from the start (see getStubConfig); one
  // written by hand without a plan gets the first one once there is a
  // choice to make.
  _afterListsLoaded() {
    if (!this._config.plan && this._plans.length > 1) {
      this._config = { ...this._config, plan: this._plans[0].id };
      this._fireChanged();
    }
  }
}
