// What the editors of all card types share: loading the lists and plans,
// the card title, the editor's styles, and the parts both put together -
// sections that open, dropdowns, switches, the task-features list, the
// link to where lists and plans are made.

import { _htText } from "../core/i18n.js";
import { DETAIL_FIELD, NEW_ENTRY_PATH, _detailFieldOn, _detailOrder, _shortDetailOrder } from "../core/helpers.js";

/**
 * Card Editor — uses safe DOM construction
 */
export class EditorBase extends HTMLElement {
  // "Defaults" section (issues #44 / #46): list-level default assignee and
  // reminders, stored in the list itself so they apply to every creation
  // path (card, service, WS, voice, todo). Loaded/saved via WS.
  _loadSectionState() {
    try {
      const raw = localStorage.getItem("ht-editor-sections");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (e) {
      return {};  // private mode, blocked storage - just start folded
    }
  }

  _saveSectionState() {
    try {
      localStorage.setItem("ht-editor-sections", JSON.stringify(this._sectionOpen));
    } catch (e) { /* not worth bothering the user about */ }
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { columns: [{}] };
    this._hass = null;
    this._lists = [];
    this._externalLists = [];
    this._listsLoaded = false;
    this._editorTab = 0;
    this._editorCodeMode = {};  // { tabIdx: bool }
    // { sectionId: bool } — which editor sections are unfolded. Kept in
    // localStorage because the editor is thrown away every time the dialog
    // closes, and re-opening it to find everything folded shut again (or
    // everything open again) is equally annoying. Nothing is open until the
    // user opens it.
    this._sectionOpen = this._loadSectionState();
    this._ignoreNextSetConfig = false; // skip the echo setConfig() call after _fireChanged
    this._listSections = {};    // { sourceKey: [{id,name,icon,sort_order}] } — server-loaded sections
    this._listMeta = {};        // { sourceKey: {tags:[], persons:[]} } — derived from the list's tasks
    this._listDefaults = {};    // { listId: {assignee, reminders} } — session cache for the Defaults section
  }

  _t(key, ...args) {
    // Same preference order as HomeTasksCard._localeCode (separate class).
    return _htText(this._hass?.locale?.language || this._hass?.language, key, args);
  }

  _el(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) {
      if (key === "className") el.className = val;
      else if (key === "textContent") el.textContent = val;
      else if (key === "value") el.value = val;
      else if (key === "selected") { if (val) el.selected = true; }
      else if (key === "placeholder") el.placeholder = val;
      else if (key === "type") el.type = val;
      else if (key === "id") el.id = val;
      else if (key === "checked") el.checked = val;
      else el.setAttribute(key, val);
    }
    for (const child of children) {
      if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    }
    return el;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._listsLoaded) {
      this._loadLists();
    }
  }

  async _loadLists() {
    try {
      const [nativeResult, externalResult, plansResult] = await Promise.all([
        this._hass.callWS({ type: "home_tasks/get_lists" }),
        this._hass.callWS({ type: "home_tasks/get_external_lists" }).catch(() => null),
        this._hass.callWS({ type: "home_tasks/get_plans" }).catch(() => null),
      ]);
      if (nativeResult && Array.isArray(nativeResult.lists)) {
        this._lists = nativeResult.lists;
      }
      this._plans = (plansResult && Array.isArray(plansResult.plans)) ? plansResult.plans : [];
      // Every list there is, for choosing a plan's lists.
      this._planLists = (plansResult && Array.isArray(plansResult.lists)) ? plansResult.lists : [];
      this._externalLists = (externalResult && Array.isArray(externalResult.external_lists))
        ? externalResult.external_lists.filter(l => l.linked)
        : [];
      this._listsLoaded = true;
      this._afterListsLoaded();
      this._render();
    } catch (e) {
      // Integration might not be loaded yet
    }
  }

  _render() {
    const root = this.shadowRoot;
    root.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; }
      .editor { display: flex; flex-direction: column; gap: 0; padding: 16px 0; }
      .editor-card-title-row { margin-bottom: 12px; }
      .editor-native-select {
        width: 100%; box-sizing: border-box; padding: 8px;
        background: var(--card-background-color); color: var(--primary-text-color);
        border: 1px solid var(--divider-color); border-radius: 4px; font-size: 14px;
      }
      .editor-native-select:focus {
        outline: none; border-color: var(--primary-color);
      }
      .editor-tabs-row {
        display: flex; align-items: center;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        margin-bottom: 0;
      }
      .editor-tabs { display: flex; gap: 0; align-items: center; flex: 1; }
      .editor-tab {
        min-width: 40px; height: 40px; padding: 0 14px;
        border: none; border-bottom: 3px solid transparent;
        background: transparent; cursor: pointer; font-size: 14px; font-weight: 500;
        font-family: inherit; color: var(--secondary-text-color);
        display: flex; align-items: center; justify-content: center;
        transition: color 0.15s, border-color 0.15s;
      }
      .editor-tab.active { color: var(--primary-color); border-bottom: 3px solid var(--primary-color); }
      .editor-tab:hover:not(.active) { color: var(--primary-text-color); background: var(--secondary-background-color); }
      .editor-tab-add {
        width: 36px; height: 36px; border-radius: 50%; border: none;
        background: transparent; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--secondary-text-color); flex-shrink: 0; padding: 0; margin-left: 4px;
        transition: background 0.15s, color 0.15s;
      }
      .editor-tab-add:hover { background: var(--secondary-background-color); color: var(--primary-color); }
      .editor-col-controls {
        display: flex; gap: 0; align-items: center;
        padding: 4px 0 8px; margin-bottom: 8px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .icon-btn {
        width: 36px; height: 36px; border-radius: 50%; border: none;
        background: transparent; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--secondary-text-color); flex-shrink: 0; padding: 0;
        transition: background 0.15s, color 0.15s;
      }
      .icon-btn:hover:not(:disabled) { background: var(--secondary-background-color); }
      .icon-btn.active { color: var(--primary-color); }
      .icon-btn.del { color: var(--error-color, #db4437); }
      .icon-btn:disabled { opacity: 0.3; cursor: default; }
      .icon-btn-spacer { flex: 1; }
      .toggle-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
      .assignee-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0; }
      .assignee-chip {
        padding: 5px 10px; border-radius: 14px; font-size: 12px; font-family: inherit;
        border: 1px solid var(--divider-color); background: none;
        color: var(--secondary-text-color); cursor: pointer;
      }
      .assignee-chip.active {
        background: color-mix(in srgb, var(--primary-color) 18%, transparent);
        color: var(--primary-color); border-color: var(--primary-color);
      }
      .assignee-chip:disabled { cursor: default; }
      .plan-workday { min-width: 40px; }
      .detail-field-row { gap: 4px; }
      .detail-field-row > .toggle-label { flex: 1; display: flex; flex-direction: column; }
      .detail-field-row.unavailable > .toggle-label { color: var(--secondary-text-color); }
      .detail-field-row > ha-switch { margin-left: 8px; }
      .group-label {
        display: flex; align-items: center; gap: 10px; margin: 14px 0 2px;
        font-size: 12px; font-weight: 500; color: var(--secondary-text-color, #888);
        text-transform: uppercase; letter-spacing: 0.06em;
      }
      .group-label::before, .group-label::after {
        content: ""; flex: 1; height: 1px;
        background: var(--divider-color, rgba(127,127,127,0.3));
      }
      .visual-editor { display: flex; flex-direction: column; gap: 8px; }
      .field { display: flex; flex-direction: column; gap: 6px; }
      details { border: 1px solid var(--divider-color, rgba(255,255,255,0.12)); border-radius: 8px; overflow: hidden; }
      summary { display: flex; align-items: center; gap: 8px; padding: 12px 16px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--primary-text-color); user-select: none; list-style: none; }
      summary::-webkit-details-marker { display: none; }
      .sum-chevron { margin-left: auto; display: inline-flex; transition: transform 0.2s; color: var(--secondary-text-color); }
      details[open] .sum-chevron { transform: rotate(180deg); }
      .section-content { display: flex; flex-direction: column; gap: 16px; padding: 16px 16px; border-top: 1px solid var(--divider-color, rgba(255,255,255,0.12)); box-sizing: border-box; }
      label { font-size: 12px; font-weight: 500; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.5px; }
      ha-icon-picker { width: 100%; }
      select.editor-native-select { width: 100%; padding: 10px 12px; border: 1px solid var(--input-outlined-idle-border-color, var(--divider-color, rgba(0,0,0,0.38))); border-radius: 4px; background-color: var(--input-fill-color, var(--secondary-background-color, transparent)); color: var(--primary-text-color, #212121); font-size: 1rem; font-family: var(--mdc-typography-body1-font-family, Roboto, sans-serif); cursor: pointer; box-sizing: border-box; }
      select.editor-native-select:hover { border-color: var(--input-outlined-hover-border-color, var(--primary-text-color, rgba(0,0,0,0.87))); }
      select.editor-native-select:focus { outline: none; border-color: var(--primary-color, #03a9f4); border-width: 2px; padding: 9px 11px; }
      select.editor-native-select option { background-color: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color, #212121); }
      .hint { font-size: 12px; color: var(--secondary-text-color); font-style: italic; margin-top: 2px; }
      .hint.plan-lists-error { color: var(--error-color, #db4437); font-style: normal; }
      .assignee-chip.plan-list-missing { font-style: italic; }
      .new-entry-link { font-size: 13px; color: var(--primary-color); text-decoration: none; align-self: flex-start; }
      .new-entry-link:hover { text-decoration: underline; }
      /* A hint belongs to what stands right above it (a field, or a group
         heading it introduces): pull it up to that instead of floating
         halfway to the next setting. */
      .section-content > * + .hint, .defaults-editor > * + .hint { margin-top: -12px; }
      .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; min-height: 40px; }
      .toggle-label { font-size: 14px; color: var(--primary-text-color); }
      .queue-panel { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      .queue-row {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px; border-radius: 6px;
        background: var(--secondary-background-color, rgba(127,127,127,0.08));
      }
      .queue-row.current { background: var(--primary-color, #03a9f4); background: color-mix(in srgb, var(--primary-color, #03a9f4) 14%, transparent); }
      .queue-pos {
        flex-shrink: 0; min-width: 18px; font-size: 12px;
        color: var(--secondary-text-color); font-variant-numeric: tabular-nums;
      }
      .queue-title { flex: 1; min-width: 0; font-size: 13px; word-break: break-word; color: var(--primary-text-color); }
      .queue-state { flex-shrink: 0; font-size: 12px; font-style: italic; color: var(--secondary-text-color); }
      .queue-cancel {
        border: none; background: transparent; cursor: pointer;
        font-size: 18px; line-height: 1; color: var(--secondary-text-color);
      }
      .queue-cancel:hover { color: var(--error-color, #db4437); }
      .queue-cancel:disabled { opacity: 0.4; cursor: default; }
      .field-wrap { position: relative; width: 100%; }
      .field-wrap input { width: 100%; box-sizing: border-box; padding: 20px 12px 6px; height: 48px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); color: var(--primary-text-color); font-size: 0.875rem; font-family: inherit; outline: none; }
      .field-wrap input:focus { border: 2px solid var(--primary-color); padding: 19px 11px 5px; }
      .field-wrap input[type="number"] { padding-right: 28px; -moz-appearance: textfield; }
      .field-wrap input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; }
      .field-wrap > span { position: absolute; top: 6px; left: 12px; font-size: 11px; font-weight: 400; color: var(--secondary-text-color); pointer-events: none; }
      .field-wrap input:focus ~ span { color: var(--primary-color); }
      .spin-btns { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; }
      .spin-btn { background: none; border: none; padding: 2px 4px; cursor: pointer; color: var(--secondary-text-color); line-height: 1; font-size: 12px; }
      .spin-btn:hover { color: var(--primary-color); }
      ha-yaml-editor { display: block; }
      .sections-editor-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
      .sections-editor-row .field-wrap { flex: 1 1 0; min-width: 80px; }
      .sections-editor-row ha-icon-picker { flex: 1 1 0; min-width: 0; }
      .icon-btn { background: none; border: 1px solid var(--divider-color, rgba(255,255,255,0.12)); border-radius: 6px; padding: 6px; cursor: pointer; color: var(--primary-text-color); display: inline-flex; align-items: center; justify-content: center; }
      .icon-btn:hover:not(:disabled) { background: var(--secondary-background-color, rgba(0,0,0,0.05)); }
      .icon-btn:disabled { opacity: 0.4; cursor: default; }
      .icon-btn.del { color: var(--error-color, #db4437); }
      .icon-btn ha-icon { --mdc-icon-size: 18px; }
      .add-section-btn { margin-top: 8px; padding: 8px 14px; border: 1px dashed var(--primary-color); border-radius: 6px; background: transparent; color: var(--primary-color); cursor: pointer; font-family: inherit; font-size: 14px; }
      .add-section-btn:hover { background: rgba(3,169,244,0.08); }
      .defaults-editor { display: flex; flex-direction: column; gap: 16px; }
      .def-reminder-row { display: flex; align-items: center; gap: 8px; }
      .def-reminder-row .field-wrap { flex: 1; min-width: 0; }
      .def-reminder-row .icon-btn { font-size: 18px; line-height: 1; }
      .def-lead-row { display: flex; gap: 8px; }
      .def-lead-row .field-wrap { flex: 1; min-width: 0; }
      .def-saved-flash { opacity: 0; transition: opacity 0.3s; color: var(--primary-color, #03a9f4); font-size: 12px; font-weight: 500; }
      .def-saved-flash.show { opacity: 1; }
      .def-saved-flash.err { color: var(--error-color, #db4437); }
      /* In the heading, take up room only while shown — else the empty flash
         shortens the line after the heading text. */
      .group-label .def-saved-flash:not(.show) { display: none; }
      .field-wrap select { width: 100%; box-sizing: border-box; padding: 20px 12px 6px; height: 48px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); color: var(--primary-text-color); font-size: 0.875rem; font-family: inherit; outline: none; cursor: pointer; }
      .field-wrap select:focus { border: 2px solid var(--primary-color); padding: 19px 11px 5px; }
      .field-wrap select:focus ~ span { color: var(--primary-color); }
      .ms-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 48px; box-sizing: border-box; padding: 20px 10px 6px; border: 1px solid var(--outline-color, var(--divider-color, rgba(255,255,255,0.12))); border-radius: 4px; background: var(--mdc-text-field-fill-color, var(--input-fill-color, transparent)); }
      .ms-chips:focus-within { border: 2px solid var(--primary-color); padding: 19px 9px 5px; }
      .field-wrap .ms-chips:focus-within ~ span { color: var(--primary-color); }
      .ms-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--primary-color); color: var(--text-primary-color, #fff); border-radius: 12px; padding: 2px 4px 2px 10px; font-size: 13px; line-height: 1.7; }
      .ms-chip-x { border: none; background: rgba(0,0,0,0.22); color: inherit; width: 18px; height: 18px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; line-height: 1; padding: 0; }
      .ms-chip-x:hover { background: rgba(0,0,0,0.42); }
      .ms-input { flex: 1 1 80px; min-width: 80px; border: none; outline: none; background: transparent; color: var(--primary-text-color); font-size: 14px; font-family: inherit; padding: 4px 2px; }
      /* Reset the generic .field-wrap input box styles (border/height/full-width) for the chip-input */
      .field-wrap .ms-input, .field-wrap .ms-input:focus { width: auto; height: auto; padding: 4px 2px; border: none; background: transparent; }
    `;
    root.appendChild(style);

    // Global card title input (above tabs)
    const cardTitleInput = this._editorText(
      "ed_card_title", "ed_card_title_placeholder", "card-title-input", this._config.title,
      (value) => {
        this._config = { ...this._config, title: value || undefined };
        this._fireChanged();
      },
    );
    const cardTitleRow = this._el("div", { className: "editor-card-title-row" }, [cardTitleInput]);

    // Below the title, what the editor of the card type sets up.
    root.appendChild(this._el("div", { className: "editor" }, [cardTitleRow, ...this._buildEditorBody()]));
  }

  // The way to a new list or a new day plan: the integration's page, where
  // Home Assistant adds an entry. In a new tab, so that this editor
  // stays open with what was changed in it; when the user comes back, lists
  // and plans are read again and the new one can be picked. Null for anyone
  // who is not an administrator - nobody else may add an entry.
  _newEntryLink() {
    if (this._hass?.user?.is_admin !== true) return null;
    const link = this._el("a", {
      className: "new-entry-link", href: NEW_ENTRY_PATH, target: "_blank", rel: "noopener",
      textContent: `+ ${this._t("new_entry_link")}`,
    });
    link.addEventListener("click", () => {
      window.addEventListener("focus", () => {
        if (this.isConnected) this._loadLists();
      }, { once: true });
    });
    return link;
  }

  // A line of text with its label inside the box. An input of the editor's
  // own: Home Assistant's ha-textfield is no longer there in 2026.11, and an
  // element that is not defined takes no room - the field was simply gone.
  _editorText(labelKey, placeholderKey, cls, value, onChange) {
    const input = this._el("input", { type: "text", className: cls, value: value || "" });
    input.placeholder = this._t(placeholderKey);
    input.addEventListener("change", () => onChange(input.value));
    return this._el("div", { className: "field-wrap title-field" }, [
      input, this._el("span", { textContent: this._t(labelKey) }),
    ]);
  }

  // A dropdown with its label inside the box, as the list editor's.
  // *options* are [value, text] pairs.
  _editorSelect(labelKey, cls, options, value, onChange) {
    const sel = this._el("select", { className: `editor-native-select ${cls}` }, options.map(
      ([val, text]) => this._el("option", { value: val, textContent: text })
    ));
    sel.value = value;
    sel.addEventListener("change", () => onChange(sel.value));
    return this._el("div", { className: "field-wrap" }, [
      sel, this._el("span", { textContent: this._t(labelKey) }),
    ]);
  }

  // The task-details fields as one list: switched on or off, and moved up or
  // down to set the order they appear in (detail_order). *get* gives the
  // config the options are in as it is now - a column, or the card itself
  // for a day plan - and *update* writes to it.
  _buildDetailFieldList({ get, update, noSections = false, onToggle = null }) {
    const list = this._el("div", { className: "detail-field-list" });
    const draw = () => {
      const cur = get() || {};
      const order = _detailOrder(cur);
      list.replaceChildren();
      order.forEach((key, i) => {
        const [, labelKey, option, , legacy] = DETAIL_FIELD[key];
        const move = (d) => {
          const next = order.slice();
          [next[i], next[i + d]] = [next[i + d], next[i]];
          update({ detail_order: _shortDetailOrder(next) });
          draw();
        };
        const label = this._el("span", { className: "toggle-label", textContent: this._t(labelKey) });
        const unavailable = key === "section" && noSections;
        if (unavailable) {
          label.appendChild(this._el("span", { className: "hint", textContent: this._t("ed_section_field_no_sections") }));
        }
        const sw = document.createElement("ha-switch");
        sw.checked = _detailFieldOn(cur, key);
        sw.setAttribute("aria-label", this._t(labelKey));
        sw.addEventListener("change", () => {
          const updates = { [option]: sw.checked };
          // The older name would otherwise still win where the new one is unset.
          if (legacy && legacy in (get() || {})) updates[legacy] = undefined;
          update(updates);
          if (onToggle) onToggle(key, sw.checked);
        });
        list.appendChild(this._el("div", {
          className: "toggle-row detail-field-row" + (unavailable ? " unavailable" : ""),
          "data-key": key,
        }, [
          label,
          this._iconButton("mdi:arrow-up", "ed_move_up", i === 0, () => move(-1)),
          this._iconButton("mdi:arrow-down", "ed_move_down", i === order.length - 1, () => move(1)),
          sw,
        ]));
      });
    };
    draw();
    return list;
  }

  // A section that opens: icon, title, chevron, and the settings inside.
  // Open or closed is remembered per section id.
  _buildEditorSection(sectionId, icon, titleKey, nodes) {
    const det = document.createElement("details");
    const isOpen = this._sectionOpen[sectionId] === true;
    if (isOpen) det.open = true;
    const sum = document.createElement("summary");
    const ico = document.createElement("ha-icon");
    ico.setAttribute("icon", icon);
    ico.style.cssText = "--mdc-icon-size:20px;width:20px;height:20px;flex-shrink:0;";
    const chevWrap = document.createElement("span");
    chevWrap.className = "sum-chevron";
    const chev = document.createElement("ha-icon");
    chev.setAttribute("icon", "mdi:chevron-down");
    chev.style.cssText = "--mdc-icon-size:20px;width:20px;height:20px;";
    chevWrap.appendChild(chev);
    sum.appendChild(ico);
    sum.appendChild(document.createTextNode(this._t(titleKey)));
    sum.appendChild(chevWrap);
    det.appendChild(sum);
    const content = document.createElement("div");
    content.className = "section-content";
    for (const n of nodes) if (n) content.appendChild(n);
    // Zero-padding wrapper: animating max-height on the padded section-content
    // would leave the padding visible at max-height:0. The wrapper has no
    // padding so max-height:0 truly collapses to 0.
    const wrap = document.createElement("div");
    wrap.appendChild(content);
    det.appendChild(wrap);

    sum.addEventListener("click", (e) => {
      e.preventDefault();
      if (det.open) {
        // Mark closed immediately so any mid-animation re-render preserves state
        this._sectionOpen[sectionId] = false;
        this._saveSectionState();
        const h = wrap.offsetHeight;
        if (!h) { det.open = false; return; }
        wrap.style.cssText = `overflow:hidden;max-height:${h}px;`;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            wrap.style.transition = "max-height 0.22s ease-in";
            wrap.style.maxHeight = "0";
            wrap.addEventListener("transitionend", () => {
              det.open = false;
              wrap.style.cssText = "";
            }, { once: true });
          });
        });
      } else {
        // Mark open immediately so any mid-animation re-render preserves state
        this._sectionOpen[sectionId] = true;
        this._saveSectionState();
        det.open = true;
        wrap.style.cssText = "overflow:hidden;max-height:0;";
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            wrap.style.transition = "max-height 0.28s ease-out";
            wrap.style.maxHeight = "800px";
            wrap.addEventListener("transitionend", () => {
              wrap.style.cssText = "";
            }, { once: true });
          });
        });
      }
    });

    return det;
  }

  // An icon-only button, e.g. the up/down arrows in the editor's lists.
  _iconButton(icon, titleKey, disabled, onClick) {
    const btn = this._el("button", { className: "icon-btn", type: "button", title: this._t(titleKey) });
    const ic = document.createElement("ha-icon");
    ic.setAttribute("icon", icon);
    btn.appendChild(ic);
    btn.disabled = disabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  _fireChanged() {
    // Flag so the immediate echo setConfig() from HA is ignored (no re-render).
    this._ignoreNextSetConfig = true;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }

  // ── What an editor fills in ───────────────────────────────────────────────

  // What stands below the card title.
  _buildEditorBody() {
    return [];
  }

  // The lists and plans are known (and the config may need one of them).
  _afterListsLoaded() {}
}
