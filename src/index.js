// The entry of the card bundle: defines the card elements and puts the
// card types into Home Assistant's card picker. scripts/build-card.mjs
// bundles everything from here into custom_components/home_tasks/home-tasks-card.js.

import { _htText } from "./core/i18n.js";
import { HomeTasksCard } from "./views/list-card.js";
import { HomeTasksDayPlanCard } from "./views/day-plan-card.js";
import { HomeTasksCardEditor } from "./editors/list-editor.js";
import { HomeTasksDayPlanCardEditor } from "./editors/plan-editor.js";

// Register elements — wait for HA's scoped custom element registry polyfill
// before calling customElements.define. The polyfill replaces the native
// define() with a JS wrapper; we detect this to avoid registering too early
// (which puts the element in the native registry where the polyfill can't
// find it, causing "Custom element not found" in Firefox/Safari/iPad).
const _htRegister = () => {
  for (const [name, element] of [
    ["home-tasks-card", HomeTasksCard],
    ["home-tasks-card-editor", HomeTasksCardEditor],
    ["home-tasks-day-plan-card", HomeTasksDayPlanCard],
    ["home-tasks-day-plan-card-editor", HomeTasksDayPlanCardEditor],
  ]) {
    try { customElements.define(name, element); } catch(_) {}
  }
};

const _htIsPolyfillReady = () =>
  !customElements.define.toString().includes("[native code]");

// Flat poll: 50ms ticks for 10s, then a native fallback registration plus
// 1s ticks for up to ~5 min. If the polyfill installs after the native
// fallback, the elements are registered again through the wrapped define and
// the result is verified: when the polyfill build refuses names already in
// the native registry (the scoped-registry polyfill does), a one-time
// reload — guarded per tab so it can never loop — is the only way to get the
// card into the scoped registry (#37).
// Reload only when it cannot destroy user work: once per tab (sessionStorage
// guard), and deferred while the user is typing anywhere on the page
// (dashboard edit mode, another card's dialog) — retried every 30s while busy.
const _htSafeReload = (attemptsLeft) => {
  try {
    if (sessionStorage.getItem("ht-poly-reload")) return;
  } catch (_) { return; /* sandboxed storage — stay registered natively */ }
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  const busy = !!active && (active.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
  if (busy) {
    if (attemptsLeft > 0) setTimeout(() => _htSafeReload(attemptsLeft - 1), 30000);
    return;
  }
  try { sessionStorage.setItem("ht-poly-reload", "1"); } catch (_) { return; }
  location.reload();
};

let _htTicks = 0;
const _htTick = () => {
  if (_htIsPolyfillReady()) {
    _htRegister();
    // >= 200: _htTicks sticks at exactly 200 after the native-fallback tick,
    // and a polyfill arriving in that very window is the most likely "slow
    // polyfill" timing — it must still get the verified heal.
    if (_htTicks >= 200 && !customElements.get("home-tasks-card")) {
      _htSafeReload(10);
    } else {
      try { sessionStorage.removeItem("ht-poly-reload"); } catch (_) { /* ignore */ }
    }
    return;
  }
  _htTicks++;
  if (_htTicks === 200) _htRegister(); // 10s: polyfill-free fallback (native registry)
  if (_htTicks >= 500) return;         // stop watching after ~5 min
  setTimeout(_htTick, _htTicks < 200 ? 50 : 1000);
};
_htTick();

// The names in the card picker. They are read once, when this file loads -
// before there is a hass object - so the language is the one Home Assistant
// keeps for this browser, else the browser's own, else English.
const _htPickerText = (key) => {
  let lang = "";
  try { lang = JSON.parse(localStorage.getItem("selectedLanguage") || "null") || ""; } catch (_) { /* blocked storage */ }
  if (!lang && typeof navigator !== "undefined") lang = navigator.language || "";
  return _htText(lang, key);
};

// Suggestions in Home Assistant's "add to dashboard" dialog, which starts
// from an entity: pick a list's todo entity, or a plan's sensor, and the
// matching card is offered. Home Assistant asks synchronously and keeps the
// answer per entity, so the answer comes from the states alone: a list's
// todo entity names its list (list_id), the sensor of a linked provider list
// names the provider's todo entity (source_entity_id), a plan's sensor its
// plan (plan_id).
const _htOwnStates = (hass) => Object.values(hass.entities || {})
  .filter((e) => e && e.platform === "home_tasks")
  .map((e) => hass.states[e.entity_id])
  .filter(Boolean);

const _htSuggestList = (hass, entityId) => {
  if (!entityId || !entityId.startsWith("todo.")) return null;
  const type = "custom:home-tasks-card";
  const own = hass.entities?.[entityId]?.platform === "home_tasks";
  const listId = own ? hass.states[entityId]?.attributes?.list_id : null;
  if (listId) return { config: { type, columns: [{ list_id: listId }] } };
  // A provider's list: only when it is linked to Home Tasks.
  const linked = !own && _htOwnStates(hass).some((s) => s.attributes?.source_entity_id === entityId);
  return linked ? { config: { type, columns: [{ entity_id: entityId }] } } : null;
};

const _htSuggestPlan = (hass, entityId) => {
  if (hass.entities?.[entityId]?.platform !== "home_tasks") return null;
  const planId = hass.states[entityId]?.attributes?.plan_id;
  return planId ? { config: { type: "custom:home-tasks-day-plan-card", plan: planId, days: 3 } } : null;
};

window.customCards = window.customCards || [];
window.customCards.push({
  type: "home-tasks-card",
  name: _htPickerText("picker_list_name"),
  description: _htPickerText("picker_list_desc"),
  preview: true,
  getEntitySuggestion: _htSuggestList,
}, {
  type: "home-tasks-day-plan-card",
  name: _htPickerText("picker_plan_name"),
  description: _htPickerText("picker_plan_desc"),
  preview: true,
  getEntitySuggestion: _htSuggestPlan,
});
