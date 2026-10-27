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
