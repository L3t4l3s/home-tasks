/**
 * collapse_recurrence: the recurrence editor folds behind a one-line summary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function build(colConfig, task) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = makeMockHass();
  card._render = () => {};
  card._columns[0].tasks = [task];
  return { card, el: card._buildRecurrenceSection(task, 0) };
}

const T = (extra = {}) => ({ id: 'T1', title: 'Bins', completed: false, sub_items: [], tags: [], recurrence_value: 1, ...extra });

describe('collapse_recurrence', () => {
  test('off (default): a plain section, no fold', async () => {
    const { el } = await build({}, T());
    assert.equal(el.tagName, 'DIV');
    assert.equal(el.querySelector('summary'), null);
  });

  test('on: folded details with a summary of the rule, closed by default', async () => {
    const { el } = await build({ collapse_recurrence: true },
      T({ recurrence_enabled: true, recurrence_unit: 'weeks', recurrence_value: 2 }));
    assert.equal(el.tagName, 'DETAILS');
    assert.equal(el.open, false);
    assert.match(el.querySelector('summary').textContent, /^Recurrence: 2 /);
    assert.ok(el.querySelectorAll('input').length > 0, 'the editor rows are inside the fold');
  });

  test('a task without recurrence summarises as Disabled', async () => {
    const { el } = await build({ collapse_recurrence: true }, T());
    assert.equal(el.querySelector('summary').textContent, 'Recurrence: Disabled');
  });

  test('open state survives a rebuild', async () => {
    const { card, el } = await build({ collapse_recurrence: true }, T());
    el.open = true;
    el.dispatchEvent(new window.Event('toggle'));
    const again = card._buildRecurrenceSection(card._columns[0].tasks[0], 0);
    assert.equal(again.open, true);
  });
});
