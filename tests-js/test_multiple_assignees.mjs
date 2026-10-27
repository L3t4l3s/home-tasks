/**
 * Several assignees per task (issue #75): the person filter matches any
 * assignee, rows show a badge per person, and the details chips edit the list.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const STATES = {
  'person.anna': { entity_id: 'person.anna', attributes: { friendly_name: 'Anna' } },
  'person.kevin': { entity_id: 'person.kevin', attributes: { friendly_name: 'Kevin' } },
};
const T = (id, extra = {}) => ({ id, title: id, sort_order: 0, completed: false, sub_items: [], tags: [], ...extra });

async function makeCard(tasks) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  const calls = [];
  card.hass = makeMockHass({ states: STATES, callWS: async (m) => { calls.push(m); return null; } });
  card._render = () => {};
  card._columns[0].tasks = tasks;
  return { card, calls };
}

const ids = (card) => JSON.parse(JSON.stringify(card._filteredTasks(0).map((t) => t.id)));

describe('person filter', () => {
  test('a shared task shows under each of its assignees', async () => {
    const { card } = await makeCard([
      T('shared', { assigned_person: 'person.anna', assigned_persons: ['person.anna', 'person.kevin'] }),
      T('anna', { assigned_person: 'person.anna' }),
      T('nobody'),
    ]);
    card._columns[0].personFilters = new Set(['person.kevin']);
    assert.deepEqual(ids(card), ['shared']);
    card._columns[0].personFilters = new Set(['person.anna']);
    assert.deepEqual(ids(card).sort(), ['anna', 'shared']);
  });

  test('tasks without assigned_persons still match on assigned_person', async () => {
    const { card } = await makeCard([T('legacy', { assigned_person: 'person.kevin' })]);
    card._columns[0].personFilters = new Set(['person.kevin']);
    assert.deepEqual(ids(card), ['legacy']);
  });
});

describe('details chips', () => {
  test('one chip per person, assignees active; toggling sends the new list', async () => {
    const { card, calls } = await makeCard([]);
    const task = T('t', { assigned_person: 'person.anna', assigned_persons: ['person.anna'] });
    const el = card._buildAssignedPersonSection(task, 0);
    const chips = [...el.querySelectorAll('.assignee-chip')];
    assert.deepEqual(chips.map((c) => [c.textContent, c.classList.contains('active')]),
      [['Anna', true], ['Kevin', false]]);

    chips[1].click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(JSON.parse(JSON.stringify(task.assigned_persons)), ['person.anna', 'person.kevin']);
    assert.equal(task.assigned_person, 'person.anna');
    const call = calls.find((c) => c.type === 'home_tasks/update_task');
    assert.deepEqual(JSON.parse(JSON.stringify(call.assigned_persons)), ['person.anna', 'person.kevin']);
  });

  test('switching the primary off promotes the next person', async () => {
    const { card } = await makeCard([]);
    const task = T('t', { assigned_person: 'person.anna', assigned_persons: ['person.anna', 'person.kevin'] });
    const el = card._buildAssignedPersonSection(task, 0);
    el.querySelectorAll('.assignee-chip')[0].click();
    assert.equal(task.assigned_person, 'person.kevin');
  });
});

describe('row badges', () => {
  const badges = (card, task) => {
    const cs = card._columns[0];
    const found = card._buildTaskMetaBadges(task, card._config.columns[0], cs, 0)
      .filter((el) => el.classList.contains('assigned-badge'))
      .map((el) => [el.getAttribute('data-eid'), el.textContent]);
    return JSON.parse(JSON.stringify(found));
  };

  test('a shared task shows a badge per assignee, primary first', async () => {
    const { card } = await makeCard([]);
    const task = T('t', { assigned_person: 'person.kevin', assigned_persons: ['person.kevin', 'person.anna'] });
    assert.deepEqual(badges(card, task), [['person.kevin', '👤 Kevin'], ['person.anna', '👤 Anna']]);
  });

  test('a provider collaborator without a person still gets its badge', async () => {
    const { card } = await makeCard([]);
    const task = T('t', { assigned_name: 'Sam' });
    const found = badges(card, task);
    assert.equal(found.length, 1);
    assert.match(found[0][1], /Sam/);
  });
});
