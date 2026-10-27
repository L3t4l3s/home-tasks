/**
 * One-tap due dates in the task details: Today, Tomorrow, Next week,
 * Next month, 3 months.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

// Noon UTC keeps "today" = 2027-01-31 in every timezone; month-end on purpose.
const FROZEN_NOW = '2027-01-31T12:00:00Z';

async function makeCard() {
  const { HomeTasksCard } = await loadCard({ force: true, frozenNow: FROZEN_NOW });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  const calls = [];
  card.hass = makeMockHass({ callWS: async (m) => { calls.push(m); return null; } });
  card._render = () => {};
  return { card, calls };
}

const task = (extra = {}) => ({ id: 'T1', title: 'Bins', completed: false, sub_items: [], tags: [], ...extra });

describe('due date quick picks', () => {
  test('five buttons, months clamp at month end', async () => {
    const { card, calls } = await makeCard();
    card._columns[0].tasks = [task()];
    const el = card._buildDateSection(card._columns[0].tasks[0], 0);
    const btns = [...el.querySelectorAll('.due-quick-btn')];
    assert.deepEqual(btns.map((b) => b.textContent), ['Today', 'Tomorrow', 'Next week', 'Next month', '3 months']);

    const dates = [];
    for (const b of btns) {
      b.click();
      await new Promise((r) => setTimeout(r, 0));
      dates.push(calls.filter((c) => c.type === 'home_tasks/update_task').at(-1).due_date);
    }
    assert.deepEqual(dates, ['2027-01-31', '2027-02-01', '2027-02-07', '2027-02-28', '2027-04-30']);
  });

  test('the current due date is highlighted and the due time kept', async () => {
    const { card, calls } = await makeCard();
    const t = task({ due_date: '2027-02-01', due_time: '18:00' });
    card._columns[0].tasks = [t];
    const btns = [...card._buildDateSection(t, 0).querySelectorAll('.due-quick-btn')];
    assert.deepEqual(btns.map((b) => b.classList.contains('active')), [false, true, false, false, false]);
    btns[2].click();
    await new Promise((r) => setTimeout(r, 0));
    const call = calls.filter((c) => c.type === 'home_tasks/update_task').at(-1);
    assert.equal(call.due_date, '2027-02-07');
    assert.equal(call.due_time, '18:00');
  });
});
