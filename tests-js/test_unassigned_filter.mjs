/**
 * Issue #93: "unassigned" in a column's preset assignee filter shows the
 * tasks nobody has taken, alone or next to named people.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const STATES = Object.fromEntries(['anna', 'kevin'].map((p) =>
  [`person.${p}`, { entity_id: `person.${p}`, attributes: { friendly_name: p[0].toUpperCase() + p.slice(1) } }]));

const T = (id, extra = {}) => ({ id, title: id, completed: false, sub_items: [], tags: [], ...extra });
const TASKS = [
  T('anna', { assigned_person: 'person.anna' }),
  T('shared', { assigned_persons: ['person.anna', 'person.kevin'] }),
  T('nobody', { assigned_person: null }),
  T('nobody-list', { assigned_persons: [] }),
];

async function shown(filters) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', filters }] });
  card.hass = makeMockHass({ states: STATES });
  card._render = () => {};
  card._columns[0].tasks = TASKS;
  return card._preFilteredTasks(0).map((t) => t.id).sort();
}

describe('unassigned preset filter', () => {
  test('only the tasks nobody is assigned to', async () => {
    assert.deepEqual(await shown({ assignees: ['unassigned'] }), ['nobody', 'nobody-list']);
  });

  test('next to a person: theirs plus the unassigned ones', async () => {
    assert.deepEqual(await shown({ assignees: ['person.kevin', 'unassigned'] }), ['nobody', 'nobody-list', 'shared']);
  });

  test('a person alone still leaves unassigned tasks out', async () => {
    assert.deepEqual(await shown({ assignees: ['person.anna'] }), ['anna', 'shared']);
  });
});

describe('unassigned preset and new tasks', () => {
  async function add(filters) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', filters }] });
    const calls = [];
    card.hass = makeMockHass({ states: STATES, callWS: async (m) => { calls.push(m); return { id: 'N1', title: m.title }; } });
    card._render = () => {};
    assert.equal(card._autoAssignPerson(0), null);
    card._columns[0].newTaskTitle = 'New';
    await card._addTask(0);
    await new Promise((r) => setTimeout(r, 0));
    return JSON.stringify(calls.filter((c) => /add_task|update_task/.test(c.type)));
  }

  test('a new task in an unassigned-only column stays unassigned', async () => {
    assert.doesNotMatch(await add({ assignees: ['unassigned'] }), /unassigned/);
  });
});

// The list's default assignees are filled in on creation whatever the card
// sends; in a column of unassigned tasks the new one is cleared right after,
// or it would leave the column it was just added in.
describe('unassigned preset and list default assignees', () => {
  const DEFAULTS = { assignees: ['person.kevin'] };

  async function card(col, ws) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const c = new HomeTasksCard();
    c.setConfig({ columns: [col] });
    const calls = [];
    c.hass = makeMockHass({ states: STATES, callWS: async (m) => { calls.push(m); return ws(m); } });
    c._render = () => {};
    await new Promise((r) => setTimeout(r, 0));
    calls.length = 0;
    return { c, calls };
  }
  const clears = (calls) => calls.filter((m) => /update_(external_)?task$/.test(m.type)
    && Array.isArray(m.assigned_persons) && m.assigned_persons.length === 0 && m.assigned_person === null);

  test('native list: the added task is unassigned again', async () => {
    const { c, calls } = await card({ list_id: 'L1', filters: { assignees: ['unassigned'] } }, (m) =>
      m.type === 'home_tasks/add_task' ? { id: 'N1', title: m.title, assigned_person: 'person.kevin', assigned_persons: ['person.kevin'] } : null);
    c._columns[0].newTaskTitle = 'New';
    await c._addTask(0);
    assert.deepEqual(clears(calls).map((m) => m.task_id), ['N1']);
  });

  test('native list: nothing to clear when the list has no default assignee', async () => {
    const { c, calls } = await card({ list_id: 'L1', filters: { assignees: ['unassigned'] } }, (m) =>
      m.type === 'home_tasks/add_task' ? { id: 'N1', title: m.title, assigned_person: null, assigned_persons: [] } : null);
    c._columns[0].newTaskTitle = 'New';
    await c._addTask(0);
    assert.equal(clears(calls).length, 0);
  });

  test("a person picked in the column's person filter still gets the new task", async () => {
    const { c, calls } = await card({ list_id: 'L1', filters: { assignees: ['unassigned'] } }, (m) =>
      m.type === 'home_tasks/add_task' ? { id: 'N1', title: m.title, assigned_person: 'person.anna', assigned_persons: ['person.anna'] } : null);
    c._columns[0].personFilters.add('person.anna');
    c._columns[0].newTaskTitle = 'New';
    await c._addTask(0);
    assert.equal(calls.find((m) => m.type === 'home_tasks/add_task').assigned_person, 'person.anna');
    assert.equal(clears(calls).length, 0);
  });

  test('linked list: the placeholder shows nobody and the new task is cleared', async () => {
    const { c, calls } = await card({ entity_id: 'todo.shop', filters: { assignees: ['unassigned'] } }, (m) =>
      m.type === 'home_tasks/create_external_task' ? { uid: 'U1' } : null);
    c._sourceDefaults['todo.shop'] = DEFAULTS;
    c._reloadExternal = () => {};
    c._columns[0].newTaskTitle = 'New';
    const adding = c._addTask(0);
    const placeholder = c._columns[0].tasks.find((t) => String(t.id).startsWith('_pending_'));
    assert.equal(placeholder.assigned_persons.length, 0);
    assert.equal(placeholder.assigned_person, null);
    await adding;
    assert.deepEqual(clears(calls).map((m) => m.task_uid), ['U1']);
  });

  test('the add-with-details draft starts with nobody', async () => {
    const { c } = await card({ list_id: 'L1', show_add_details: true, filters: { assignees: ['unassigned'] } }, (m) =>
      m.type === 'home_tasks/get_defaults' ? { defaults: DEFAULTS } : null);
    await c._openDraft(0);
    assert.equal(c._columns[0].draft.assigned_persons.length, 0);
  });
});

describe('unassigned preset in the editor', () => {
  async function editor(filters) {
    const { window } = await loadCard({ force: true });
    const ed = new (window.customElements.get('home-tasks-card-editor'))();
    ed.hass = makeMockHass({ states: STATES });
    ed.setConfig({ columns: [{ list_id: 'L1', filters }] });
    const events = [];
    ed._fireChanged = () => events.push(ed._config.columns[0].filters?.assignees);
    const root = ed._buildVisualEditor(0);
    const label = [...root.querySelectorAll('.group-label')].find((l) => l.textContent === 'Limit to people');
    return { events, field: label.parentElement };
  }
  const chips = (field) => [...field.querySelectorAll('.assignee-chip')]
    .map((c) => c.textContent + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''));

  test('"Unassigned" is offered last and can be switched on', async () => {
    const { field, events } = await editor(undefined);
    assert.deepEqual(chips(field), ['Anna', 'Kevin', 'Unassigned']);
    field.querySelectorAll('.assignee-chip')[2].click();
    assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1))), ['unassigned']);
  });

  test('a saved "unassigned" shows as the one chip, not as a person', async () => {
    const { field } = await editor({ assignees: ['unassigned'] });
    assert.deepEqual(chips(field), ['Anna', 'Kevin', 'Unassigned*']);
  });
});
