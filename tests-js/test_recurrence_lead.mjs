/**
 * "Reopen early" in the recurrence editor (PR #74): how long before its next
 * due moment a completed recurring task opens again.
 *
 * Stored in minutes; the unit picker offers what fits the interval, a lead
 * as long as the interval is never offered, and linked lists don't show it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCard } from './setup.mjs';

async function makeCard(column = { list_id: 'L1' }, listLead = 0) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const calls = [];
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [], reopen_lead: listLead };
      if (msg.type === 'home_tasks/get_external_tasks') return { tasks: [], sections: [] };
      return null;
    },
    callService: async () => {},
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [column] });
  card.hass = hass;
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return { card, calls };
}

const baseTask = (extra) => ({
  id: 'T1', title: 'Food shop', recurrence_enabled: true, recurrence_value: 1,
  recurrence_unit: 'weeks', recurrence_type: 'interval', recurrence_weekdays: [], ...extra,
});

function lead(section) {
  const box = section.querySelector('.recurrence-lead-section');
  const input = box.querySelector('input[data-focus-key="recurrence_reopen_lead"]');
  const select = box.querySelector('select');
  return {
    box, input, select,
    units: [...select.options].map(o => o.value),
    set(value, unit) {
      if (unit) { select.value = unit; select.dispatchEvent(new Event('change')); }
      if (value !== undefined) { input.value = String(value); input.dispatchEvent(new Event('change')); }
    },
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));
const leadSaves = (calls) => calls.filter(c => c.type === 'home_tasks/update_task' && 'recurrence_reopen_lead' in c);

describe('reopen early', () => {
  test('the interval matches the backend', async () => {
    // Same cases as test_recurrence_interval_minutes in tests/integration/test_init.py.
    const { HomeTasksCard } = await loadCard({ force: true });
    const cases = JSON.parse(readFileSync(new URL('../tests/fixtures/recurrence_interval_cases.json', import.meta.url), 'utf8'));
    for (const c of cases) {
      assert.equal(HomeTasksCard.recurrenceIntervalMinutes(c.unit, c.value, c.weekdays), c.minutes, JSON.stringify(c));
    }
  });

  test('the units fit the interval', async () => {
    const { card } = await makeCard();
    const units = (extra) => lead(card._buildRecurrenceSection(baseTask(extra), 0)).units;
    assert.deepEqual(units({ recurrence_unit: 'hours', recurrence_value: 6 }), ['minutes', 'hours']);
    assert.deepEqual(units({ recurrence_unit: 'days', recurrence_value: 2 }), ['hours', 'days']);
    assert.deepEqual(units({ recurrence_unit: 'months' }), ['hours', 'days']);
  });

  test('a unit that could only hold 0 is not offered', async () => {
    const { card } = await makeCard();
    const units = (extra) => lead(card._buildRecurrenceSection(baseTask(extra), 0)).units;
    assert.deepEqual(units({ recurrence_unit: 'days', recurrence_value: 1 }), ['hours']);
    assert.deepEqual(units({ recurrence_unit: 'hours', recurrence_value: 1 }), ['minutes']);
    // weekly on Mon..Fri: one day apart, so hours only
    assert.deepEqual(units({ recurrence_weekdays: [0, 1, 2, 3, 4] }), ['hours']);
  });

  test('a stored lead shows in the largest unit that fits', async () => {
    const { card } = await makeCard();
    const days = lead(card._buildRecurrenceSection(baseTask({ recurrence_reopen_lead: 2880 }), 0));
    assert.equal(days.select.value, 'days');
    assert.equal(days.input.value, '2');
    // 90 minutes on a weekly task: kept as minutes, not rounded to hours
    const odd = lead(card._buildRecurrenceSection(baseTask({ recurrence_reopen_lead: 90 }), 0));
    assert.deepEqual(odd.units, ['minutes', 'hours', 'days']);
    assert.equal(odd.select.value, 'minutes');
    assert.equal(odd.input.value, '90');
    // none set: 0, nothing extra offered
    const none = lead(card._buildRecurrenceSection(baseTask(), 0));
    assert.equal(none.input.value, '0');
    assert.deepEqual(none.units, ['hours', 'days']);
  });

  test('entering a lead saves it in minutes', async () => {
    const { card, calls } = await makeCard();
    const l = lead(card._buildRecurrenceSection(baseTask(), 0));
    l.set(3);
    await tick();
    assert.equal(leadSaves(calls).at(-1).recurrence_reopen_lead, 3 * 1440);
    l.set(undefined, 'hours');   // same number, other unit
    await tick();
    assert.equal(leadSaves(calls).at(-1).recurrence_reopen_lead, 3 * 60);
  });

  test('a lead as long as the interval is cut to the longest that fits', async () => {
    const { card, calls } = await makeCard();
    const l = lead(card._buildRecurrenceSection(baseTask(), 0));
    assert.equal(l.input.max, '6');           // weekly: up to 6 days
    l.set(9);
    await tick();
    assert.equal(l.input.value, '6');
    assert.equal(leadSaves(calls).at(-1).recurrence_reopen_lead, 6 * 1440);
  });

  test('a shorter interval drops a lead that no longer fits', async () => {
    const { card, calls } = await makeCard();
    const section = card._buildRecurrenceSection(baseTask({ recurrence_reopen_lead: 2 * 1440 }), 0);
    const unit = section.querySelector('.recurrence-input-row select');
    unit.value = 'days';
    unit.dispatchEvent(new Event('change'));
    await tick();
    const save = calls.find(c => c.type === 'home_tasks/update_task' && c.recurrence_unit === 'days');
    assert.equal(save.recurrence_reopen_lead, 0);
    assert.equal(lead(section).input.value, '0');
  });

  test('a longer interval keeps the lead', async () => {
    const { card, calls } = await makeCard();
    const section = card._buildRecurrenceSection(baseTask({ recurrence_unit: 'days', recurrence_reopen_lead: 120 }), 0);
    const unit = section.querySelector('.recurrence-input-row select');
    unit.value = 'weeks';
    unit.dispatchEvent(new Event('change'));
    await tick();
    const save = calls.find(c => c.type === 'home_tasks/update_task' && c.recurrence_unit === 'weeks');
    assert.ok(!('recurrence_reopen_lead' in save));
    assert.equal(lead(section).input.value, '2');
    assert.equal(lead(section).select.value, 'hours');
  });

  // Issue #77: the list's lead is taken over when recurrence is switched on.
  const neverSetUp = { recurrence_enabled: false, recurrence_unit: null, recurrence_reopen_lead: null };
  async function switchOn(section) {
    const sw = section.querySelector('ha-switch');
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    await tick();
  }
  const interval = (section) => [
    section.querySelector('input[data-focus-key="recurrence_value"]').value,
    section.querySelector('.recurrence-input-row select').value,
  ];

  test("a task never set up starts a day longer than the list's lead, and takes it over", async () => {
    const { card, calls } = await makeCard({ list_id: 'L1' }, 30 * 1440);
    const section = card._buildRecurrenceSection(baseTask(neverSetUp), 0);
    assert.deepEqual(interval(section), ['31', 'days']);
    assert.equal(lead(section).input.value, '30');
    assert.equal(lead(section).select.value, 'days');
    await switchOn(section);
    const save = leadSaves(calls).at(-1);
    assert.equal(save.recurrence_enabled, true);
    assert.equal(save.recurrence_value, 31);
    assert.equal(save.recurrence_unit, 'days');
    assert.equal(save.recurrence_reopen_lead, 30 * 1440);
  });

  test('a list lead under a day keeps the daily start', async () => {
    const { card, calls } = await makeCard({ list_id: 'L1' }, 6 * 60);
    const section = card._buildRecurrenceSection(baseTask(neverSetUp), 0);
    assert.deepEqual(interval(section), ['1', 'days']);
    await switchOn(section);
    assert.equal(leadSaves(calls).at(-1).recurrence_reopen_lead, 6 * 60);
  });

  test('a year-long list lead starts at every 2 years', async () => {
    const { card } = await makeCard({ list_id: 'L1' }, 365 * 1440);
    assert.deepEqual(interval(card._buildRecurrenceSection(baseTask(neverSetUp), 0)), ['2', 'years']);
  });

  test("an interval set up before stays, and only takes a list lead it can hold", async () => {
    const { card, calls } = await makeCard({ list_id: 'L1' }, 30 * 1440);
    const section = card._buildRecurrenceSection(
      baseTask({ recurrence_enabled: false, recurrence_reopen_lead: 2 * 1440 }), 0);
    assert.deepEqual(interval(section), ['1', 'weeks']);
    assert.equal(lead(section).input.value, '0');
    await switchOn(section);
    assert.equal(leadSaves(calls).at(-1).recurrence_reopen_lead, 0);
  });

  test("a recurring task without a lead reopens when due, whatever the list's", async () => {
    // From before reopen early, or moved in: the backend applies 0.
    const { card } = await makeCard({ list_id: 'L1' }, 2 * 1440);
    assert.equal(lead(card._buildRecurrenceSection(baseTask(), 0)).input.value, '0');
  });

  test("a recurring task keeps its own lead, whatever the list's", async () => {
    const { card } = await makeCard({ list_id: 'L1' }, 2 * 1440);
    const l = lead(card._buildRecurrenceSection(baseTask({ recurrence_reopen_lead: 1440 }), 0));
    assert.equal(l.input.value, '1');
    assert.equal(l.select.value, 'days');
  });

  test('a linked list does not offer it', async () => {
    const { card } = await makeCard({ entity_id: 'todo.groceries' });
    const l = lead(card._buildRecurrenceSection(baseTask(), 0));
    assert.equal(l.box.style.display, 'none');
  });
});
