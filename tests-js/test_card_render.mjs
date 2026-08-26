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
    card._bgUpdates = 1;
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
    // _bgUpdates stays 0 → render should proceed
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
    card._bgUpdates = 1;
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


// ---------------------------------------------------------------------------
// REGRESSION: text input inside an expanded task must allow text selection
//
// The whole .task element is draggable=true. Without protection, mousedown
// on a textarea/input inside the expanded task-details container is
// intercepted by the browser's drag-detection system: the cursor cannot
// be positioned, text cannot be selected, and on touch the long-press
// timer fires after 150ms and starts a drag instead of focusing the input.
// ---------------------------------------------------------------------------


describe('REGRESSION: input fields inside expanded tasks accept text selection', () => {
  async function expandedCard() {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{
          id: 'T1', title: 'Has notes', notes: 'existing notes',
          sort_order: 0, sub_items: [], tags: [], reminders: [],
        }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    // Expand the task so its details (including the notes textarea) render
    card._expandedTasks.add('T1');
    card._render();
    return card;
  }

  test('mousedown on the notes textarea is intercepted before reaching the draggable parent', async () => {
    const card = await expandedCard();
    const notesEl = card.shadowRoot.querySelector('.task-details textarea');
    assert.ok(notesEl, 'notes textarea must exist in expanded task');

    // Listen on the parent .task to verify the mousedown does NOT bubble there
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    let bubbled = false;
    taskEl.addEventListener('mousedown', () => { bubbled = true; });

    notesEl.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.MouseEvent(
      'mousedown', { bubbles: true, cancelable: true }
    ));
    assert.equal(bubbled, false,
      'mousedown on the notes textarea must be stopped before reaching the draggable .task');
  });

  test('mousedown on the tag input is intercepted', async () => {
    const card = await expandedCard();
    const inputs = card.shadowRoot.querySelectorAll('.task-details input[type="text"]');
    // Find the tag input by its placeholder
    const tagInput = [...inputs].find(i => i.placeholder && i.placeholder.length);
    if (!tagInput) return;  // tag input only renders when tags section visible

    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    let bubbled = false;
    taskEl.addEventListener('mousedown', () => { bubbled = true; });

    tagInput.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.MouseEvent(
      'mousedown', { bubbles: true, cancelable: true }
    ));
    assert.equal(bubbled, false);
  });

  test('mousedown on a non-input element inside details DOES bubble', async () => {
    // Sanity check: only inputs are protected, the rest of the details
    // area still allows the parent task's drag detection.
    const card = await expandedCard();
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    const label = card.shadowRoot.querySelector('.task-details .detail-label');
    assert.ok(label);

    let bubbled = false;
    taskEl.addEventListener('mousedown', () => { bubbled = true; });

    label.dispatchEvent(new card.shadowRoot.ownerDocument.defaultView.MouseEvent(
      'mousedown', { bubbles: true, cancelable: true }
    ));
    assert.equal(bubbled, true,
      'mousedown on non-input details element must reach the parent .task');
  });

  test('touchstart on a textarea inside details does NOT arm the drag timer', async () => {
    const card = await expandedCard();
    const notesEl = card.shadowRoot.querySelector('.task-details textarea');
    assert.ok(notesEl);

    // Verify no timer is set after a touchstart on the input
    card._touchStartTimer = null;
    const win = card.shadowRoot.ownerDocument.defaultView;
    const TouchEvent = win.TouchEvent || win.Event;
    // jsdom may not implement TouchEvent — fall back to a synthetic Event
    // with the same shape that the handler reads.
    const evt = new win.Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'touches', {
      value: [{ clientX: 0, clientY: 0 }],
      configurable: true,
    });
    Object.defineProperty(evt, 'target', { value: notesEl, configurable: true });
    notesEl.dispatchEvent(evt);

    assert.equal(card._touchStartTimer, null,
      'long-press drag timer must NOT be armed when tapping a text input');
  });

  test('touchstart on the task body DOES arm the drag timer', async () => {
    // Sanity check: tapping outside an input still triggers the long press
    const card = await expandedCard();
    const win = card.shadowRoot.ownerDocument.defaultView;
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    const titleSpan = taskEl.querySelector('.task-title') || taskEl;

    card._touchStartTimer = null;
    const evt = new win.Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'touches', {
      value: [{ clientX: 0, clientY: 0 }],
      configurable: true,
    });
    Object.defineProperty(evt, 'target', { value: titleSpan, configurable: true });
    taskEl.dispatchEvent(evt);

    assert.notEqual(card._touchStartTimer, null,
      'long-press drag timer should arm when tapping the task body');
    // Clean up the timer so it doesn't fire after the test
    clearTimeout(card._touchStartTimer);
  });

  test('dragstart on a textarea is preventDefault\'d so the drag never begins', async () => {
    const card = await expandedCard();
    const win = card.shadowRoot.ownerDocument.defaultView;
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    const notesEl = card.shadowRoot.querySelector('.task-details textarea');

    // Synthesize a dragstart event with target = textarea
    const evt = new win.Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'target', { value: notesEl, configurable: true });
    // dataTransfer is what the existing handler reads — provide a stub
    Object.defineProperty(evt, 'dataTransfer', {
      value: { effectAllowed: '', setData: () => {} },
      configurable: true,
    });

    taskEl.dispatchEvent(evt);

    assert.equal(evt.defaultPrevented, true,
      'dragstart originating from a textarea must be preventDefault\'d');
    assert.equal(card._draggedTaskId, null,
      'no drag state should have been recorded');
  });

  test('dragstart on the task body is NOT preventDefault\'d (sanity)', async () => {
    const card = await expandedCard();
    const win = card.shadowRoot.ownerDocument.defaultView;
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    const titleSpan = taskEl.querySelector('.task-title') || taskEl;

    const evt = new win.Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'target', { value: titleSpan, configurable: true });
    Object.defineProperty(evt, 'dataTransfer', {
      value: { effectAllowed: '', setData: () => {} },
      configurable: true,
    });

    taskEl.dispatchEvent(evt);

    assert.equal(evt.defaultPrevented, false);
    assert.equal(card._draggedTaskId, 'T1');
    // Clean up so subsequent tests don't see leftover drag state
    card._draggedTaskId = null;
    card._draggedColIdx = null;
  });
});


// ---------------------------------------------------------------------------
// REGRESSION: expanded tasks must NOT be draggable (browser blocks all
// text selection/cursor inside any draggable=true ancestor regardless of
// JS-level event interception, so the only working fix is draggable=false)
// ---------------------------------------------------------------------------


describe('REGRESSION: draggable attribute toggles with expanded state', () => {
  async function cardWithOneTask() {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'X', sort_order: 0, sub_items: [], notes: '' }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);
    return card;
  }

  test('collapsed task is draggable=true', async () => {
    const card = await cardWithOneTask();
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(taskEl.getAttribute('draggable'), 'true');
  });

  test('expanded task is draggable=false', async () => {
    const card = await cardWithOneTask();
    card._expandedTasks.add('T1');
    card._render();
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(taskEl.getAttribute('draggable'), 'false',
      'expanded task must be non-draggable so its inputs accept text selection');
  });

  test('editing-title task is draggable=false', async () => {
    const card = await cardWithOneTask();
    card._editingTaskId = 'T1';
    card._render();
    const taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(taskEl.getAttribute('draggable'), 'false');
  });

  test('collapsing a task makes it draggable again', async () => {
    const card = await cardWithOneTask();
    card._expandedTasks.add('T1');
    card._render();
    let taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(taskEl.getAttribute('draggable'), 'false');

    card._expandedTasks.delete('T1');
    card._render();
    taskEl = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(taskEl.getAttribute('draggable'), 'true');
  });
});


