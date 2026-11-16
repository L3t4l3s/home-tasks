// What the card and its editors share outside their classes: constants,
// small pure helpers, and the per-list detail folding kept in localStorage.

export const REMINDER_OFFSETS = [
  [0, "rem_at_due"],
  [5, "rem_5m"],
  [15, "rem_15m"],
  [30, "rem_30m"],
  [60, "rem_1h"],
  [120, "rem_2h"],
  [1440, "rem_1d"],
  [2880, "rem_2d"],
];

// Reminder editing shared by the task detail sheet and the editor's Defaults
// section (host provides _el/_t). MAX_REMINDERS mirrors the backend's
// MAX_REMINDERS_PER_TASK.
export const MAX_REMINDERS = 5;
// Mirrors the backend's MAX_REOPEN_LEAD_MINUTES: a year ahead at most.
export const MAX_REOPEN_LEAD_MINUTES = 365 * 24 * 60;
export const reminderOffsetOptions = (host, offset) => {
  const opts = [];
  let matched = false;
  for (const [val, key] of REMINDER_OFFSETS) {
    const opt = host._el("option", { value: String(val), textContent: host._t(key) });
    if (val === offset) { opt.selected = true; matched = true; }
    opts.push(opt);
  }
  // Offsets set via WS/service can be any 0..43200 minutes: give them their
  // own option instead of silently displaying (and rewriting them to) the
  // first preset.
  if (!matched && Number.isFinite(offset)) {
    const opt = host._el("option", { value: String(offset), textContent: offset + " min" });
    opt.selected = true;
    opts.push(opt);
  }
  return opts;
};
export const nextFreeReminderOffset = (used) =>
  (REMINDER_OFFSETS.find(([v]) => !used.has(v)) || REMINDER_OFFSETS[0])[0];

// Person options shared by the detail sheet's assignee chips and the
// editor (the "nobody" entry stays with the callers). People in *hidden*
// are left out.
export const personEntries = (hass, hidden = []) =>
  Object.keys((hass && hass.states) || {})
    .filter((eid) => eid.startsWith("person.") && !hidden.includes(eid))
    .sort()
    .map((eid) => ({
      value: eid,
      label: (hass.states[eid] && hass.states[eid].attributes && hass.states[eid].attributes.friendly_name) || eid,
    }));

// How a person is shown, in the task row and in the filter row above it.
// Two switches (chip on/off, picture on/off) could say the same four things,
// but only if you found both of them - they sat nine rows apart in one grid.
export const PERSON_MODES = ["off", "picture", "name", "both"];

// Initials-circle colours, picked by a hash of the person so the same face
// keeps the same colour on every card and after every reload. Dark enough
// for white text in either theme.
export const PERSON_COLORS = [
  "#185fa5", "#0f6e56", "#993c1d", "#993556", "#534ab7",
  "#3b6d11", "#854f0b", "#a32d2d", "#5f5e5a",
];

// Marker for "we stopped waiting", as opposed to "the backend said no".
export const WS_TIMEOUT = "timeout";

// HA todo entity feature bits (TodoListEntityFeature) used for capability gating.
export const TODO_FEATURE = { SET_DUE_DATE: 16, SET_DUE_DATETIME: 32, SET_DESCRIPTION: 64 };

// Can tasks of an external list carry a due date / a due time? `info` is an
// entry of the get_external_lists result ({supported_features, capabilities}).
// One definition shared by the card (add row, detail panel) and the editor so
// the three places can't drift apart.
// The ai_task entity and prefix a card hands to every list it shows, or
// null when it has no entity. Shared by the card and its editor.
export function imageSettingsForLists(host) {
  const imgCfg = host._config?.image_generation || {};
  if (!imgCfg.entity_id) return null;
  return { ai_task_entity_id: imgCfg.entity_id, prompt_prefix: imgCfg.prompt_prefix || "" };
}

export function listInfoFor(host, col) {
  return col.entity_id
    ? (host._externalLists || []).find(l => l.entity_id === col.entity_id)
    : (host._lists || []).find(l => l.id === col.list_id);
}

export function listSupportsDue(info) {
  const features = (info && info.supported_features) || 0;
  const caps = (info && info.capabilities) || {};
  return !!((features & TODO_FEATURE.SET_DUE_DATE) || (features & TODO_FEATURE.SET_DUE_DATETIME) || caps.can_sync_due_time);
}
export function listSupportsDueTime(info) {
  const features = (info && info.supported_features) || 0;
  return !!(features & TODO_FEATURE.SET_DUE_DATETIME);
}

// list_columns: 1-4 columns of tasks in list view (default 1).
export function _listColumns(col) {
  const n = parseInt(col && col.list_columns, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(4, n)) : 1;
}

// list_column_min_width: px a list column must keep before the card drops
// to fewer columns (80-600, default 160 - two columns fit on a phone).
export function _listMinWidth(col) {
  const n = parseInt(col && col.list_column_min_width, 10);
  return Number.isFinite(n) ? Math.max(80, Math.min(600, n)) : null;
}

