/**
 * "Reopen recurring tasks right away": a list setting under which a ticked-off
 * recurring task comes straight back. The card then has no reopen lead to
 * offer - not on a task, not as the list's default. And the order of a native
 * list's todo entity, set in the same place.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('the task editor', () => {
  async function card(column, tasksReply) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const c = new HomeTasksCard();
    c.setConfig({ columns: [column] });
    c.hass = makeMockHass({
      callWS: async (msg) => {
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        if (msg.type === 'home_tasks/get_tasks' || msg.type === 'home_tasks/get_external_tasks') {
          return { tasks: [], sections: [], ...tasksReply };
        }
        return null;
      },
    });
    for (let i = 0; i < 5; i++) await tick();
    return c;
  }
  const task = { id: 'T1', title: 'Bins', recurrence_enabled: true, recurrence_value: 1,
    recurrence_unit: 'weeks', recurrence_type: 'interval', recurrence_weekdays: [] };
  const leadBox = (c) => c._buildRecurrenceSection(task, 0).querySelector('.recurrence-lead-section');

  test('offers the reopen lead on an ordinary list', async () => {
    const c = await card({ list_id: 'L1' }, { reopen_lead: 0 });
    assert.notEqual(leadBox(c).style.display, 'none');
  });

  test('hides it where the list reopens on completion', async () => {
    const c = await card({ list_id: 'L1' }, { reopen_lead: 1440, reopen_on_complete: true });
    assert.equal(c._columns[0].reopenOnComplete, true);
    assert.equal(leadBox(c).style.display, 'none');
  });

  test('a linked list reports the setting too', async () => {
    const c = await card({ entity_id: 'todo.groceries' }, { reopen_on_complete: true });
    assert.equal(c._columns[0].reopenOnComplete, true);
  });
});

describe('the card editor', () => {
  async function editor(column, defaults, { externalLists = [], lists = [{ id: 'L1', name: 'L' }] } = {}) {
    const { window } = await loadCard({ force: true });
    const ed = window.document.createElement('home-tasks-card-editor');
    const calls = [];
    ed.hass = makeMockHass({
      callWS: async (msg) => {
        calls.push(msg);
        if (msg.type === 'home_tasks/get_defaults') return { defaults };
        if (msg.type === 'home_tasks/set_defaults') return { defaults: { ...defaults, ...msg } };
        if (msg.type === 'home_tasks/set_list_settings') return { settings: {} };
        if (msg.type === 'home_tasks/get_lists') return { lists };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: externalLists };
        return null;
      },
    });
    ed.setConfig({ columns: [column] });
    window.document.body.appendChild(ed);
    await tick(30);
    return { ed, calls, root: ed.shadowRoot };
  }
  const reopenSwitch = (root) => [...root.querySelectorAll('.defaults-editor .toggle-row')]
    .find((r) => r.textContent.includes('Reopen recurring tasks right away'))?.querySelector('ha-switch');
  const leadRow = (root) => root.querySelector('.defaults-editor .def-lead-row');

  test('switching it on saves it and takes the default lead away', async () => {
    const { calls, root } = await editor({ list_id: 'L1' }, { reminders: [], tags: [], recurrence_reopen_lead: 1440 });
    const sw = reopenSwitch(root);
    assert.ok(sw, 'the switch is there');
    assert.equal(sw.checked, false);
    assert.ok(leadRow(root), 'the default lead shows while it is off');

    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    await tick(10);

    const set = calls.find((c) => c.type === 'home_tasks/set_defaults');
    assert.equal(set.recurrence_reopen_on_complete, true);
    assert.equal(leadRow(root), null);
  });

  test('a list that reopens on completion shows no default lead', async () => {
    const { root } = await editor({ list_id: 'L1' }, { reminders: [], tags: [], recurrence_reopen_on_complete: true });
    assert.equal(reopenSwitch(root).checked, true);
    assert.equal(leadRow(root), null);
  });

  test('a linked list has it too, unless its provider runs the recurrence', async () => {
    const plain = await editor({ entity_id: 'todo.caldav' }, { reminders: [], tags: [] }, {
      externalLists: [{ entity_id: 'todo.caldav', name: 'CalDAV', linked: true, capabilities: {} }],
    });
    assert.ok(reopenSwitch(plain.root));
    const todoist = await editor({ entity_id: 'todo.todoist' }, { reminders: [], tags: [] }, {
      externalLists: [{ entity_id: 'todo.todoist', name: 'Todoist', linked: true, capabilities: { can_sync_recurrence: true } }],
    });
    assert.equal(reopenSwitch(todoist.root), undefined);
  });

  test('the todo entity order is set on a native list', async () => {
    const { calls, root } = await editor({ list_id: 'L1' }, { reminders: [], tags: [] }, {
      lists: [{ id: 'L1', name: 'L', todo_sort: 'due' }],
    });
    const select = root.querySelector('.todo-sort-field select');
    assert.ok(select);
    assert.equal(select.value, 'due');
    select.value = 'priority';
    select.dispatchEvent(new Event('change'));
    await tick(10);
    const set = calls.find((c) => c.type === 'home_tasks/set_list_settings');
    assert.equal(set.list_id, 'L1');
    assert.equal(set.todo_sort, 'priority');
  });

  test('a linked list has no todo entity order to set', async () => {
    const { root } = await editor({ entity_id: 'todo.caldav' }, { reminders: [], tags: [] }, {
      externalLists: [{ entity_id: 'todo.caldav', name: 'CalDAV', linked: true, capabilities: {} }],
    });
    assert.equal(root.querySelector('.todo-sort-field'), null);
  });
});