// ---------------------------------------------------------------------------
// Due soon filter
// ---------------------------------------------------------------------------


describe('due soon filter', () => {
  const TASKS = [
    { id: 'T1', title: 'Overdue',   due_date: '2027-06-10', completed: false, sort_order: 0, sub_items: [] },
    { id: 'T2', title: 'Today',     due_date: '2027-06-15', completed: false, sort_order: 1, sub_items: [] },
    { id: 'T3', title: 'In 3 days', due_date: '2027-06-18', completed: false, sort_order: 2, sub_items: [] },
    { id: 'T4', title: 'In 10 days',due_date: '2027-06-25', completed: false, sort_order: 3, sub_items: [] },
    { id: 'T5', title: 'No due',    due_date: null,         completed: false, sort_order: 4, sub_items: [] },
    { id: 'T6', title: 'Done',      due_date: '2027-06-15', completed: true,  sort_order: 5, sub_items: [] },
  ];

  test('filter button hidden by default', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    const btns = [...card.shadowRoot.querySelectorAll('.filter-btn')];
    const labels = btns.map(b => b.textContent);
    assert.equal(labels.length, 3);
    assert.ok(!labels.includes('Due Soon'));
  });

  test('filter button shown when show_due_soon_filter is true', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_due_soon_filter: true }] });
    card.hass = hass;
    await flush(card);

    const btns = [...card.shadowRoot.querySelectorAll('.filter-btn')];
    const labels = btns.map(b => b.textContent);
    assert.equal(labels.length, 4);
    assert.ok(labels.includes('Due Soon'));
  });

  test('due_soon filter shows only open tasks with due dates within range', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_due_soon_filter: true, due_soon_days: 7 }] });
    card.hass = hass;
    await flush(card);

    // Set filter to due_soon
    card._columns[0].filter = 'due_soon';
    card._render();

    const taskEls = [...card.shadowRoot.querySelectorAll('.task')];
    const titles = taskEls.map(el => el.querySelector('.task-title')?.textContent?.trim());
    // Should include: Overdue (past due), Today, In 3 days
    // Should exclude: In 10 days (beyond 7 days), No due (no date), Done (completed)
    assert.ok(titles.includes('Overdue'), 'overdue tasks should be included');
    assert.ok(titles.includes('Today'), 'today tasks should be included');
    assert.ok(titles.includes('In 3 days'), 'tasks within range should be included');
    assert.ok(!titles.includes('In 10 days'), 'tasks beyond range should be excluded');
    assert.ok(!titles.includes('No due'), 'tasks without due date should be excluded');
    assert.ok(!titles.includes('Done'), 'completed tasks should be excluded');
    assert.equal(taskEls.length, 3);
  });

  test('due_soon filter with due_soon_days 0 shows only today and overdue', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_due_soon_filter: true, due_soon_days: 0 }] });
    card.hass = hass;
    await flush(card);

    card._columns[0].filter = 'due_soon';
    card._render();

    const titles = [...card.shadowRoot.querySelectorAll('.task')]
      .map(el => el.querySelector('.task-title')?.textContent?.trim());
    assert.ok(titles.includes('Overdue'), 'overdue still included by default');
    assert.ok(titles.includes('Today'), 'today included');
    assert.ok(!titles.includes('In 3 days'), 'future tasks excluded when days is 0');
    assert.equal(titles.length, 2);
  });

  test('hide_overdue excludes overdue tasks from due_soon filter', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_due_soon_filter: true, due_soon_days: 7, hide_overdue: true }] });
    card.hass = hass;
    await flush(card);

    card._columns[0].filter = 'due_soon';
    card._render();

    const titles = [...card.shadowRoot.querySelectorAll('.task')]
      .map(el => el.querySelector('.task-title')?.textContent?.trim());
    assert.ok(!titles.includes('Overdue'), 'overdue excluded when hide_overdue is set');
    assert.ok(titles.includes('Today'), 'today still included');
    assert.ok(titles.includes('In 3 days'), 'upcoming still included');
    assert.equal(titles.length, 2);
  });

  test('due_soon_days 0 with hide_overdue shows only tasks due today', async () => {
    const { HomeTasksCard } = await loadCard({ force: true, frozenNow: '2027-06-15T12:00:00Z' });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_due_soon_filter: true, due_soon_days: 0, hide_overdue: true }] });
    card.hass = hass;
    await flush(card);

    card._columns[0].filter = 'due_soon';
    card._render();

    const titles = [...card.shadowRoot.querySelectorAll('.task')]
      .map(el => el.querySelector('.task-title')?.textContent?.trim());
    assert.deepEqual(titles, ['Today']);
  });
});

describe('preset filters', () => {
  const TASKS = [
    { id: 'P1', title: 'Ben homework', assigned_person: 'Ben',  tags: ['School'],          completed: false, sort_order: 0, sub_items: [] },
    { id: 'P2', title: 'Ben chores',   assigned_person: 'Ben',  tags: ['Home'],            completed: false, sort_order: 1, sub_items: [] },
    { id: 'P3', title: 'Anna music',   assigned_person: 'Anna', tags: ['School', 'Music'], completed: false, sort_order: 2, sub_items: [] },
    { id: 'P4', title: 'Anna done',    assigned_person: 'Anna', tags: ['Home'],            completed: true,  sort_order: 3, sub_items: [] },
    { id: 'P5', title: 'Unassigned',   assigned_person: null,                              completed: false, sort_order: 4, sub_items: [] },
  ];

  const setup = async (colConfig) => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
    card.hass = hass;
    await flush(card);
    return card;
  };

  const titlesOf = (card) => [...card.shadowRoot.querySelectorAll('.task')]
    .map(el => el.querySelector('.task-title')?.textContent?.trim());

  test('assignees preset limits the column to those people', async () => {
    const card = await setup({ filters: { assignees: ['Ben'] } });
    assert.deepEqual(titlesOf(card).sort(), ['Ben chores', 'Ben homework']);
  });

  test('labels preset limits the column to tasks with those tags', async () => {
    const card = await setup({ filters: { labels: ['School'] } });
    assert.deepEqual(titlesOf(card).sort(), ['Anna music', 'Ben homework']);
  });

  test('assignees and labels presets combine (AND)', async () => {
    const card = await setup({ filters: { assignees: ['Anna'], labels: ['School'] } });
    assert.deepEqual(titlesOf(card), ['Anna music']);
  });

  test('labels preset on a list with tag-less tasks does not error', async () => {
    // P5 has no `tags` property at all — it must be silently excluded, not throw.
    const card = await setup({ filters: { labels: ['Home'] } });
    const titles = titlesOf(card);
    assert.ok(!titles.includes('Unassigned'), 'tag-less task excluded by a label preset');
    assert.ok(titles.includes('Ben chores'));
    assert.equal(card._preFilteredTasks(0).length, 2);
  });

  test('preset filter composes with the runtime filter', async () => {
    const card = await setup({ filters: { assignees: ['Anna'] } });
    card._columns[0].filter = 'done';
    card._render();
    assert.deepEqual(titlesOf(card), ['Anna done']);
  });

  test('no filters key — all tasks pass through _preFilteredTasks', async () => {
    const card = await setup({});
    assert.equal(card._preFilteredTasks(0).length, 5);
  });
});


