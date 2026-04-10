/**
 * Render and integration tests for HomeTasksCard.
 *
 * Mocks `hass.callWS` to return canned responses, then drives the card
 * through its full lifecycle (setConfig → set hass → _loadLists → render).
 * Asserts on the resulting shadow DOM and on the WS commands the card
 * sent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';


/**
 * Build a hass mock that records every callWS invocation and returns
 * canned responses based on the command type.
 *
 * Usage:
 *   const hass = makeRecordingHass({
 *     "home_tasks/get_lists": { lists: [{ id: "L1", name: "Test" }] },
 *     "home_tasks/get_tasks": { tasks: [{ id: "T1", title: "Hi" }] },
 *   });
 *   ...
 *   hass.calls // → [{ type: "home_tasks/get_lists", ... }, ...]
 */
function makeRecordingHass(responses = {}) {
  const calls = [];
  const services = [];
  return {
    language: 'en',
    states: {},
    auth: {},
    calls,
    services,
    callWS: async (msg) => {
      calls.push(msg);
      const fn = responses[msg.type];
      if (typeof fn === 'function') return fn(msg);
      if (fn !== undefined) return fn;
      // Sensible defaults
      if (msg.type === 'home_tasks/get_lists') return { lists: [] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [] };
      if (msg.type === 'home_tasks/get_external_tasks') return { tasks: [] };
      return null;
    },
    callService: async (...args) => { services.push(args); },
  };
}

/**
 * Wait until all pending microtasks/macrotasks settle. The card's
 * _loadLists is async and not awaited from `set hass`, so we need to
 * yield a few times before the first render is complete.
 */
async function flush(card) {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}


// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------


describe('initial render with native list', () => {
  test('calls home_tasks/get_lists and home_tasks/get_external_lists on first hass set', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': { tasks: [] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const types = hass.calls.map(c => c.type);
    assert.ok(types.includes('home_tasks/get_lists'));
    assert.ok(types.includes('home_tasks/get_external_lists'));
    assert.ok(types.includes('home_tasks/get_tasks'));
  });

  test('renders one .task element per task returned', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', title: 'First', sort_order: 0, sub_items: [] },
          { id: 'T2', title: 'Second', sort_order: 1, sub_items: [] },
          { id: 'T3', title: 'Third', sort_order: 2, sub_items: [] },
        ],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const taskEls = card.shadowRoot.querySelectorAll('.task[data-task-id]');
    assert.equal(taskEls.length, 3);
    const ids = [...taskEls].map(el => el.dataset.taskId);
    assert.deepEqual(ids, ['T1', 'T2', 'T3']);
  });

  test('renders empty state when no tasks', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': { tasks: [] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const taskEls = card.shadowRoot.querySelectorAll('.task[data-task-id]');
    assert.equal(taskEls.length, 0);
  });
});


// ---------------------------------------------------------------------------
// Optimistic local update — regression for the bugs we fixed earlier
// ---------------------------------------------------------------------------


describe('optimistic updates', () => {
  test('_deleteSubTask removes the sub locally before WS resolves', async () => {
    // REGRESSION for the bug where sub-task delete was not optimistic.
    const { HomeTasksCard } = await loadCard({ force: true });
    let resolveDelete;
    const deletePromise = new Promise(r => { resolveDelete = r; });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{
          id: 'T1', title: 'P', sort_order: 0,
          sub_items: [
            { id: 'S1', title: 'sub one', completed: false },
            { id: 'S2', title: 'sub two', completed: false },
          ],
        }],
      },
      'home_tasks/delete_sub_task': () => deletePromise,
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const task = card._columns[0].tasks[0];
    assert.equal(task.sub_items.length, 2);

    const promise = card._deleteSubTask('T1', 'S1', 0);
    // Local sub_items must already be filtered before WS resolves
    assert.equal(task.sub_items.length, 1,
      'sub_items should drop the deleted sub before WS resolves');
    assert.equal(task.sub_items[0].id, 'S2');

    resolveDelete(null);
    await promise;
  });

  test('_updateTaskNotes mutates local task before WS resolves', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    let resolveUpdate;
    const updatePromise = new Promise(r => { resolveUpdate = r; });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'N', notes: 'old', sort_order: 0, sub_items: [] }],
      },
      'home_tasks/update_task': () => updatePromise,
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const task = card._columns[0].tasks[0];
    const promise = card._updateTaskNotes('T1', 'new notes', 0);
    assert.equal(task.notes, 'new notes');
    resolveUpdate(null);
    await promise;
  });

  test('_updateTaskTitle mutates local task before WS resolves', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    let resolveUpdate;
    const updatePromise = new Promise(r => { resolveUpdate = r; });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'Old', sort_order: 0, sub_items: [] }],
      },
      'home_tasks/update_task': () => updatePromise,
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const task = card._columns[0].tasks[0];
    const promise = card._updateTaskTitle('T1', 'New title', 0);
    assert.equal(task.title, 'New title');
    resolveUpdate(null);
    await promise;
  });
});


