import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function externalCard(callWS) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({
    image_generation: { entity_id: 'ai_task.google_ai_task' },
    columns: [{
      entity_id: 'todo.do_zrobienia',
      show_images: true,
    }],
  });
  card._hass = makeMockHass({ callWS });
  card._refreshOpenSheetImage = () => {};
  card._refreshTaskTileEverywhere = () => {};
  return card;
}

describe('external task images', () => {
  test('shows image controls in external task details', async () => {
    const card = await externalCard(async () => null);
    const details = card._buildTaskDetails({
      id: 'todoist-details',
      title: 'External task',
      image_url: '/local/home_tasks/external.png',
      tags: [],
      reminders: [],
      sub_items: [],
      history: [],
    }, 0);

    assert.ok(details.querySelector('.detail-section--image'));
    assert.equal(
      details.querySelector('.task-image')?.getAttribute('src'),
      '/local/home_tasks/external.png',
    );
    assert.ok(details.querySelector('.generate-image-btn'));
  });

  test('routes generation to the Todoist entity, not a native list', async () => {
    let payload;
    const card = await externalCard(async (msg) => {
      payload = msg;
      return {
        task: {
          id: 'todoist-1',
          title: 'Buy milk',
          image_url: '/local/home_tasks/generated.png',
        },
      };
    });
    card._columns[0].tasks = [{ id: 'todoist-1', title: 'Buy milk' }];

    await card._generateTaskImage(card._columns[0].tasks[0], 0);

    assert.equal(payload.todo_entity_id, 'todo.do_zrobienia');
    assert.equal(payload.entry_id, undefined);
    assert.equal(payload.entity_id, 'ai_task.google_ai_task');
    assert.equal(payload.task_id, 'todoist-1');
  });

  test('does not replace a same-ID task from another external list', async () => {
    const card = await externalCard(async () => ({
      task: {
        id: 'shared-id',
        title: 'Buy milk',
        description: 'Source description',
        image_url: '/local/home_tasks/generated.png',
      },
    }));
    card._config.columns.push({
      entity_id: 'todo.other_list',
      show_images: true,
    });
    card._columns.push({
      tasks: [{ id: 'shared-id', title: 'Unrelated task', description: 'Keep me' }],
    });
    card._columns[0].tasks = [{ id: 'shared-id', title: 'Buy milk' }];

    await card._generateTaskImage(card._columns[0].tasks[0], 0);

    assert.equal(card._columns[0].tasks[0].description, 'Source description');
    assert.deepEqual(card._columns[1].tasks[0], {
      id: 'shared-id',
      title: 'Unrelated task',
      description: 'Keep me',
    });
  });

  test('saves an external image URL in the overlay', async () => {
    let payload;
    const card = await externalCard(async (msg) => {
      payload = msg;
      return { image_url: msg.image_url };
    });
    const task = { id: 'todoist-2', title: 'Call dentist' };
    card._columns[0].tasks = [task];

    await card._saveImageUrl(task, 0, '/local/home_tasks/dentist.png');

    assert.equal(payload.type, 'home_tasks/update_external_overlay');
    assert.equal(payload.entity_id, 'todo.do_zrobienia');
    assert.equal(payload.task_uid, 'todoist-2');
    assert.equal(payload.image_url, '/local/home_tasks/dentist.png');
    assert.equal(card._columns[0].tasks[0].image_url, '/local/home_tasks/dentist.png');
  });

  test('manual image changes do not replace a same-ID task in another list', async () => {
    const card = await externalCard(async (msg) => ({ image_url: msg.image_url }));
    card._config.columns.push({ entity_id: 'todo.other_list', show_images: true });
    card._columns.push({
      tasks: [{ id: 'shared-id', title: 'Other task', image_url: '/local/other.png' }],
    });
    const task = { id: 'shared-id', title: 'Source task' };
    card._columns[0].tasks = [task];

    await card._saveImageUrl(task, 0, '/local/source.png');

    assert.equal(card._columns[0].tasks[0].image_url, '/local/source.png');
    assert.equal(card._columns[1].tasks[0].image_url, '/local/other.png');
    assert.equal(card._columns[1].tasks[0].title, 'Other task');
  });

  // ws_update_external_overlay answers with the COMPLETE overlay — every
  // field, defaults included — because async_set_overlay merges onto
  // _empty_overlay(). Anything a provider owns (Todoist: due date, notes,
  // priority, labels, sub-items) is null in there, so merging the whole
  // response into the task blanks the row until the next reload.
  test('an image save keeps the fields the provider owns', async () => {
    const fullOverlay = (imageUrl) => ({
      priority: null, due_date: null, due_time: null, notes: null,
      assigned_person: null, tags: [], reminders: [], sub_items: [],
      sort_order: 0, recurrence_enabled: false, recurrence_type: 'interval',
      recurrence_value: 1, recurrence_unit: null, recurrence_weekdays: [],
      history: [], completed_at: null, section_id: null, image_url: imageUrl,
    });
    const card = await externalCard(async (msg) => fullOverlay(msg.image_url));
    const task = {
      id: 'todoist-3', title: 'Buy milk', due_date: '2026-09-01', due_time: '18:00',
      notes: 'from Todoist', priority: 3, tags: ['shopping'],
      sub_items: [{ id: 's1', title: 'oat', completed: false }], _external: true,
    };
    card._columns[0].tasks = [task];

    await card._saveImageUrl(task, 0, '/local/home_tasks/milk.png');

    const after = card._columns[0].tasks[0];
    assert.equal(after.image_url, '/local/home_tasks/milk.png');
    assert.equal(after.due_date, '2026-09-01');
    assert.equal(after.due_time, '18:00');
    assert.equal(after.notes, 'from Todoist');
    assert.equal(after.priority, 3);
    assert.deepEqual(after.tags, ['shopping']);
    assert.equal(after.sub_items.length, 1);
  });

  // The counterpart to the two tests above: a card may show one list in two
  // columns (the documented open | done layout), and both copies must follow
  // an image change.
  test('the same list in two columns is updated in both', async () => {
    const card = await externalCard(async (msg) => ({ image_url: msg.image_url }));
    card._config.columns.push({ entity_id: 'todo.do_zrobienia', default_filter: 'done', show_images: true });
    const shared = { id: 'todoist-4', title: 'Shared', image_url: '/local/old.png' };
    card._columns[0].tasks = [{ ...shared }];
    card._columns.push({ tasks: [{ ...shared }] });

    await card._saveImageUrl(card._columns[0].tasks[0], 0, null);

    assert.equal(card._columns[0].tasks[0].image_url, null);
    assert.equal(card._columns[1].tasks[0].image_url, null);
  });

  test('generated images reach every column showing that list', async () => {
    const card = await externalCard(async () => ({
      task: { id: 'todoist-5', title: 'Buy milk', image_url: '/local/gen.png' },
    }));
    card._config.image_generation = { entity_id: 'ai_task.google_ai_task' };
    card._config.columns.push({ entity_id: 'todo.do_zrobienia', default_filter: 'done', show_images: true });
    card._columns[0].tasks = [{ id: 'todoist-5', title: 'Buy milk' }];
    card._columns.push({ tasks: [{ id: 'todoist-5', title: 'Buy milk' }] });

    await card._generateTaskImage(card._columns[0].tasks[0], 0);

    assert.equal(card._columns[0].tasks[0].image_url, '/local/gen.png');
    assert.equal(card._columns[1].tasks[0].image_url, '/local/gen.png');
  });
});