// ---------------------------------------------------------------------------
// Discoverable title editing: the title is a plain span when collapsed and a
// bordered text input when expanded (so users find how to rename a task).
// ---------------------------------------------------------------------------


describe('discoverable title editing', () => {
  async function cardWithTask() {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'Rename me', sort_order: 0, sub_items: [], notes: '' }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);
    return card;
  }

  test('collapsed task shows the title as a plain span (not an input)', async () => {
    const card = await cardWithTask();
    const row = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.ok(row.querySelector('.task-title'), 'collapsed shows a .task-title span');
    assert.equal(row.querySelector('.edit-title-input'), null);
  });

  test('expanding a task renders the title as an editable text input', async () => {
    const card = await cardWithTask();
    card._expandedTasks.add('T1');
    card._render();
    const input = card.shadowRoot.querySelector('.task[data-task-id="T1"] .edit-title-input');
    assert.ok(input, 'expanded task renders an editable title input');
    assert.equal(input.value, 'Rename me');
  });

  test('focusing the expanded title input marks the task as editing (defers bg renders)', async () => {
    const card = await cardWithTask();
    card._expandedTasks.add('T1');
    card._render();
    const input = card.shadowRoot.querySelector('.task[data-task-id="T1"] .edit-title-input');
    const win = card.shadowRoot.ownerDocument.defaultView;
    input.dispatchEvent(new win.Event('focus'));
    assert.equal(card._editingTaskId, 'T1',
      'focusing the title must set _editingTaskId so a poll mid-typing cannot revert it');
  });
});


// ---------------------------------------------------------------------------
// Person-chips toggle: show_person_chips:false hides the per-column person
// filter chips even when tasks have assignees.
// ---------------------------------------------------------------------------


describe('person chips toggle', () => {
  async function cardWith(extra = {}) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', title: 'a', assigned_person: 'Ben', sort_order: 0, sub_items: [] },
          { id: 'T2', title: 'b', assigned_person: 'Anna', sort_order: 1, sub_items: [] },
        ],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...extra }] });
    card.hass = hass;
    await flush(card);
    return card;
  }

  test('person chips render by default when tasks have assignees', async () => {
    const card = await cardWith();
    assert.ok(card.shadowRoot.querySelector('.person-chips'), 'chips shown by default');
    assert.equal(card.shadowRoot.querySelectorAll('.person-chip').length, 2);
  });

  test('show_person_chips:false hides the person chips', async () => {
    const card = await cardWith({ show_person_chips: false });
    assert.equal(card.shadowRoot.querySelector('.person-chips'), null);
    assert.equal(card.shadowRoot.querySelectorAll('.person-chip').length, 0);
  });
});


// ---------------------------------------------------------------------------
// confirm_complete (issue #29) — opt-in in-card confirmation before completing
// ---------------------------------------------------------------------------


describe('confirm_complete column option', () => {
  async function setup(colExtra) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'Careful', sort_order: 0, sub_items: [], completed: false }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    card.hass = hass;
    await flush(card);
    return { card, hass };
  }
  const dialogOf = (card) => card.shadowRoot.querySelector('dialog.ht-confirm');

  test('default (off): completing never shows the dialog', async () => {
    const { card, hass } = await setup({});
    await card._toggleTask('T1', false, 0);
    await flush(card);
    assert.equal(dialogOf(card), null);
    assert.ok(hass.calls.some(c => c.type === 'home_tasks/update_task' && c.completed === true));
  });

  test('enabled: shows an in-card dialog (not window.confirm) with the task title', async () => {
    const { card } = await setup({ confirm_complete: true });
    const win = card.ownerDocument.defaultView;
    let nativeCalls = 0;
    win.confirm = () => { nativeCalls++; return true; };
    const pending = card._toggleTask('T1', false, 0);
    await flush(card);
    const dlg = dialogOf(card);
    assert.ok(dlg, 'in-card dialog must be rendered into the shadow root');
    assert.equal(nativeCalls, 0, 'must not use the native browser confirm');
    assert.match(dlg.querySelector('.ht-confirm-msg').textContent, /Careful/);
    assert.ok(dlg.querySelector('.ht-confirm-btn.primary'));
    dlg.querySelector('.ht-confirm-btn:not(.primary)').click();  // cancel → settle
    await pending;
  });

  test('enabled + cancel: no update is sent, dialog removed, task stays open', async () => {
    const { card, hass } = await setup({ confirm_complete: true });
    const pending = card._toggleTask('T1', false, 0);
    await flush(card);
    dialogOf(card).querySelector('.ht-confirm-btn:not(.primary)').click();
    await pending;
    await flush(card);
    assert.equal(dialogOf(card), null, 'dialog must be removed after cancel');
    assert.ok(!hass.calls.some(c => c.type === 'home_tasks/update_task'));
    const cb = card.shadowRoot.querySelector('.task[data-task-id="T1"] input[type=checkbox]');
    assert.ok(cb && cb.checked === false, 'checkbox must be restored to unchecked');
  });

  test('enabled + confirm: completes as usual', async () => {
    const { card, hass } = await setup({ confirm_complete: true });
    const pending = card._toggleTask('T1', false, 0);
    await flush(card);
    dialogOf(card).querySelector('.ht-confirm-btn.primary').click();
    await pending;
    await flush(card);
    assert.equal(dialogOf(card), null);
    assert.ok(hass.calls.some(c => c.type === 'home_tasks/update_task' && c.completed === true));
  });

  test('enabled: Escape (dialog cancel event) counts as cancel', async () => {
    const { card, hass } = await setup({ confirm_complete: true });
    const pending = card._toggleTask('T1', false, 0);
    await flush(card);
    const dlg = dialogOf(card);
    dlg.dispatchEvent(new card.ownerDocument.defaultView.Event('cancel', { cancelable: true }));
    await pending;
    assert.ok(!hass.calls.some(c => c.type === 'home_tasks/update_task'));
  });

  test('enabled: reopening (uncomplete) never prompts', async () => {
    const { card } = await setup({ confirm_complete: true });
    await card._toggleTask('T1', true, 0);  // currently completed → reopen
    await flush(card);
    assert.equal(dialogOf(card), null);
  });
});


// ---------------------------------------------------------------------------
// card-mod compatibility (issues #31 / #34)
// ---------------------------------------------------------------------------


describe('card-mod node survives re-renders', () => {
  test('a <card-mod> child of the shadow root is re-attached (same instance) after a rebuild', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': { tasks: [{ id: 'T1', title: 'Styled', sort_order: 0, sub_items: [] }] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);

    // Simulate card-mod's hui-card hook: it appends a <card-mod> element
    // (carrying the user's <style>) directly into the card's shadow root.
    const doc = card.ownerDocument;
    const cm = doc.createElement('card-mod');
    const style = doc.createElement('style');
    style.textContent = '.task-title { font-size: 16px !important; }';
    cm.appendChild(style);
    card.shadowRoot.appendChild(cm);

    // Any data refresh rebuilds the shadow root...
    card._render();
    await flush(card);

    // ...but the very same card-mod node must still be there, styles intact.
    const after = card.shadowRoot.querySelector('card-mod');
    assert.ok(after, 'card-mod node was dropped by the rebuild');
    assert.strictEqual(after, cm, 'must be the same instance (card-mod keeps state on it)');
    assert.ok(after.querySelector('style'), 'its <style> child must be preserved');
    // and the card content was rebuilt normally
    assert.ok(card.shadowRoot.querySelector('.task[data-task-id="T1"]'));
  });
});


