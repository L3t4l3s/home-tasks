// Visibility conditions on one column of the list card: the conditions a
// card's own Visibility tab in Home Assistant takes, judged the way Home
// Assistant judges them for a card.
//
// Written after Home Assistant's frontend, which a custom card cannot import:
//   - checkConditionsMet (panels/lovelace/common/validate-condition.ts)
//     judges a condition in the browser;
//   - translate.ts / split.ts decide what goes to core: `screen`, `user`,
//     `time`, `view_columns` and `location` stay in the browser, everything
//     else (state, numeric_state, template, sun, zone, device, ...) is asked
//     of core with `subscribe_condition`, sibling server conditions in one
//     subscription;
//   - evaluate-locally.ts seeds a result before core answers;
//   - ConditionEvaluatorController keeps it live (media queries, time
//     boundaries, core pushes) and hides on an error from core.
// A list holds when every condition holds. Unknown stays unknown through
// `not`, and only a known true shows, as in Home Assistant.
//
// Where Home Assistant does not take `subscribe_condition` (before 2026.6,
// or 2026.6 to 2026.9 for a user who is not an administrator), the server
// part is judged in the browser where it can be (state, numeric_state), as
// Home Assistant did before, and stays unknown - hidden - where it cannot.

const CLIENT_TYPES = new Set(["screen", "user", "view_columns", "location", "time"]);
const LOGICAL_TYPES = new Set(["and", "or", "not"]);
const ROW_CONFIG_KEYS = ["alias", "note", "enabled"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// What Home Assistant answers for a command it does not know, or will not
// run for this user.
const REFUSALS = new Set(["unknown_command", "unauthorized"]);

const ensureArray = (v) => (v === undefined || v === null ? v : Array.isArray(v) ? v : [v]);
const isValidEntityId = (v) => typeof v === "string" && /^(\w+)\.(\w+)$/.test(v);
const isObject = (c) => typeof c === "object" && c !== null && !Array.isArray(c);
const domainOf = (entityId) => String(entityId).split(".", 1)[0];

// ── Shapes ──────────────────────────────────────────────────────────────────

// A column's `visibility` as judged: a list, or undefined for none. One
// condition written without a list is a list of one; entries that are no
// condition at all (`- ` in YAML) are dropped at any depth, as Home
// Assistant's dropInvalidConditions does.
export function normalizeVisibility(value) {
  if (value === undefined || value === null) return undefined;
  const list = dropInvalid(Array.isArray(value) ? value : [value]);
  return list.length ? list : undefined;
}

function dropInvalid(conditions) {
  const valid = [];
  for (const c of conditions) {
    if (!isObject(c)) continue;
    if ("conditions" in c && c.conditions != null) {
      valid.push({ ...c, conditions: dropInvalid(ensureArray(c.conditions)) });
    } else {
      valid.push(c);
    }
  }
  return valid;
}

export const isLogicalCondition = (c) => "condition" in c && LOGICAL_TYPES.has(c.condition);
const logicalChildren = (c) => ensureArray(c.conditions) || [];
const isDisabledCondition = (c) => "enabled" in c && c.enabled === false;
const isEntityReference = (v) => typeof v === "string" && isNaN(Number(v)) && isValidEntityId(v);

// Lovelace state / numeric_state that core would judge differently, so Home
// Assistant keeps judging them in the browser.
function hasLegacyOnlySemantics(c) {
  if (c.condition === "numeric_state") return [c.above, c.below].some(isEntityReference);
  if ("attribute" in c && c.attribute !== undefined) return true;
  return [...(ensureArray(c.state) || []), ...(ensureArray(c.state_not) || [])].some(isEntityReference);
}

// Whether a condition goes to core. A mixed and/or/not stays in the browser
// so it can wrap server parts.
export function isServerCondition(c) {
  if (isLogicalCondition(c)) return logicalChildren(c).every(isServerCondition);
  if (!("condition" in c)) return !hasLegacyOnlySemantics(c);
  if (CLIENT_TYPES.has(c.condition)) return false;
  if ((c.condition === "state" || c.condition === "numeric_state") && !("entity_id" in c)) {
    return !hasLegacyOnlySemantics(c);
  }
  return true;
}

const isClientCondition = (c) => !isServerCondition(c);
const isPureClientCondition = (c) =>
  isLogicalCondition(c) ? logicalChildren(c).every(isPureClientCondition) : isClientCondition(c);

// ── Translation to core's shape (translate.ts) ─────────────────────────────

function pickRowConfig(c) {
  const out = {};
  for (const k of ROW_CONFIG_KEYS) if (k in c) out[k] = c[k];
  return out;
}

const alwaysFalse = () => ({ condition: "not", conditions: [{ condition: "and", conditions: [] }] });
const NEVER = Symbol("never-satisfied");

export function toCoreCondition(c) {
  if (!("condition" in c)) return toCoreState({ condition: "state", ...c });
  if (isLogicalCondition(c)) {
    const row = pickRowConfig(c);
    if (c.conditions === undefined) return { ...row, condition: "and", conditions: [] };
    const conditions = logicalChildren(c).map(toCoreCondition);
    // Lovelace `not` is NOT(AND); core's is NOT(OR).
    if (c.condition === "not") return { ...row, condition: "not", conditions: [{ condition: "and", conditions }] };
    return { ...row, condition: c.condition, conditions };
  }
  if (c.condition === "state") return toCoreState(c);
  if (c.condition === "numeric_state") return toCoreNumericState(c);
  return c;
}

function toCoreState(c) {
  if ("entity_id" in c) return c;
  const row = pickRowConfig(c);
  if (!c.entity || (c.state === undefined && c.state_not === undefined)) return { ...row, ...alwaysFalse() };
  const base = { condition: "state", entity_id: c.entity, ...(c.attribute !== undefined ? { attribute: c.attribute } : {}) };
  if (c.state !== undefined) return { ...row, ...base, state: c.state };
  return { ...row, condition: "not", conditions: [{ ...base, state: c.state_not }] };
}

function toCoreBound(bound, side) {
  if (bound == null) return undefined;
  const n = typeof bound === "number" ? bound : Number(bound);
  if (isNaN(n)) return typeof bound === "string" && isValidEntityId(bound) ? bound : undefined;
  if (!isFinite(n)) return (side === "above") === n > 0 ? NEVER : undefined;
  return n;
}

function toCoreNumericState(c) {
  if ("entity_id" in c) return c;
  const row = pickRowConfig(c);
  if (!c.entity) return { ...row, ...alwaysFalse() };
  const above = toCoreBound(c.above, "above");
  const below = toCoreBound(c.below, "below");
  if (above === NEVER || below === NEVER) return { ...row, ...alwaysFalse() };
  if (above === undefined && below === undefined) {
    return {
      ...row,
      condition: "template",
      value_template: c.attribute === undefined
        ? `{{ is_number(states(${JSON.stringify(c.entity)})) }}`
        : `{{ is_number(state_attr(${JSON.stringify(c.entity)}, ${JSON.stringify(c.attribute)})) }}`,
    };
  }
  const core = { ...row, condition: "numeric_state", entity_id: c.entity };
  if (c.attribute !== undefined) core.attribute = c.attribute;
  if (above !== undefined) core.above = above;
  if (below !== undefined) core.below = below;
  return core;
}

// ── Judging in the browser (checkConditionsMet) ────────────────────────────

function stateFromEntityId(hass, value) {
  return isValidEntityId(value) && hass.states[value] ? hass.states[value].state : undefined;
}

function checkState(c, hass, ctx) {
  const entityId = c.entity_id || c.entity || ctx.entity_id;
  const stateObj = entityId ? hass.states[entityId] : undefined;
  let state;
  if (!stateObj) state = "unknown";
  else if (c.attribute) {
    const v = stateObj.attributes?.[c.attribute];
    state = v == null ? "unknown" : String(v);
  } else state = stateObj.state;
  let value = c.state ?? c.state_not;
  if (value === undefined) return false;
  if (Array.isArray(value)) {
    value = [...value, ...value.map((v) => stateFromEntityId(hass, v)).filter((v) => v !== undefined)];
  } else if (typeof value === "string") {
    const fromEntity = stateFromEntityId(hass, value);
    value = fromEntity ? [value, fromEntity] : [value];
  }
  return c.state != null ? ensureArray(value).includes(state) : !ensureArray(value).includes(state);
}

function checkNumericState(c, hass, ctx) {
  const entityId = c.entity_id || c.entity || ctx.entity_id;
  const stateObj = entityId ? hass.states[entityId] : undefined;
  const state = c.attribute ? stateObj?.attributes?.[c.attribute] : stateObj?.state;
  let above = c.above;
  let below = c.below;
  if (typeof above === "string") above = stateFromEntityId(hass, above) ?? above;
  if (typeof below === "string") below = stateFromEntityId(hass, below) ?? below;
  const n = Number(state);
  const a = Number(above);
  const b = Number(below);
  if (isNaN(n)) return false;
  return (c.above == null || isNaN(a) || a < n) && (c.below == null || isNaN(b) || b > n);
}

// The time zone Home Assistant's dashboards judge `time` in.
function conditionTimeZone(hass) {
  if (hass.locale?.time_zone === "server" && hass.config?.time_zone) return hass.config.time_zone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return "UTC"; }
}

