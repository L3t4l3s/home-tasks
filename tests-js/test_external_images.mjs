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

describe('editor image section', () => {
  async function editor(queueResult, colExtra = {}) {
    const { window } = await loadCard({ force: true });
    const Editor = window.customElements.get('home-tasks-card-editor');
    const ed = new Editor();
    ed.hass = makeMockHass({
      callWS: async (m) => {
        if (m.type === 'home_tasks/get_lists') {
          return { lists: [{ id: 'L1', name: 'Household', share_images: true }] };
        }
        if (m.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        if (m.type === 'home_tasks/get_image_queue') return queueResult;
        return null;
      },
    });
    ed.setConfig({
      image_generation: { entity_id: 'ai_task.openai' },
      columns: [{ list_id: 'L1', show_images: true, auto_generate_image: true, ...colExtra }],
    });
    window.document.body.appendChild(ed);
    await new Promise((r) => setTimeout(r, 150));
    return ed;
  }
  const sections = (ed) =>
    [...ed.shadowRoot.querySelectorAll('details > summary')].map(s => s.textContent.trim());
  const imageSection = (ed) =>
    [...ed.shadowRoot.querySelectorAll('details')].find(
      d => (d.querySelector('summary')?.textContent || '').toLowerCase().includes('image')
    );

  // Everything about images used to be in three places: two switches in
  // Display, the AI entity in its own section at the bottom, the list
  // settings in a third. One section now.
  test('gathers the switches, the AI entity and the list settings', async () => {
    const ed = await editor({ current: null, queue: [] });
    try {
      assert.ok(!sections(ed).some(s => /AI Image/i.test(s)), 'no separate AI section');
      const sec = imageSection(ed);
      assert.ok(sec, 'an Images section exists');
      const toggles = [...sec.querySelectorAll('.toggle-label')].map(e => e.textContent.trim());
      assert.deepEqual(toggles, ['Images', 'Auto-generate image', 'Share images with other lists']);
      assert.ok(sec.querySelector('ha-form'), 'the ai_task entity is configured here');
    } finally {
      ed.remove();
    }
  });

  test('hides the queue until the list asks for background generation', async () => {
    const ed = await editor({ current: null, queue: [] }, { auto_generate_image: false });
    try {
      const sec = imageSection(ed);
      assert.equal(sec.querySelector('.queue-panel'), null);
      const hints = [...sec.querySelectorAll('.hint')].map(h => h.textContent);
      assert.ok(!hints.some(h => /Nothing waiting/.test(h)),
        'no sentence about a queue nobody asked for');
    } finally {
      ed.remove();
    }
  });

  test('starts with every section folded', async () => {
    const ed = await editor({ current: null, queue: [] });
    try {
      const open = [...ed.shadowRoot.querySelectorAll('details')].filter(d => d.open);
      assert.deepEqual(open, [], 'the editor remembers what you opened, nothing more');
    } finally {
      ed.remove();
    }
  });

  // The switch takes effect on the list immediately, not on save, so the
  // queue it enables has to show up immediately too.
  test('the queue appears as soon as the switch is flipped', async () => {
    const ed = await editor(
      { current: null, queue: [{ list_id: 'L1', task_id: 'T1', title: 'Waiting one' }] },
      { auto_generate_image: false },
    );
    try {
      assert.equal(imageSection(ed).querySelector('.queue-panel'), null);

      const sec = imageSection(ed);
      const sw = [...sec.querySelectorAll('ha-switch')][1];  // Auto-generate image
      sw.checked = true;
      sw.dispatchEvent(new (ed.ownerDocument.defaultView.Event)('change'));
      await new Promise((r) => setTimeout(r, 200));

      assert.ok(imageSection(ed).querySelector('.queue-panel'), 'no save needed');
      assert.equal(imageSection(ed).querySelectorAll('.queue-row').length, 1);
    } finally {
      ed.remove();
    }
  });

  test('sits where the AI settings used to, at the end', async () => {
    const ed = await editor({ current: null, queue: [] });
    try {
      assert.equal(sections(ed).at(-1), 'Images');
    } finally {
      ed.remove();
    }
  });

  test('shows what is generating and numbers what comes next', async () => {
    const ed = await editor({
      current: { list_id: 'L1', task_id: 'T9', title: 'Running one' },
      queue: [
        { list_id: 'L1', task_id: 'T1', title: 'First in line' },
        { list_id: 'L1', task_id: 'T2', title: 'Second in line' },
      ],
    });
    try {
      const rows = [...imageSection(ed).querySelectorAll('.queue-row')].map(r => ({
        title: r.querySelector('.queue-title').textContent,
        pos: r.querySelector('.queue-pos').textContent,
        running: r.classList.contains('current'),
        cancellable: !!r.querySelector('.queue-cancel'),
      }));
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], {
        title: 'Running one', pos: '▶', running: true,
        cancellable: false,  // the provider call is already out
      });
      assert.equal(rows[1].pos, '1.', 'the next one is numbered 1');
      assert.equal(rows[2].pos, '2.');
      assert.ok(rows[1].cancellable && rows[2].cancellable);
    } finally {
      ed.remove();
    }
  });
});

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

  // auto_generate_image on an external column: the row the add path puts on
  // screen carries a temporary id, and the provider's uid only arrives with
  // the reload afterwards — so the generation has to wait for the real task.
  describe('auto-generation on create', () => {
    async function autoCard({ uid = 'todoist-new', colExtra = {} } = {}) {
      const calls = [];
      const card = await externalCard(async (msg) => {
        calls.push(msg);
        if (msg.type === 'home_tasks/create_external_task') return { uid };
        if (msg.type === 'home_tasks/generate_task_image') {
          return { task: { id: msg.task_id, title: 'Milch', image_url: '/local/auto.png' } };
        }
        return null;
      });
      Object.assign(card._config.columns[0], {
        auto_generate_image: true, show_images: true, ...colExtra,
      });
      card._config.image_generation = { entity_id: 'ai_task.google_ai_task' };
      card._columns[0].newTaskTitle = 'Milch';
      // The generation waits for the real task and gives up on a detached
      // card, so this one has to live in the document.
      document.body.appendChild(card);
      card._reloadExternal = () => {};   // the real one is a 1.5s timer
      card._render = () => {};
      return { card, calls };
    }
    const generated = (calls) => calls.filter((c) => c.type === 'home_tasks/generate_task_image');
    const settle = () => new Promise((r) => setTimeout(r, 50));

    test('generates once the provider task has arrived', async () => {
      const { card, calls } = await autoCard();
      const pending = card._addTask(0);
      // Stand in for the post-create reload bringing in the real task.
      card._columns[0].tasks = [{ id: 'todoist-new', title: 'Milch' }];
      await pending;
      await settle();

      const gen = generated(calls);
      assert.equal(gen.length, 1);
      assert.equal(gen[0].task_id, 'todoist-new');
      assert.equal(gen[0].todo_entity_id, 'todo.do_zrobienia');
      assert.equal(gen[0].entry_id, undefined, 'must not be routed as a native list');
    });

    test('does nothing when the provider returned no uid', async () => {
      const { card, calls } = await autoCard({ uid: '' });
      await card._addTask(0);
      await settle();
      assert.deepEqual(generated(calls), []);
    });

    test('does nothing when the option is off', async () => {
      const { card, calls } = await autoCard({ colExtra: { auto_generate_image: false } });
      const pending = card._addTask(0);
      card._columns[0].tasks = [{ id: 'todoist-new', title: 'Milch' }];
      await pending;
      await settle();
      assert.deepEqual(generated(calls), []);
    });

    test('skips a task that already carries an image', async () => {
      const { card, calls } = await autoCard();
      const pending = card._addTask(0);
      card._columns[0].tasks = [{ id: 'todoist-new', title: 'Milch', image_url: '/local/known.png' }];
      await pending;
      await settle();
      assert.deepEqual(generated(calls), [], 'the same-title image is already there');
    });
  });

  // The backend decides what is stored; the card must not paint an image
  // into a column whose list opted out of the pool, or it shows something
  // that disappears on the next reload.
  test('a list that opted out is not painted by a generation elsewhere', async () => {
    const card = await externalCard(async () => ({
      task: { id: 'a1', title: 'Zimmer aufräumen', image_url: '/local/gen.png' },
    }));
    card._config.columns.push({ entity_id: 'todo.kid_b', show_images: true });
    card._externalLists = [
      { entity_id: 'todo.do_zrobienia', share_images: true },
      { entity_id: 'todo.kid_b', share_images: false },
    ];
    card._columns[0].tasks = [{ id: 'a1', title: 'Zimmer aufräumen' }];
    card._columns.push({ tasks: [{ id: 'b1', title: 'Zimmer aufräumen' }] });

    await card._generateTaskImage(card._columns[0].tasks[0], 0);

    assert.equal(card._columns[0].tasks[0].image_url, '/local/gen.png');
    assert.equal(card._columns[1].tasks[0].image_url, undefined);
  });

  test('a source list that opted out does not paint the others', async () => {
    const card = await externalCard(async () => ({
      task: { id: 'a1', title: 'Zimmer aufräumen', image_url: '/local/gen.png' },
    }));
    card._config.columns.push({ entity_id: 'todo.kid_b', show_images: true });
    card._externalLists = [
      { entity_id: 'todo.do_zrobienia', share_images: false },
      { entity_id: 'todo.kid_b', share_images: true },
    ];
    card._columns[0].tasks = [{ id: 'a1', title: 'Zimmer aufräumen' }];
    card._columns.push({ tasks: [{ id: 'b1', title: 'Zimmer aufräumen' }] });

    await card._generateTaskImage(card._columns[0].tasks[0], 0);

    assert.equal(card._columns[0].tasks[0].image_url, '/local/gen.png');
    assert.equal(card._columns[1].tasks[0].image_url, undefined);
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