describe('card-mod self-application via developer API', () => {
  async function setupWithFakeCardMod(cardConfig) {
    const { HomeTasksCard, window: win } = await loadCard({ force: true });
    const calls = [];
    // Fake card-mod with the public developer API (static applyToElement).
    if (!win.customElements.get('card-mod')) {
      class FakeCardMod extends win.HTMLElement {
        static applyToElement(...args) { calls.push(args); }
      }
      win.customElements.define('card-mod', FakeCardMod);
    } else {
      win.customElements.get('card-mod').applyToElement = (...args) => calls.push(args);
    }
    const card = new HomeTasksCard();
    card.setConfig(cardConfig);
    card.hass = makeRecordingHass({ 'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'L' }] } });
    win.document.body.appendChild(card);  // → connectedCallback
    await flush(card);
    return { card, calls };
  }

  test('asks card-mod to apply when the config carries card_mod', async () => {
    const cm = { style: '.task-title { font-size: 16px !important; }' };
    const { card, calls } = await setupWithFakeCardMod({ columns: [{ list_id: 'L1' }], card_mod: cm });
    assert.ok(calls.length >= 1, 'applyToElement must be called');
    const [el, type, cfg, vars, shadow, cls] = calls[0];
    assert.strictEqual(el, card);
    assert.equal(type, 'card');
    assert.strictEqual(cfg, cm);
    assert.strictEqual(vars.config, card._config);
    assert.equal(shadow, true);
    assert.equal(cls, 'type-custom-home-tasks-card');
  });

  test('does nothing without card_mod in the config', async () => {
    const { calls } = await setupWithFakeCardMod({ columns: [{ list_id: 'L1' }] });
    assert.equal(calls.length, 0);
  });
});


// ---------------------------------------------------------------------------
// max_height column option (issues #33 / #34)
// ---------------------------------------------------------------------------


describe('max_height column option', () => {
  const TASKS = Array.from({ length: 30 }, (_, i) => ({ id: `T${i}`, title: `Task ${i}`, sort_order: i, sub_items: [] }));
  async function setup(colExtra) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': { tasks: TASKS },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    card.hass = hass;
    await flush(card);
    return card;
  }

  test('unset: task list is not capped (no inline max-height, no scrollable class)', async () => {
    const card = await setup({});
    const list = card.shadowRoot.querySelector('.task-list');
    assert.ok(list);
    assert.equal(list.style.maxHeight, '');
    assert.ok(!list.classList.contains('scrollable'));
  });

  test('max_height caps only the task list and marks it scrollable', async () => {
    const card = await setup({ max_height: 350 });
    const list = card.shadowRoot.querySelector('.task-list');
    assert.equal(list.style.maxHeight, '350px');
    assert.ok(list.classList.contains('scrollable'));
    // Header / add-task row are siblings above the list, not inside it
    const col = list.parentElement;
    assert.ok(col.querySelector('.header'), 'header must exist in the column');
    assert.ok(!list.contains(col.querySelector('.header')), 'header must not be inside the scroll container');
    assert.ok(!list.contains(col.querySelector('.add-task')), 'add-task row must not be inside the scroll container');
    // the scrollable rule exists in the stylesheet
    assert.ok(card._getStyles().includes('.task-list.scrollable, .tile-grid-wrap.scrollable'));
  });

  test('tiles view: the tile grid wrapper gets the cap', async () => {
    const card = await setup({ max_height: 400, view_mode: 'tiles' });
    const wrap = card.shadowRoot.querySelector('.tile-grid-wrap');
    assert.ok(wrap);
    assert.equal(wrap.style.maxHeight, '400px');
    assert.ok(wrap.classList.contains('scrollable'));
  });

  test('invalid values (0, negative, NaN, string junk) are ignored', async () => {
    for (const v of [0, -5, 'abc', null]) {
      const card = await setup({ max_height: v });
      const list = card.shadowRoot.querySelector('.task-list');
      assert.equal(list.style.maxHeight, '', `max_height=${v} must not cap`);
    }
    // numeric strings are accepted (YAML/editor may deliver them)
    const card = await setup({ max_height: '280' });
    assert.equal(card.shadowRoot.querySelector('.task-list').style.maxHeight, '280px');
  });
});


describe('fixed-rows contract of HA sections view (--row-size)', () => {
  async function setup(rowSize) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_tasks': { tasks: [{ id: 'T1', title: 'One', sort_order: 0, sub_items: [] }] },
    });
    const card = new HomeTasksCard();
    if (rowSize !== undefined) card.style.setProperty('--row-size', rowSize);
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    card.ownerDocument.body.appendChild(card); // connectedCallback + computed styles
    await flush(card);
    return card;
  }

  test('no --row-size (auto height / masonry): no fit-rows mode', async () => {
    const card = await setup(undefined);
    assert.ok(!card.classList.contains('fit-rows'));
  });

  test('--row-size: auto is treated as unconstrained', async () => {
    const card = await setup('auto');
    assert.ok(!card.classList.contains('fit-rows'));
  });

  test('fixed --row-size switches the host into fit-rows (fill + scroll body) mode', async () => {
    const card = await setup('6');
    assert.ok(card.classList.contains('fit-rows'));
    const css = card._getStyles();
    assert.ok(css.includes(':host(.fit-rows) { display: block; height: 100%; }'));
    assert.ok(css.includes(':host(.fit-rows) ha-card { height: 100%; }'));
    assert.ok(css.includes(':host(.fit-rows) .task-list, :host(.fit-rows) .tile-grid-wrap { flex: 1 1 auto; min-height: 40px; }'));
  });

  test('re-render re-evaluates the mode (layout edited at runtime)', async () => {
    const card = await setup(undefined);
    assert.ok(!card.classList.contains('fit-rows'));
    card.style.setProperty('--row-size', '4');
    card._render();
    assert.ok(card.classList.contains('fit-rows'));
    card.style.removeProperty('--row-size');
    card._render();
    assert.ok(!card.classList.contains('fit-rows'));
  });

  test('exposes getGridOptions (current HA API) with auto rows by default', async () => {
    const card = await setup(undefined);
    // JSON compare: the object comes from the jsdom realm (different Object prototype)
    // 12-column grid: min_columns 12 == full width (legacy getLayoutOptions says 4 on the old 4-grid)
    assert.equal(JSON.stringify(card.getGridOptions()), JSON.stringify({ columns: 'full', min_columns: 12, rows: 'auto', min_rows: 2 }));
  });
});


// ---------------------------------------------------------------------------
// Section collapse/expand must never strand a body in a half-animated state
// (stuck inline max-height + overflow hidden → later content growth is
// clipped and the next section headers visually overlap it).
// ---------------------------------------------------------------------------


