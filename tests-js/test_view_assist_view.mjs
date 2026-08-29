/**
 * Tests for the View Assist views in docs/view-assist/ (issue #18).
 *
 * The views are YAML files that nobody imports, so this drives the REAL card
 * with the REAL config from those files:
 *
 *   - hometasks.yaml         -> straight into HomeTasksCard
 *   - hometasks-dynamic.yaml -> through a faithful re-implementation of
 *                               button-card's `[[[ … ]]]` evaluation first
 *
 * The button-card part matters because that is where the view can silently
 * break: a template that throws, or a variable that resolves to nothing,
 * would hand the card a list id that does not exist.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadCard } from './setup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VA_DIR = path.resolve(__dirname, '../docs/view-assist');

const loadView = (name) =>
  YAML.parse(fs.readFileSync(path.join(VA_DIR, name), 'utf8'));

const STATIC_VIEW = loadView('hometasks.yaml');
const DYNAMIC_VIEW = loadView('hometasks-dynamic.yaml');

const LISTS = [
  { id: 'L1', name: 'Household', sensor_entity_id: 'sensor.household_open_tasks' },
  { id: 'L2', name: 'Shopping', sensor_entity_id: 'sensor.shopping_open_tasks' },
];

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null,
  ...over,
});

const TASKS = [
  TASK({ id: 'T1', title: 'Later', due_date: '2027-06-20', sort_order: 0 }),
  TASK({ id: 'T2', title: 'Sooner', due_date: '2027-06-11', sort_order: 1 }),
  TASK({ id: 'T3', title: 'Finished', completed: true, sort_order: 2 }),
];

function makeHass(tasksByList = { L1: TASKS, L2: [] }) {
  const calls = [];
  return {
    language: 'en',
    states: {},
    auth: {},
    calls,
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: LISTS };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') {
        const tasks = tasksByList[msg.list_id];
        // The backend rejects an unknown list id — so must the mock.
        if (!tasks) throw new Error(`unknown list ${msg.list_id}`);
        return { tasks, sections: [] };
      }
      return null;
    },
    callService: async () => null,
  };
}

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(config, hass = makeHass()) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig(JSON.parse(JSON.stringify(config)));
  card.hass = hass;
  await flush();
  return { card, hass };
}

const titles = (card) =>
  [...card.shadowRoot.querySelectorAll('.task .task-title')].map((e) => e.textContent.trim());

// ---------------------------------------------------------------------------
// button-card template evaluation (mirrors src/button-card.ts)
// ---------------------------------------------------------------------------

/** Same Function signature button-card calls a `[[[ … ]]]` body with. */
function evalTemplate(body, ctx) {
  return new Function('states', 'entity', 'user', 'hass', 'variables', 'html', 'helpers',
    `'use strict'; ${body}`
  ).call(null, ctx.hass.states, undefined, undefined, ctx.hass, ctx.variables, () => {}, {});
}

const TEMPLATE_RX = /^(\[{3,})(.*?)(\]{3,})$/s;

/** button-card's _getTemplateOrValue: recurses through objects AND arrays. */
function evalConfig(value, ctx) {
  if (['number', 'boolean', 'function'].includes(typeof value)) return value;
  if (!value) return value;
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = evalConfig(value[key], ctx);
    return value;
  }
  const match = String(value).trim().match(TEMPLATE_RX);
  if (match && match[1].length === 3 && match[3].length === 3) {
    return evalTemplate(match[2], ctx);
  }
  return value;
}

/**
 * button-card resolves `variables` lazily through a Proxy, so a variable may
 * reference another one regardless of declaration order.
 */
function makeCtx(hass, rawVariables) {
  const cache = {};
  const ctx = { hass };
  ctx.variables = new Proxy(rawVariables, {
    get: (target, prop) => {
      if (prop in cache) return cache[prop];
      if (!(prop in target)) return undefined;
      cache[prop] = evalConfig(target[prop], ctx);
      return cache[prop];
    },
  });
  return ctx;
}

/** Everything the View Assist dashboard's variable_template contributes. */
const VA_VARIABLES = { var_assistsat_entity: 'sensor.viewassist_kitchen' };

