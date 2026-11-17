// The editor of the list card: its columns, one tab each.

import { MAX_REMINDERS, MAX_REOPEN_LEAD_MINUTES, SORT_MODES, TODO_FEATURE, UNASSIGNED, CURRENT_USER, _TILE_SIZES, _assignees, _tileMinWidth, imageSettingsForLists, listInfoFor, listSupportsDue, nextFreeReminderOffset, personEntries, reminderOffsetOptions } from "../core/helpers.js";
import { EditorBase } from "./editor-base.js";

export class HomeTasksCardEditor extends EditorBase {
  _buildDefaultsEditor(col) {
    const container = this._el("div", { className: "defaults-editor" });
    const target = this._sectionsTargetPayload(col);
    const key = this._sourceKeyForCol(col);
    if (!target) return container;
    const cached = this._listDefaults[key];
    if (cached) {
      this._renderDefaultsInto(container, col, cached);
      return container;
    }
    container.appendChild(this._el("span", { className: "hint", textContent: this._t("ed_loading") }));
    // Fetched once per editor session and cached like _listSections /
    // _listMeta: the editor rebuilds its DOM on every structural change, and
    // an uncached fetch would flash "Loading\u2026" and hit the backend each
    // time.
    this._hass.callWS({ type: "home_tasks/get_defaults", ...target })
      .then((r) => {
        const d = (r && r.defaults) || {};
        this._listDefaults[key] = {
          assignees: [...(d.assignees || (d.assignee ? [d.assignee] : []))],
          reminders: [...(d.reminders || [])],
          tags: [...(d.tags || [])],
          priority: d.priority ?? null,
          section_id: d.section_id || null,
          tag_catalog: [...(d.tag_catalog || [])],
          recurrence_reopen_lead: d.recurrence_reopen_lead || 0,
          recurrence_reopen_on_complete: d.recurrence_reopen_on_complete === true,
        };
        this._renderDefaultsInto(container, col, this._listDefaults[key]);
      })
      .catch(() => {
        // Never seed the cache with fabricated empty defaults: an editable
        // empty state would let the very next change wipe the list's real
        // defaults on the server. Show the failure; the next render retries.
        container.replaceChildren(
          this._el("span", { className: "hint", textContent: this._t("ed_defaults_load_failed") })
        );
      });
    return container;
  }

  // Whether this column's LIST takes part in the cross-list image pool.
  // Unlike the switches above this is not a card option: it belongs to the
  // list itself, so every card showing it behaves the same and the backend
  // can honour it for generations triggered anywhere.
  // What the background generation still has to do. Cancelling a job also
  // switches its list's automatic generation off - leaving it on would just
  // put the task back on the next scan and make the button look broken.
  // The queue runs without a dashboard, so the list has to remember that it
  // wants images, and the backend has to know which ai_task entity to use.
  async _syncAutoGenerate(col, on) {
    const target = col.entity_id ? { entity_id: col.entity_id } : { list_id: col.list_id };
    if (!target.entity_id && !target.list_id) return;
    try {
      const own = on ? imageSettingsForLists(this) : null;
      if (own) {
        await this._hass.callWS({ type: "home_tasks/sync_image_config", ...own });
      }
      const change = { auto_generate_images: on, ...(own || {}) };
      await this._hass.callWS({ type: "home_tasks/set_list_settings", ...target, ...change });
      const info = listInfoFor(this, col);
      if (info) Object.assign(info, change);
    } catch (e) {
      console.warn("Could not sync automatic image generation:", e);
    }
  }

