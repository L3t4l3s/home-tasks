/**
 * hidden_persons: people not offered for assignment in this card.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const STATES = Object.fromEntries(['anna', 'kevin', 'mqtt'].map((p) =>
  [`person.${p}`, { entity_id: `person.${p}`, attributes: { friendly_name: p[0].toUpperCase() + p.slice(1) } }]));

async function offered(colConfig, task) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = makeMockHass({ states: STATES });
  card._render = () => {};
  const el = card._buildAssignedPersonSection(task, 0);
  return [...el.querySelectorAll('option, .assignee-chip')].map((o) => o.value || o.textContent).filter(Boolean);
}

const T = (extra = {}) => ({ id: 'T1', title: 'x', completed: false, sub_items: [], tags: [], ...extra });

describe('hidden_persons', () => {
  test('everyone is offered by default', async () => {
    const people = await offered({}, T());
    assert.ok(people.some((p) => /mqtt/i.test(p)));
  });

  test('hidden people are not offered', async () => {
    const people = await offered({ hidden_persons: ['person.mqtt', 'person.kevin'] }, T());
    assert.ok(!people.some((p) => /mqtt|kevin/i.test(p)), JSON.stringify(people));
    assert.ok(people.some((p) => /anna/i.test(p)));
  });

  test('a hidden person already assigned to the task stays visible', async () => {
    const people = await offered({ hidden_persons: ['person.kevin'] }, T({ assigned_person: 'person.kevin' }));
    assert.ok(people.some((p) => /kevin/i.test(p)));
  });
});

describe('hidden_persons in the editor', () => {
  async function editor(colConfig) {
    const { window } = await loadCard({ force: true });
    const ed = new (window.customElements.get('home-tasks-card-editor'))();
    ed.hass = makeMockHass({ states: STATES });
    ed.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
    const events = [];
    ed._fireChanged = () => events.push(ed._config.columns[0].hidden_persons);
    const root = ed._buildVisualEditor(0);
    const label = [...root.querySelectorAll('.group-label')].find((l) => l.textContent === 'Selectable people');
    return { ed, events, field: label && label.parentElement };
  }
  const chips = (field) => [...field.querySelectorAll('.assignee-chip')]
    .map((c) => c.textContent + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''));

  test('highlighted people are the ones offered; tapping one hides it', async () => {
    const { field, events } = await editor({ hidden_persons: ['person.mqtt'] });
    assert.deepEqual(chips(field), ['Anna*', 'Kevin*', 'Mqtt']);
    field.querySelectorAll('.assignee-chip')[1].click();
    assert.deepEqual(chips(field), ['Anna*', 'Kevin', 'Mqtt']);
    assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1))), ['person.kevin', 'person.mqtt']);
  });

  test('the last selectable person cannot be switched off', async () => {
    const { field } = await editor({ hidden_persons: ['person.anna', 'person.mqtt'] });
    field.querySelectorAll('.assignee-chip')[1].click();
    assert.deepEqual(chips(field), ['Anna', 'Kevin*', 'Mqtt']);
  });

  test('someone hidden who left Home Assistant can still be switched back on', async () => {
    const { field, events } = await editor({ hidden_persons: ['person.gone'] });
    assert.deepEqual(chips(field), ['Anna*', 'Kevin*', 'Mqtt*', 'gone']);
    field.querySelectorAll('.assignee-chip')[3].click();
    assert.equal(events.at(-1), undefined);
  });

  test('the field only shows while the Persons toggle is on', async () => {
    const { field } = await editor({ show_assigned_person: false });
    assert.equal(field.style.display, 'none');
  });
});

describe('hidden_persons and new tasks', () => {
  async function add(colConfig) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
    const calls = [];
    card.hass = makeMockHass({ states: STATES, callWS: async (m) => { calls.push(m); return { id: 'N1', title: m.title }; } });
    card._render = () => {};
    card._columns[0].newTaskTitle = 'New';
    await card._addTask(0);
    await new Promise((r) => setTimeout(r, 0));
    return JSON.stringify(calls.filter((c) => /add_task|update_task/.test(c.type)));
  }

  test('a preset assignee is given to new tasks', async () => {
    assert.match(await add({ filters: { assignees: ['person.kevin'] } }), /person\.kevin/);
  });

  test('a preset assignee the card hides is not', async () => {
    assert.doesNotMatch(await add({ filters: { assignees: ['person.mqtt'] }, hidden_persons: ['person.mqtt'] }), /person\.mqtt/);
  });
});
