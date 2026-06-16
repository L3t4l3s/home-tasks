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