  _buildQueuePanel() {
    const wrap = this._el("div", { className: "queue-panel" });

    const cancelBtn = (job) => {
      const btn = this._el("button", { className: "queue-cancel", textContent: "\u00d7" });
      btn.title = this._t("ed_queue_cancel");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await this._hass.callWS({
            type: "home_tasks/cancel_image_queue",
            jobs: [{
              ...(job.list_id ? { list_id: job.list_id } : {}),
              ...(job.entity_id ? { entity_id: job.entity_id } : {}),
              task_id: job.task_id,
            }],
          });
        } catch (e) { /* the refresh below shows what actually happened */ }
        load();
      });
      return btn;
    };

    const render = (current, jobs) => {
      wrap.innerHTML = "";
      if (!current && !jobs.length) {
        wrap.appendChild(this._el("div", {
          className: "hint", textContent: this._t("ed_queue_empty"),
        }));
        return;
      }
      if (current) {
        // The one being generated right now cannot be cancelled - the
        // provider call is already out.
        const row = this._el("div", { className: "queue-row current" }, [
          this._el("span", { className: "queue-pos", textContent: "\u25b6" }),
          this._el("span", { className: "queue-title", textContent: current.title || current.task_id }),
          this._el("span", { className: "queue-state", textContent: this._t("ed_queue_running") }),
        ]);
        wrap.appendChild(row);
      }
      if (jobs.length) {
        wrap.appendChild(this._el("div", {
          className: "hint", textContent: this._t("ed_queue_pending", String(jobs.length)),
        }));
      }
      jobs.forEach((job, i) => {
        const row = this._el("div", { className: "queue-row" }, [
          // Numbered so the order is not a guess: 1 is generated next.
          this._el("span", { className: "queue-pos", textContent: `${i + 1}.` }),
          this._el("span", { className: "queue-title", textContent: job.title || job.task_id }),
        ]);
        row.appendChild(cancelBtn(job));
        wrap.appendChild(row);
      });
    };

    // Generation takes seconds, so the panel follows along — but only while
    // there is something to follow. Once the queue is empty it stops polling
    // instead of ticking forever behind a closed editor (an interval would
    // also outlive the panel, and in tests the process with it).
    let timer = null;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const load = async (scheduled = false) => {
      stop();
      // The first call runs before the panel has been appended, so only a
      // tick that scheduled itself may give up on being disconnected.
      if (scheduled && !wrap.isConnected) return;
      let current = null;
      let jobs = [];
      try {
        const r = await this._hass.callWS({ type: "home_tasks/get_image_queue" });
        current = (r && r.current) || null;
        jobs = (r && r.queue) || [];
      } catch (e) { /* render the empty state below */ }
      render(current, jobs);
      if ((current || jobs.length) && wrap.isConnected) {
        timer = setTimeout(() => load(true), 3000);
      }
    };
    load();
    return wrap;
  }

  _buildListSettingToggle(col, key, labelKey, defaultOn) {
    const info = col.entity_id
      ? (this._externalLists || []).find(l => l.entity_id === col.entity_id)
      : (this._lists || []).find(l => l.id === col.list_id);
    const sw = document.createElement("ha-switch");
    sw.checked = info && info[key] !== undefined ? info[key] !== false : defaultOn;
    sw.disabled = !info;
    sw.setAttribute("aria-label", this._t(labelKey));
    sw.addEventListener("change", async () => {
      const target = col.entity_id ? { entity_id: col.entity_id } : { list_id: col.list_id };
      try {
        await this._hass.callWS({
          type: "home_tasks/set_list_settings", ...target, [key]: sw.checked,
        });
        if (info) info[key] = sw.checked;  // keep the cached list in sync
      } catch (e) {
        sw.checked = !sw.checked;  // put the switch back if the write failed
      }
    });
    return this._el("div", { className: "toggle-row" }, [
      this._el("span", { className: "toggle-label", textContent: this._t(labelKey) }),
      sw,
    ]);
  }

  // The order of the list's own todo entity - what Home Assistant's to-do
  // page, the phone and Assist show - in the card's sort modes. A setting of
  // the list, so it holds for every card; native lists only, a linked list's
  // entity belongs to its integration.
  _buildTodoSortField(col) {
    const info = (this._lists || []).find((l) => l.id === col.list_id);
    const select = this._el("select", { className: "editor-native-select" });
    const current = (info && info.todo_sort) || "manual";
    for (const mode of SORT_MODES) {
      const opt = this._el("option", { value: mode, textContent: this._t(`sort_${mode}`) });
      if (mode === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.disabled = !info;
    select.addEventListener("change", async () => {
      const prev = (info && info.todo_sort) || "manual";
      try {
        await this._hass.callWS({ type: "home_tasks/set_list_settings", list_id: col.list_id, todo_sort: select.value });
        if (info) info.todo_sort = select.value;  // keep the cached list in sync
      } catch (e) {
        select.value = prev;  // put it back if the write failed
      }
    });
    return this._el("div", { className: "todo-sort-field" }, [
      this._el("div", { className: "field-wrap" }, [
        select,
        this._el("span", { textContent: this._t("ed_todo_sort") }),
      ]),
      this._el("span", { className: "hint", textContent: this._t("ed_todo_sort_hint") }),
    ]);
  }

  // The list's "Reopen on completion" switch: a recurring task comes straight
  // back when ticked off, already due on its next occurrence.
  _buildReopenOnComplete(defaults, onChange) {
    const sw = document.createElement("ha-switch");
    sw.checked = defaults.recurrence_reopen_on_complete === true;
    sw.setAttribute("aria-label", this._t("ed_reopen_on_complete"));
    sw.addEventListener("change", () => {
      defaults.recurrence_reopen_on_complete = sw.checked;
      onChange(sw.checked);
    });
    return [
      this._el("div", { className: "toggle-row" }, [
        this._el("span", { className: "toggle-label", textContent: this._t("ed_reopen_on_complete") }),
        sw,
      ]),
      this._el("span", { className: "hint", textContent: this._t("ed_reopen_on_complete_hint") }),
    ];
  }

  // The list's "Reopen early": number + unit like the task's own field, but
  // with no interval to fit — a task starts its interval long enough for it.
  _buildDefaultLead(defaults, save) {
    const FACTORS = { minutes: 1, hours: 60, days: 1440 };
    const lead = defaults.recurrence_reopen_lead || 0;
    const units = ["hours", "days"];
    if (lead % 60) units.unshift("minutes");  // kept as set, not rounded
    const pick = [...units].reverse().find(u => lead % FACTORS[u] === 0);
    const maxIn = (u) => Math.floor(MAX_REOPEN_LEAD_MINUTES / FACTORS[u]);
    const input = this._el("input", { type: "number", value: String(lead / FACTORS[pick]) });
    input.min = 0;
    input.max = maxIn(pick);
    const unitSelect = this._el("select", { className: "editor-native-select" });
    for (const u of units) {
      const opt = this._el("option", { value: u, textContent: this._t(`rec_${u}`) });
      if (u === pick) opt.selected = true;
      unitSelect.appendChild(opt);
    }
    const commit = () => {
      const u = unitSelect.value;
      const n = Math.min(Math.max(0, parseInt(input.value, 10) || 0), maxIn(u));
      input.value = n;
      input.max = maxIn(u);
      if (n * FACTORS[u] === defaults.recurrence_reopen_lead) return;
      defaults.recurrence_reopen_lead = n * FACTORS[u];
      save({ recurrence_reopen_lead: defaults.recurrence_reopen_lead });
    };
    input.addEventListener("change", commit);
    unitSelect.addEventListener("change", commit);
    const spinUp = this._el("button", { className: "spin-btn spin-up", textContent: "▴", type: "button" });
    const spinDown = this._el("button", { className: "spin-btn spin-down", textContent: "▾", type: "button" });
    spinUp.addEventListener("click", () => {
      input.value = (parseInt(input.value, 10) || 0) + 1;
      commit();
    });
    spinDown.addEventListener("click", () => {
      input.value = (parseInt(input.value, 10) || 0) - 1;
      commit();
    });
    return [
      this._el("div", { className: "def-lead-row" }, [
        this._el("div", { className: "field-wrap" }, [
          input,
          this._el("span", { textContent: this._t("rec_lead_lbl") }),
          this._el("div", { className: "spin-btns" }, [spinUp, spinDown]),
        ]),
        this._el("div", { className: "field-wrap" }, [
          unitSelect,
          this._el("span", { textContent: this._t("rec_unit_lbl") }),
        ]),
      ]),
      this._el("span", { className: "hint", textContent: this._t("ed_default_lead_hint") }),
    ];
  }

  _renderDefaultsInto(container, col, defaults) {
    const target = this._sectionsTargetPayload(col);
    const key = this._sourceKeyForCol(col);
    const savedFlash = this._el("span", { className: "def-saved-flash" });
    // Partial saves with in-flight coalescing: each change sends only the
    // field(s) it touched (the backend keeps omitted fields), and changes
    // made while a write is in flight merge into one trailing flush.
    let saving = false;
    let pending = null;
    let renderInto;
    const flush = () => {
      const patch = pending;
      pending = null;
      saving = true;
      this._hass.callWS({ type: "home_tasks/set_defaults", ...target, ...patch })
        .then((r) => {
          // Adopt the server-normalized state (deduped, sorted reminders) so
          // the session cache cannot diverge from the store — but NEVER while
          // a newer local patch is queued: adopting then would revert the
          // optimistic DOM state and later row clicks would splice stale
          // indices. The trailing flush's response adopts instead.
          if (!pending) {
            const d = (r && r.defaults) || {};
            const norm = d.reminders || [];
            const normTags = d.tags || [];
            const normCatalog = d.tag_catalog || [];
            const normPeople = d.assignees || (d.assignee ? [d.assignee] : []);
            const changed = JSON.stringify(normPeople) !== JSON.stringify(defaults.assignees || []) ||
              (d.priority ?? null) !== defaults.priority ||
              (d.section_id || null) !== defaults.section_id ||
              JSON.stringify(norm) !== JSON.stringify(defaults.reminders) ||
              JSON.stringify(normTags) !== JSON.stringify(defaults.tags) ||
              JSON.stringify(normCatalog) !== JSON.stringify(defaults.tag_catalog || []) ||
              (d.recurrence_reopen_lead || 0) !== (defaults.recurrence_reopen_lead || 0) ||
              (d.recurrence_reopen_on_complete === true) !== (defaults.recurrence_reopen_on_complete === true);
            defaults.recurrence_reopen_lead = d.recurrence_reopen_lead || 0;
            defaults.recurrence_reopen_on_complete = d.recurrence_reopen_on_complete === true;
            defaults.assignees = [...normPeople];
            defaults.priority = d.priority ?? null;
            defaults.section_id = d.section_id || null;
            defaults.reminders.splice(0, defaults.reminders.length, ...norm);
            defaults.tags.splice(0, defaults.tags.length, ...normTags);
            defaults.tag_catalog = [...normCatalog];
            if (changed) renderInto();
          }
          savedFlash.classList.remove("err");
          savedFlash.textContent = "\u2713 " + this._t("ed_defaults_saved");
          savedFlash.classList.add("show");
          clearTimeout(savedFlash._hideT);
          savedFlash._hideT = setTimeout(() => savedFlash.classList.remove("show"), 1500);
        })
        .catch(() => {
          // Make the failure visible (the flash stays until the next
          // success) and drop the session cache so the next editor render
          // refetches the server truth instead of showing unsaved state.
          clearTimeout(savedFlash._hideT);
          savedFlash.textContent = "\u2717 " + this._t("ed_defaults_save_failed");
          savedFlash.classList.add("err", "show");
          delete this._listDefaults[key];
        })
        .then(() => {
          saving = false;
          if (pending) flush();
        });
    };
    const save = (patch) => {
      pending = { ...(pending || {}), ...patch };
      if (!saving) flush();
    };
    renderInto = () => {
      // Fixed tags and the reopen lead come first; the values every new
      // task gets follow, starting with the default people.
      const known = (key && this._listMeta[key]) || { tags: [] };
      const kids = [];
      // Fixed tags (issue #61) — not applied to new tasks like the defaults
      // below, but a per-list setting all the same: always offered when
      // tagging a task, in every card that shows the list.
      if (!defaults.tag_catalog) defaults.tag_catalog = [];
      kids.push(this._buildMultiSelect(
        this._t("ed_tag_catalog"),
        defaults.tag_catalog,
        known.tags,
        (vals) => {
          defaults.tag_catalog = vals.map((v) => String(v).trim().replace(/^#/, "").toLowerCase()).filter(Boolean);
          save({ tag_catalog: [...defaults.tag_catalog] });
        },
      ));
      kids.push(this._el("span", { className: "hint", textContent: this._t("ed_tag_catalog_hint") }));
      // Reopen on completion: a list policy for every recurring task, not a
      // value a task takes over. Not where the provider runs the recurrence
      // itself (Todoist).
      const ext = col.entity_id ? (this._externalLists || []).find((l) => l.entity_id === col.entity_id) : null;
      if (!ext?.capabilities?.can_sync_recurrence) {
        kids.push(...this._buildReopenOnComplete(defaults, (on) => {
          save({ recurrence_reopen_on_complete: on });
          renderInto();  // the reopen lead below comes and goes with it
        }));
      }
      // Reopen early (issue #77): taken over by a task when its recurrence
      // is switched on, so a later change leaves recurring tasks alone.
      // Native lists only, as for the task's own lead - and nothing to set
      // where tasks reopen on completion anyway.
      if (!col.entity_id && !defaults.recurrence_reopen_on_complete) {
        kids.push(...this._buildDefaultLead(defaults, save));
      }
      const peopleField = this._buildPersonChips(
        this._t("ed_default_assignee"),
        this._personOptions(defaults.assignees),
        defaults.assignees,
        (people) => {
          defaults.assignees = people;
          save({ assignees: people });
        },
      );
      // "Saved" shows in the first heading of the values new tasks get.
      peopleField.querySelector(".group-label").appendChild(savedFlash);
      kids.push(peopleField);

      const prioritySelect = this._el("select", { className: "editor-native-select" });
      for (const [value, labelKey] of [["", "ed_default_none"], ["1", "pri_low"], ["2", "pri_medium"], ["3", "pri_high"]]) {
        const opt = this._el("option", { value, textContent: this._t(labelKey) });
        if (String(defaults.priority ?? "") === value) opt.selected = true;
        prioritySelect.appendChild(opt);
      }
      prioritySelect.addEventListener("change", () => {
        defaults.priority = prioritySelect.value ? parseInt(prioritySelect.value, 10) : null;
        save({ priority: defaults.priority });
      });
      kids.push(this._el("div", { className: "field-wrap" }, [
        prioritySelect,
        this._el("span", { textContent: this._t("ed_default_priority") }),
      ]));

      // Suggestions come from the tags already in use on this list; the
      // multi-select takes free text too, same as the preset filters.
      kids.push(this._buildMultiSelect(
        this._t("ed_default_tags"),
        defaults.tags,
        known.tags,
        (vals) => {
          defaults.tags.splice(0, defaults.tags.length, ...vals);
          save({ tags: [...defaults.tags] });
        },
      ));

      // Sections are loaded for the Sections editor in the same render pass;
      // until they arrive this is just the "no section" entry, and the load
      // re-renders the editor.
      const sections = (key && this._listSections[key]) || [];
      if (sections.length) {
        const sectionSelect = this._el("select", { className: "editor-native-select" });
        const noSection = this._el("option", { value: "", textContent: this._t("ed_default_none") });
        if (!defaults.section_id) noSection.selected = true;
        sectionSelect.appendChild(noSection);
        for (const s of [...sections].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
          const opt = this._el("option", { value: s.id, textContent: s.name });
          if (s.id === defaults.section_id) opt.selected = true;
          sectionSelect.appendChild(opt);
        }
        sectionSelect.addEventListener("change", () => {
          defaults.section_id = sectionSelect.value || null;
          save({ section_id: defaults.section_id });
        });
        kids.push(this._el("div", { className: "field-wrap" }, [
          sectionSelect,
          this._el("span", { textContent: this._t("ed_default_section") }),
        ]));
      }

      defaults.reminders.forEach((offset, ri) => {
        const sel = this._el("select", { className: "editor-native-select" });
        for (const opt of reminderOffsetOptions(this, offset)) sel.appendChild(opt);
        sel.addEventListener("change", () => {
          defaults.reminders[ri] = parseInt(sel.value, 10);
          save({ reminders: [...defaults.reminders] });
        });
        const removeBtn = this._el("button", { className: "icon-btn del", textContent: "\u00D7", title: this._t("remove_reminder"), type: "button" });
        removeBtn.addEventListener("click", () => {
          defaults.reminders.splice(ri, 1);
          save({ reminders: [...defaults.reminders] });
          renderInto();
        });
        kids.push(this._el("div", { className: "def-reminder-row" }, [
          this._el("div", { className: "field-wrap" }, [sel, this._el("span", { textContent: this._t("reminder") })]),
          removeBtn,
        ]));
      });
      if (defaults.reminders.length < MAX_REMINDERS) {
        const addBtn = this._el("button", { className: "add-section-btn", textContent: this._t("rem_add"), type: "button" });
        addBtn.addEventListener("click", () => {
          defaults.reminders.push(nextFreeReminderOffset(new Set(defaults.reminders)));
          save({ reminders: [...defaults.reminders] });
          renderInto();
        });
        kids.push(addBtn);
      }
      container.replaceChildren(...kids);
    };
    renderInto();
  }

  _sourceKeyForCol(col) {
    if (!col) return null;
    if (col.entity_id) return `ext:${col.entity_id}`;
    if (col.list_id) return col.list_id;
    return null;
  }

  _sectionsTargetPayload(col) {
    if (col.entity_id) return { entity_id: col.entity_id };
    if (col.list_id) return { list_id: col.list_id };
    return null;
  }

  async _loadSectionsFor(col) {
    const target = this._sectionsTargetPayload(col);
    if (!target) return [];
    const key = this._sourceKeyForCol(col);
    try {
      const r = await this._hass.callWS({ type: "home_tasks/get_sections", ...target });
      const arr = (r && r.sections) || [];
      this._listSections[key] = arr;
      return arr;
    } catch (e) {
      this._listSections[key] = [];
      return [];
    }
  }

  // Fetch the column's tasks once to derive the tag + assignee-name sets used
  // as autocomplete suggestions in the preset-filter multi-selects. Cached per
  // source key like _listSections; missing/empty is fine (free-text entry).
  async _loadMetaFor(col) {
    const key = this._sourceKeyForCol(col);
    if (!key) return { tags: [], persons: [] };
    try {
      let tasks = [];
      if (col.entity_id) {
        const r = await this._hass.callWS({ type: "home_tasks/get_external_tasks", entity_id: col.entity_id });
        tasks = (r && r.tasks) || [];
      } else if (col.list_id) {
        const r = await this._hass.callWS({ type: "home_tasks/get_tasks", list_id: col.list_id });
        tasks = (r && r.tasks) || [];
      }
      const tags = new Set();
      const persons = new Set();
      for (const t of tasks) {
        for (const tag of (t.tags || [])) tags.add(tag);
        for (const p of _assignees(t)) persons.add(p);
      }
      // Persons may be stored as `person.*` entity ids — resolve each to its
      // friendly name for display while keeping the raw value for matching.
      const personOpts = [...persons].sort().map((v) => ({
        value: v,
        label: this._hass?.states?.[v]?.attributes?.friendly_name || v,
      }));
      this._listMeta[key] = { tags: [...tags].sort(), persons: personOpts };
    } catch (e) {
      this._listMeta[key] = { tags: [], persons: [] };
    }
    return this._listMeta[key];
  }

  async _wsCallSection(col, type, extra = {}) {
    const target = this._sectionsTargetPayload(col);
    if (!target) throw new Error("No list selected");
    return this._hass.callWS({ type, ...target, ...extra });
  }

  setConfig(config) {
    // Normalize old single-list format
    // Keep HA card-level keys (type, etc.) at root, not inside column objects
    if (config.list_id && !config.columns) {
      const { type, columns: _c, ...colConfig } = config;
      config = { ...(type ? { type } : {}), columns: [colConfig] };
    }
    if (!config.columns || !Array.isArray(config.columns) || config.columns.length === 0) {
      config = { ...config, columns: [{}] };
    }
    // Strip any stray type keys from column objects
    config = {
      ...config,
      columns: config.columns.map(({ type: _t, ...col }) => col),
    };
    this._config = { ...config };

    // Clamp active tab
    if (this._editorTab >= this._config.columns.length) {
      this._editorTab = this._config.columns.length - 1;
    }

    // Skip re-render if this setConfig is the echo of our own _fireChanged call
    if (this._ignoreNextSetConfig) {
      this._ignoreNextSetConfig = false;
      return;
    }
    if (this._listsLoaded) {
      this._render();
    }
  }

  _clearCodeState() {
    this._editorCodeMode = {};
  }

  // The card-level ai_task entity and prompt prefix, rendered inside the
  // column's Images section. Card-level, but shown where images are.
  _buildImgGenForm() {
    const imgGen = this._config.image_generation || {};

    const form = document.createElement("ha-form");
    form.hass = this._hass;
    form.data = { entity_id: imgGen.entity_id || "", prompt_prefix: imgGen.prompt_prefix || "" };
    form.schema = [
      {
        name: "entity_id",
        selector: { entity: { domain: ["ai_task"] } },
      },
      {
        name: "prompt_prefix",
        selector: { text: {} },
      },
    ];
    form.computeLabel = (schema) =>
      schema.name === "entity_id" ? this._t("ed_ai_image_entity")
      : schema.name === "prompt_prefix" ? this._t("ed_ai_prompt_prefix")
      : schema.name;
    // ha-form can emit value-changed on its own: while it settles after
    // opening, or when a selector normalises a value it does not know yet
    // (an ai_task entity whose integration is still loading). Such an event
    // reports the field as empty, and taking it at face value wrote a
    // dashboard without its AI entity - while the background queue, which
    // remembers the last entity it was handed, kept generating. Only the
    // user clears a field: nothing is written before they have touched the
    // form, and a field the event leaves out or reports unchanged is left
    // alone.
    let touched = false;
    for (const type of ["pointerdown", "keydown", "focusin"]) {
      form.addEventListener(type, () => { touched = true; });
    }
    form.addEventListener("value-changed", (e) => {
      if (!touched) return;
      const val = e.detail?.value;
      if (!val || typeof val !== "object") return;
      const current = this._config.image_generation || {};
      const next = { ...current };
      for (const key of ["entity_id", "prompt_prefix"]) {
        if (!(key in val)) continue;
        if (val[key]) next[key] = val[key]; else delete next[key];
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      this._config = { ...this._config, image_generation: Object.keys(next).length ? next : undefined };
      this._fireChanged();
    });

    return form;
  }

  _buildCodeEditor(tabIdx) {
    const col = this._config.columns[tabIdx] || {};
    const editor = document.createElement("ha-yaml-editor");
    editor.defaultValue = col;
    editor.addEventListener("value-changed", (e) => {
      const val = e.detail.value;
      if (val !== undefined && typeof val === "object" && !Array.isArray(val)) {
        const { type: _t, ...stripped } = val;  // strip stray type key
        const newCols = [...this._config.columns];
        newCols[tabIdx] = stripped;
        this._config = { ...this._config, columns: newCols };
        this._fireChanged();
      }
    });
    return editor;
  }

  _buildVisualEditor(tabIdx) {
    const col = this._config.columns[tabIdx] || {};

    const updateCol = (updates) => {
      const newCols = [...this._config.columns];
      newCols[tabIdx] = { ...newCols[tabIdx], ...updates };
      this._config = { ...this._config, columns: newCols };
      this._fireChanged();
    };

    const groupLabel = (key) =>
      this._el("div", { className: "group-label" }, [
        this._el("span", { textContent: this._t(key) }),
      ]);

    const makeSelect = (labelKey, options, currentVal, onChange) => {
      const sel = document.createElement("select");
      sel.className = "editor-native-select";
      for (const [val, key] of options) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = this._t(key);
        if (val === currentVal) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener("change", () => onChange(sel.value));
      return this._el("div", { className: "field-wrap" }, [
        sel,
        this._el("span", { textContent: this._t(labelKey) }),
      ]);
    };

    // Off / Profile picture / Name / Both, for the filter row and for the
    // task row. Both keys are written on every change and the three older
    // ones dropped, so the two can never disagree about the picture.
    //
    // Read from the config as it is *now*, never from the `col` captured when
    // the editor was drawn: the editor ignores the setConfig echo of its own
    // change and so does not re-render, which would make the second dropdown
    // write back the value the first one had already replaced.
    const personMode = (which) => {
      const current = (this._config.columns || [])[tabIdx] || {};
      const chosen = which === "badge" ? current.person_badge : current.person_filter;
      if (["off", "picture", "name", "both"].includes(chosen)) return chosen;
      const chipOn = which === "badge"
        ? current.badge_person !== false : current.show_person_chips !== false;
      const picture = current.show_person_avatar === true;
      if (!chipOn) return picture ? "picture" : "off";
      return picture ? "both" : "name";
    };
    const makePersonSelect = (which) => makeSelect(
      which === "badge" ? "ed_badge_person" : "ed_show_person_chips",
      [["off", "ed_person_off"], ["picture", "ed_show_person_avatar"],
       ["name", "ed_person_name"], ["both", "ed_person_both"]],
      personMode(which),
      (val) => updateCol({
        person_badge: which === "badge" ? val : personMode("badge"),
        person_filter: which === "filter" ? val : personMode("filter"),
        badge_person: undefined,
        show_person_chips: undefined,
        show_person_avatar: undefined,
      }),
    );

    // List select — native lists + linked external entities
    const listSelect = document.createElement("select");
    listSelect.className = "editor-native-select";
    const currentSource = col.entity_id ? `ext:${col.entity_id}` : (col.list_id || "");
    if (!col.list_id && !col.entity_id) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "\u2014"; opt.selected = true;
      listSelect.appendChild(opt);
    }
    // Native lists
    for (const l of this._lists) {
      const opt = document.createElement("option");
      opt.value = l.id; opt.textContent = l.name;
      if (l.id === col.list_id && !col.entity_id) opt.selected = true;
      listSelect.appendChild(opt);
    }
    // External lists (linked)
    if (this._externalLists && this._externalLists.length > 0) {
      const optGroup = document.createElement("optgroup");
      optGroup.label = this._t("ed_external_lists") || "External";
      for (const el of this._externalLists) {
        const opt = document.createElement("option");
        opt.value = `ext:${el.entity_id}`;
        opt.textContent = `${el.name} \u2197`;
        if (col.entity_id === el.entity_id) opt.selected = true;
        optGroup.appendChild(opt);
      }
      listSelect.appendChild(optGroup);
    }
    listSelect.addEventListener("change", () => {
      const val = listSelect.value || "";
      if (val.startsWith("ext:")) {
        const entityId = val.slice(4);
        // Find the external list's supported_features and adapter capabilities
        const extList = (this._externalLists || []).find(l => l.entity_id === entityId);
        const features = extList?.supported_features || 0;
        const caps = extList?.capabilities || {};
        // Auto-set visibility defaults for external lists:
        // - Rich adapters (Todoist): enable all synced fields based on capabilities
        // - Generic adapters: enable only fields supported by HA's todo entity interface
        const HAS_DUE = listSupportsDue(extList);             // incl. adapters that sync due times
        const HAS_DESC = !!(features & TODO_FEATURE.SET_DESCRIPTION);
        updateCol({
          entity_id: entityId,
          list_id: undefined,
          default_sort: "manual",
          show_due_date: HAS_DUE,
          show_notes: HAS_DESC || !!caps.can_sync_description,
          show_priority: !!caps.can_sync_priority,
          show_tags: !!caps.can_sync_labels,
          show_sub_tasks: !!caps.can_sync_sub_items,
          show_assigned_person: !!caps.can_sync_assignee,
          show_reminders: HAS_DUE,
          show_recurrence: !!caps.can_sync_recurrence,
          show_history: false,
        });
        this._render();
      } else {
        // Native list: restore default visibility (all features ON)
        updateCol({
          list_id: val || undefined,
          entity_id: undefined,
          default_sort: "manual",
          show_due_date: true,
          show_notes: true,
          show_priority: true,
          show_tags: true,
          show_sub_tasks: true,
          show_assigned_person: true,
          show_reminders: true,
          show_recurrence: true,
          show_history: undefined,  // default off for native too
        });
        this._render();
      }
    });

    // Title input
    const titleInput = this._editorText(
      "ed_title", "ed_title_placeholder", "column-title-input", col.title,
      (value) => updateCol({ title: value || undefined }),
    );

    // Icon picker
    const iconPicker = document.createElement("ha-icon-picker");
    iconPicker.label = this._t("ed_icon");
    iconPicker.value = col.icon || "";
    iconPicker.addEventListener("value-changed", (e) => updateCol({ icon: e.detail.value || undefined }));

    const filterOptions = [["all", "filter_all"], ["open", "filter_open"], ["done", "filter_done"]];
    if (col.show_due_soon_filter === true) {
      filterOptions.push(["due_soon", "filter_due_soon"]);
    }
    const filterField = makeSelect(
      "ed_default_filter",
      filterOptions,
      col.default_filter || "all",
      (val) => { if (val !== (col.default_filter || "all")) updateCol({ default_filter: val }); }
    );

    const sortField = makeSelect(
      "ed_default_sort",
      SORT_MODES.map((mode) => [mode, `sort_${mode}`]),
      col.default_sort || "manual",
      (val) => { if (val !== (col.default_sort || "manual")) updateCol({ default_sort: val }); }
    );

    // Toggle helper — uses ha-switch for native HA look
    const makeToggle = (_id, labelKey, configKey, defaultOn = true, onChange = null) => {
      const checked = defaultOn ? col[configKey] !== false : col[configKey] === true;
      const sw = document.createElement("ha-switch");
      sw.checked = checked;
      sw.setAttribute("aria-label", this._t(labelKey));
      sw.addEventListener("change", () => {
        updateCol({ [configKey]: sw.checked });
        if (onChange) onChange(sw.checked);
      });
      return this._el("div", { className: "toggle-row" }, [
        this._el("span", { className: "toggle-label", textContent: this._t(labelKey) }),
        sw,
      ]);
    };

    // Where to get a new list: the link for those who may add one, the
    // sentence for everybody else.
    const hint = this._newEntryLink()
      || this._el("span", { className: "hint", textContent: this._t("ed_hint") });

    const makeSection = (...args) => this._buildEditorSection(...args);

    // Preset filters live under col.filters.{assignees,labels}. Merge against
    // the LIVE config (not the render-time `col` snapshot) so two sequential
    // edits don't clobber each other before the next re-render.
    const updateFilters = (patch) => {
      const live = this._config.columns[tabIdx] || {};
      const filters = { ...(live.filters || {}), ...patch };
      for (const k of Object.keys(filters)) {
        const v = filters[k];
        if (v == null || (Array.isArray(v) && v.length === 0)) delete filters[k];
      }
      updateCol({ filters: Object.keys(filters).length ? filters : undefined });
    };

    // Tag / assignee values for the multi-select autocomplete, derived from
    // the list's tasks (lazy-loaded, cached per source key). Empty is fine \u2014
    // the multi-select still allows free-text entry.
    const metaKey = this._sourceKeyForCol(col);
    if (metaKey && this._listMeta[metaKey] === undefined) {
      this._loadMetaFor(col).then(() => this._render());
    }
    const meta = (metaKey && this._listMeta[metaKey]) || { tags: [], persons: [] };

    // Due-soon filter toggle
    const dueSoonToggle = (() => {
      const sw = document.createElement("ha-switch");
      sw.checked = col.show_due_soon_filter === true;
      sw.setAttribute("aria-label", this._t("ed_show_due_soon_filter"));
      sw.addEventListener("change", () => {
        const updates = { show_due_soon_filter: sw.checked };
        if (!sw.checked && col.default_filter === "due_soon") updates.default_filter = "all";
        updateCol(updates);
        this._render();
      });
      return this._el("div", { className: "toggle-row" }, [
        this._el("span", { className: "toggle-label", textContent: this._t("ed_show_due_soon_filter") }),
        sw,
      ]);
    })();

    // Days-ahead + hide-overdue \u2014 only shown when the due-soon filter is on
    const dueSoonDetail = col.show_due_soon_filter === true ? [(() => {
      const daysInput = this._el("input", { type: "number", value: col.due_soon_days ?? 7 });
      daysInput.min = 0;
      daysInput.max = 90;
      // 0 = "due today only"; guard the NaN case so a valid 0 isn't reset to 7.
      const clampDays = (n) => Math.max(0, Math.min(90, Number.isNaN(n) ? 7 : n));
      daysInput.addEventListener("change", () => {
        const v = clampDays(parseInt(daysInput.value, 10));
        daysInput.value = v;
        updateCol({ due_soon_days: v });
      });
      const spinUp = this._el("button", { className: "spin-btn spin-up", textContent: "\u25b4", type: "button" });
      const spinDown = this._el("button", { className: "spin-btn spin-down", textContent: "\u25be", type: "button" });
      spinUp.addEventListener("click", () => {
        daysInput.value = clampDays(parseInt(daysInput.value, 10)) + 1;
        daysInput.dispatchEvent(new Event("change"));
      });
      spinDown.addEventListener("click", () => {
        daysInput.value = clampDays(parseInt(daysInput.value, 10)) - 1;
        daysInput.dispatchEvent(new Event("change"));
      });
      return this._el("div", { className: "field-wrap inline" }, [
        daysInput,
        this._el("span", { textContent: this._t("ed_due_soon_days") }),
        this._el("div", { className: "spin-btns" }, [spinUp, spinDown]),
      ]);
    })(), makeToggle("hide-overdue", "ed_hide_overdue", "hide_overdue", false)] : [];

    // Who this card offers for assignment: everyone highlighted. The config
    // keeps the ones switched off (hidden_persons), so a person added to
    // Home Assistant later is offered without editing every card.
    const offeredPersons = (() => {
      // Someone hidden who is no longer in Home Assistant still gets a chip,
      // so the entry can be switched back on and leaves the config.
      const people = this._personOptions(col.hidden_persons);
      const hidden = new Set(col.hidden_persons || []);
      const field = this._buildPersonChips(
        this._t("ed_offered_persons"),
        people,
        people.filter((p) => !hidden.has(p.value)).map((p) => p.value),
        (on) => {
          const off = people.map((p) => p.value).filter((v) => !on.includes(v)).sort();
          updateCol({ hidden_persons: off.length ? off : undefined });
        },
        {
          hint: this._t("ed_offered_persons_hint"),
          // At least one person stays selectable: with none, the task
          // details would show an empty assignee row.
          keep: (on) => on.some((v) => this._hass?.states?.[v]),
        },
      );
      if (col.show_assigned_person === false) field.style.display = "none";
      return field;
    })();

    // Images has its switch in the Images section too; the two follow
    // each other.
    const imagesToggle = makeToggle("show-images", "ed_show_images", "show_images", false, (on) => {
      const twin = detailFields.querySelector('.detail-field-row[data-key="images"] ha-switch');
      if (twin) twin.checked = on;
    });

    // The task-details fields as one list: switched on or off, and moved up
    // or down to set the order they appear in (detail_order).
    const listSections = this._listSections[this._sourceKeyForCol(col)];
    const detailFields = this._buildDetailFieldList({
      get: () => this._config.columns[tabIdx] || {},
      update: updateCol,
      // Section only shows in the details once the list has sections.
      noSections: Array.isArray(listSections) && listSections.length === 0,
      onToggle: (key, on) => {
        if (key === "person") offeredPersons.style.display = on ? "" : "none";
        if (key === "images") imagesToggle.querySelector("ha-switch").checked = on;
      },
    });

    return this._el("div", { className: "visual-editor" }, [
      this._el("div", { className: "field" }, [
        this._el("div", { className: "field-wrap" }, [listSelect, this._el("span", { textContent: this._t("ed_list") })]),
        hint,
      ]),
      makeSection("view", "mdi:eye", "ed_sec_view", [
        // Two dozen switches in one grid meant reading every label to find
        // the one you wanted, and two of them said "person". Three groups
        // by where the effect shows up: the card as a whole, its header,
        // the task rows.
        groupLabel("ed_group_card"),
        makeSelect(
          "ed_view_mode",
          [["list", "ed_view_mode_list"], ["tiles", "ed_view_mode_tiles"]],
          col.view_mode || "list",
          (val) => { updateCol({ view_mode: val === "list" ? undefined : val }); this._render(); }
        ),
        ...(col.view_mode === "tiles"
          ? [this._el("div", { className: "hint", textContent: this._t("ed_tile_help"), style: "white-space:pre-line" })]
          : []),
        col.view_mode === "tiles"
          ? makeSelect(
            "ed_tile_size",
            [
              ["small", "ed_tile_size_small"], ["compact", "ed_tile_size_compact"], ["medium", "ed_tile_size_medium"], ["large", "ed_tile_size_large"],
              // A width in px set in YAML: shown as itself, kept unless changed.
              ...(_tileMinWidth(col) && !_TILE_SIZES[col.tile_size]
                ? [[String(col.tile_size), `${_tileMinWidth(col)} px`]] : []),
            ],
            // Medium is the default: unset (or unknown) shows as it.
            _tileMinWidth(col) ? String(col.tile_size) : "medium",
            (val) => updateCol({ tile_size: val === "medium" ? undefined : (_TILE_SIZES[val] ? val : parseInt(val, 10)) })
          )
          : makeSelect(
            "ed_list_columns",
            [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]],
            String(col.list_columns || 1),
            (val) => updateCol({ list_columns: val === "1" ? undefined : parseInt(val, 10) })
          ),
        this._el("div", { className: "toggle-grid" }, [
          makeToggle("compact", "ed_compact", "compact", false),
        ]),
        this._el("div", { className: "field" }, [(() => {
          // max_height (px): 0 / empty = unlimited. Caps the task body only.
          // (Editor is its own class — don't reach for HomeTasksCard helpers here.)
          const curMh = Number(col.max_height);
          const mhInput = this._el("input", { type: "number", value: Number.isFinite(curMh) && curMh > 0 ? Math.round(curMh) : "" });
          mhInput.min = 0;
          mhInput.step = 10;
          mhInput.placeholder = "0";
          mhInput.addEventListener("change", () => {
            const v = parseInt(mhInput.value, 10);
            const valid = Number.isFinite(v) && v > 0;
            mhInput.value = valid ? v : "";
            // undefined drops the key on serialization (same as view_mode).
            updateCol({ max_height: valid ? v : undefined });
          });
          return this._el("div", { className: "field-wrap" }, [
            mhInput,
            this._el("span", { textContent: this._t("ed_max_height") }),
          ]);
        })()]),
        groupLabel("ed_group_header"),
        this._el("div", { className: "field" }, [titleInput]),
        this._el("div", { className: "field" }, [iconPicker]),
        this._el("div", { className: "toggle-grid" }, [
          makeToggle("show-title", "ed_show_title", "show_title", true),
          makeToggle("show-progress", "ed_show_progress", "show_progress", true),
          makeToggle("show-add-task", "ed_show_add_task", "show_add_task", true),
          // On/off switch for the live search in the add-task field.
          makeToggle("task-search", "ed_task_search", "show_task_search", true),
          makeToggle("show-add-due", "ed_show_add_due", "show_add_due", false),
          makeToggle("show-voice", "ed_show_voice", "show_voice", true),
          makeToggle("show-add-details", "ed_show_add_details", "show_add_details", false),
          makeToggle("show-sort", "ed_show_sort", "show_sort", true),
          makeToggle("show-filters", "ed_show_filters", "show_filters", true),
          makeToggle("show-tag-chips", "ed_show_tag_chips", "show_tag_chips", true),
        ]),
        makePersonSelect("filter"),
        groupLabel("ed_group_tasks"),
        this._el("div", { className: "toggle-grid" }, [
          makeToggle("badge-priority", "ed_badge_priority", "badge_priority", true),
          makeToggle("badge-progress", "ed_badge_progress", "badge_progress", true),
          makeToggle("badge-due", "ed_badge_due", "badge_due", true),
          makeToggle("badge-recurrence", "ed_badge_recurrence", "badge_recurrence", true),
          makeToggle("badge-tags", "ed_badge_tags", "badge_tags", true),
          makeToggle("badge-reminders", "ed_badge_reminders", "badge_reminders", true),
          makeToggle("auto-delete", "ed_auto_delete", "auto_delete_completed", false),
          makeToggle("confirm-complete", "ed_confirm_complete", "confirm_complete", false),
          ...(col.view_mode === "tiles"
            ? [makeToggle("show-tile-title", "ed_show_tile_title", "show_tile_title", true)]
            // Tiles already complete on a tap; the list needs the switch.
            : [makeToggle("tap-to-complete", "ed_tap_to_complete", "tap_to_complete", false)]),
        ]),
        makePersonSelect("badge"),
      ]),
      makeSection("defaults", "mdi:account-check-outline", "ed_sec_defaults", [
        sortField,
        makeToggle("overdue-first", "ed_overdue_first", "overdue_first", false),
        ...(col.list_id && !col.entity_id ? [this._buildTodoSortField(col)] : []),
        // Defaults live with the list, native or external, so they apply
        // however the task is created - card, voice, service or todo entity.
        this._buildDefaultsEditor(col),
      ]),
      makeSection("filters", "mdi:filter-variant", "ed_sec_filters", [
        filterField,
        dueSoonToggle,
        ...dueSoonDetail,
        this._buildPersonChips(
          this._t("ed_preset_assignees"),
          // Linked lists can name people Home Assistant doesn't know (a
          // Todoist collaborator), so the list's own assignees come too.
          // "Unassigned" comes last (issue #93).
          // "Current user" stands for whoever views the dashboard.
          [
            ...this._personOptions([...meta.persons.map((p) => p.value), ...(col.filters?.assignees || [])])
              .filter((p) => p.value !== UNASSIGNED && p.value !== CURRENT_USER),
            { value: CURRENT_USER, label: this._t("ed_preset_current_user") },
            { value: UNASSIGNED, label: this._t("ed_preset_unassigned") },
          ],
          col.filters?.assignees || [],
          (vals) => updateFilters({ assignees: vals }),
        ),
        this._buildMultiSelect(
          this._t("ed_preset_labels"),
          col.filters?.labels || [],
          meta.tags,
          (vals) => updateFilters({ labels: vals }),
        ),
      ]),
      makeSection("visibility", "mdi:eye-check-outline", "ed_sec_visibility",
        this._buildVisibilityEditor(tabIdx, updateCol)),
      makeSection("config", "mdi:tune", "ed_sec_display", [
        detailFields,
        makeToggle("show-move", "ed_show_move", "show_move", true),
        offeredPersons,
      ]),
      this._buildSectionsEditor(col),
      makeSection("images", "mdi:image-multiple", "ed_sec_images", [
        this._el("div", { className: "toggle-grid" }, [
          imagesToggle,
          // Also tells the integration to generate for this list when no
          // dashboard is open - one switch, both behaviours.
          makeToggle("auto-image", "ed_auto_image", "auto_generate_image", false, (on) => {
            // The list is switched over right away, not on save — so redraw
            // now as well, or the queue below would only turn up after the
            // dialog is saved and reopened.
            this._syncAutoGenerate(col, on);
            this._render();
          }),
          ...(col.list_id || col.entity_id
            ? [this._buildListSettingToggle(col, "share_images", "ed_share_images", true)]
            : []),
        ]),
        ...(col.list_id || col.entity_id
          ? [this._el("div", { className: "hint", textContent: this._t("ed_share_images_hint") })]
          : []),
        this._buildImgGenForm(),
        this._el("div", { className: "hint", textContent: this._t("ed_ai_image_hint") }),
        // Only worth showing once the list actually asks for background
        // generation - otherwise "nothing waiting" is a sentence without a
        // subject.
        ...((col.list_id || col.entity_id) && col.auto_generate_image === true ? [
          this._el("label", { textContent: this._t("ed_queue_title") }),
          this._buildQueuePanel(),
        ] : []),
      ]),
    ]);
  }

  // The column's visibility conditions, set as a card's own are: with Home
  // Assistant's Visibility editor, the one under a card's Visibility tab. It
  // is defined wherever Home Assistant's card editor is open; until it is, or
  // where something in the list is no condition it can show, the conditions
  // are edited as YAML.
  _buildVisibilityEditor(tabIdx, updateCol) {
    const col = this._config.columns[tabIdx] || {};
    const raw = col.visibility;
    const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    const allConditions = (items) => items.every((c) => {
      if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
      if (c.conditions == null) return true;
      return allConditions(Array.isArray(c.conditions) ? c.conditions : [c.conditions]);
    });
    const save = (value) => {
      const next = Array.isArray(value) && value.length ? value : undefined;
      if (JSON.stringify(next) === JSON.stringify(this._config.columns[tabIdx]?.visibility)) return;
      updateCol({ visibility: next });
    };
    const nodes = [this._el("div", { className: "hint", textContent: this._t("ed_visibility_hint") })];
    const Editor = customElements.get("ha-card-conditions-editor");
    if (Editor && allConditions(list)) {
      const ed = document.createElement("ha-card-conditions-editor");
      ed.hass = this._hass;
      ed.conditions = list;
      ed.addEventListener("value-changed", (e) => {
        // Ours alone: Home Assistant's card editor around listens for it too.
        e.stopPropagation();
        const value = e.detail?.value;
        if (!Array.isArray(value)) return;
        ed.conditions = value;  // it shows what it is given
        save(value);
      });
      nodes.push(ed);
      return nodes;
    }
    if (!Editor && !this._waitingForConditionsEditor && customElements.whenDefined) {
      this._waitingForConditionsEditor = true;
      customElements.whenDefined("ha-card-conditions-editor").then(() => {
        this._waitingForConditionsEditor = false;
        if (this.isConnected) this._render();
      });
    }
    const yaml = document.createElement("ha-yaml-editor");
    yaml.defaultValue = list;
    yaml.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const value = e.detail?.value;
      if (value == null || (Array.isArray(value) && allConditions(value))) save(value || []);
      else if (typeof value === "object" && allConditions([value])) save([value]);
    });
    nodes.push(yaml);
    return nodes;
  }

  // Everyone Home Assistant knows as a person, plus *extra* values that are
  // not one (a removed person, a provider's collaborator), named as stored.
  _personOptions(extra = []) {
    const people = personEntries(this._hass);
    for (const v of extra || []) {
      if (v && !people.some((p) => p.value === v)) {
        people.push({ value: v, label: String(v).replace(/^person\./, "") });
      }
    }
    return people;
  }

  // A row of person chips, any number on - the editor's counterpart of the
  // assignee chips in the task details. onChange gets who is on in the order
  // they were switched on, as there (the first is a default's primary);
  // *keep* can refuse a change (returns false).
  _buildPersonChips(labelText, options, selected, onChange, { hint = null, keep = null } = {}) {
    let on = [...(selected || [])];
    const row = this._el("div", { className: "assignee-chip-row" });
    for (const { value, label } of options) {
      const chip = this._el("button", { className: "assignee-chip", textContent: label });
      chip.type = "button";
      const mark = () => {
        chip.classList.toggle("active", on.includes(value));
        chip.setAttribute("aria-pressed", String(on.includes(value)));
      };
      mark();
      chip.addEventListener("click", () => {
        const next = on.includes(value) ? on.filter((v) => v !== value) : [...on, value];
        if (keep && !keep(next)) return;
        on = next;
        mark();
        onChange([...on]);
      });
      row.appendChild(chip);
    }
    const kids = [this._el("div", { className: "group-label", textContent: labelText }), row];
    if (hint) kids.push(this._el("div", { className: "hint", textContent: hint }));
    return this._el("div", { className: "field" }, kids);
  }

  // Chip multi-select: removable chips for the selected values plus a text
  // input with datalist autocomplete from `suggestions`. Free-text entry is
  // allowed (Enter / comma / blur), so a value can be preset even when no
  // task currently uses it. Renders fine with zero suggestions.
  //
  // `suggestions` items are plain strings or {value,label} objects. Chips and
  // the datalist show the label; the stored value (e.g. a `person.*` entity
  // id) is what the filter matches — so the editor can show "Ben" while the
  // config keeps `person.ben`.
  _buildMultiSelect(labelText, currentValues, suggestions, onChange) {
    const values = Array.isArray(currentValues) ? currentValues.slice() : [];
    const opts = (suggestions || []).map((s) =>
      (s && typeof s === "object") ? { value: s.value, label: s.label || s.value } : { value: s, label: s });
    const labelOf = (v) => { const o = opts.find((o) => o.value === v); return o ? o.label : v; };
    const valueOf = (typed) => {
      const o = opts.find((o) => o.label === typed || o.value === typed);
      return o ? o.value : typed;
    };
    const dlId = "ms-dl-" + Math.random().toString(36).slice(2, 9);
    const input = this._el("input", { className: "ms-input", type: "text", list: dlId, placeholder: this._t("ed_ms_add") });
    const chipBox = this._el("div", { className: "ms-chips" });

    const datalist = document.createElement("datalist");
    datalist.id = dlId;
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.label;
      datalist.appendChild(opt);
    }

    const renderChips = () => {
      chipBox.innerHTML = "";
      for (const v of values) {
        const x = this._el("button", { className: "ms-chip-x", type: "button", textContent: "×" });
        x.addEventListener("click", () => {
          const i = values.indexOf(v);
          if (i < 0) return;
          values.splice(i, 1);
          renderChips();
          onChange(values.slice());
          input.focus();
        });
        chipBox.appendChild(this._el("span", { className: "ms-chip" }, [
          this._el("span", { textContent: labelOf(v) }), x,
        ]));
      }
      chipBox.appendChild(input);
    };

    const addValue = (raw) => {
      const typed = (raw || "").trim();
      input.value = "";
      if (!typed) return;
      const v = valueOf(typed);
      if (values.includes(v)) return;
      values.push(v);
      renderChips();
      onChange(values.slice());
      input.focus();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        addValue(input.value);
      } else if (e.key === "Backspace" && !input.value && values.length) {
        values.pop();
        renderChips();
        onChange(values.slice());
      }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) addValue(input.value); });

    renderChips();
    return this._el("div", { className: "field-wrap" }, [
      chipBox,
      this._el("span", { textContent: labelText }),
      datalist,
    ]);
  }

  _buildSectionsEditor(col) {
    const key = this._sourceKeyForCol(col);
    const cached = key ? this._listSections[key] : null;
    if (!key) {
      return this._el("div", { className: "field" }, [
        this._el("span", { className: "hint", textContent: this._t("ed_sections_select_list_hint") }),
      ]);
    }
    const list = (cached || []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    // Build a collapsible <details> section using the same makeSection-style markup,
    // but inline (we cannot reuse makeSection because it lives in the closure of
    // _buildVisualEditor — we replicate the visual structure via the same classes).
    const det = document.createElement("details");
    if (this._sectionOpen.sections) det.open = true;
    const sum = document.createElement("summary");
    const ico = document.createElement("ha-icon");
    ico.setAttribute("icon", "mdi:folder-multiple");
    ico.style.cssText = "--mdc-icon-size:20px;width:20px;height:20px;flex-shrink:0;";
    const chevWrap = document.createElement("span");
    chevWrap.className = "sum-chevron";
    const chev = document.createElement("ha-icon");
    chev.setAttribute("icon", "mdi:chevron-down");
    chev.style.cssText = "--mdc-icon-size:20px;width:20px;height:20px;";
    chevWrap.appendChild(chev);
    sum.appendChild(ico);
    sum.appendChild(document.createTextNode(this._t("ed_sec_sections")));
    sum.appendChild(chevWrap);
    sum.addEventListener("click", () => {
      this._sectionOpen.sections = !det.open;
      this._saveSectionState();
    });
    det.appendChild(sum);

    const content = document.createElement("div");
    content.className = "section-content";

    if (cached === null || cached === undefined) {
      // Trigger lazy load — re-render once it arrives
      this._loadSectionsFor(col).then(() => this._render());
      content.appendChild(this._el("span", { className: "hint", textContent: this._t("ed_loading") || "…" }));
    } else if (list.length === 0) {
      content.appendChild(this._el("span", { className: "hint", textContent: this._t("ed_sections_empty") }));
    }

    for (let i = 0; i < list.length; i++) {
      const section = list[i];
      const row = this._el("div", { className: "sections-editor-row" });

      const upBtn = this._iconButton("mdi:arrow-up", "ed_move_up", i === 0, async () => {
        if (i === 0) return;
        const ids = list.map((s) => s.id);
        [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
        await this._wsCallSection(col, "home_tasks/reorder_sections", { section_ids: ids });
        await this._loadSectionsFor(col);
        this._render();
      });
      row.appendChild(upBtn);

      const downBtn = this._iconButton("mdi:arrow-down", "ed_move_down", i === list.length - 1, async () => {
        if (i === list.length - 1) return;
        const ids = list.map((s) => s.id);
        [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
        await this._wsCallSection(col, "home_tasks/reorder_sections", { section_ids: ids });
        await this._loadSectionsFor(col);
        this._render();
      });
      row.appendChild(downBtn);

      const nameInput = this._el("input", { type: "text", autocomplete: "off" });
      nameInput.value = section.name;
      nameInput.addEventListener("change", async (e) => {
        const newName = (e.target.value || "").trim();
        if (!newName || newName === section.name) {
          e.target.value = section.name;
          return;
        }
        await this._wsCallSection(col, "home_tasks/update_section", { section_id: section.id, name: newName });
        await this._loadSectionsFor(col);
        this._render();
      });
      const nameWrap = this._el("div", { className: "field-wrap" }, [
        nameInput,
        this._el("span", { textContent: this._t("ed_section_name") }),
      ]);
      row.appendChild(nameWrap);

      const iconPicker = document.createElement("ha-icon-picker");
      iconPicker.label = this._t("ed_section_icon");
      iconPicker.value = section.icon || "";
      iconPicker.addEventListener("value-changed", async (e) => {
        const newIcon = e.detail.value || null;
        await this._wsCallSection(col, "home_tasks/update_section", { section_id: section.id, icon: newIcon });
        await this._loadSectionsFor(col);
        this._render();
      });
      row.appendChild(iconPicker);

      const delBtn = this._el("button", { className: "icon-btn del", type: "button", title: this._t("ed_delete_section") });
      delBtn.appendChild((() => { const ic = document.createElement("ha-icon"); ic.setAttribute("icon", "mdi:delete"); return ic; })());
      delBtn.addEventListener("click", async () => {
        if (!window.confirm(this._t("confirm_delete_section"))) return;
        await this._wsCallSection(col, "home_tasks/delete_section", { section_id: section.id });
        await this._loadSectionsFor(col);
        this._render();
      });
      row.appendChild(delBtn);

      content.appendChild(row);
    }

    if (cached !== null && cached !== undefined) {
      const addBtn = this._el("button", { className: "add-section-btn", type: "button", textContent: this._t("ed_add_section") });
      addBtn.addEventListener("click", async () => {
        const name = window.prompt(this._t("ed_section_name_prompt"));
        if (!name || !name.trim()) return;
        try {
          await this._wsCallSection(col, "home_tasks/add_section", { name: name.trim() });
          await this._loadSectionsFor(col);
          this._render();
        } catch (err) {
          window.alert(err.message || String(err));
        }
      });
      content.appendChild(addBtn);
    }

    const wrap = document.createElement("div");
    wrap.appendChild(content);
    det.appendChild(wrap);
    return det;
  }

  // ── EditorBase hooks ──────────────────────────────────────────────────────

  // Below the card title: a tab per column, its controls and its settings.
  _buildEditorBody() {
    const cols = this._config.columns || [];
    const activeTab = Math.min(this._editorTab, cols.length - 1);

    // Tab bar (tabs on left, + on right)
    const tabsEl = this._el("div", { className: "editor-tabs" });
    for (let i = 0; i < cols.length; i++) {
      const colName = cols[i].title ||
        this._lists.find(l => l.id === cols[i].list_id)?.name ||
        (cols[i].entity_id && (this._externalLists || []).find(l => l.entity_id === cols[i].entity_id)?.name) ||
        String(i + 1);
      const tab = this._el("button", {
        className: "editor-tab" + (i === activeTab ? " active" : ""),
        textContent: String(i + 1),
        title: colName,
      });
      tab.addEventListener("click", () => {
        this._editorTab = i;
        this._render();
      });
      tabsEl.appendChild(tab);
    }
    const addTabBtn = document.createElement("button");
    addTabBtn.className = "editor-tab-add";
    addTabBtn.title = this._t("ed_add_column");
    const _plusIcon = document.createElement("ha-icon");
    _plusIcon.setAttribute("icon", "mdi:plus");
    _plusIcon.style.setProperty("--mdc-icon-size", "20px");
    addTabBtn.appendChild(_plusIcon);
    addTabBtn.addEventListener("click", () => {
      this._clearCodeState();
      const newCols = [...cols, {}];
      this._config = { ...this._config, columns: newCols };
      this._editorTab = newCols.length - 1;
      this._fireChanged();
      this._render();
    });
    const tabsRow = this._el("div", { className: "editor-tabs-row" }, [tabsEl, addTabBtn]);

    // Column controls using ha-icon-button
    const isCodeMode = this._editorCodeMode[activeTab] === true;
    const controls = this._el("div", { className: "editor-col-controls" });

    const makeIconBtn = (icon, label, cls, handler, disabled = false) => {
      const btn = document.createElement("button");
      btn.className = "icon-btn" + (cls ? " " + cls : "");
      btn.title = label;
      btn.disabled = disabled;
      const haIcon = document.createElement("ha-icon");
      haIcon.setAttribute("icon", icon);
      haIcon.style.setProperty("--mdc-icon-size", "20px");
      btn.appendChild(haIcon);
      btn.addEventListener("click", handler);
      return btn;
    };

    controls.appendChild(makeIconBtn(
      "mdi:code-braces",
      isCodeMode ? this._t("ed_visual_editor") : this._t("ed_code_editor"),
      isCodeMode ? "active" : "",
      () => {
        this._editorCodeMode[activeTab] = !isCodeMode;
        this._render();
      }
    ));
    const _btnSpacer = document.createElement("div");
    _btnSpacer.className = "icon-btn-spacer";
    controls.appendChild(_btnSpacer);

    // Left/right arrows always visible; disabled when not applicable
    controls.appendChild(makeIconBtn("mdi:arrow-left", this._t("ed_move_left"), "", () => {
      this._clearCodeState();
      const newCols = [...cols];
      [newCols[activeTab - 1], newCols[activeTab]] = [newCols[activeTab], newCols[activeTab - 1]];
      this._config = { ...this._config, columns: newCols };
      this._editorTab = activeTab - 1;
      this._fireChanged();
      this._render();
    }, cols.length < 2 || activeTab === 0));
    controls.appendChild(makeIconBtn("mdi:arrow-right", this._t("ed_move_right"), "", () => {
      this._clearCodeState();
      const newCols = [...cols];
      [newCols[activeTab], newCols[activeTab + 1]] = [newCols[activeTab + 1], newCols[activeTab]];
      this._config = { ...this._config, columns: newCols };
      this._editorTab = activeTab + 1;
      this._fireChanged();
      this._render();
    }, cols.length < 2 || activeTab === cols.length - 1));

    if (cols.length > 1) {
      controls.appendChild(makeIconBtn("mdi:content-copy", this._t("ed_duplicate"), "", () => {
        this._clearCodeState();
        const newCols = [...cols];
        newCols.splice(activeTab + 1, 0, { ...cols[activeTab] });
        this._config = { ...this._config, columns: newCols };
        this._editorTab = activeTab + 1;
        this._fireChanged();
        this._render();
      }));
      controls.appendChild(makeIconBtn("mdi:delete", this._t("ed_delete_column"), "del", () => {
        this._clearCodeState();
        const newCols = cols.filter((_, i) => i !== activeTab);
        this._config = { ...this._config, columns: newCols };
        this._editorTab = Math.min(activeTab, newCols.length - 1);
        this._fireChanged();
        this._render();
      }));
    }

    // Tab content
    const tabContent = isCodeMode
      ? this._buildCodeEditor(activeTab)
      : this._buildVisualEditor(activeTab);

    // The AI settings used to sit in their own section at the bottom, which
    // is not where anyone looks for them — everything about images is in the
    // column's "Images" section now.
    return [tabsRow, controls, tabContent];
  }

  // Auto-select first list for first column if none set
  _afterListsLoaded() {
    if (!this._config.columns[0]?.list_id && !this._config.columns[0]?.entity_id && this._lists.length > 0) {
      const newCols = [...this._config.columns];
      newCols[0] = { ...newCols[0], list_id: this._lists[0].id };
      this._config = { ...this._config, columns: newCols };
      this._fireChanged();
    }
  }
}
