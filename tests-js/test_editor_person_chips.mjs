/**
 * Person chips in the editor: the default assignees (any number of people)
 * and the column's "Limit to assignees" preset, both once a select or a
 * free-text field.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const STATES = Object.fromEntries(['anna', 'kevin'].map((p) =>
  [`person.${p}`, { entity_id: `person.${p}`, attributes: { friendly_name: p[0].toUpperCase() + p.slice(1) } }]));

// Config objects live in the jsdom realm; compare shape, not prototype.
const plain = (o) => JSON.parse(JSON.stringify(o));

const chipsIn = (field) => [...field.querySelectorAll('.assignee-chip')]
  .map((c) => c.textContent + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''));

describe('default assignees', () => {
  async function editor(defaults) {
    const { window } = await loadCard({ force: true });
    const ed = window.document.createElement('home-tasks-card-editor');
    const calls = [];
    ed.hass = makeMockHass({
      states: STATES,
      callWS: async (msg) => {
        calls.push(msg);
        if (msg.type === 'home_tasks/get_defaults') return { defaults };
        if (msg.type === 'home_tasks/set_defaults') return { defaults: { ...defaults, assignees: msg.assignees ?? [] } };
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'L' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        return null;
      },
    });
    ed.setConfig({ columns: [{ list_id: 'L1' }] });
    window.document.body.appendChild(ed);
    await new Promise((r) => setTimeout(r, 30));
    const field = ed.shadowRoot.querySelector('.defaults-editor .assignee-chip-row').parentElement;
    return { ed, calls, field };
  }

  test('a list may default to several people', async () => {
    const { calls, field } = await editor({ assignees: ['person.kevin'], reminders: [] });
    assert.deepEqual(chipsIn(field), ['Anna', 'Kevin*']);
    field.querySelectorAll('.assignee-chip')[0].click();
    await new Promise((r) => setTimeout(r, 10));
    const set = calls.find((c) => c.type === 'home_tasks/set_defaults');
    assert.deepEqual(plain(set.assignees), ['person.anna', 'person.kevin']);
  });

  test('a default saved by an older version shows as its one person', async () => {
    const { field } = await editor({ assignee: 'person.anna', reminders: [] });
    assert.deepEqual(chipsIn(field), ['Anna*', 'Kevin']);
  });
});

describe('limit to assignees', () => {
  async function editor(col, listPersons = []) {
    const { window } = await loadCard({ force: true });
    const ed = new (window.customElements.get('home-tasks-card-editor'))();
    ed.hass = makeMockHass({ states: STATES });
    ed.setConfig({ columns: [{ list_id: 'L1', ...col }] });
    ed._listMeta = { 'list:L1': { tags: [], persons: listPersons.map((v) => ({ value: v, label: v })) } };
    ed._sourceKeyForCol = () => 'list:L1';
    const events = [];
    ed._fireChanged = () => events.push(plain(ed._config.columns[0].filters?.assignees));
    const root = ed._buildVisualEditor(0);
    const label = [...root.querySelectorAll('.group-label')].find((l) => l.textContent === 'Limit to assignees');
    return { events, field: label.parentElement };
  }

  test('a chip per person; tapping one limits the column to them', async () => {
    const { field, events } = await editor({});
    assert.deepEqual(chipsIn(field), ['Anna', 'Kevin']);
    field.querySelectorAll('.assignee-chip')[1].click();
    assert.deepEqual(events.at(-1), ['person.kevin']);
  });

  test("a linked list's own assignees without a person entity are offered too", async () => {
    const { field } = await editor({ filters: { assignees: ['Sam'] } }, ['Sam', 'person.anna']);
    assert.deepEqual(chipsIn(field), ['Anna', 'Kevin', 'Sam*']);
  });
});