describe('section collapse/expand robustness', () => {
  async function setup({ hidden, stallRaf, listId }) {
    const { HomeTasksCard, window: win } = await loadCard({ force: true });
    if (stallRaf) win.requestAnimationFrame = () => 0;  // frame callbacks never run (hidden tab / throttled WebView)
    if (!win.CSS || !win.CSS.escape) win.CSS = { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch) };  // jsdom lacks CSS.escape
    Object.defineProperty(win.document, 'hidden', { value: hidden, configurable: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: listId, name: 'L' }] },
      'home_tasks/get_tasks': {
        tasks: [
          { id: 'T1', title: 'In section', sort_order: 0, sub_items: [], section_id: 'S1' },
          { id: 'T2', title: 'Loose', sort_order: 1, sub_items: [] },
        ],
        sections: [{ id: 'S1', name: 'Sec', sort_order: 0 }],
      },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: listId }] });
    card.hass = hass;
    win.document.body.appendChild(card);
    await flush(card);
    return { card, win };
  }
  const body = (card) => card.shadowRoot.querySelector('.section-body[data-section-id="S1"]');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  for (const variant of [{ hidden: true, stallRaf: true, name: 'hidden document' }, { hidden: false, stallRaf: true, name: 'visible but rAF never fires' }]) {
    test(`${variant.name}: collapse completes and leaves no inline styles`, async () => {
      const { card } = await setup({ ...variant, listId: 'L-' + variant.name.replace(/\W/g, '') + '-c' });
      assert.ok(body(card) && !body(card).classList.contains('collapsed'));
      card._toggleSectionCollapsed(0, 'S1');
      await wait(450);
      assert.equal(card._isSectionCollapsed(0, 'S1'), true, 'collapse state must be committed');
      const b = body(card);
      assert.ok(b.classList.contains('collapsed'), 'body must carry the collapsed class baseline');
      assert.equal(b.style.maxHeight, '');
      assert.equal(b.style.overflow, '');
    });

    test(`${variant.name}: expand ends fully visible, no stale max-height`, async () => {
      const { card } = await setup({ ...variant, listId: 'L-' + variant.name.replace(/\W/g, '') + '-e' });
      card._setSectionCollapsed(0, 'S1', true);
      card._render();
      assert.ok(body(card).classList.contains('collapsed'));
      card._toggleSectionCollapsed(0, 'S1');
      await wait(500);
      const b = body(card);
      assert.equal(card._isSectionCollapsed(0, 'S1'), false);
      assert.ok(!b.classList.contains('expanding'), 'expanding baseline must be removed');
      assert.ok(!b.classList.contains('collapsed'));
      assert.equal(b.style.maxHeight, '', 'no stale inline max-height');
      assert.equal(b.style.overflow, '');
      assert.equal(b.style.opacity, '');
    });
  }
});


describe('height-constrained list must scroll, not squeeze its children', () => {
  test('stylesheet pins flex-shrink: 0 on direct children of the list / tile wrap', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{}] });
    const css = card._getStyles();
    // Regression: with max_height / fit-rows, section headers (min-height: 0)
    // were shrunk to 0px by the flex algorithm and overlapped the task above.
    assert.ok(css.includes('.task-list > *, .tile-grid-wrap > * { flex-shrink: 0; }'));
  });
});


// ---------------------------------------------------------------------------
// show_add_due (issue #38) — due date while creating a task
// ---------------------------------------------------------------------------


describe('show_add_due column option', () => {
  async function setup(colExtra, extra = {}) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Test List' }] },
      'home_tasks/get_external_lists': { external_lists: extra.externalLists || [] },
      'home_tasks/get_tasks': { tasks: [] },
      'home_tasks/get_external_tasks': { tasks: [] },
      'home_tasks/add_task': (msg) => ({ id: 'NEW', title: msg.title, due_date: msg.due_date || null, due_time: msg.due_time || null, sub_items: [] }),
      'home_tasks/create_external_task': (msg) => ({ id: 'X1', title: msg.title }),
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ ...colExtra }] });
    card.hass = hass;
    await flush(card);
    return { card, hass };
  }
  const row = (card) => card.shadowRoot.querySelector('.add-due-row');

  test('off by default: add row is the single classic .add-task row, no due row', async () => {
    const { card } = await setup({ list_id: 'L1' });
    assert.equal(row(card), null);
    assert.ok(card.shadowRoot.querySelector('.add-task'));
    assert.equal(card.shadowRoot.querySelector('.add-task-group'), null);
  });

  test('on: date + time row is always visible under the add input (no toggle, no extra buttons)', async () => {
    const { card } = await setup({ list_id: 'L1', show_add_due: true });
    const r = row(card);
    assert.ok(r, 'due row must render without any toggle');
    assert.ok(r.querySelector('input[type=date]') && r.querySelector('input[type=time]'));
    assert.equal(r.querySelectorAll('button').length, 0, 'native inputs bring their own clearing');
  });

  test('native add sends due_date + due_time in ONE add_task call and resets the values', async () => {
    const { card, hass } = await setup({ list_id: 'L1', show_add_due: true });
    const win = card.ownerDocument.defaultView;
    const cs = card._columns[0];
    const dateInput = row(card).querySelector('input[type=date]');
    dateInput.value = '2027-03-15'; dateInput.dispatchEvent(new win.Event('change'));
    const timeInput = row(card).querySelector('input[type=time]');
    timeInput.value = '09:30'; timeInput.dispatchEvent(new win.Event('change'));
    cs.newTaskTitle = 'Dentist';
    await card._addTask(0);
    await flush(card);
    const add = hass.calls.find(c => c.type === 'home_tasks/add_task');
    assert.ok(add);
    assert.equal(add.due_date, '2027-03-15');
    assert.equal(add.due_time, '09:30');
    assert.ok(!hass.calls.some(c => c.type === 'home_tasks/update_task'), 'no follow-up update call');
    assert.equal(cs.newTaskDue, '');
    assert.equal(cs.newTaskDueTime, '');
    assert.ok(row(card), 'row remains for the next task');
  });

  test('empty date: task is created without due; time without date is ignored', async () => {
    const { card, hass } = await setup({ list_id: 'L1', show_add_due: true });
    const cs = card._columns[0];
    cs.newTaskDueTime = '10:00';  // no date
    cs.newTaskTitle = 'No date';
    await card._addTask(0);
    const add = hass.calls.find(c => c.type === 'home_tasks/add_task');
    assert.equal(add.due_date, undefined);
    assert.equal(add.due_time, undefined);
  });

  test('external column: due passed to create_external_task when the provider supports it, row hidden otherwise', async () => {
    const withDue = await setup({ entity_id: 'todo.a', show_add_due: true }, {
      externalLists: [{ entity_id: 'todo.a', name: 'A', linked: true, supported_features: 16, capabilities: {} }],
    });
    assert.ok(row(withDue.card), 'provider with SET_DUE_DATE must show the row');
    const cs = withDue.card._columns[0];
    cs.newTaskDue = '2027-04-01'; cs.newTaskTitle = 'Ext';
    await withDue.card._addTask(0);
    const create = withDue.hass.calls.find(c => c.type === 'home_tasks/create_external_task');
    assert.equal(create.due_date, '2027-04-01');

    const noDue = await setup({ entity_id: 'todo.b', show_add_due: true }, {
      externalLists: [{ entity_id: 'todo.b', name: 'B', linked: true, supported_features: 0, capabilities: {} }],
    });
    assert.equal(row(noDue.card), null, 'provider without due support must not show the row');
  });
});



// ---------------------------------------------------------------------------
// Review follow-ups: open overlays survive a rebuild untouched, Enter in the
// add-row due inputs still shows the new task, time input gated per provider
// ---------------------------------------------------------------------------


describe('rebuild keeps foreign / long-lived shadow-root nodes in place', () => {
  test('an open confirm dialog is neither detached nor re-opened by _render', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'L' }] },
      'home_tasks/get_tasks': { tasks: [{ id: 'T1', title: 'A', sort_order: 0, sub_items: [] }] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', confirm_complete: true }] });
    card.hass = hass;
    await flush(card);
    const pending = card._toggleTask('T1', false, 0);
    await flush(card);
    const dlg = card.shadowRoot.querySelector('dialog.ht-confirm');
    assert.ok(dlg);
    let disconnected = 0;
    const origRemove = dlg.remove.bind(dlg);
    dlg.remove = () => { disconnected++; origRemove(); };
    card._render();  // background refresh while the prompt is up
    await flush(card);
    assert.equal(disconnected, 0, 'dialog must not be detached by a rebuild');
    assert.strictEqual(card.shadowRoot.querySelector('dialog.ht-confirm'), dlg);
    assert.ok(dlg.hasAttribute('open'), 'still open');
    // DOM order: style, ha-card, then the dialog
    const kids = [...card.shadowRoot.children].map(k => k.localName);
    assert.ok(kids.indexOf('ha-card') < kids.indexOf('dialog'));
    dlg.querySelector('.ht-confirm-btn.primary').click();
    await pending;
  });
});


