/**
 * overdue_first: open overdue tasks lead whatever the sort (issue #57).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

// Noon UTC keeps "today" = 2027-06-15 in every timezone.
const FROZEN_NOW = '2027-06-15T12:00:00Z';

async function makeCard(colConfig, tasks) {
  const { HomeTasksCard } = await loadCard({ force: true, frozenNow: FROZEN_NOW });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = makeMockHass();
  card._columns[0].tasks = tasks;
  card._columns[0].sortBy = colConfig.default_sort || 'manual';
  return card;
}

const T = (id, extra = {}) => ({ id, title: id, sort_order: 0, completed: false, sub_items: [], tags: [], ...extra });

const TASKS = [
  T('manual-first', { sort_order: 0, priority: 1 }),
  T('overdue-recent', { sort_order: 1, due_date: '2027-06-14', priority: 1 }),
  T('high-prio', { sort_order: 2, priority: 3, due_date: '2027-06-20' }),
  T('overdue-old', { sort_order: 3, due_date: '2027-06-01' }),
  T('done-overdue', { sort_order: 4, due_date: '2027-05-01', completed: true }),
  T('due-today', { sort_order: 5, due_date: '2027-06-15' }),
];

const order = (card) => JSON.parse(JSON.stringify(card._filteredTasks(0).map(t => t.id)));

describe('overdue_first', () => {
  test('off: the chosen sort alone decides (manual)', async () => {
    const card = await makeCard({}, TASKS);
    assert.deepEqual(order(card), ['manual-first', 'overdue-recent', 'high-prio', 'overdue-old', 'due-today', 'done-overdue']);
  });

  test('on, manual sort: overdue lead, oldest first, the rest keep manual order', async () => {
    const card = await makeCard({ overdue_first: true }, TASKS);
    assert.deepEqual(order(card), ['overdue-old', 'overdue-recent', 'manual-first', 'high-prio', 'due-today', 'done-overdue']);
  });

  test('on, priority sort: overdue lead, then by priority', async () => {
    const card = await makeCard({ overdue_first: true, default_sort: 'priority' }, TASKS);
    assert.deepEqual(order(card).slice(0, 3), ['overdue-old', 'overdue-recent', 'high-prio']);
  });

  test('on, title sort: the same pinning', async () => {
    const card = await makeCard({ overdue_first: true, default_sort: 'title' }, TASKS);
    assert.deepEqual(order(card).slice(0, 2), ['overdue-old', 'overdue-recent']);
  });

  test('due today is not overdue, and completed overdue tasks stay at the bottom', async () => {
    const card = await makeCard({ overdue_first: true }, TASKS);
    const ids = order(card);
    assert.equal(ids.at(-1), 'done-overdue');
    assert.ok(ids.indexOf('due-today') > ids.indexOf('overdue-recent'));
  });

  test('same overdue day: the due time breaks the tie', async () => {
    const card = await makeCard({ overdue_first: true }, [
      T('late', { sort_order: 0, due_date: '2027-06-10', due_time: '18:00' }),
      T('early', { sort_order: 1, due_date: '2027-06-10', due_time: '08:00' }),
    ]);
    assert.deepEqual(order(card), ['early', 'late']);
  });
});

describe('overdue_first and dragging (manual sort)', () => {
  // Saved order A,B,C,D,E with D overdue: drawn as D,A,B,C,E.
  const tasks = () => ['A', 'B', 'C', 'D', 'E'].map((id, i) =>
    T(id, { sort_order: i, ...(id === 'D' ? { due_date: '2027-06-01' } : {}) }));
  const saved = (card, drawnOrder, draggedId) =>
    JSON.parse(JSON.stringify(card._mergeHiddenTasks(0, drawnOrder, draggedId)));

  test('dragging another task leaves the overdue one at its own manual place', async () => {
    const card = await makeCard({ overdue_first: true }, tasks());
    // E dragged above B in the drawn list: D,A,E,B,C
    assert.deepEqual(saved(card, ['D', 'A', 'E', 'B', 'C'], 'E'), ['A', 'E', 'B', 'C', 'D']);
  });

  test('the overdue task itself keeps the place it was dropped at', async () => {
    const card = await makeCard({ overdue_first: true }, tasks());
    // D dragged between A and B: A,D,B,C,E
    assert.deepEqual(saved(card, ['A', 'D', 'B', 'C', 'E'], 'D'), ['A', 'D', 'B', 'C', 'E']);
  });

  test('without the option the drawn order is saved as is', async () => {
    const card = await makeCard({}, tasks());
    assert.deepEqual(saved(card, ['A', 'E', 'B', 'C', 'D'], 'E'), ['A', 'E', 'B', 'C', 'D']);
  });
});
