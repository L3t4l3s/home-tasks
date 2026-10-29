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

describe('the draft and the list defaults', () => {
  async function draftCard(colConfig, defaults, { external = false } = {}) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [external ? { entity_id: 'todo.x', ...colConfig } : { list_id: 'L1', ...colConfig }] });
    const calls = [];
    card.hass = makeMockHass({
      callWS: async (m) => {
        calls.push(m);
        if (m.type === 'home_tasks/get_defaults') return { defaults };
        if (m.type === 'home_tasks/add_task') return { id: 'NEW1' };
        if (m.type === 'home_tasks/create_external_task') return { uid: 'U1' };
        return null;
      },
    });
    if (external) card._sourceDefaults['todo.x'] = defaults;
    card._render = () => {};
    card._loadAllTasks = async () => {};
    card._reloadExternal = () => {};
    const cs = card._columns[0];
    cs.newTaskTitle = 'Task';
    return { card, cs, calls };
  }
  const plain = (o) => JSON.parse(JSON.stringify(o));

  test('every default person, and the due date picked in the add row', async () => {
    const { card, cs } = await draftCard({ show_add_details: true, show_add_due: true },
      { assignees: ['person.kevin', 'person.lisa'] });
    cs.newTaskDue = '2027-03-01';
    await card._openDraft(0);
    assert.deepEqual(plain(cs.draft.assigned_persons), ['person.kevin', 'person.lisa']);
    assert.equal(cs.draft.due_date, '2027-03-01');
    assert.equal(cs.newTaskDue, '');
    await card._saveDraft(0);
  });

  test('a default the draft emptied stays empty', async () => {
    const { card, cs, calls } = await draftCard({ show_add_details: true },
      { assignees: ['person.kevin'], tags: ['home'], priority: 2 });
    await card._openDraft(0);
    await card._updateTaskRouted(0, cs.draft.id, { assigned_persons: [], tags: [], priority: null });
    await card._saveDraft(0);
    const upd = calls.find((c) => c.type === 'home_tasks/update_task');
    assert.equal(upd.task_id, 'NEW1');
    assert.deepEqual(plain(upd.assigned_persons), []);
    assert.deepEqual(plain(upd.tags), []);
    assert.equal(upd.priority, null);
  });

  test('a kept default sends no clean-up', async () => {
    const { card, calls } = await draftCard({ show_add_details: true }, { tags: ['home'] });
    await card._openDraft(0);
    await card._saveDraft(0);
    assert.ok(!calls.some((c) => c.type === 'home_tasks/update_task'));
  });

  test('external list: recurrence follows creation, not inside it', async () => {
    const { card, cs, calls } = await draftCard({ show_add_details: true }, {}, { external: true });
    await card._openDraft(0);
    await card._updateTaskRouted(0, cs.draft.id, { recurrence_enabled: true, recurrence_end_type: 'count', recurrence_max_count: 3 });
    await card._saveDraft(0);
    const create = calls.find((c) => c.type === 'home_tasks/create_external_task');
    assert.equal('recurrence_end_type' in create, false);
    const upd = calls.find((c) => c.type === 'home_tasks/update_external_task');
    assert.equal(upd.task_uid, 'U1');
    assert.equal(upd.recurrence_max_count, 3);
  });

  test('Add pressed twice creates one task', async () => {
    const { card, calls } = await draftCard({ show_add_details: true }, {});
    await card._openDraft(0);
    await Promise.all([card._saveDraft(0), card._saveDraft(0)]);
    assert.equal(calls.filter((c) => c.type === 'home_tasks/add_task').length, 1);
  });

  test('no sub-tasks, images or history before the task exists', async () => {
    const { card, cs } = await draftCard({ show_add_details: true, show_images: true, show_history: true }, {});
    await card._openDraft(0);
    const panel = card._buildDraftPanel(cs, 0);
    const labels = [...panel.querySelectorAll('.detail-label')].map((l) => l.textContent);
    for (const l of ['Sub-tasks', 'History', 'Image']) assert.ok(!labels.includes(l), JSON.stringify(labels));
    assert.ok(labels.includes('Notes'), JSON.stringify(labels));
  });
});
