/**
 * The recurrence editor's anchor choice: "From completion" / "From due date".
 *
 * Builds the recurrence section for a native task and checks which radios
 * each unit offers, which one starts checked, and what a pick sends.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

async function makeCard() {
  const { HomeTasksCard } = await loadCard({ force: true });
  const calls = [];
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [] };
      return null;
    },
    callService: async () => {},
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  card.hass = hass;
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return { card, calls };
}

const baseTask = (extra) => ({
  id: 'T1', title: 'Chore', recurrence_enabled: true, recurrence_value: 1,
  recurrence_type: 'interval', recurrence_weekdays: [], ...extra,
});

// Visible radio values of one named group inside the section.
function group(section, prefix) {
  const radios = [...section.querySelectorAll(`input[type=radio][name^="${prefix}"]`)];
  return {
    values: radios.filter(r => r.closest('label').style.display !== 'none').map(r => r.value),
    checked: radios.find(r => r.checked)?.value,
    radio: (v) => radios.find(r => r.value === v),
    row: radios[0]?.closest('.recurrence-radio-row'),
  };
}

describe('recurrence anchor radios', () => {
  test('days offers From completion / From due date, completion checked by default', async () => {
    const { card } = await makeCard();
    const section = card._buildRecurrenceSection(baseTask({ recurrence_unit: 'days' }), 0);
    const g = group(section, 'rec_basic_pattern_');
    assert.deepEqual(g.values, ['completion', 'due']);
    assert.equal(g.checked, 'completion');
    assert.notEqual(g.row.style.display, 'none');
  });

  test('hours shows the anchor row, weeks does not', async () => {
    const { card } = await makeCard();
    const hours = card._buildRecurrenceSection(baseTask({ recurrence_unit: 'hours' }), 0);
    assert.notEqual(group(hours, 'rec_basic_pattern_').row.style.display, 'none');
    const weeks = card._buildRecurrenceSection(baseTask({ recurrence_unit: 'weeks' }), 0);
    assert.equal(group(weeks, 'rec_basic_pattern_').row.style.display, 'none');
  });

  test('weeks, months and years add From due date next to their patterns', async () => {
    const { card } = await makeCard();
    const task = baseTask({ recurrence_unit: 'weeks', recurrence_anchor: 'due' });
    const section = card._buildRecurrenceSection(task, 0);
    const w = group(section, 'rec_week_pattern_');
    assert.deepEqual(w.values, ['none', 'due', 'on']);
    assert.equal(w.checked, 'due');
    assert.deepEqual(group(section, 'rec_month_pattern_').values, ['none', 'due', 'day_of_month', 'nth_weekday']);
    assert.deepEqual(group(section, 'rec_year_pattern_').values, ['none', 'due', 'on']);
  });

  test('a calendar pattern wins over the anchor in its row', async () => {
    const { card } = await makeCard();
    const task = baseTask({ recurrence_unit: 'weeks', recurrence_weekdays: [0, 2], recurrence_anchor: 'due' });
    const section = card._buildRecurrenceSection(task, 0);
    assert.equal(group(section, 'rec_week_pattern_').checked, 'on');
  });

  test('picking From due date saves recurrence_anchor', async () => {
    const { card, calls } = await makeCard();
    const section = card._buildRecurrenceSection(baseTask({ recurrence_unit: 'days' }), 0);
    const due = group(section, 'rec_basic_pattern_').radio('due');
    due.checked = true;
    due.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 0));
    const update = calls.find(c => c.type === 'home_tasks/update_task' && 'recurrence_anchor' in c);
    assert.ok(update, 'an update_task call carrying recurrence_anchor');
    assert.equal(update.recurrence_anchor, 'due');
  });

  test('picking From completion on weeks clears weekdays and saves the anchor', async () => {
    const { card, calls } = await makeCard();
    const task = baseTask({ recurrence_unit: 'weeks', recurrence_weekdays: [1], recurrence_anchor: 'due' });
    const section = card._buildRecurrenceSection(task, 0);
    const none = group(section, 'rec_week_pattern_').radio('none');
    none.checked = true;
    none.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 0));
    const update = calls.find(c => c.type === 'home_tasks/update_task' && 'recurrence_anchor' in c);
    assert.equal(update.recurrence_weekdays.length, 0);
    assert.equal(update.recurrence_anchor, 'completion');
  });
});