describe('Enter inside the add-row due inputs', () => {
  test('hands focus to the title input so the render is not deferred, and the task appears', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const tasks = [];
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'L' }] },
      'home_tasks/get_tasks': () => ({ tasks: [...tasks] }),
      'home_tasks/add_task': (msg) => { const t = { id: 'N' + tasks.length, title: msg.title, due_date: msg.due_date || null, due_time: msg.due_time || null, sort_order: tasks.length, sub_items: [] }; tasks.push(t); return t; },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', show_add_due: true }] });
    card.hass = hass;
    card.ownerDocument.body.appendChild(card);
    await flush(card);
    const win = card.ownerDocument.defaultView;
    const cs = card._columns[0];
    cs.newTaskTitle = 'From date field';
    const dateInput = card.shadowRoot.querySelector('.add-due-row input[type=date]');
    dateInput.value = '2027-05-05';
    dateInput.focus();
    assert.strictEqual(card.shadowRoot.activeElement, dateInput);
    dateInput.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush(card); await flush(card);
    const add = hass.calls.find(c => c.type === 'home_tasks/add_task');
    assert.ok(add && add.due_date === '2027-05-05', 'add_task sent with the date read from the input');
    assert.ok(card.shadowRoot.querySelector('.task[data-task-id="N0"]'), 'new task must be rendered (render not swallowed by the date-input guard)');
    assert.notStrictEqual(card.shadowRoot.activeElement && card.shadowRoot.activeElement.type, 'date');
  });
});


describe('add-row time input follows the provider\'s due-time capability', () => {
  async function setup(features) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [] },
      'home_tasks/get_external_lists': { external_lists: [{ entity_id: 'todo.x', name: 'X', linked: true, supported_features: features, capabilities: {} }] },
      'home_tasks/get_external_tasks': { tasks: [] },
      'home_tasks/create_external_task': (msg) => ({ id: 'E1', title: msg.title }),
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ entity_id: 'todo.x', show_add_due: true }] });
    card.hass = hass;
    await flush(card);
    return { card, hass };
  }

  test('SET_DUE_DATE only: date input, no time input; a stray time is not sent', async () => {
    const { card, hass } = await setup(16);
    const row = card.shadowRoot.querySelector('.add-due-row');
    assert.ok(row.querySelector('input[type=date]'));
    assert.equal(row.querySelector('input[type=time]'), null);
    const cs = card._columns[0];
    cs.newTaskDue = '2027-06-06'; cs.newTaskDueTime = '10:00'; cs.newTaskTitle = 'X';
    await card._addTask(0);
    const create = hass.calls.find(c => c.type === 'home_tasks/create_external_task');
    assert.equal(create.due_date, '2027-06-06');
    assert.equal(create.due_time, undefined);
  });

  test('SET_DUE_DATETIME: both inputs', async () => {
    const { card } = await setup(32);
    const row = card.shadowRoot.querySelector('.add-due-row');
    assert.ok(row.querySelector('input[type=date]') && row.querySelector('input[type=time]'));
  });
});


describe('editor Defaults section (issues #44 / #46)', () => {
  async function makeEditor(colExtra, wsResponses = {}) {
    const { HomeTasksCard, window: win } = await loadCard({ force: true });
    const ed = win.document.createElement('home-tasks-card-editor');
    const calls = [];
    ed.hass = {
      language: 'en',
      states: { 'person.alice': { attributes: { friendly_name: 'Alice' } } },
      callWS: async (msg) => {
        calls.push(msg);
        if (msg.type === 'home_tasks/get_defaults') return wsResponses.get_defaults ?? { defaults: { assignee: 'person.alice', reminders: [0] } };
        if (msg.type === 'home_tasks/set_defaults') return { defaults: {} };
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    };
    ed.setConfig({ columns: [colExtra] });
    win.document.body.appendChild(ed);
    await new Promise(r => setTimeout(r, 30));
    return { ed, calls, root: ed.shadowRoot || ed };
  }

  test('native list: section renders and loads the stored defaults', async () => {
    const { ed, calls, root } = await makeEditor({ list_id: 'L1' });
    assert.ok(calls.some(c => c.type === 'home_tasks/get_defaults' && c.list_id === 'L1'));
    const container = root.querySelector('.defaults-editor');
    assert.ok(container, 'defaults editor container must render');
    const personSel = container.querySelector('select');
    assert.equal(personSel.value, 'person.alice');
    assert.ok(container.textContent.includes('Applied to every new task'));
    ed.remove();
  });

  test('changing the assignee saves via set_defaults', async () => {
    const { ed, calls, root } = await makeEditor({ list_id: 'L1' });
    const personSel = root.querySelector('.defaults-editor select');
    personSel.value = '';
    personSel.dispatchEvent(new ed.ownerDocument.defaultView.Event('change'));
    await new Promise(r => setTimeout(r, 10));
    const set = calls.find(c => c.type === 'home_tasks/set_defaults');
    assert.ok(set);
    assert.equal(set.assignee, null);
    ed.remove();
  });

  test('external column: no Defaults section', async () => {
    const { root } = await makeEditor({ entity_id: 'todo.x' });
    assert.equal(root.querySelector('.defaults-editor'), null);
  });
});


describe('chip display toggles (issue #45)', () => {
  const TASK = { id: 'T1', title: 'Rich', sort_order: 0, sub_items: [], priority: 3, due_date: '2099-01-01', tags: ['a'], reminders: [0], recurrence_enabled: true, recurrence_unit: 'days', recurrence_value: 1, assigned_person: 'person.alice' };
  async function setup(colExtra) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'L' }] },
      'home_tasks/get_tasks': { tasks: [TASK] },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    card.hass = hass;
    await flush(card);
    return card;
  }
  const expand = async (card) => {
    card._expandedTasks && card._expandedTasks.add && card._expandedTasks.add('T1');
    if (!card._expandedTasks || !card._expandedTasks.add) card._expandedTaskId = 'T1';
    card._render();
  };

  test('default: all chips render', async () => {
    const card = await setup({});
    const row = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.ok(row.querySelector('.priority-badge'));
    assert.ok(row.querySelector('.due-date'));
    assert.ok(row.querySelector('.tag-badge'));
    assert.ok(row.querySelector('.reminder-badge'));
    assert.ok(row.querySelector('.recurrence-badge'));
  });

  test('badge_reminders: false hides the chip but keeps the feature switch untouched', async () => {
    const card = await setup({ badge_reminders: false });
    const row = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(row.querySelector('.reminder-badge'), null, 'reminder chip hidden');
    assert.ok(row.querySelector('.due-date'), 'other chips unaffected');
  });

  test('badge toggles are independent per chip', async () => {
    const card = await setup({ badge_tags: false, badge_priority: false });
    const row = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(row.querySelector('.tag-badge'), null);
    assert.equal(row.querySelector('.priority-badge'), null);
    assert.ok(row.querySelector('.due-date'));
    assert.ok(row.querySelector('.reminder-badge'));
  });

  test('feature switch still hides the chip too (unchanged semantics)', async () => {
    const card = await setup({ show_reminders: false });
    const row = card.shadowRoot.querySelector('.task[data-task-id="T1"]');
    assert.equal(row.querySelector('.reminder-badge'), null);
  });
});