const wallFormats = new Map();
// Wall clock in *zone* at *date*: weekday and seconds into the day.
function wallClock(zone, date) {
  let fmt = wallFormats.get(zone);
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch (_) { fmt = null; }
    wallFormats.set(zone, fmt);
  }
  if (!fmt) {
    return { weekday: WEEKDAYS[date.getDay()], seconds: date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() };
  }
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;
  return {
    weekday: String(parts.weekday).slice(0, 3).toLowerCase(),
    seconds: hour * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

function timeOfDay(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  const [h, m, s = 0] = parts.map(Number);
  if (h > 23 || m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function checkTime(c, hass, now = new Date()) {
  const wall = wallClock(conditionTimeZone(hass), now);
  if (Array.isArray(c.weekdays) && c.weekdays.length > 0 && !c.weekdays.includes(wall.weekday)) return false;
  if (!c.after && !c.before) return true;
  const after = c.after ? timeOfDay(c.after) : null;
  const before = c.before ? timeOfDay(c.before) : null;
  const t = wall.seconds;
  if (after !== null && before !== null) {
    if (before < after) return t >= after || t <= before;  // crosses midnight
    return t >= after && t <= before;
  }
  if (after !== null) return t >= after;
  if (before !== null) return t <= before;
  return true;
}

// The person of the user viewing the dashboard (getUserPerson): its entity
// id, or undefined where the user has none.
const personOfUser = new Map();
export function viewerPersonId(hass) {
  const userId = hass?.user?.id;
  const states = hass?.states;
  if (!userId || !states) return undefined;
  const cached = personOfUser.get(userId);
  if (cached && states[cached]?.attributes?.user_id === userId) return cached;
  for (const id of Object.keys(states)) {
    if (domainOf(id) === "person" && states[id]?.attributes?.user_id === userId) {
      personOfUser.set(userId, id);
      return id;
    }
  }
  return undefined;
}

function viewerPerson(hass) {
  const id = viewerPersonId(hass);
  return id ? hass.states[id] : undefined;
}

const TARGET_KEYS = ["entity_id", "device_id", "area_id", "floor_id", "label_id"];
const isIdList = (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
function isTarget(t, allowExclude = true) {
  return isObject(t) && Object.entries(t).every(([k, v]) =>
    k === "exclude" ? allowExclude && isTarget(v, false) : TARGET_KEYS.includes(k) && isIdList(v));
}

// The zones a target selects: directly, or through a device, area, floor or
// label, as Home Assistant's target selector resolves them.
function targetZones(hass, target) {
  const entities = hass.entities || {};
  const devices = hass.devices || {};
  const areas = hass.areas || {};
  const ids = (v) => ensureArray(v) || [];
  const zoneIds = new Set([
    ...Object.keys(entities).filter((id) => domainOf(id) === "zone"),
    ...Object.keys(hass.states).filter((id) => domainOf(id) === "zone"),
  ]);
  const resolve = (t) => {
    const out = new Set(ids(t.entity_id).filter((id) => domainOf(id) === "zone"));
    const areaIds = new Set(ids(t.area_id));
    for (const floor of ids(t.floor_id)) {
      for (const [areaId, area] of Object.entries(areas)) if (area?.floor_id === floor) areaIds.add(areaId);
    }
    const deviceIds = new Set(ids(t.device_id));
    const labels = new Set(ids(t.label_id));
    for (const [areaId, area] of Object.entries(areas)) {
      if ((area?.labels || []).some((l) => labels.has(l))) areaIds.add(areaId);
    }
    for (const [deviceId, device] of Object.entries(devices)) {
      if ((device?.labels || []).some((l) => labels.has(l))) deviceIds.add(deviceId);
      if (device?.area_id && areaIds.has(device.area_id)) deviceIds.add(deviceId);
    }
    for (const id of zoneIds) {
      const entry = entities[id];
      if (!entry) continue;
      const area = entry.area_id || (entry.device_id ? devices[entry.device_id]?.area_id : undefined);
      if ((entry.labels || []).some((l) => labels.has(l))
          || (entry.device_id && deviceIds.has(entry.device_id))
          || (area && areaIds.has(area))) {
        out.add(id);
      }
    }
    return out;
  };
  const zones = resolve(target);
  if (target.exclude) for (const id of resolve(target.exclude)) zones.delete(id);
  return [...zones].filter((id) => id in hass.states);
}

function activeZoneState(hass, zoneId) {
  const stateObj = hass.states[zoneId];
  if (!stateObj || stateObj.attributes?.passive) return undefined;
  return zoneId === "zone.home" ? "home" : stateObj.attributes?.friendly_name;
}

function checkLocation(c, hass) {
  const stateObj = viewerPerson(hass);
  if (!stateObj) return false;
  if (c.locations?.includes(stateObj.state)) return true;
  if (c.away === true && stateObj.state === "not_home") return true;
  if (!isTarget(c.target)) return false;
  const zones = targetZones(hass, c.target);
  const inZones = stateObj.attributes?.in_zones;
  if (!Array.isArray(inZones) || inZones.length === 0) {
    return stateObj.state !== "not_home" && zones.some((z) => activeZoneState(hass, z) === stateObj.state);
  }
  if (c.match_mode === "active_zone") {
    const active = inZones.find((z) => activeZoneState(hass, z) === stateObj.state);
    return active !== undefined && zones.includes(active);
  }
  return inZones.some((z) => zones.includes(z));
}

function checkUser(c, hass) {
  return c.users && hass.user?.id ? c.users.includes(hass.user.id) : false;
}

function checkViewColumns(c, ctx) {
  if (!ctx.max_columns) return true;
  return (c.min == null || ctx.max_columns >= c.min) && (c.max == null || ctx.max_columns <= c.max);
}

function matchesMedia(query) {
  try { return !!window.matchMedia && window.matchMedia(query).matches; } catch (_) { return false; }
}

// Whether every condition of *conditions* holds, judged in the browser.
export function checkConditionsMet(conditions, hass, ctx = {}) {
  return conditions.every((c) => {
    if (!("condition" in c)) return checkState(c, hass, ctx);
    switch (c.condition) {
      case "view_columns": return checkViewColumns(c, ctx);
      case "time": return checkTime(c, hass, ctx.now);
      case "screen": return c.media_query ? matchesMedia(c.media_query) : false;
      case "user": return checkUser(c, hass);
      case "location": return checkLocation(c, hass);
      case "numeric_state": return checkNumericState(c, hass, ctx);
      case "and": return !c.conditions || checkConditionsMet(ensureArray(c.conditions), hass, ctx);
      case "not": return !c.conditions || !checkConditionsMet(ensureArray(c.conditions), hass, ctx);
      case "or": return !c.conditions || ensureArray(c.conditions).some((x) => checkConditionsMet([x], hass, ctx));
      default: return checkState(c, hass, ctx);
    }
  });
}

function checkLeaf(c, hass, ctx) {
  try { return checkConditionsMet([c], hass, ctx); } catch (_) { return false; }
}

// ── Three-valued logic (true / false / undefined = unknown) ────────────────

function andOf(values) {
  let unknown = false;
  for (const v of values) {
    if (v === false) return false;
    if (v === undefined) unknown = true;
  }
  return unknown ? undefined : true;
}

function orOf(values) {
  let unknown = false;
  for (const v of values) {
    if (v === true) return true;
    if (v === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

// Whether a server leaf judged in the browser says what core would.
function isLocallyEvaluableServerLeaf(c, states, ctx) {
  const type = "condition" in c ? c.condition : "state";
  if (type !== "state" && type !== "numeric_state") return false;
  if (!("entity_id" in c)) {
    const target = c.entity || ctx.entity_id;
    return !!target && target in states;
  }
  if (typeof c.entity_id !== "string" || !(c.entity_id in states) || c.attribute !== undefined
      || c.for !== undefined || c.match !== undefined || c.value_template !== undefined) {
    return false;
  }
  if (type === "numeric_state") {
    const bounds = [c.above, c.below].filter((b) => b !== undefined);
    return bounds.length > 0 && bounds.every((b) => typeof b === "number");
  }
  return !(ensureArray(c.state) || []).some(isEntityReference);
}

// What the browser alone can tell about a list (evaluateConditionsLocally):
// true, false, or undefined while it depends on core.
export function evaluateLocally(conditions, hass, ctx = {}) {
  const node = (c) => {
    if ("enabled" in c && typeof c.enabled !== "boolean") return undefined;
    if (isLogicalCondition(c)) {
      if (c.conditions === undefined) return true;
      const values = logicalChildren(c).filter((x) => !isDisabledCondition(x)).map(node);
      if (c.condition === "or") return orOf(values);
      const all = andOf(values);
      return c.condition === "not" ? (all === undefined ? undefined : !all) : all;
    }
    if (isClientCondition(c) || isLocallyEvaluableServerLeaf(c, hass.states, ctx)) return checkLeaf(c, hass, ctx);
    return undefined;
  };
  return andOf(conditions.filter((c) => !isDisabledCondition(c)).map(node));
}

// ── Splitting into core subscriptions (split.ts) ───────────────────────────

// The server subtrees of a list - each one subscription - and how to combine
// their answers with what the browser judges.
export function splitConditionTree(conditions) {
  const subtrees = [];
  const addSubtree = (coreCondition, original, operator) => {
    const id = String(subtrees.length);
    subtrees.push({ id, coreCondition, original, operator });
    return (_client, server) => server[id];
  };
  const siblings = (children, operator) => {
    const server = [];
    const client = [];
    for (const child of children) {
      if (isDisabledCondition(child)) continue;
      (isServerCondition(child) ? server : client).push(child);
    }
    const nodes = [];
    if (server.length === 1) {
      nodes.push(addSubtree(toCoreCondition(server[0]), server, operator));
    } else if (server.length > 1) {
      nodes.push(addSubtree({ condition: operator, conditions: server.map(toCoreCondition) }, server, operator));
    }
    for (const child of client) nodes.push(build(child));
    return nodes;
  };
  const build = (c) => {
    if ("enabled" in c && typeof c.enabled !== "boolean") return () => undefined;
    if (isLogicalCondition(c)) {
      const children = logicalChildren(c);
      if (c.condition === "or") {
        const nodes = siblings(children, "or");
        return (cl, sv) => orOf(nodes.map((n) => n(cl, sv)));
      }
      const nodes = siblings(children, "and");
      if (c.condition === "not") {
        return (cl, sv) => { const v = andOf(nodes.map((n) => n(cl, sv))); return v === undefined ? undefined : !v; };
      }
      return (cl, sv) => andOf(nodes.map((n) => n(cl, sv)));
    }
    if (isServerCondition(c)) return addSubtree(toCoreCondition(c), [c], "and");
    return (client) => client(c);
  };
  const roots = siblings(conditions, "and");
  return {
    subtrees,
    evaluate: (client, server) => andOf(roots.map((n) => n(client, server))),
  };
}

// ── Keeping a list's result live (ConditionEvaluatorController) ────────────

// The media queries and time conditions in a list, at any depth.
function collect(conditions, type) {
  const out = [];
  for (const c of conditions) {
    if ("conditions" in c && c.conditions) out.push(...collect(ensureArray(c.conditions), type));
    if (c.condition === type) out.push(c);
  }
  return out;
}

// What every watcher shares about one connection: whether it takes
// subscribe_condition, as far as is known. A refusal is not asked again until
// the connection comes back (Home Assistant may have been upgraded).
const connectionSupport = new WeakMap();
function supportOf(connection) {
  let rec = connectionSupport.get(connection);
  if (!rec) {
    rec = { support: "unknown", listeners: new Set() };
    connectionSupport.set(connection, rec);
    try {
      connection.addEventListener?.("ready", () => {
        if (rec.support === "no") rec.support = "unknown";
        for (const l of [...rec.listeners]) l();
      });
    } catch (_) { /* a connection without events: asked again on the next resubscribe */ }
  }
  return rec;
}

// One list of conditions, judged live. `visible` is what the column shows:
// true without conditions, else only a known true. `onChange` is called
// whenever a media query, a time boundary or core may have changed it; a new
// hass is judged by observe(), and the caller compares.
export class ConditionWatcher {
  constructor(onChange) {
    this._onChange = onChange;
    this._conditions = undefined;
    this._signature = undefined;
    this._subscribedSignature = undefined;
    this._hass = null;
    this._ctx = {};
    this._connection = null;
    this._split = null;
    this._server = {};
    this._errors = {};
    this._refused = new Set();
    this._subscriptions = [];
    this._listeners = [];
    this._generation = 0;
    this._result = "unknown";
    this._stopped = false;
    this._onReady = () => {
      if (this._stopped) return;
      this._resubscribe();
      if (this._onChange) this._onChange();
    };
  }

  // Take the current conditions and hass; subscribes again only when the
  // conditions say something else or Home Assistant's connection changed.
  observe(conditions, hass, ctx = {}) {
    this._stopped = false;
    this._hass = hass;
    this._ctx = ctx;
    if (conditions !== this._conditions) {
      this._conditions = conditions;
      this._signature = conditions ? JSON.stringify(conditions) : undefined;
    }
    const connection = hass?.connection || null;
    if (this._signature !== this._subscribedSignature || connection !== this._connection) {
      this._resubscribe();
    } else {
      this._recompute();
    }
  }

  get visible() {
    const conditions = this._conditions;
    if (!conditions || conditions.length === 0) return true;
    if (this._result !== "unknown") return this._result === "visible";
    if (!this._hass) return true;
    return evaluateLocally(conditions, this._hass, this._ctx) === true;
  }

  stop() {
    this._stopped = true;
    this._teardown();
    this._subscribedSignature = undefined;
    this._connection = null;
    this._result = "unknown";
  }

  _teardown() {
    this._generation += 1;
    for (const sub of this._subscriptions) {
      Promise.resolve(sub).then((unsub) => { if (typeof unsub === "function") unsub(); }).catch(() => undefined);
    }
    this._subscriptions = [];
    for (const unsub of this._listeners) {
      try { unsub(); } catch (_) { /* listener already gone */ }
    }
    this._listeners = [];
    if (this._connection) supportOf(this._connection).listeners.delete(this._onReady);
    this._split = null;
    this._server = {};
    this._errors = {};
    this._refused = new Set();
  }

  _resubscribe() {
    this._teardown();
    const conditions = this._conditions;
    const hass = this._hass;
    this._connection = hass?.connection || null;
    this._subscribedSignature = this._signature;
    if (!conditions || !hass) { this._setResult("unknown"); return; }

    const split = splitConditionTree(conditions);
    this._split = split;
    const generation = this._generation;
    const connection = this._connection;
    const canSubscribe = connection && typeof connection.subscribeMessage === "function";
    const rec = canSubscribe ? supportOf(connection) : null;
    if (rec) rec.listeners.add(this._onReady);

    for (const subtree of split.subtrees) {
      this._server[subtree.id] = undefined;
      if (!canSubscribe || rec.support === "no") { this._refused.add(subtree.id); continue; }
      const sub = connection.subscribeMessage((msg) => {
        if (generation !== this._generation) return;
        if (msg && msg.error !== undefined) {
          this._server[subtree.id] = false;
          this._errors[subtree.id] = typeof msg.error === "string" ? msg.error : msg.error?.message || "error";
        } else {
          this._server[subtree.id] = msg ? msg.result : undefined;
          this._errors[subtree.id] = undefined;
        }
        this._changed();
      }, { type: "subscribe_condition", condition: subtree.coreCondition });
      Promise.resolve(sub).then(() => { rec.support = "yes"; }, (err) => {
        if (generation !== this._generation) return;
        if (REFUSALS.has(err?.code)) {
          rec.support = "no";
          this._refused.add(subtree.id);
          this._server[subtree.id] = undefined;
        } else {
          this._server[subtree.id] = false;
          this._errors[subtree.id] = err?.message || "error";
        }
        this._changed();
      });
      this._subscriptions.push(sub);
    }

    for (const c of collect(conditions, "screen")) {
      if (!c.media_query || !window.matchMedia) continue;
      try {
        const mql = window.matchMedia(c.media_query);
        const handler = () => this._changed();
        if (mql.addEventListener) {
          mql.addEventListener("change", handler);
          this._listeners.push(() => mql.removeEventListener("change", handler));
        } else if (mql.addListener) {
          mql.addListener(handler);
          this._listeners.push(() => mql.removeListener(handler));
        }
      } catch (_) { /* an invalid media query never matches */ }
    }
    if (collect(conditions, "time").length) {
      // Judged again just past every full minute: every boundary a time
      // condition can name is on one.
      let timer = null;
      const tick = () => {
        const now = Date.now();
        timer = setTimeout(() => { this._changed(); tick(); }, 60000 - (now % 60000) + 500);
      };
      tick();
      this._listeners.push(() => clearTimeout(timer));
    }
    this._recompute();
  }

  // Something the browser cannot see coming changed (core answered, a media
  // query flipped, a minute passed): judged again and the card told.
  _changed() {
    this._recompute();
    if (this._onChange) this._onChange();
  }

  _recompute() {
    if (!this._split || !this._hass) { this._setResult("unknown"); return; }
    const hass = this._hass;
    const ctx = this._ctx;
    if (Object.values(this._errors).some((e) => !!e)) { this._setResult("hidden"); return; }
    const server = { ...this._server };
    // Refused by Home Assistant: judged in the browser where it can be.
    for (const subtree of this._split.subtrees) {
      if (!this._refused.has(subtree.id)) continue;
      const values = subtree.original.map((c) => evaluateLocally([c], hass, ctx));
      server[subtree.id] = subtree.operator === "or" ? orOf(values) : andOf(values);
    }
    const value = this._split.evaluate((c) => checkLeaf(c, hass, ctx), server);
    this._setResult(value === undefined ? "unknown" : value ? "visible" : "hidden");
  }

  _setResult(result) {
    this._result = result;
  }
}

// Exposed for the tests.
export const _internals = { isPureClientCondition, checkTime, targetZones };
