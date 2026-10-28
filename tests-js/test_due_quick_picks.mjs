/**
 * One-tap due dates in the task details: Today, Tomorrow, In 1 week,
 * In 1 month, In 3 months.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

// Noon UTC keeps "today" = 2027-01-31 in every timezone; month-end on purpose.
const FROZEN_NOW = '2027-01-31T12:00:00Z';

async function makeCard() {
  const { HomeTasksCard, window } = await loadCard({ force: true, frozenNow: FROZEN_NOW });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  const calls = [];
  card.hass = makeMockHass({ callWS: async (m) => { calls.push(m); return null; } });
  card._render = () => {};
  return { card, calls, window };
}

// Moves the card's clock: `new Date()` returns `iso` from now on.
function setNow(window, iso) {
  const RealDate = Object.getPrototypeOf(window.Date);
  const ts = new RealDate(iso).getTime();
  const D = function (...args) { return args.length ? new RealDate(...args) : new RealDate(ts); };
  D.now = () => ts;
  Object.setPrototypeOf(D, RealDate);
  D.prototype = RealDate.prototype;
  window.Date = D;
}

const task = (extra = {}) => ({ id: 'T1', title: 'Bins', completed: false, sub_items: [], tags: [], ...extra });

describe('due date quick picks', () => {
  test('five buttons, months clamp at month end', async () => {
    const { card, calls } = await makeCard();
    card._columns[0].tasks = [task()];
    const el = card._buildDateSection(card._columns[0].tasks[0], 0);
    const btns = [...el.querySelectorAll('.due-quick-btn')];
    assert.deepEqual(btns.map((b) => b.textContent), ['Today', 'Tomorrow', 'In 1 week', 'In 1 month', 'In 3 months']);

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

  test('the highlight follows the date field and its clear button', async () => {
    const { card } = await makeCard();
    const t = task({ due_date: '2027-02-01' });
    card._columns[0].tasks = [t];
    const el = card._buildDateSection(t, 0);
    const active = () => [...el.querySelectorAll('.due-quick-btn')].map((b) => b.classList.contains('active'));
    el.querySelector('.field-clear-btn').click();
    assert.deepEqual(active(), [false, false, false, false, false]);
    const date = el.querySelector('input[type="date"]');
    date.value = '2027-02-07';
    date.dispatchEvent(new Event('change'));
    assert.deepEqual(active(), [false, false, true, false, false]);
  });
  test('the highlighted button is announced as pressed', async () => {
    const { card } = await makeCard();
    const t = task({ due_date: '2027-01-31' });
    card._columns[0].tasks = [t];
    const btns = [...card._buildDateSection(t, 0).querySelectorAll('.due-quick-btn')];
    assert.deepEqual(btns.map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false', 'false']);
  });

  test('tapping the date already set sends nothing', async () => {
    const { card, calls } = await makeCard();
    const t = task({ due_date: '2027-02-01' });
    card._columns[0].tasks = [t];
    card._buildDateSection(t, 0).querySelectorAll('.due-quick-btn')[1].click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.filter((c) => c.type === 'home_tasks/update_task').length, 0);
  });

  test('details left open past midnight use the new day', async () => {
    const { card, calls, window } = await makeCard();
    const t = task();
    card._columns[0].tasks = [t];
    const btns = [...card._buildDateSection(t, 0).querySelectorAll('.due-quick-btn')];
    setNow(window, '2027-02-01T12:00:00Z');
    btns[0].click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.filter((c) => c.type === 'home_tasks/update_task').at(-1).due_date, '2027-02-01');
  });
});