function resolveDynamicCard(satelliteState) {
  const hass = { states: {} };
  if (satelliteState) hass.states['sensor.viewassist_kitchen'] = satelliteState;
  const view = JSON.parse(JSON.stringify(DYNAMIC_VIEW));
  const ctx = makeCtx(hass, { ...VA_VARIABLES, ...view.variables });
  return evalConfig(view.custom_fields.message.card, ctx);
}

// ---------------------------------------------------------------------------

describe('View Assist view — hometasks.yaml', () => {
  test('renders the first list when no list_id is configured', async () => {
    const { card, hass } = await mount(STATIC_VIEW);

    assert.equal(card.shadowRoot.querySelector('.title').textContent.trim(), 'Household');
    const asked = hass.calls.filter((c) => c.type === 'home_tasks/get_tasks');
    assert.deepEqual(asked.map((c) => c.list_id), ['L1']);
  });

  test('applies the satellite presets from the file', async () => {
    const { card } = await mount(STATIC_VIEW);
    const col = card._config.columns[0];

    assert.equal(card._columns[0].filter, 'open', 'default_filter: open');
    assert.equal(card._columns[0].sortBy, 'due', 'default_sort: due');
    assert.equal(col.compact, true);
    assert.equal(col.confirm_complete, true, 'guards accidental taps on a wall tablet');
  });

  test('open filter and due sort actually take effect on the rendered list', async () => {
    const { card } = await mount(STATIC_VIEW);
    assert.deepEqual(titles(card), ['Sooner', 'Later'], 'done task hidden, earliest due first');
  });

  test('an extra root key (the version marker) does not disturb the card', async () => {
    const { card } = await mount(STATIC_VIEW);
    assert.equal(card._config.variables.hometasksversion, '1.0.0');
    assert.equal(card.shadowRoot.querySelectorAll('.task').length, 2);
  });
});

describe('View Assist view — hometasks-dynamic.yaml', () => {
  test('resolves list_id from the satellite attribute', () => {
    const card = resolveDynamicCard({ attributes: { home_tasks_list: 'L2' } });
    assert.equal(card.columns[0].list_id, 'L2');
    assert.equal(card.type, 'custom:home-tasks-card');
  });

  test('yields an empty list_id when the attribute is not set', () => {
    const card = resolveDynamicCard({ attributes: {} });
    assert.equal(card.columns[0].list_id, '');
  });

  test('does not throw when the satellite entity is missing entirely', () => {
    const card = resolveDynamicCard(null);
    assert.equal(card.columns[0].list_id, '');
  });

  test('an empty list_id falls back to the first list instead of showing nothing', async () => {
    const resolved = resolveDynamicCard({ attributes: {} });
    const { card, hass } = await mount(resolved);

    assert.equal(card._config.columns[0].list_id, 'L1');
    assert.equal(card.shadowRoot.querySelector('.title').textContent.trim(), 'Household');
    assert.ok(hass.calls.some((c) => c.type === 'home_tasks/get_tasks' && c.list_id === 'L1'));
  });

  test('a stale list_id renders an empty card instead of breaking the view', async () => {
    const resolved = resolveDynamicCard({ attributes: { home_tasks_list: 'DELETED' } });
    const { card } = await mount(resolved);

    assert.equal(card.shadowRoot.querySelectorAll('.task').length, 0);
    assert.ok(card.shadowRoot.querySelector('.empty-state'), 'shows the empty state, no crash');
  });

  test('the satellite list is the one the card asks the backend for', async () => {
    const resolved = resolveDynamicCard({ attributes: { home_tasks_list: 'L2' } });
    const { hass } = await mount(resolved);

    const asked = hass.calls.filter((c) => c.type === 'home_tasks/get_tasks');
    assert.deepEqual(asked.map((c) => c.list_id), ['L2']);
  });

  test('card_mod styling is passed through to the card', async () => {
    const resolved = resolveDynamicCard({ attributes: { home_tasks_list: 'L1' } });
    const { card } = await mount(resolved);
    // The card only honours card_mod when it survives setConfig.
    assert.match(card._config.card_mod.style['.'], /max-height/);
  });
});
