/**
 * detail_order: the task-details fields in a chosen order.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function labels(colConfig) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', show_sub_tasks: false, show_tags: false, ...colConfig }] });
  card.hass = makeMockHass();
  card._render = () => {};
  const task = { id: 'T1', title: 'x', completed: false, sub_items: [], tags: [], notes: '' };
  card._columns[0].tasks = [task];
  const el = card._buildTaskDetails(task, 0);
  return [...el.querySelectorAll('.task-details-inner > .detail-section > .detail-label, .task-details-inner > .detail-section > label')]
    .map((l) => l.textContent);
}

describe('detail_order', () => {
  test('default order unchanged', async () => {
    const got = await labels({});
    assert.ok(got.indexOf('Notes') < got.indexOf('Due'), JSON.stringify(got));
  });

  test('listed fields first, the rest in default order; notes last', async () => {
    const order = ['due_date', 'person', 'priority', 'reminders', 'recurrence', 'notes'];
    const got = await labels({ detail_order: order });
    assert.equal(got[0], 'Due', JSON.stringify(got));
    assert.equal(got.at(-1), 'Notes', JSON.stringify(got));
  });

  test('unknown and duplicate keys are ignored', async () => {
    const got = await labels({ detail_order: ['bogus', 'due_date', 'due_date'] });
    assert.equal(got[0], 'Due');
    assert.equal(got.filter((l) => l === 'Due').length, 1);
  });
});

describe('detail fields in the editor', () => {
  async function editor(col = {}, sections = null) {
    const { window } = await loadCard({ force: true });
    const ed = new (window.customElements.get('home-tasks-card-editor'))();
    ed.hass = makeMockHass({ states: { 'person.anna': { attributes: { friendly_name: 'Anna' } } } });
    ed.setConfig({ columns: [{ list_id: 'L1', ...col }] });
    const events = [];
    ed._fireChanged = () => events.push(JSON.parse(JSON.stringify(ed._config.columns[0])));
    if (sections) ed._listSections = { [ed._sourceKeyForCol(ed._config.columns[0])]: sections };
    const root = ed._buildVisualEditor(0);
    const list = root.querySelector('.detail-field-list');
    const keys = () => [...list.querySelectorAll('.detail-field-row')].map((r) => r.dataset.key);
    const row = (key) => list.querySelector(`.detail-field-row[data-key="${key}"]`);
    return { root, list, keys, row, events };
  }

  test('one row per field, each with arrows and its switch', async () => {
    const { keys, row } = await editor();
    assert.deepEqual(keys(), ['notes', 'sub_tasks', 'person', 'section', 'priority', 'tags',
      'due_date', 'reminders', 'recurrence', 'history', 'images']);
    const notes = row('notes');
    assert.equal(notes.querySelectorAll('.icon-btn').length, 2);
    assert.ok(notes.querySelector('ha-switch').checked);
    assert.equal(row('images').querySelector('ha-switch').checked, false);
  });

  test('the arrows set detail_order, the list follows', async () => {
    const { keys, row, events } = await editor();
    row('due_date').querySelectorAll('.icon-btn')[0].click();
    // Only as far as it differs from the default order, so a field a later
    // version adds still finds its own place.
    assert.deepEqual(events.at(-1).detail_order,
      ['notes', 'sub_tasks', 'person', 'section', 'priority', 'due_date']);
    assert.equal(keys()[5], 'due_date');
  });

  test('moved back into the default order, detail_order goes', async () => {
    const { row, events } = await editor();
    row('due_date').querySelectorAll('.icon-btn')[0].click();
    row('due_date').querySelectorAll('.icon-btn')[1].click();
    assert.equal(events.at(-1).detail_order, undefined);
  });

  test('sub-tasks switched off under their older option name', async () => {
    const { row, events } = await editor({ show_sub_items: false });
    const sw = row('sub_tasks').querySelector('ha-switch');
    assert.equal(sw.checked, false);
    sw.checked = true;
    sw.dispatchEvent(new sw.ownerDocument.defaultView.Event('change'));
    assert.equal(events.at(-1).show_sub_tasks, true);
    assert.equal('show_sub_items' in events.at(-1), false);
  });

  test('without sections, the Section row says when it shows', async () => {
    const { row } = await editor({}, []);
    assert.ok(row('section').classList.contains('unavailable'));
    assert.ok(row('section').querySelector('.hint'));
    const withSections = await editor({}, [{ id: 's1', name: 'A' }]);
    assert.equal(withSections.row('section').querySelector('.hint'), null);
  });

  test('the two Images switches follow each other', async () => {
    const { root, row } = await editor();
    const inList = row('images').querySelector('ha-switch');
    const inSection = [...root.querySelectorAll('.toggle-row')]
      .find((r) => !r.dataset.key && r.textContent.includes('Images')).querySelector('ha-switch');
    inList.checked = true;
    inList.dispatchEvent(new inList.ownerDocument.defaultView.Event('change'));
    assert.equal(inSection.checked, true);
    inSection.checked = false;
    inSection.dispatchEvent(new inSection.ownerDocument.defaultView.Event('change'));
    assert.equal(inList.checked, false);
  });

  test('a switch sets its own option', async () => {
    const { row, events } = await editor();
    const sw = row('images').querySelector('ha-switch');
    sw.checked = true;
    sw.dispatchEvent(new sw.ownerDocument.defaultView.Event('change'));
    assert.equal(events.at(-1).show_images, true);
  });

  test('selectable people come after the list, not inside it', async () => {
    const { list } = await editor({ detail_order: ['person', 'notes'] });
    assert.equal(list.querySelector('.assignee-chip-row'), null);
    const after = [...list.parentElement.children].slice([...list.parentElement.children].indexOf(list) + 1);
    assert.ok(after.some((el) => el.querySelector('.assignee-chip-row')), 'the person chips follow the list');
  });
});
