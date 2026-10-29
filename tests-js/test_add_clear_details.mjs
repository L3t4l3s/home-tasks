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

  test('the pencil pressed again closes the draft and gives the title back', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Gutters';
    await card._openDraft(0);
    const btn = card._buildColumnAddTask(cs, 0).querySelector('.add-details-btn');
    assert.ok(btn.classList.contains('active'));
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    btn.click();
    assert.equal(cs.draft, null);
    assert.equal(cs.newTaskTitle, 'Gutters');
    assert.ok(!calls.some((c) => c.type === 'home_tasks/add_task'));
  });

  test('the clear button shows while a draft is open and drops it', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Gutters';
    await card._openDraft(0);
    const clear = card._buildColumnAddTask(cs, 0).querySelector('.add-clear-btn');
    assert.equal(clear.style.display, '', 'shown although the field is empty');
    clear.click();
    assert.equal(cs.draft, null);
    assert.equal(cs.newTaskTitle, '');
    assert.ok(!calls.some((c) => c.type === 'home_tasks/add_task'));
  });

  test('the add field is the draft title; no due row and no search meanwhile', async () => {
    const { card, calls } = await makeCard({ show_add_details: true, show_add_due: true });
    card._colSupportsDue = () => true;
    const cs = card._columns[0];
    cs.newTaskTitle = 'Gutters';
    const before = card._buildColumnAddTask(cs, 0);
    assert.ok(before.querySelector('.add-due-row'), 'due row without a draft');
    await card._openDraft(0);
    assert.equal(card._buildDraftPanel(cs, 0).querySelector('input.add-input'), null, 'no second title field');
    const row = card._buildColumnAddTask(cs, 0);
    assert.equal(row.querySelector('.add-due-row'), null, 'due row gone while drafting');
    const input = row.querySelector('.add-input');
    assert.equal(input.value, 'Gutters');
    card._refreshTaskListDOM = () => { throw new Error('searched'); };
    input.value = 'Clean gutters';
    input.dispatchEvent(new window.Event('input'));
    assert.equal(cs.draft.title, 'Clean gutters');
    assert.equal(cs.taskSearchQuery, '');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 0));
    const add = calls.find((c) => c.type === 'home_tasks/add_task');
    assert.equal(add.title, 'Clean gutters');
    assert.equal(cs.draft, null);
  });

  test('the pencil opens the draft with an empty field too; Add without a title creates nothing', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    let nudged = 0;
    card._nudgeAddInput = () => { nudged++; };
    card._buildColumnAddTask(cs, 0).querySelector('.add-details-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(cs.draft, 'draft opened');
    assert.equal(cs.draft.title, '');
    await card._saveDraft(0);
    assert.equal(nudged, 1);
    assert.ok(cs.draft, 'still open');
    assert.ok(!calls.some((c) => c.type === 'home_tasks/add_task'));
  });

  test('+ creates the draft; Escape in the field closes it', async () => {
    const { card, calls } = await makeCard({ show_add_details: true });
    const cs = card._columns[0];
    cs.newTaskTitle = 'Gutters';
    await card._openDraft(0);
    let row = card._buildColumnAddTask(cs, 0);
    row.querySelector('.add-input').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(cs.draft, null);
    assert.equal(cs.newTaskTitle, 'Gutters');
    await card._openDraft(0);
    row = card._buildColumnAddTask(cs, 0);
    [...row.querySelectorAll('.add-btn')].find((b) => b.textContent === '+').click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.filter((c) => c.type === 'home_tasks/add_task').length, 1);
    assert.equal(cs.draft, null);
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

describe('show_add_details review fixes', () => {
  async function draftCard(colConfig, defaults, { external = false, fail = [] } = {}) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [external ? { entity_id: 'todo.x', ...colConfig } : { list_id: 'L1', ...colConfig }] });
    const calls = [];
    const errors = [];
    card.hass = makeMockHass({
      callWS: async (m) => {
        calls.push(m);
        if (fail.includes(m.type)) throw new Error('boom');
        if (m.type === 'home_tasks/get_defaults') return { defaults };
        if (m.type === 'home_tasks/add_task') return { id: 'NEW1' };
        if (m.type === 'home_tasks/create_external_task') return { uid: 'U1' };
        return null;
      },
    });
    card._render = () => {};
    card._loadAllTasks = async () => {};
    card._reloadExternal = () => {};
    card._showError = (msg) => errors.push(msg);
    const cs = card._columns[0];
    cs.newTaskTitle = 'Task';
    return { card, cs, calls, errors };
  }
  const writes = (calls) => calls.filter((c) => /update|delete|reorder/.test(c.type));

  test('no detail field of a draft writes to the backend', async () => {
    for (const external of [false, true]) {
      const { card, cs, calls } = await draftCard(
        { show_add_details: true, show_images: true, show_history: true }, {}, { external });
      cs.sections = [{ id: 'S1', name: 'Bakery', sort_order: 0 }, { id: 'S2', name: 'Fruit', sort_order: 1 }];
      await card._openDraft(0);
      const panel = card._buildDraftPanel(cs, 0);
      for (const sel of panel.querySelectorAll('select')) {
        if (sel.options.length < 2) continue;
        sel.value = sel.options[sel.options.length - 1].value;
        sel.dispatchEvent(new window.Event('change'));
      }
      for (const inp of panel.querySelectorAll('input[type="date"], input[type="time"], input[type="number"]')) {
        inp.value = inp.type === 'date' ? '2027-03-01' : inp.type === 'time' ? '08:00' : '2';
        inp.dispatchEvent(new window.Event('change'));
      }
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(writes(calls), [], `${external ? 'external' : 'native'}: ${JSON.stringify(writes(calls))}`);
      assert.equal(cs.draft.section_id, 'S2', 'the section stays on the draft');
    }
  });

  test('dictating while drafting sets the draft title, without searching', async () => {
    const { card, cs } = await draftCard({ show_add_details: true }, {});
    await card._openDraft(0);
    card._refreshTaskListDOM = () => { throw new Error('searched'); };
    card._startHAStt = async (_c, _i, setTranscript) => setTranscript('Clean windows');
    card._startVoiceInput(0);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(cs.draft.title, 'Clean windows');
    assert.equal(cs.newTaskTitle, '');
    assert.equal(cs.taskSearchQuery, '');
  });

  test('a failure after creating closes the draft and reports it', async () => {
    const { card, cs, calls, errors } = await draftCard({ show_add_details: true }, {}, { fail: ['home_tasks/update_task'] });
    await card._openDraft(0);
    cs.draft.recurrence_enabled = true;
    await card._saveDraft(0);
    assert.equal(calls.filter((c) => c.type === 'home_tasks/add_task').length, 1);
    assert.equal(cs.draft, null, 'closed: Add again would create it twice');
    assert.deepEqual(errors, ['Task added, but some of its details could not be saved']);
  });

  test('a failed create keeps the draft', async () => {
    const { card, cs, errors } = await draftCard({ show_add_details: true }, {}, { fail: ['home_tasks/add_task'] });
    await card._openDraft(0);
    await card._saveDraft(0);
    assert.ok(cs.draft);
    assert.deepEqual(errors, ['Could not add task']);
  });

  test('a save finishing late leaves a newer draft alone', async () => {
    const { card, cs } = await draftCard({ show_add_details: true }, {});
    await card._openDraft(0);
    const saving = card._saveDraft(0);
    card._closeDraft(0, false);
    cs.newTaskTitle = 'Next';
    await card._openDraft(0);
    const next = cs.draft;
    await saving;
    assert.equal(cs.draft, next);
  });

  test('an external draft asks for the current defaults', async () => {
    const { card, cs, calls } = await draftCard({ show_add_details: true }, { tags: ['fresh'] }, { external: true });
    card._sourceDefaults['todo.x'] = { tags: ['stale'] };
    await card._openDraft(0);
    assert.ok(calls.some((c) => c.type === 'home_tasks/get_defaults' && c.entity_id === 'todo.x'));
    assert.equal(JSON.stringify(cs.draft.tags), '["fresh"]');
    assert.deepEqual(card._sourceDefaults['todo.x'], { tags: ['fresh'] });
  });

  test('closing gives the title back as a search, like typed text', async () => {
    const { card, cs } = await draftCard({ show_add_details: true }, {});
    await card._openDraft(0);
    cs.draft.title = 'Milk ';
    card._closeDraft(0, true);
    assert.equal(cs.newTaskTitle, 'Milk ');
    assert.equal(cs.taskSearchQuery, 'Milk');
  });

  test('the pressed pencil is labelled by what it does', async () => {
    const { card, cs } = await draftCard({ show_add_details: true }, {});
    let btn = card._buildColumnAddTask(cs, 0).querySelector('.add-details-btn');
    assert.equal(btn.title, 'Add with details');
    await card._openDraft(0);
    btn = card._buildColumnAddTask(cs, 0).querySelector('.add-details-btn');
    assert.equal(btn.title, 'Cancel');
    assert.equal(btn.getAttribute('aria-label'), 'Cancel');
  });
});
