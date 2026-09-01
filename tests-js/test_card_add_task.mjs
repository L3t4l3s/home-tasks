/**
 * Adding a task never fails silently (issue #59).
 *
 * The reporter pressed "+" and nothing happened at all — no task, no message,
 * nothing in the UI. There are two ways to end up there: an empty input (the
 * button has nothing to add) and a backend call that fails (swallowed by
 * _callWs, which logs and returns null). Both used to look identical to the
 * user, and identical to a broken button. These tests pin down that each one
 * now says something.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const LISTS = [{ id: 'L1', name: 'Local To-do', sensor_entity_id: null }];
const EXTERNAL = [{ entity_id: 'todo.local_todo', name: 'Local To-do', supported_features: 15 }];

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, ...over,
});

function makeHass({ failAdd = false, timeout = false } = {}) {
  const calls = [];
  return {
    language: 'en',
    states: { 'todo.local_todo': { state: '1', attributes: { supported_features: 15 } } },
    auth: {},
    calls,
    callWS: async (msg) => {
      calls.push(msg.type);
      switch (msg.type) {
        case 'home_tasks/get_lists': return { lists: LISTS };
        case 'home_tasks/get_external_lists': return { external_lists: EXTERNAL };
        case 'home_tasks/get_tasks':
          return { tasks: [TASK({ id: 'T1', title: 'Existing', sort_order: 0 })], sections: [] };
        case 'home_tasks/get_external_tasks':
          return { tasks: [TASK({ id: 'U1', title: 'Existing', sort_order: 0, _external: true })], sections: [] };
        case 'home_tasks/add_task':
          if (timeout) throw new Error('timeout');
          if (failAdd) throw new Error('unknown_error');
          return TASK({ id: 'NEW', title: msg.title });
        case 'home_tasks/create_external_task':
          if (timeout) throw new Error('timeout');
          if (failAdd) throw new Error('unknown_error');
          return { uid: 'UNEW' };
        default: return null;
      }
    },
    callService: async () => null,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(col = { list_id: 'L1' }, hassOpts = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const hass = makeHass(hassOpts);
  const card = new HomeTasksCard();
  // Focus only moves inside a connected tree, so the card has to live in the
  // document the way it does on a dashboard.
  const { window } = await loadCard();
  window.document.body.replaceChildren(card);
  card.setConfig({ columns: [col] });
  card.hass = hass;
  await flush();
  return { card, hass, win: window };
}

const addInput = (card) => card.shadowRoot.querySelector('.add-input');
const addBtn = (card) => card.shadowRoot.querySelector('.add-btn');
const toast = (card) => card.shadowRoot.querySelector('.toast-error');

async function clickPlus(card, win) {
  addBtn(card).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await flush();
}

async function type(card, win, text) {
  const el = addInput(card);
  el.value = text;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  await flush();
}

describe('adding a task says what happened', () => {
  test('+ on an empty field puts the cursor in the field instead of doing nothing', async () => {
    const { card, hass, win } = await mount();
    hass.calls.length = 0;

    await clickPlus(card, win);

    assert.equal(hass.calls.length, 0, 'nothing to add, so no backend call');
    assert.equal(card.shadowRoot.activeElement, addInput(card), 'the text goes here');
    assert.ok(addInput(card).classList.contains('nudge'), 'and the field says so visibly');
  });

  test('the nudge does not stick around', async () => {
    const { card, win } = await mount();
    await clickPlus(card, win);
    assert.ok(addInput(card).classList.contains('nudge'));
    await new Promise((r) => setTimeout(r, 750));
    assert.equal(addInput(card).classList.contains('nudge'), false);
  });

  test('+ with a title still adds the task', async () => {
    const { card, hass, win } = await mount();
    await type(card, win, 'Bread');
    hass.calls.length = 0;

    await clickPlus(card, win);

    assert.ok(hass.calls.includes('home_tasks/add_task'), 'the regression guard');
    assert.equal(toast(card), null, 'and no complaint on the happy path');
  });

  test('a native list that refuses the task shows why', async () => {
    const { card, win } = await mount({ list_id: 'L1' }, { failAdd: true });
    await type(card, win, 'Bread');

    await clickPlus(card, win);

    const t = toast(card);
    assert.ok(t, 'a failed add must not be silent');
    assert.equal(t.textContent, 'Could not add task');
  });

  test('an external list that refuses the task shows why', async () => {
    const { card, win } = await mount({ entity_id: 'todo.local_todo' }, { failAdd: true });
    await type(card, win, 'Bread');

    await clickPlus(card, win);

    assert.ok(toast(card), 'the optimistic row disappears on reload — say something first');
  });

  test('Enter behaves like the button', async () => {
    const { card, hass, win } = await mount();
    hass.calls.length = 0;
    addInput(card).dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    assert.equal(hass.calls.length, 0);
    assert.equal(card.shadowRoot.activeElement, addInput(card));
  });
});

// ---------------------------------------------------------------------------
// A refusal and a timeout are not the same thing (review follow-up).
// ---------------------------------------------------------------------------

describe('what happens to the typed title', () => {
  test('a refused external add gives the text back and removes the ghost row', async () => {
    const { card, win } = await mount({ entity_id: 'todo.local_todo' }, { failAdd: true });
    await type(card, win, 'Bread');

    await clickPlus(card, win);

    assert.ok(toast(card), 'the refusal is visible');
    assert.equal(card._columns[0].newTaskTitle, 'Bread', 'the text comes back');
    assert.equal(addInput(card).value, 'Bread', 'and it is back in the field');
    assert.equal(card._columns[0].tasks.filter((t) => String(t.id).startsWith('_pending_')).length, 0,
      'the optimistic row is gone rather than lingering until the reload');
  });

  test('a refused native add keeps the text where it was', async () => {
    const { card, win } = await mount({ list_id: 'L1' }, { failAdd: true });
    await type(card, win, 'Bread');
    await clickPlus(card, win);
    assert.equal(card._columns[0].newTaskTitle, 'Bread');
  });

  test('a timeout is not reported as a failure', async () => {
    // Our own 5s race, not a refusal: the backend may well have created the
    // task, so claiming it failed would be a lie.
    const { card, hass, win } = await mount({ list_id: 'L1' }, { timeout: true });
    await type(card, win, 'Bread');
    hass.calls.length = 0;

    await clickPlus(card, win);

    assert.equal(toast(card), null, 'no error message');
    assert.ok(hass.calls.includes('home_tasks/get_tasks'), 'the list is re-read instead');
  });

  test('an external timeout reloads and says nothing', async () => {
    const { card, win } = await mount({ entity_id: 'todo.local_todo' }, { timeout: true });
    await type(card, win, 'Bread');

    await clickPlus(card, win);

    assert.equal(toast(card), null);
    assert.ok(card._columns[0].tasks.some((t) => t.title === 'Bread'),
      'the optimistic row stays until the reload decides');
  });
});

