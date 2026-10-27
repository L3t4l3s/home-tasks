/**
 * Add row: a clear (x) button inside the field, and show_add_details' second
 * button that creates the task with its details open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function makeCard(colConfig = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  const calls = [];
  card.hass = makeMockHass({
    callWS: async (m) => {
      calls.push(m);
      if (m.type === 'home_tasks/add_task') return { id: 'NEW1', title: m.title };
      return null;
    },
  });
  card._render = () => {};
  card._loadAllTasks = async () => {};
  return { card, calls };
}

describe('add row clear button', () => {
  test('hidden when empty, shown while typing, clears title and search', async () => {
    const { card } = await makeCard();
    const cs = card._columns[0];
    const row = card._buildColumnAddTask(cs, 0);
    const input = row.querySelector('.add-input');
    const clear = row.querySelector('.add-clear-btn');
    assert.equal(clear.style.display, 'none');
    input.value = 'Milk';
    input.dispatchEvent(new window.Event('input'));
    assert.equal(clear.style.display, '');
    assert.equal(cs.newTaskTitle, 'Milk');
    card._refreshTaskListDOM = () => {};
    clear.click();
    assert.equal(input.value, '');
    assert.equal(cs.newTaskTitle, '');
    assert.equal(cs.taskSearchQuery, '');
  });
});

describe('show_add_details (draft)', () => {
  test('off by default: only the + button', async () => {
    const { card } = await makeCard();
    const row = card._buildColumnAddTask(card._columns[0], 0);
    assert.equal(row.querySelector('.add-details-btn'), null);
  });

  test('the button opens a draft; nothing is created until Add', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Book MOT';
    card._buildColumnAddTask(cs, 0).querySelector('.add-details-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(cs.draft, 'draft opened');
    assert.equal(cs.draft.title, 'Book MOT');
    assert.equal(cs.newTaskTitle, '');
    assert.ok(!calls.some((c) => c.type === 'home_tasks/add_task'));

    // edits made through the normal detail fields land on the draft
    await card._updateTaskRouted(0, cs.draft.id, { due_date: '2027-01-10', notes: 'KW68' });
    assert.ok(!calls.some((c) => c.type === 'home_tasks/update_task'));

    const panel = card._buildDraftPanel(cs, 0);
    assert.ok(panel.querySelector('.task-details'), 'detail fields shown');
    assert.equal(panel.querySelector('.detail-actions'), null, 'no duplicate/delete row');
    await card._saveDraft(0);
    const add = calls.find((c) => c.type === 'home_tasks/add_task');
    assert.equal(add.title, 'Book MOT');
    assert.equal(add.due_date, '2027-01-10');
    assert.equal(add.notes, 'KW68');
    assert.equal(cs.draft, null);
  });

  test('the draft shows its fields (not the collapsed height:0 of a task row)', async () => {
    const { card } = await makeCard({ show_add_details: true });
    const css = card.shadowRoot ? [...card.shadowRoot.querySelectorAll('style')].map((x) => x.textContent).join('') : '';
    const src = css || (await import('node:fs')).readFileSync(new URL('../custom_components/home_tasks/home-tasks-card.js', import.meta.url), 'utf8');
    assert.match(src, /\.task-draft \.task-details \{ height: auto;/);
  });

  test('Cancel discards the draft and gives the title back', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Gutters';
    await card._openDraft(0);
    const panel = card._buildDraftPanel(cs, 0);
    panel.querySelector('.draft-cancel-btn').click();
    assert.equal(cs.draft, null);
    assert.equal(cs.newTaskTitle, 'Gutters');
    assert.ok(!calls.some((c) => c.type === 'home_tasks/add_task'));
  });

  test('recurrence set on the draft is applied after creation', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Bins';
    await card._openDraft(0);
    await card._updateTaskRouted(0, cs.draft.id, { recurrence_enabled: true, recurrence_unit: 'weeks', recurrence_value: 2 });
    await card._saveDraft(0);
    const upd = calls.find((c) => c.type === 'home_tasks/update_task');
    assert.equal(upd.task_id, 'NEW1');
    assert.equal(upd.recurrence_unit, 'weeks');
    assert.equal(upd.recurrence_value, 2);
  });
});