// ---------------------------------------------------------------------------
// Move to list (issue #47) — button next to Duplicate/Delete, in-card dialog
// ---------------------------------------------------------------------------


describe('move to list (issue #47)', () => {
  async function setup(colExtra, lists) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: lists || [{ id: 'L1', name: 'List 1' }, { id: 'L2', name: 'List 2' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'Wander', sort_order: 0, sub_items: [], completed: false }],
      },
      'home_tasks/move_task': {},
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    card.hass = hass;
    await flush(card);
    const task = card._columns[0].tasks[0];
    return { card, hass, task };
  }
  const dialogOf = (card) => card.shadowRoot.querySelector('dialog.ht-confirm');

  test('default: Move button renders next to Duplicate/Delete, targets exclude the source list', async () => {
    const { card, task } = await setup({});
    const actions = card._buildActionsSection(task, 0);
    assert.ok(actions.querySelector('.move-task-btn'), 'move button present');
    assert.ok(actions.querySelector('.duplicate-task-btn'), 'duplicate still present');
    assert.ok(actions.querySelector('.delete-task-btn'), 'delete still present');
    // JSON compare: objects come from the jsdom realm, deepEqual rejects them
    assert.equal(JSON.stringify(card._moveTargets(0)), JSON.stringify([{ label: 'List 2', list_id: 'L2' }]));
  });

  test('show_move: false hides the button (Task features toggle)', async () => {
    const { card, task } = await setup({ show_move: false });
    const actions = card._buildActionsSection(task, 0);
    assert.equal(actions.querySelector('.move-task-btn'), null);
    assert.ok(actions.querySelector('.delete-task-btn'));
  });

  test('no other list -> no button even when enabled', async () => {
    const { card, task } = await setup({}, [{ id: 'L1', name: 'List 1' }]);
    const actions = card._buildActionsSection(task, 0);
    assert.equal(actions.querySelector('.move-task-btn'), null);
  });

  test('confirming the dialog moves via the native fast path and closes the dialog', async () => {
    const { card, hass, task } = await setup({});
    const actions = card._buildActionsSection(task, 0);
    actions.querySelector('.move-task-btn').click();
    const dlg = dialogOf(card);
    assert.ok(dlg, 'in-card dialog opened');
    assert.match(dlg.querySelector('.ht-confirm-msg').textContent, /Wander/);
    const sel = dlg.querySelector('.ht-move-select');
    assert.equal(sel.options.length, 1);
    assert.equal(sel.options[0].textContent, 'List 2');
    dlg.querySelector('.ht-confirm-btn.primary').click();
    await flush(card);
    const move = hass.calls.find(c => c.type === 'home_tasks/move_task');
    assert.ok(move, 'move_task called');
    assert.equal(move.source_list_id, 'L1');
    assert.equal(move.target_list_id, 'L2');
    assert.equal(move.task_id, 'T1');
    assert.equal(dialogOf(card), null, 'dialog removed');
    assert.ok(!hass.calls.some(c => c.type === 'home_tasks/move_task_cross'), 'no cross path for native->native');
  });

  test('cancel makes no move call', async () => {
    const { card, hass, task } = await setup({});
    const actions = card._buildActionsSection(task, 0);
    actions.querySelector('.move-task-btn').click();
    dialogOf(card).querySelector('.ht-confirm-btn:not(.primary)').click();
    await flush(card);
    assert.ok(!hass.calls.some(c => c.type === 'home_tasks/move_task' || c.type === 'home_tasks/move_task_cross'));
    assert.equal(dialogOf(card), null);
  });
});


// ---------------------------------------------------------------------------
// Code-review fixes: move error surfacing, defaults cache, non-preset offsets
// ---------------------------------------------------------------------------


describe('move failure surfacing (review)', () => {
  test('a failed move shows the error toast instead of a silent no-op', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'List 1' }, { id: 'L2', name: 'List 2' }] },
      'home_tasks/get_tasks': {
        tasks: [{ id: 'T1', title: 'Doomed', sort_order: 0, sub_items: [], completed: false }],
      },
      'home_tasks/move_task': () => { throw new Error('Task not found'); },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);
    const task = card._columns[0].tasks[0];
    const actions = card._buildActionsSection(task, 0);
    actions.querySelector('.move-task-btn').click();
    card.shadowRoot.querySelector('dialog.ht-confirm .ht-confirm-btn.primary').click();
    await flush(card);
    const toast = card.shadowRoot.querySelector('.toast-error');
    assert.ok(toast, 'error toast must appear');
    assert.match(toast.textContent, /Task not found/);
  });
});


