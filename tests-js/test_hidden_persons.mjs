/**
 * hidden_persons: people not offered for assignment in this card.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const STATES = Object.fromEntries(['anna', 'kevin', 'mqtt'].map((p) =>
  [`person.${p}`, { entity_id: `person.${p}`, attributes: { friendly_name: p[0].toUpperCase() + p.slice(1) } }]));

async function offered(colConfig, task) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = makeMockHass({ states: STATES });
  card._render = () => {};
  const el = card._buildAssignedPersonSection(task, 0);
  return [...el.querySelectorAll('option, .assignee-chip')].map((o) => o.value || o.textContent).filter(Boolean);
}

const T = (extra = {}) => ({ id: 'T1', title: 'x', completed: false, sub_items: [], tags: [], ...extra });

describe('hidden_persons', () => {
  test('everyone is offered by default', async () => {
    const people = await offered({}, T());
    assert.ok(people.some((p) => /mqtt/i.test(p)));
  });

  test('hidden people are not offered', async () => {
    const people = await offered({ hidden_persons: ['person.mqtt', 'person.kevin'] }, T());
    assert.ok(!people.some((p) => /mqtt|kevin/i.test(p)), JSON.stringify(people));
    assert.ok(people.some((p) => /anna/i.test(p)));
  });

  test('a hidden person already assigned to the task stays visible', async () => {
    const people = await offered({ hidden_persons: ['person.kevin'] }, T({ assigned_person: 'person.kevin' }));
    assert.ok(people.some((p) => /kevin/i.test(p)));
  });
});
