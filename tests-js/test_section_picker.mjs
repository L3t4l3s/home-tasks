/**
 * Section picker in the task details: shows the list's sections and moves
 * the task with the same section_id update a drag across a header makes.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const SECTIONS = [
  { id: 'S2', name: 'House', sort_order: 1 },
  { id: 'S1', name: 'Admin', sort_order: 0 },
];

async function makeCard(colConfig = {}, { external = false } = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  const col = external ? { entity_id: 'todo.shopping_list' } : { list_id: 'L1' };
  card.setConfig({ columns: [{ ...col, ...colConfig }] });
  const calls = [];
  card.hass = makeMockHass({ callWS: async (msg) => { calls.push(msg); return null; } });
  card._render = () => {};
  card._columns[0].sections = SECTIONS;
  return { card, calls };
}

const task = (extra = {}) => ({ id: 'T1', title: 'Tax', completed: false, sub_items: [], tags: [], ...extra });

describe('section picker', () => {
  test('lists None plus the sections in their order, current one selected', async () => {
    const { card } = await makeCard();
    const el = card._buildSectionPickerSection(task({ section_id: 'S2' }), 0);
    const opts = [...el.querySelectorAll('option')].map((o) => [o.value, o.textContent, o.selected]);
    assert.deepEqual(opts, [['', '– None –', false], ['S1', 'Admin', false], ['S2', 'House', true]]);
    assert.equal(el.querySelector('.detail-label').textContent, 'Section');
  });

  test('a task in an unknown section shows None', async () => {
    const { card } = await makeCard();
    const el = card._buildSectionPickerSection(task({ section_id: 'gone' }), 0);
    assert.equal(el.querySelector('select').value, '');
  });

  test('choosing a section updates a native task', async () => {
    const { card, calls } = await makeCard();
    const t = task();
    const sel = card._buildSectionPickerSection(t, 0).querySelector('select');
    sel.value = 'S1';
    sel.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(t.section_id, 'S1');
    const call = calls.find((c) => c.type === 'home_tasks/update_task');
    assert.ok(call, 'update_task was sent');
    assert.equal(call.section_id, 'S1');
    assert.equal(call.task_id, 'T1');
  });

  test('None clears the section; external lists write the overlay', async () => {
    const { card, calls } = await makeCard({}, { external: true });
    const t = task({ section_id: 'S1' });
    const sel = card._buildSectionPickerSection(t, 0).querySelector('select');
    sel.value = '';
    sel.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    const call = calls.find((c) => c.type === 'home_tasks/update_external_overlay');
    assert.ok(call, 'update_external_overlay was sent');
    assert.equal(call.section_id, null);
    assert.equal(call.entity_id, 'todo.shopping_list');
  });

  test('a failed save reloads, so the task shows where the server has it', async () => {
    const { card } = await makeCard();
    card._callWs = async () => { throw new Error('nope'); };
    const errors = [];
    card._showError = (m) => errors.push(m);
    let reloaded = 0;
    card._loadAllTasks = async () => { reloaded += 1; };
    const sel = card._buildSectionPickerSection(task(), 0).querySelector('select');
    await new Promise((r) => setTimeout(r, 0));
    reloaded = 0; // only what the failed save does
    sel.value = 'S1';
    sel.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(errors.length, 1);
    assert.equal(reloaded, 1);
  });
});