describe('editor Defaults cache and non-preset offsets (review)', () => {
  async function makeEditor(wsResponses = {}) {
    const { window: win } = await loadCard({ force: true });
    const ed = win.document.createElement('home-tasks-card-editor');
    const calls = [];
    ed.hass = {
      language: 'en',
      states: { 'person.alice': { attributes: { friendly_name: 'Alice' } } },
      callWS: async (msg) => {
        calls.push(msg);
        if (msg.type === 'home_tasks/get_defaults') return wsResponses.get_defaults ?? { defaults: { assignee: null, reminders: [0] } };
        if (msg.type === 'home_tasks/set_defaults') return { defaults: {} };
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    };
    ed.setConfig({ columns: [{ list_id: 'L1' }] });
    win.document.body.appendChild(ed);
    await new Promise(r => setTimeout(r, 30));
    return { ed, calls, root: ed.shadowRoot || ed };
  }

  test('get_defaults is fetched once and served from cache on re-renders', async () => {
    const { ed, calls } = await makeEditor();
    const before = calls.filter(c => c.type === 'home_tasks/get_defaults').length;
    assert.equal(before, 1, 'exactly one fetch on first render');
    ed._render();
    await new Promise(r => setTimeout(r, 20));
    const after = calls.filter(c => c.type === 'home_tasks/get_defaults').length;
    assert.equal(after, 1, 're-render must not re-fetch');
    assert.ok((ed.shadowRoot || ed).querySelector('.defaults-editor select'), 'cached content renders synchronously');
    ed.remove();
  });

  test('a stored non-preset offset gets its own selected option instead of masquerading as "At due time"', async () => {
    const { ed, root } = await makeEditor({ get_defaults: { defaults: { assignee: null, reminders: [10080] } } });
    const rows = root.querySelectorAll('.def-reminder-row select');
    assert.equal(rows.length, 1);
    const sel = rows[0];
    assert.equal(sel.value, '10080');
    const selected = sel.options[sel.selectedIndex];
    assert.match(selected.textContent, /10080/);
    ed.remove();
  });
});


describe('editor Defaults error paths and partial saves (review round 2)', () => {
  async function makeEditor(wsImpl) {
    const { window: win } = await loadCard({ force: true });
    const ed = win.document.createElement('home-tasks-card-editor');
    const calls = [];
    ed.hass = {
      language: 'en',
      states: { 'person.alice': { attributes: { friendly_name: 'Alice' } } },
      callWS: async (msg) => {
        calls.push(msg);
        const custom = wsImpl && wsImpl(msg);
        if (custom !== undefined) return custom;
        if (msg.type === 'home_tasks/get_defaults') return { defaults: { assignee: null, reminders: [0] } };
        if (msg.type === 'home_tasks/set_defaults') return { defaults: { assignee: msg.assignee ?? null, reminders: msg.reminders ?? [0] } };
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    };
    ed.setConfig({ columns: [{ list_id: 'L1' }] });
    win.document.body.appendChild(ed);
    await new Promise(r => setTimeout(r, 30));
    return { ed, calls, root: ed.shadowRoot || ed };
  }

  test('failed get_defaults shows an error hint instead of an editable empty state', async () => {
    const { ed, calls, root } = await makeEditor((msg) => {
      if (msg.type === 'home_tasks/get_defaults') throw new Error('list not ready');
    });
    const container = root.querySelector('.defaults-editor');
    assert.equal(container.querySelector('select'), null, 'no editable controls over fabricated defaults');
    assert.match(container.textContent, /Could not load defaults/);
    // cache must not be poisoned: every subsequent render retries the fetch
    const before = calls.filter(c => c.type === 'home_tasks/get_defaults').length;
    ed._render();
    await new Promise(r => setTimeout(r, 20));
    const after = calls.filter(c => c.type === 'home_tasks/get_defaults').length;
    assert.ok(after > before, 'failed fetch must not be cached');
    ed.remove();
  });

  test('changing the assignee sends a partial payload without reminders', async () => {
    const { ed, calls, root } = await makeEditor();
    const personSel = root.querySelector('.defaults-editor select');
    personSel.value = 'person.alice';
    personSel.dispatchEvent(new ed.ownerDocument.defaultView.Event('change'));
    await new Promise(r => setTimeout(r, 10));
    const set = calls.find(c => c.type === 'home_tasks/set_defaults');
    assert.ok(set);
    assert.equal(set.assignee, 'person.alice');
    assert.ok(!('reminders' in set), 'untouched field must be omitted (backend keeps it)');
    ed.remove();
  });

  test('a failed save shows the error flash and invalidates the session cache', async () => {
    const { ed, calls, root } = await makeEditor((msg) => {
      if (msg.type === 'home_tasks/set_defaults') throw new Error('boom');
    });
    const personSel = root.querySelector('.defaults-editor select');
    personSel.value = 'person.alice';
    personSel.dispatchEvent(new ed.ownerDocument.defaultView.Event('change'));
    await new Promise(r => setTimeout(r, 10));
    const flash = root.querySelector('.def-saved-flash');
    assert.ok(flash.classList.contains('err'), 'error state shown');
    assert.match(flash.textContent, /Save failed/);
    // cache dropped: the next render refetches instead of serving stale state
    ed._render();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(calls.filter(c => c.type === 'home_tasks/get_defaults').length, 2);
    ed.remove();
  });
});


describe('boot-window lists retry (#37 family)', () => {
  async function makeCard(responses) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass(responses);
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    card.hass = hass;
    await flush(card);
    return { card, hass };
  }

  test('failed get_lists schedules a backoff retry instead of giving up', async () => {
    const { card } = await makeCard({
      'home_tasks/get_lists': () => { throw new Error('unknown command'); },
      'home_tasks/get_external_lists': () => { throw new Error('unknown command'); },
    });
    assert.ok(card._listsRetryTimer, 'retry timer armed');
    assert.equal(card._listsRetryCount, 1);
    card.remove(); // disconnectedCallback clears the pending timer
  });

  test('a configured list missing from the response also triggers the retry', async () => {
    const { card } = await makeCard({
      'home_tasks/get_lists': { lists: [{ id: 'OTHER', name: 'Not mine' }] },
      'home_tasks/get_tasks': { tasks: [] },
    });
    assert.ok(card._listsRetryTimer, 'retry armed while configured list is absent');
    card.remove();
  });

  test('a later successful load heals the card and resets the retry state', async () => {
    const responses = {
      'home_tasks/get_lists': () => { throw new Error('unknown command'); },
      'home_tasks/get_tasks': { tasks: [{ id: 'T1', title: 'Back', sort_order: 0, sub_items: [] }] },
    };
    const { card } = await makeCard(responses);
    assert.equal(card._lists.length, 0);
    // backend comes up: the same fetch now answers
    responses['home_tasks/get_lists'] = { lists: [{ id: 'L1', name: 'Mine' }] };
    clearTimeout(card._listsRetryTimer);
    card._listsRetryTimer = null;
    await card._loadLists();
    await flush(card);
    assert.equal(card._lists.length, 1);
    assert.equal(card._listsRetryCount, 0, 'retry state reset after full success');
    assert.equal(card._listsRetryTimer, null);
    assert.ok(card.shadowRoot.querySelector('.task[data-task-id="T1"]'), 'tasks render after heal');
    card.remove();
  });

  test('a clean load never schedules a retry', async () => {
    const { card } = await makeCard({
      'home_tasks/get_lists': { lists: [{ id: 'L1', name: 'Mine' }] },
      'home_tasks/get_tasks': { tasks: [] },
    });
    assert.equal(card._listsRetryTimer ?? null, null);
    assert.equal(card._listsRetryCount ?? 0, 0);
    card.remove();
  });
});


describe('review round 3 card fixes', () => {
  test('server response adoption is skipped while a local patch is pending', async () => {
    const { window: win } = await loadCard({ force: true });
    const ed = win.document.createElement('home-tasks-card-editor');
    let resolveFirst;
    let setCalls = 0;
    ed.hass = {
      language: 'en',
      states: {},
      callWS: async (msg) => {
        if (msg.type === 'home_tasks/get_defaults') return { defaults: { assignee: null, reminders: [10, 30] } };
        if (msg.type === 'home_tasks/set_defaults') {
          setCalls++;
          if (setCalls === 1) {
            // stale server state from BEFORE the second local edit
            return new Promise((res) => { resolveFirst = () => res({ defaults: { assignee: null, reminders: [30] } }); });
          }
          return { defaults: { assignee: null, reminders: msg.reminders } };
        }
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    };
    ed.setConfig({ columns: [{ list_id: 'L1' }] });
    win.document.body.appendChild(ed);
    await new Promise(r => setTimeout(r, 30));
    const root = ed.shadowRoot || ed;
    const removeButtons = () => root.querySelectorAll('.def-reminder-row .icon-btn');
    assert.equal(removeButtons().length, 2);
    removeButtons()[0].click();           // remove 10 -> flush-1 in flight (hangs)
    await new Promise(r => setTimeout(r, 5));
    removeButtons()[0].click();           // remove 30 -> queued as pending, local []
    await new Promise(r => setTimeout(r, 5));
    resolveFirst();                        // stale response [30] arrives
    await new Promise(r => setTimeout(r, 10));
    // adoption must NOT revert the local state to [30] while pending existed;
    // the trailing flush sends [] and its response is adopted instead
    assert.equal(removeButtons().length, 0, 'both removed rows stay removed');
    ed.remove();
  });

  test('a pending lists retry resumes after detach/reattach', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const hass = makeRecordingHass({
      'home_tasks/get_lists': () => { throw new Error('unknown command'); },
      'home_tasks/get_external_lists': () => { throw new Error('unknown command'); },
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1' }] });
    const doc = card.ownerDocument;
    doc.body.appendChild(card);
    card.hass = hass;
    await flush(card);
    assert.ok(card._listsRetryTimer, 'retry armed after failed boot fetch');
    card.remove();                         // disconnect cancels the timer
    assert.equal(card._listsRetryTimer, null);
    doc.body.appendChild(card);            // reattach (dashboard view switch)
    assert.ok(card._listsRetryTimer, 'retry rescheduled on reattach');
    card.remove();
  });
});
