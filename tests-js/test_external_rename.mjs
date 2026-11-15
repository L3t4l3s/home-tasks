/**
 * A provider that makes a new item of a renamed one (Bring!): the backend
 * answers an update with the task's new uid, and the card holds the task
 * under that from then on - its open details, and its rows on a day plan.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

describe('a task that gets a new id on a rename', () => {
  test('the list card keeps it open and edits it under the new id', async () => {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ entity_id: 'todo.shopping' }] });
    const sent = [];
    card._hass = makeMockHass({
      callWS: async (msg) => {
        sent.push(msg);
        return { unsynced: [], uid: msg.task_uid === 'old' ? 'new' : msg.task_uid };
      },
    });
    card._render = () => {};
    const task = { id: 'old', title: 'Milk', sub_items: [], tags: [], reminders: [] };
    card._columns[0].tasks = [task];
    card._expandedTasks.add('old');
    card._editingTaskId = 'old';

    await card._updateTaskRouted(0, task.id, { title: 'Oat milk' });
    assert.equal(task.id, 'new');
    assert.ok(card._expandedTasks.has('new') && !card._expandedTasks.has('old'));
    assert.equal(card._editingTaskId, 'new');

    await card._updateTaskRouted(0, task.id, { notes: 'the big one' });
    assert.deepEqual(sent.map((m) => m.task_uid), ['old', 'new']);
  });

  test('the day plan card moves its rows to the new id', async () => {
    const { window } = await loadCard({ force: true });
    const card = new (window.customElements.get('home-tasks-day-plan-card'))();
    card._plan = {
      sources: [{ entry_id: 'L1' }, { entry_id: 'B1' }],
      days: [{ date: '2026-11-16', items: [
        { entry_id: 'B1', task_id: 'old' }, { entry_id: 'L1', task_id: 'old' },
      ] }],
    };
    card._planJson = 'as read';
    card._onTaskIdChanged(1, 'old', 'new');
    assert.deepEqual(card._plan.days[0].items.map((r) => `${r.entry_id}|${r.task_id}`), ['B1|new', 'L1|old']);
    assert.equal(card._planJson, null);
  });
});
