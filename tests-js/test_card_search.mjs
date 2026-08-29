/**
 * Live search in the add-task field (PR #51 + follow-up fixes).
 *
 * Typing in the add-task input filters the column to matching tasks instead
 * of blindly offering to add a duplicate. The tricky part is that the list is
 * swapped in place — a full re-render would recreate the <input> and make the
 * on-screen keyboard flicker on mobile — so these tests pin down that the
 * swapped-in body is equivalent to what a full render would produce.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const LISTS = [
  { id: 'L1', name: 'Household', sensor_entity_id: 'sensor.household_open_tasks' },
  { id: 'L2', name: 'Shopping', sensor_entity_id: 'sensor.shopping_open_tasks' },
];

const SECTIONS = [
  { id: 'S_A', name: 'Indoors', sort_order: 0 },
  { id: 'S_B', name: 'Outdoors', sort_order: 1 },
];

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, ...over,
});

const TASKS_L1 = [
  TASK({ id: 'T1', title: 'Take out the bins', sort_order: 0, section_id: 'S_B' }),
  TASK({ id: 'T2', title: 'Water the plants', sort_order: 1, section_id: 'S_A' }),
  TASK({ id: 'T3', title: 'Bin bags', sort_order: 2 }),
  TASK({ id: 'T4', title: 'Sort the recycling', sort_order: 3, completed: true }),
];

const TASKS_L2 = [TASK({ id: 'X1', title: 'Milk', sort_order: 0 })];

function makeHass() {
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
        const tasks = msg.list_id === 'L1' ? TASKS_L1 : TASKS_L2;
        return { tasks: tasks.map((t) => ({ ...t })), sections: msg.list_id === 'L1' ? SECTIONS : [] };
      }
      if (msg.type === 'home_tasks/add_task') {
        return { ...TASK({ id: 'NEW', title: msg.title, sort_order: 9 }) };
      }
      if (msg.type === 'home_tasks/update_task') return null;
      return null;
    },
    callService: async () => null,
  };
}

async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

async function mount(colExtra = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const hass = makeHass();
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', default_filter: 'all', ...colExtra }] });
  card.hass = hass;
  await flush();
  return { card, hass };
}

const input = (card, colIdx = 0) =>
  card.shadowRoot.querySelector(`.add-input[data-focus-key="add_task_col_${colIdx}"]`);
const titles = (card) =>
  [...card.shadowRoot.querySelectorAll('.task .task-title')].map((e) => e.textContent.trim());
const sectionNames = (card) =>
  [...card.shadowRoot.querySelectorAll('.section-header .section-name')].map((e) => e.textContent.trim());
const body = (card) => card.shadowRoot.querySelector('.task-list, .tile-grid-wrap');

async function type(card, text, colIdx = 0) {
  const el = input(card, colIdx);
  el.value = text;
  el.dispatchEvent(new card.ownerDocument.defaultView.Event('input', { bubbles: true }));
  await flush();
  return el;
}

async function press(card, key, colIdx = 0) {
  const el = input(card, colIdx);
  el.dispatchEvent(new card.ownerDocument.defaultView.KeyboardEvent('keydown', { key, bubbles: true }));
  await flush();
}

// ---------------------------------------------------------------------------

describe('add-task search', () => {
  test('typing filters the column to matching tasks, completed ones included', async () => {
    const { card } = await mount();
    await type(card, 'bin');
    assert.deepEqual(titles(card), ['Bin bags', 'Take out the bins'], 'prefix match first');
  });

  test('section headers give way to a flat result list', async () => {
    const { card } = await mount();
    assert.deepEqual(sectionNames(card), ['Indoors', 'Outdoors', 'Done']);
    await type(card, 'bin');
    assert.deepEqual(sectionNames(card), []);
  });

  test('no match shows the empty state', async () => {
    const { card } = await mount();
    await type(card, 'zzz');
    assert.equal(titles(card).length, 0);
    assert.ok(card.shadowRoot.querySelector('.task-list .empty-state'));
  });

  test('Escape clears the search and restores the section view', async () => {
    const { card } = await mount();
    await type(card, 'bin');
    await press(card, 'Escape');
    assert.deepEqual(sectionNames(card), ['Indoors', 'Outdoors', 'Done']);
    assert.equal(input(card).value, '');
  });

  test('the add-task input is never recreated while searching', async () => {
    const { card } = await mount();
    const before = input(card);
    await type(card, 'bin');
    await press(card, 'Escape');
    assert.equal(input(card), before, 'same DOM node — otherwise the mobile keyboard flickers');
  });

  // Tasks that survive the query slide from their old spot to their new one,
  // the same FLIP sorting and filtering use — most visible in tiles view,
  // where the grid reflows in two dimensions. jsdom has no layout engine
  // (every rect is 0×0), so the transforms themselves can only be verified in
  // a real browser; what is pinned here is the wiring: positions captured
  // before the swap, flip applied after, with the whole pre-search set as the
  // reference so nothing is left to jump.
  test('the surviving tasks are handed to the FLIP animation', async () => {
    const { card } = await mount();
    const seen = [];
    const capture = card._captureListFlip.bind(card);
    const apply = card._applyFlip.bind(card);
    card._captureListFlip = (i) => {
      const m = capture(i);
      seen.push({ step: 'capture', ids: [...m.keys()].sort() });
      return m;
    };
    card._applyFlip = (before, i, duration) => {
      seen.push({ step: 'apply', ids: [...before.keys()].sort(), duration });
      return apply(before, i, duration);
    };

    await type(card, 'bin');

    assert.deepEqual(seen.map((s) => s.step), ['capture', 'apply']);
    assert.deepEqual(seen[0].ids, ['T1', 'T2', 'T3', 'T4'], 'captured before the swap');
    assert.deepEqual(seen[1].ids, seen[0].ids);
    assert.equal(seen[1].duration, 0.2, 'shorter than sort/filter — it runs per keystroke');
  });

  test('show_task_search: false leaves the list alone', async () => {
    const { card } = await mount({ show_task_search: false });
    await type(card, 'bin');
    assert.equal(titles(card).length, 4);
    assert.equal(card._columns[0].taskSearchQuery, '');
  });
});

describe('add-task search — max_height', () => {
  // The cap lives on the body node, which the search swaps out. Losing it
  // makes the list grow out of an overflow-hidden card, putting tasks out of
  // reach.
  const capped = (card) => {
    const el = body(card);
    return { scrollable: el.classList.contains('scrollable'), maxHeight: el.style.maxHeight };
  };

  test('survives typing and clearing the search', async () => {
    const { card } = await mount({ max_height: 280 });
    assert.deepEqual(capped(card), { scrollable: true, maxHeight: '280px' });

    await type(card, 'bin');
    assert.deepEqual(capped(card), { scrollable: true, maxHeight: '280px' }, 'kept while searching');

    await press(card, 'Escape');
    assert.deepEqual(capped(card), { scrollable: true, maxHeight: '280px' }, 'kept after clearing');
  });

  test('an uncapped column stays uncapped', async () => {
    const { card } = await mount();
    await type(card, 'bin');
    assert.deepEqual(capped(card), { scrollable: false, maxHeight: '' });
  });
});

describe('add-task search — tiles view', () => {
  const tileTitles = (card) =>
    [...card.shadowRoot.querySelectorAll('.task-tile .tile-title')].map((e) => e.textContent.trim());

  test('filters the tiles too', async () => {
    const { card } = await mount({ view_mode: 'tiles' });
    assert.equal(tileTitles(card).length, 4);
    await type(card, 'bin');
    assert.deepEqual(tileTitles(card).sort(), ['Bin bags', 'Take out the bins']);
  });

  test('swaps the grid in place instead of re-rendering the card', async () => {
    const { card } = await mount({ view_mode: 'tiles' });
    const before = input(card);
    await type(card, 'bin');
    assert.equal(input(card), before);
  });

  test('Escape restores the full grid', async () => {
    const { card } = await mount({ view_mode: 'tiles' });
    await type(card, 'bin');
    await press(card, 'Escape');
    assert.equal(tileTitles(card).length, 4);
  });
});

describe('add-task search — lifecycle', () => {
  test('adding the task clears the search', async () => {
    const { card } = await mount();
    await type(card, 'Something new');
    assert.equal(titles(card).length, 0, 'no match while typing');
    await press(card, 'Enter');
    await flush();
    assert.equal(card._columns[0].taskSearchQuery, '');
    assert.deepEqual(sectionNames(card), ['Indoors', 'Outdoors', 'Done']);
  });

  test('pointing the column at another list drops the stale query', async () => {
    const { card } = await mount();
    await type(card, 'bin');
    assert.equal(titles(card).length, 2);

    card.setConfig({ columns: [{ list_id: 'L2', default_filter: 'all' }] });
    await flush();

    assert.equal(card._columns[0].taskSearchQuery, '');
    assert.deepEqual(titles(card), ['Milk'], 'the new list is shown unfiltered');
  });

  test('completing a match ends the search', async () => {
    const { card } = await mount();
    await type(card, 'bin');
    await card._toggleTask('T3', false, 0);
    await flush();
    assert.equal(card._columns[0].taskSearchQuery, '');
  });

  test('reopening a match keeps the search', async () => {
    const { card } = await mount();
    await type(card, 'recycl');
    await card._toggleTask('T4', true, 0);  // completed → reopen
    await flush();
    assert.equal(card._columns[0].taskSearchQuery, 'recycl');
  });

  test('cancelling the confirm_complete prompt keeps the search and the typed text', async () => {
    const { card } = await mount({ confirm_complete: true });
    await type(card, 'bin');

    const pending = card._toggleTask('T3', false, 0);
    await flush();
    const dlg = card.shadowRoot.querySelector('dialog.ht-confirm');
    assert.ok(dlg, 'confirm dialog must be shown');
    dlg.querySelector('.ht-confirm-btn:not(.primary)').click();  // cancel
    await pending;
    await flush();

    assert.equal(card._columns[0].taskSearchQuery, 'bin', 'a cancelled tap must not wipe the search');
    assert.equal(input(card).value, 'bin');
    assert.deepEqual(titles(card), ['Bin bags', 'Take out the bins']);
  });

  test('confirming completes and ends the search', async () => {
    const { card, hass } = await mount({ confirm_complete: true });
    await type(card, 'bin');

    const pending = card._toggleTask('T3', false, 0);
    await flush();
    card.shadowRoot.querySelector('dialog.ht-confirm .ht-confirm-btn.primary').click();
    await pending;
    await flush();

    assert.ok(hass.calls.some((c) => c.type === 'home_tasks/update_task' && c.completed === true));
    assert.equal(card._columns[0].taskSearchQuery, '');
  });
});
