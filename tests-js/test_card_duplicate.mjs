/**
 * Duplicate on a linked list.
 *
 * The button used to be native-only ("Native lists only"), so a task on a
 * linked list simply could not be copied from the card. It routes to the
 * external command now, with the entity and the provider's uid.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, ...over,
});

function makeHass() {
  const calls = [];
  return {
    language: 'en', states: {}, auth: {}, calls,
    callWS: async (msg) => {
      calls.push(msg);
      switch (msg.type) {
        case 'home_tasks/get_lists': return { lists: [{ id: 'L1', name: 'Native' }] };
        case 'home_tasks/get_external_lists':
          return { external_lists: [{ entity_id: 'todo.linked', name: 'Linked', supported_features: 15 }] };
        case 'home_tasks/get_tasks':
          return { tasks: [TASK({ id: 'T1', title: 'Native task', sort_order: 0 })], sections: [] };
        case 'home_tasks/get_external_tasks':
          return { tasks: [TASK({ id: 'uid-1', title: 'Linked task', sort_order: 0, _external: true, assigned_person: 'person.kevin' })], sections: [] };
        case 'home_tasks/duplicate_task': return TASK({ id: 'T2', title: msg.title });
        case 'home_tasks/duplicate_external_task': return { uid: 'uid-2' };
        default: return null;
      }
    },
    callService: async () => null,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(col) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const hass = makeHass();
  const card = new HomeTasksCard();
  card.setConfig({ columns: [col] });
  card.hass = hass;
  await flush();
  return { card, hass };
}

describe('duplicating a task', () => {
  test('a linked list offers the button too', async () => {
    const { card } = await mount({ entity_id: 'todo.linked' });
    const task = card._columns[0].tasks[0];
    const actions = card._buildActionsSection(task, 0);
    assert.ok(actions.querySelector('.duplicate-task-btn'), 'no longer native-only');
  });

  test('on a linked list it goes to the external command', async () => {
    const { card, hass } = await mount({ entity_id: 'todo.linked' });
    const task = card._columns[0].tasks[0];
    hass.calls.length = 0;

    await card._duplicateTask(task, 0);

    const call = hass.calls.find((c) => c.type === 'home_tasks/duplicate_external_task');
    assert.ok(call, 'the external command is used');
    assert.equal(call.entity_id, 'todo.linked');
    assert.equal(call.task_uid, 'uid-1');
    assert.equal(call.assigned_person, 'person.kevin', 'the source assignee travels along');
    assert.ok(!hass.calls.some((c) => c.type === 'home_tasks/duplicate_task'), 'and not the native one');
    assert.ok(hass.calls.some((c) => c.type === 'home_tasks/get_external_tasks'), 'then the list is re-read');
  });

  test('a native list still goes the native way', async () => {
    const { card, hass } = await mount({ list_id: 'L1' });
    const task = card._columns[0].tasks[0];
    hass.calls.length = 0;

    await card._duplicateTask(task, 0);

    const call = hass.calls.find((c) => c.type === 'home_tasks/duplicate_task');
    assert.ok(call);
    assert.equal(call.list_id, 'L1');
    assert.equal(call.task_id, 'T1');
  });
});