// ---------------------------------------------------------------------------
// Render guard for background updates
// ---------------------------------------------------------------------------


describe('_render guard for background updates', () => {
  test('background update is blocked when editing a task', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'X', sort_order: 0, sub_items: [] }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    // Simulate editing
    card._editingTaskId = 'T1';
    card._isBackgroundUpdate = true;
    card._render();
    // _pendingRender should be set, no actual render took place
    assert.equal(card._pendingRender, true);
  });

  test('user-initiated render goes through even while editing', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'X', sort_order: 0, sub_items: [] }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    card._editingTaskId = 'T1';
    // _isBackgroundUpdate stays false → render should proceed
    card._render();
    assert.equal(card._pendingRender, false);
  });

  test('background update is blocked while dragging', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    card._draggedTaskId = 'T1';
    card._isBackgroundUpdate = true;
    card._render();
    assert.equal(card._pendingRender, true);
  });
});


// ---------------------------------------------------------------------------
// Sort comparator integration via _filteredTasks
// ---------------------------------------------------------------------------


describe('_filteredTasks integration', () => {
  test('returns tasks in manual sort_order by default', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', title: 'Third', sort_order: 2, sub_items: [] },
          { id: 'T2', title: 'First', sort_order: 0, sub_items: [] },
          { id: 'T3', title: 'Second', sort_order: 1, sub_items: [] },
        ],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const filtered = card._filteredTasks(0);
    assert.deepEqual(filtered.map(t => t.id), ['T2', 'T3', 'T1']);
  });

  test('filters by completion status (filter=open)', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', title: 'Open',   completed: false, sort_order: 0, sub_items: [] },
          { id: 'T2', title: 'Done',   completed: true,  sort_order: 1, sub_items: [] },
          { id: 'T3', title: 'Open2',  completed: false, sort_order: 2, sub_items: [] },
        ],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    card._columns[0].filter = 'open';
    const filtered = card._filteredTasks(0);
    assert.deepEqual(filtered.map(t => t.id), ['T1', 'T3']);
  });

  test('filters by completion status (filter=done)', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', completed: false, sort_order: 0, sub_items: [] },
          { id: 'T2', completed: true,  sort_order: 1, sub_items: [] },
        ],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    card._columns[0].filter = 'done';
    const filtered = card._filteredTasks(0);
    assert.deepEqual(filtered.map(t => t.id), ['T2']);
  });
});


// ---------------------------------------------------------------------------
// _isExternalCol / _colListId / _colEntityId helpers via integration
// ---------------------------------------------------------------------------


describe('column type helpers', () => {
  test('native column returns false for _isExternalCol', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    assert.equal(card._isExternalCol(0), false);
    assert.equal(card._colListId(0), 'L1');
    assert.equal(card._colEntityId(0), undefined);
  });

  test('external column returns true for _isExternalCol', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ entity_id: 'todo.test' }] });
    assert.equal(card._isExternalCol(0), true);
    assert.equal(card._colEntityId(0), 'todo.test');
  });
});
