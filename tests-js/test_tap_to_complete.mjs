/**
 * tap_to_complete: the whole list row ticks the task off (issue #69).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

async function makeCard(colExtra = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const calls = [];
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [{ id: 'T1', title: 'Bins', sort_order: 0, completed: false, sub_items: [], tags: ['weekly'], reminders: [] }] };
      return null;
    },
    callService: async () => {},
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
  card.hass = hass;
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
  return { card, calls };
}

const q = (card, sel) => card.shadowRoot.querySelector(sel);
const click = (el, detail = 1) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
const tick = () => new Promise(r => setTimeout(r, 0));
const completedCalls = (calls) => calls.filter(c => c.type === 'home_tasks/update_task' && c.completed === true);

describe('tap_to_complete', () => {
  test('off (default): tapping the row opens the details', async () => {
    const { card, calls } = await makeCard();
    click(q(card, '.task-content'));
    await tick();
    assert.ok(card._expandedTasks.has('T1'));
    assert.equal(completedCalls(calls).length, 0);
  });

  test('on: tapping the row completes the task', async () => {
    const { card, calls } = await makeCard({ tap_to_complete: true });
    click(q(card, '.task-title'));
    await tick(); await tick();
    assert.equal(completedCalls(calls).length, 1);
    assert.equal(card._expandedTasks.has('T1'), false);
  });

  test('on: the chevron still opens the details', async () => {
    const { card, calls } = await makeCard({ tap_to_complete: true });
    click(q(card, '.expand-btn'));
    await tick();
    assert.ok(card._expandedTasks.has('T1'));
    assert.equal(completedCalls(calls).length, 0);
  });

  test('on, with confirm_complete: it asks first', async () => {
    const { card, calls } = await makeCard({ tap_to_complete: true, confirm_complete: true });
    let asked = null;
    card._confirmDialog = async (msg) => { asked = msg; return false; };
    click(q(card, '.task-content'));
    await tick(); await tick();
    assert.equal(asked, 'Mark "Bins" as completed?');
    assert.equal(completedCalls(calls).length, 0, 'cancelled — nothing saved');
  });

  test('on: the click that ends a touch drag does not complete the task', async () => {
    const { card, calls } = await makeCard({ tap_to_complete: true });
    card._suppressRowTapUntil = Date.now() + 500;   // what the touch drag's end sets
    click(q(card, '.task-content'));
    await tick();
    assert.equal(completedCalls(calls).length, 0);
  });

  test('a touch drag released on the checkbox does not tick it (any setting)', async () => {
    const { card, calls } = await makeCard();
    document.body.appendChild(card);                 // jsdom fires "change" only when connected
    for (let i = 0; i < 6; i++) await tick();
    card._suppressRowTapUntil = Date.now() + 500;
    q(card, '.checkbox-container input').click();
    await tick(); await tick();
    assert.equal(completedCalls(calls).length, 0);
    card._suppressRowTapUntil = 0;
    q(card, '.checkbox-container input').click();
    await tick(); await tick();
    assert.equal(completedCalls(calls).length, 1);
    card.remove();
  });

  test('on: a double-click on the title does not open title editing', async () => {
    const { card } = await makeCard({ tap_to_complete: true });
    q(card, '.task-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    assert.equal(card._editingTaskId ?? null, null);
  });

  test('on: tag and person chips keep their own click', async () => {
    const { card, calls } = await makeCard({ tap_to_complete: true });
    const tag = q(card, '.tag-badge');
    assert.ok(tag, 'tag chip rendered');
    click(tag);
    await tick();
    assert.equal(completedCalls(calls).length, 0);
  });
});

describe('editor', () => {
  async function editorFor(colExtra) {
    const { window } = await loadCard({ force: true });
    const Editor = window.customElements.get('home-tasks-card-editor');
    const ed = new Editor();
    ed.hass = { language: 'en', states: {}, callWS: async (m) => {
      if (m.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
      if (m.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      return null;
    } };
    ed.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
    window.document.body.appendChild(ed);
    await new Promise(r => setTimeout(r, 50));
    return [...ed.shadowRoot.querySelectorAll('.toggle-label')].map(e => e.textContent);
  }

  test('the switch is offered in list view only', async () => {
    assert.ok((await editorFor({})).includes('Tap row to complete'));
    assert.equal((await editorFor({ view_mode: 'tiles' })).includes('Tap row to complete'), false);
  });
});