// tile_size: "small" | "compact" | "medium" | "large", or a minimum tile
// width in px (60-400). Medium ("Normal") is the built-in size and the
// default (140px), so it sets nothing - same as leaving tile_size unset.
// The compact switch doesn't change the tile size.
export const _TILE_SIZES = { small: 80, compact: 100, large: 200 };
export function _tileMinWidth(col) {
  const v = col && col.tile_size;
  if (v == null || v === "" || v === "medium") return null;
  if (typeof v === "string" && _TILE_SIZES[v]) return _TILE_SIZES[v];
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(60, Math.min(400, n)) : null;
}

// Task-details fields folded by the user (by key), per list - like the
// folded sections of a list - and kept in localStorage. One Set per list for
// every card on the page, loaded once, so two cards showing the same list
// never write back each other's stale copy; a card that folds a field tells
// the others with DETAIL_FOLD_EVENT.
export const DETAIL_FOLD_STORAGE_KEY = "home_tasks_card:detail_fold";
export const DETAIL_FOLD_EVENT = "home-tasks-detail-fold";
export const _foldedDetailSets = new Map();
export function _foldedDetailKeys(list) {
  let keys = _foldedDetailSets.get(list);
  if (!keys) {
    try {
      const raw = window.localStorage.getItem(`${DETAIL_FOLD_STORAGE_KEY}:${list}`);
      const parsed = raw ? JSON.parse(raw) : [];
      keys = new Set(Array.isArray(parsed) ? parsed : []);
    } catch (e) {
      keys = new Set();  // storage blocked: folding lasts this session
    }
    _foldedDetailSets.set(list, keys);
  }
  return keys;
}

// Everyone a task is assigned to (issue #75), primary first. Older tasks
// (and providers) only carry assigned_person.

export function _assignees(task) {
  const people = Array.isArray(task && task.assigned_persons) ? task.assigned_persons.filter(Boolean) : [];
  const primary = task && task.assigned_person;
  if (primary && !people.includes(primary)) people.unshift(primary);
  return people;
}

// Stands for "nobody" in a column's preset assignee filter (issue #93), so a
// column can show the unclaimed tasks, alone or next to named people. Never
// a person: nothing is ever assigned to it.
export const UNASSIGNED = "unassigned";

// The task-details fields in their default order: [key, editor label,
// show_* option, shown by default, older name of the option].
export const DETAIL_FIELDS = [
  ["notes", "ed_show_notes", "show_notes", true],
  ["sub_tasks", "ed_show_sub_items", "show_sub_tasks", true, "show_sub_items"],
  ["person", "ed_show_person", "show_assigned_person", true],
  ["section", "ed_show_section", "show_section", true],
  ["priority", "ed_show_priority", "show_priority", true],
  ["tags", "ed_show_tags", "show_tags", true],
  ["due_date", "ed_show_due_date", "show_due_date", true],
  ["reminders", "ed_show_reminders", "show_reminders", true],
  ["recurrence", "ed_show_recurrence", "show_recurrence", true],
  ["history", "ed_show_history", "show_history", false],
  ["images", "ed_show_images", "show_images", false],
];
export const DETAIL_FIELD = Object.fromEntries(DETAIL_FIELDS.map((f) => [f[0], f]));
export const DETAIL_KEYS = DETAIL_FIELDS.map((f) => f[0]);

// Whether a column has the task-details field *key* switched on.
export function _detailFieldOn(col, key) {
  const [, , option, defaultOn, legacy] = DETAIL_FIELD[key];
  const v = col[option] ?? (legacy ? col[legacy] : undefined);
  return defaultOn ? v !== false : v === true;
}

// detail_order: the task-details fields in the order given; unknown keys
// are ignored and fields not listed follow in the default order.
export function _detailOrder(col, defaults = DETAIL_KEYS) {
  const wanted = Array.isArray(col && col.detail_order) ? col.detail_order : [];
  const listed = wanted.filter((k, i) => defaults.includes(k) && wanted.indexOf(k) === i);
  return [...listed, ...defaults.filter((k) => !listed.includes(k))];
}

// The shortest detail_order giving *order*: fields at the end that already
// follow in the default order are left out, so a field a later version adds
// still lands in its default place.
export function _shortDetailOrder(order) {
  let n = order.length;
  while (n > 0 && _detailOrder({ detail_order: order.slice(0, n - 1) }).join() === order.join()) n--;
  return n ? order.slice(0, n) : undefined;
}

// Where a list, a linked list or a day plan is added: the integration's page
// in Home Assistant's settings, with its "Add service" button. Adding one is
// Home Assistant's job, not the card's: the card only takes the user there.
// The card exists only once Home Tasks is set up, so the address that starts
// the dialog directly (/config/integrations/dashboard/add?domain=…) is the
// wrong one - it first asks whether to "set up" what is already there.
export const NEW_ENTRY_PATH = "/config/integrations/integration/home_tasks";
