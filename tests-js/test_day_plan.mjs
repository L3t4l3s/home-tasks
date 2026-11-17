/**
 * custom:home-tasks-day-plan-card - the days of a plan instead of list columns.
 *
 * A plan only refers to tasks. What these tests pin down: the card draws the
 * days, a row acts on the task in its own list, and every change to the plan
 * goes out as one of the plan's commands.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const MON = '2026-11-16', TUE = '2026-11-17', WED = '2026-11-18';
const HORIZON = [MON, TUE, WED, '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];

const task = (id, title, extra = {}) => ({
  id, title, sort_order: 0, completed: false, sub_items: [], tags: [], reminders: [], ...extra,
});
const row = (task_id, entry_id, list_name, title, extra = {}) => ({
  task_id, entry_id, list_name, title, priority: null, tags: [], assigned_person: null,
  assigned_persons: [], due_date: null, due_time: null, completed: false, kind: 'planned', ...extra,
});

function fixture() {
  return {
    tasks: {
      L1: [
        task('A', 'Write report', { priority: 3 }),
        task('B', 'Send offer', { due_date: MON }),
        task('C', 'Call back', { completed: true }),
        task('D', 'Unplanned idea'),
      ],
      L2: [task('E', 'Buy milk'), task('F', 'Water plants')],
    },
    plan: {
      id: 'P1', name: 'Today', sensor_entity_id: 'sensor.today_open_items', carry_over: 'suggest',
      today: MON, current: MON, horizon: HORIZON,
      sources: [
        { entry_id: 'L1', name: 'Work', kind: 'native', entity_id: null, stamp: 'w1' },
        { entry_id: 'L2', name: 'Home', kind: 'native', entity_id: null, stamp: 'h1' },
      ],
      days: [
        {
          date: MON, note: 'Focus: release', updated: null, updated_by: null,
          items: [
            row('B', 'L1', 'Work', 'Send offer', { due_date: MON, kind: 'due' }),
            row('A', 'L1', 'Work', 'Write report', { priority: 3 }),
            row('C', 'L1', 'Work', 'Call back', { completed: true }),
          ],
        },
        { date: TUE, note: '', updated: null, updated_by: null, items: [row('E', 'L2', 'Home', 'Buy milk')] },
        { date: WED, note: '', updated: null, updated_by: null, items: [] },
      ],
    },
  };
}

// A card without its plan keeps asking for it (with backoff, for minutes).
// Closing the window of a finished test stops its timers, so that the run
// ends when the tests do.
const openWindows = [];
async function freshCard() {
  const loaded = await loadCard({ force: true });
  openWindows.push(loaded.window);
  return loaded;
}
afterEach(() => {
  while (openWindows.length) openWindows.pop().close();
});

async function settle(n = 8) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function makeCard(config = {}, mutate = null) {
  const { HomeTasksCard, window } = await freshCard();
  const data = fixture();
  if (mutate) mutate(data);
  const calls = [];
  const hass = {
    language: 'en', states: { 'sensor.today_open_items': { state: '2' } }, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      switch (msg.type) {
        case 'home_tasks/get_lists':
          return { lists: [
            { id: 'L1', name: 'Work', sensor_entity_id: 'sensor.work_open_tasks' },
            { id: 'L2', name: 'Home', sensor_entity_id: 'sensor.home_open_tasks' },
          ] };
        case 'home_tasks/get_external_lists': return { external_lists: [] };
        case 'home_tasks/get_plan':
          if (!data.plan) throw { code: 'invalid_request', message: 'There is no plan yet' };
          return { ...data.plan, days: data.plan.days.slice(0, msg.days) };
        case 'home_tasks/get_plans':
          return { plans: data.plan ? [{ ...data.plan, days: undefined }] : [] };
        case 'home_tasks/get_tasks': return { tasks: data.tasks[msg.list_id] || [] };
        default: return {};
      }
    },
    callService: async () => {},
  };
  // A config with columns is a card of lists; everything else is the day plan card.
  const card = new (config.columns ? HomeTasksCard : window.customElements.get('home-tasks-day-plan-card'))();
  card.setConfig(config.columns
    ? { type: 'custom:home-tasks-card', ...config }
    : { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3, ...config });
  document.body.appendChild(card);
  card.hass = hass;
  await settle();
  return { card, calls, data, hass };
}

const q = (card, sel) => card.shadowRoot.querySelector(sel);
const qa = (card, sel) => [...card.shadowRoot.querySelectorAll(sel)];
const text = (el) => el.textContent.trim();
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const sent = (calls, type) => calls.filter((c) => c.type === `home_tasks/${type}`);
// What the card sends is made in jsdom's realm; compare it as plain data.
const same = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
const day = (card, date) => q(card, `.plan-day-list[data-plan-date="${date}"]`).closest('.plan-day');

describe('day plan: titles with identical IDs in different lists', () => {
  async function twins() {
    return makeCard({}, (data) => {
      data.tasks.L2[0].id = 'A';
      data.plan.days[1].items[0].task_id = 'A';
    });
  }
  const taskRow = (card, entry) => q(card, `.plan-row[data-plan-entry="${entry}"][data-task-id="A"]`);

  for (const entry of ['L1', 'L2']) {
    test(`editing ${entry} opens and saves only that list's title`, async () => {
      const { card, calls, data } = await twins();
      const other = entry === 'L1' ? 'L2' : 'L1';
      const otherTitle = data.tasks[other].find((task) => task.id === 'A').title;
      taskRow(card, entry).querySelector('.task-title').dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true }),
      );
      await settle();
      const input = taskRow(card, entry).querySelector('.edit-title-input');
      assert.equal(qa(card, '.edit-title-input').length, 1);
      assert.equal(card.shadowRoot.activeElement, input);
      assert.equal(taskRow(card, other).querySelector('.edit-title-input'), null);
      input.value = `Renamed ${entry}`;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await settle();
      same(sent(calls, 'update_task'), [{
        type: 'home_tasks/update_task', list_id: entry, task_id: 'A', title: `Renamed ${entry}`,
      }]);
      assert.equal(data.tasks[other].find((task) => task.id === 'A').title, otherTitle);
    });
  }

  test('focus and caret stay in the second list after a forced rebuild', async () => {
    const { card } = await twins();
    click(taskRow(card, 'L1').querySelector('.task-content'));
    await settle();
    click(taskRow(card, 'L2').querySelector('.task-content'));
    await settle();
    assert.equal(qa(card, '.edit-title-input').length, 2);
    const input = taskRow(card, 'L2').querySelector('.edit-title-input');
    input.focus();
    input.setSelectionRange(1, 3);
    card._render();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const restored = taskRow(card, 'L2').querySelector('.edit-title-input');
    assert.equal(card.shadowRoot.activeElement, restored);
    assert.equal(restored.selectionStart, 1);
    assert.equal(restored.selectionEnd, 3);
  });

  test('a provider ID change keeps only its own list expanded', async () => {
    const { card, calls } = await twins();
    click(taskRow(card, 'L2').querySelector('.task-content'));
    await settle();
    card._taskIdChanged(1, 'A', 'new-A');
    card._render();
    await settle();
    assert.equal(taskRow(card, 'L1').querySelector('.edit-title-input'), null);
    const renamedRow = q(card, '.plan-row[data-plan-entry="L2"][data-task-id="new-A"]');
    const input = renamedRow.querySelector('.edit-title-input');
    assert.ok(input);
    input.focus();
    input.value = 'Renamed after ID change';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert.equal(sent(calls, 'update_task').at(-1).task_id, 'new-A');
    assert.equal(sent(calls, 'update_task').at(-1).list_id, 'L2');
  });
});

describe('day plan: what it shows', () => {
  test('one column per day, the current one first and set apart', async () => {
    const { card, calls } = await makeCard();
    const days = qa(card, '.plan-day');
    assert.equal(days.length, 3);
    assert.ok(days[0].classList.contains('plan-current'));
    assert.equal(qa(card, '.plan-current').length, 1);
    assert.deepEqual(qa(card, '.plan-day-name').map(text), ['Today', 'Tomorrow', 'Wednesday']);
    assert.equal(sent(calls, 'get_plan')[0].plan, 'P1');
    assert.equal(sent(calls, 'get_plan')[0].days, 3);
  });

  test('it is not a list: no list columns, no add-task field, no filters', async () => {
    const { card } = await makeCard();
    assert.equal(qa(card, '.card-column').length, 0);
    assert.equal(qa(card, '.add-task').length, 0);
    assert.equal(qa(card, '.filters').length, 0);
  });

  test('the current day shows its note and how far it is', async () => {
    const { card } = await makeCard();
    const today = day(card, MON);
    assert.equal(text(today.querySelector('.plan-note')), 'Focus: release');
    assert.equal(text(today.querySelector('.plan-progress-text')), '1 of 3 done');
    assert.equal(today.querySelector('.plan-bar-fill').style.width, '33%');
    // Other days: how many, no progress bar.
    assert.equal(text(day(card, TUE).querySelector('.plan-count')), '1');
    assert.equal(day(card, TUE).querySelector('.plan-progress'), null);
  });

  test('rows carry their number, in the order of the plan', async () => {
    const { card } = await makeCard();
    const rows = [...day(card, MON).querySelectorAll('.plan-row')];
    assert.deepEqual(rows.map((r) => text(r.querySelector('.task-title'))), ['Send offer', 'Write report', 'Call back']);
    assert.deepEqual(rows.map((r) => text(r.querySelector('.plan-num'))), ['1', '2', '']);
    assert.ok(rows[2].classList.contains('completed'));
    assert.ok(rows[2].querySelector('.plan-num.done ha-icon'));
    assert.equal(qa(card, '.plan-row input[type="checkbox"]').length, 0);
  });

  test('a row says which list it is from and why it is there', async () => {
    const { card } = await makeCard();
    const rows = [...day(card, MON).querySelectorAll('.plan-row')];
    assert.equal(text(rows[0].querySelector('.plan-list-badge')), 'Work');
    assert.ok(rows[0].classList.contains('plan-kind-due'));
    assert.ok(rows[1].classList.contains('plan-kind-planned'));
    assert.ok(rows[0].querySelector('.due-date'), 'the due badge stays on the row');
    assert.ok(rows[1].querySelector('.priority-badge'));
  });

  test('with one list the list badge is left out', async () => {
    const { card } = await makeCard({}, (data) => { data.plan.sources.pop(); data.plan.days[1].items = []; });
    assert.equal(qa(card, '.plan-list-badge').length, 0);
  });

  test('an empty day says so', async () => {
    const { card } = await makeCard();
    assert.equal(text(day(card, WED).querySelector('.plan-empty')), 'Nothing planned');
  });

  test('days: 1 is today only; out of range is brought back', async () => {
    const one = await makeCard({ days: undefined });
    assert.equal(qa(one.card, '.plan-day').length, 1);
    const many = await makeCard({ days: 99 });
    assert.equal(sent(many.calls, 'get_plan')[0].days, 7);
  });

  test('no plan: the card says where to make one', async () => {
    const { card } = await makeCard({}, (data) => { data.plan = null; });
    assert.match(text(q(card, '.plan-missing')), /No day plan found/);
    assert.match(text(q(card, '.plan-missing-detail')), /no plan yet/);
    assert.equal(qa(card, '.plan-day').length, 0);
  });

  test('no plan: an administrator gets the way to where one is made', async () => {
    const PATH = '/config/integrations/integration/home_tasks';
    const { card, hass } = await makeCard({}, (data) => { data.plan = null; });
    assert.equal(q(card, '.new-entry-link'), null, 'not for everybody: only an administrator can add one');

    card.hass = { ...hass, user: { is_admin: true } };
    card._render();
    const link = q(card, '.plan-missing .new-entry-link');
    assert.equal(text(link), '+ Create a new list or day plan');
    assert.equal(link.getAttribute('href'), PATH);

    // A click stays within Home Assistant: the address moves, the page is not loaded anew.
    const win = card.ownerDocument.defaultView;
    const moved = [];
    win.addEventListener('location-changed', (e) => moved.push(e.detail));
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(win.location.pathname + win.location.search, PATH);
    same(moved, [{ replace: false }]);
  });

  test('display options of a column apply to the rows', async () => {
    const { card } = await makeCard({ show_priority: false });
    assert.equal(qa(card, '.priority-badge').length, 0);
  });

  test('it is a card type of its own, next to the list card', async () => {
    const { window } = await freshCard();
    const Plan = window.customElements.get('home-tasks-day-plan-card');
    const List = window.customElements.get('home-tasks-card');
    assert.ok(Plan && List && Plan !== List);
    // Both are built on the same base; the plan card is no list card.
    assert.equal(Object.getPrototypeOf(Plan), Object.getPrototypeOf(List));
    assert.equal(Plan.prototype instanceof List, false);
    // Two entries in the card picker, each with a name of its own.
    const entries = window.customCards.filter((c) => c.type.startsWith('home-tasks'));
    same(entries.map((c) => [c.type, c.name]), [
      ['home-tasks-card', 'Home Tasks: List'],
      ['home-tasks-day-plan-card', 'Home Tasks: Day plan'],
    ]);
    assert.ok(entries.every((c) => c.description && c.preview === true));
    // Each has its own editor.
    assert.equal(Plan.getConfigElement().localName, 'home-tasks-day-plan-card-editor');
    assert.equal(List.getConfigElement().localName, 'home-tasks-card-editor');
  });

  test('picking an entity in "add to dashboard" suggests the matching card', async () => {
    const { window } = await freshCard();
    const entry = (type) => window.customCards.find((c) => c.type === type);
    const list = entry('home-tasks-card').getEntitySuggestion;
    const plan = entry('home-tasks-day-plan-card').getEntitySuggestion;
    // Each list and plan has a device that says what it is (device.py).
    const dev = (id, ...identifiers) => [id, { id, identifiers }];
    const hass = {
      devices: Object.fromEntries([
        dev('d_list', ['home_tasks', 'list:L1']),
        dev('d_linked', ['home_tasks', 'linked:todo.google_einkauf']),
        dev('d_plan', ['home_tasks', 'plan:P1']),
        dev('d_google', ['google_tasks', 'account']),
        dev('d_other', ['other', 'plan:X']),
      ]),
      entities: Object.fromEntries([
        ['todo.bens_aufgaben', 'd_list'],
        ['binary_sensor.bens_aufgaben_overdue', 'd_list'],
        ['todo.google_einkauf', 'd_google'],
        ['sensor.google_einkauf_open_tasks', 'd_linked'],
        ['todo.shopping_list', undefined],
        ['sensor.heute_open_items', 'd_plan'],
        ['sensor.other', 'd_other'],
      ].map(([entity_id, device_id]) => [entity_id, { entity_id, device_id }])),
      states: {},
    };
    const listCard = (column) => ({ config: { type: 'custom:home-tasks-card', columns: [column] } });
    // Any entity of a Home Tasks list.
    same(list(hass, 'todo.bens_aufgaben'), listCard({ list_id: 'L1' }));
    same(list(hass, 'binary_sensor.bens_aufgaben_overdue'), listCard({ list_id: 'L1' }));
    // A provider's list linked to Home Tasks - also with its own device -
    // and the linked list's own entities.
    same(list(hass, 'todo.google_einkauf'), listCard({ entity_id: 'todo.google_einkauf' }));
    same(list(hass, 'sensor.google_einkauf_open_tasks'), listCard({ entity_id: 'todo.google_einkauf' }));
    // Not linked, someone else's device, or nothing known: nothing to offer.
    assert.equal(list(hass, 'todo.shopping_list'), null);
    assert.equal(list(hass, 'sensor.other'), null);
    assert.equal(list(hass, 'todo.unknown'), null);
    assert.equal(list({}, 'todo.bens_aufgaben'), null);
    // A plan's entity.
    same(plan(hass, 'sensor.heute_open_items'),
      { config: { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 } });
    assert.equal(plan(hass, 'sensor.other'), null);
    assert.equal(plan(hass, 'todo.bens_aufgaben'), null);
    assert.equal(list(hass, 'sensor.heute_open_items'), null);
  });

  test('a suggested card shows its list or plan as it is', async () => {
    const { window } = await freshCard();
    const entry = (type) => window.customCards.find((c) => c.type === type);
    const hass = {
      devices: {
        d1: { id: 'd1', identifiers: [['home_tasks', 'list:L1']] },
        d2: { id: 'd2', identifiers: [['home_tasks', 'plan:P1']] },
      },
      entities: {
        'todo.work': { entity_id: 'todo.work', device_id: 'd1' },
        'sensor.today_open_items': { entity_id: 'sensor.today_open_items', device_id: 'd2' },
      },
    };
    const { card: listCard } = await makeCard(
      entry('home-tasks-card').getEntitySuggestion(hass, 'todo.work').config);
    assert.match(listCard.shadowRoot.textContent, /Write report/);
    const { card: planCard } = await makeCard(
      entry('home-tasks-day-plan-card').getEntitySuggestion(hass, 'sensor.today_open_items').config);
    assert.equal(planCard._planId, 'P1');
    assert.match(planCard.shadowRoot.textContent, /Write report/);
  });

  test('a new card from the picker names the first plan', async () => {
    const { window } = await freshCard();
    const Plan = window.customElements.get('home-tasks-day-plan-card');
    const hass = { callWS: async () => ({ plans: [{ id: 'P1' }, { id: 'P2' }] }) };
    same(await Plan.getStubConfig(hass), { days: 3, plan: 'P1' });
    same(await Plan.getStubConfig({ callWS: async () => ({ plans: [] }) }), { days: 3 });
    same(await Plan.getStubConfig({ callWS: async () => { throw new Error('away'); } }), { days: 3 });
  });

  test('the list card says where the day plan went', async () => {
    const { HomeTasksCard } = await freshCard();
    const card = new HomeTasksCard();
    assert.throws(
      () => card.setConfig({ type: 'custom:home-tasks-card', view: 'day_plan', plan: 'P1' }),
      /custom:home-tasks-day-plan-card/,
    );
  });

  test('keys of a list card in the config are left alone, not read', async () => {
    // Written while the plan was a view of the list card.
    const { HomeTasksCard: _l, window } = await freshCard();
    const card = new (window.customElements.get('home-tasks-day-plan-card'))();
    card.setConfig({
      type: 'custom:home-tasks-day-plan-card', view: 'day_plan', plan: 'P1', days: 2,
      columns: [{ list_id: 'L1', show_priority: false }],
    });
    assert.equal(card._sourceCols().length, 0, 'its lists come from the plan, not from columns');
    assert.equal(card._planDays, 2);
    assert.equal('show_priority' in card._planTemplate, false);
    assert.equal('columns' in card._planTemplate || 'view' in card._planTemplate, false);
  });

  test('a look in the background that brings the same tasks back does not rebuild the card', async () => {
    const { card, data } = await makeCard();
    const before = q(card, '.plan-day');
    card._columns[0].stale = true;             // as the poll marks a linked list
    await card._loadAllTasks(true);
    assert.equal(q(card, '.plan-day'), before, 'asked again, nothing new: the same elements');

    // A new answer, not the objects the card holds: that is what a list sends.
    data.tasks.L1 = data.tasks.L1.map((t) => (t.id === 'A' ? { ...t, title: 'Write the report' } : { ...t }));
    card._columns[0].stale = true;
    await card._loadAllTasks(true);
    assert.notEqual(q(card, '.plan-day'), before);
    assert.ok(qa(card, '.task-title').some((el) => text(el) === 'Write the report'));
  });

  test('a card title is the heading of the plan, tinted like the head of the current day', async () => {
    const { card } = await makeCard({ title: 'My week' });
    const title = q(card, '.plan-view > .card-global-title');
    assert.equal(text(title), 'My week');
    assert.equal(title.nextElementSibling.className.split(' ')[0], 'plan-days');
    // The rule that tints it, with the tint the current day's head has.
    const css = [...card.shadowRoot.querySelectorAll('style')].map((el) => el.textContent).join(' ');
    const tint = 'background: color-mix(in srgb, var(--todo-primary) 14%, var(--todo-bg));';
    const rule = css.slice(css.indexOf('.plan-view > .card-global-title {'));
    assert.ok(rule.startsWith('.plan-view > .card-global-title {') && rule.slice(0, rule.indexOf('}')).includes(tint));
    const head = css.slice(css.indexOf('.plan-current .plan-day-head {'));
    assert.ok(head.slice(0, head.indexOf('}')).includes(tint));
    // Without a title there is no bar.
    const plain = await makeCard();
    assert.equal(q(plain.card, '.card-global-title'), null);
  });

  test('a regional language reads its base language, in the card and in the picker', async () => {
    const { card, hass } = await makeCard();
    card.hass = { ...hass, language: 'de-CH', locale: undefined };
    card._render();
    assert.equal(text(q(card, '.plan-day-name')), 'Heute');
    card.hass = { ...hass, language: 'xx', locale: undefined };
    card._render();
    assert.equal(text(q(card, '.plan-day-name')), 'Today', 'an unknown language reads English');
  });

  test('date, focus line and progress bar can each be switched off', async () => {
    const all = await makeCard();
    assert.equal(qa(all.card, '.plan-day-date').length, 3);
    assert.equal(qa(all.card, '.plan-note').length, 3);

    const noDate = await makeCard({ show_date: false });
    assert.equal(qa(noDate.card, '.plan-day-date').length, 0);
    assert.deepEqual(qa(noDate.card, '.plan-day-name').map(text), ['Today', 'Tomorrow', 'Wednesday']);
    assert.ok(q(noDate.card, '.plan-note') && q(noDate.card, '.plan-progress'), 'the others stay');

    const noFocus = await makeCard({ show_focus: false });
    assert.equal(qa(noFocus.card, '.plan-note').length, 0, 'also a note that is set');
    assert.equal(qa(noFocus.card, '.plan-day-date').length, 3);

    const noBar = await makeCard({ show_progress: false });
    assert.equal(q(noBar.card, '.plan-progress'), null);
    assert.equal(text(day(noBar.card, TUE).querySelector('.plan-count')), '1', 'the count of other days stays');
  });
});

describe('day plan: a row is the task in its list', () => {
  test('the number completes the task in its own list', async () => {
    const { card, calls } = await makeCard();
    click(day(card, MON).querySelector('.plan-row .plan-num'));
    await settle();
    const [update] = sent(calls, 'update_task');
    assert.equal(update.list_id, 'L1');
    assert.equal(update.task_id, 'B');
    assert.equal(update.completed, true);
    assert.ok(sent(calls, 'get_plan').length >= 2, 'the plan is read again');
  });

  test('the tick shows at once, before the backend has answered', async () => {
    const { card, calls, hass } = await makeCard();
    let release;
    const callWS = hass.callWS;
    hass.callWS = (msg) => {
      if (msg.type !== 'home_tasks/update_task') return callWS(msg);
      calls.push(msg);
      return new Promise((resolve) => { release = () => resolve({}); });
    };
    click(day(card, MON).querySelector('.plan-row .plan-num'));
    await settle(2);
    const first = day(card, MON).querySelector('.plan-row');
    assert.ok(first.classList.contains('completed'), 'struck through while the write is still out');
    assert.equal(text(day(card, MON).querySelector('.plan-progress-text')), '2 of 3 done');
    assert.ok(release, 'the write went out');
    release();
    await settle();
  });

  test('confirm_complete asks first', async () => {
    const { card, calls } = await makeCard({ confirm_complete: true });
    let asked = null;
    card._confirmDialog = async (message) => { asked = message; return false; };
    click(day(card, MON).querySelector('.plan-row .plan-num'));
    await settle();
    assert.equal(asked, 'Mark "Send offer" as completed?');
    assert.equal(sent(calls, 'update_task').length, 0);
    assert.ok(!day(card, MON).querySelector('.plan-row').classList.contains('completed'));
  });

  test('a tap on the row opens the task editor of its list', async () => {
    const { card, calls } = await makeCard();
    click(day(card, MON).querySelectorAll('.plan-row')[1].querySelector('.task-content'));
    await settle();
    assert.ok(q(card, '.plan-row[data-task-id="A"].is-expanded'));
    assert.ok(q(card, '.plan-row .task-details'));
    assert.equal(sent(calls, 'update_task').length, 0);
  });

  test('done today but open again (a recurring task): a tap takes the day\'s "done" back', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.tasks.L1[2].completed = false;      // reopened for its next round
    });
    const num = () => day(card, MON).querySelectorAll('.plan-row')[2].querySelector('.plan-num');
    assert.ok(num().classList.contains('done'));
    assert.equal(num().disabled, false);
    click(num());
    // The row is open at once ...
    assert.equal(num().classList.contains('done'), false);
    await settle();
    // ... the plan is told, and the task is not: toggling it would complete
    // its next round.
    same(sent(calls, 'untick_plan_task').at(-1), {
      type: 'home_tasks/untick_plan_task', task_id: 'C', entry_id: 'L1', plan: 'P1',
    });
    assert.equal(sent(calls, 'update_task').length, 0);
  });

  test('the second click of a double-click on that tick does not complete the next round', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.tasks.L1[2].completed = false;
    });
    const num = () => day(card, MON).querySelectorAll('.plan-row')[2].querySelector('.plan-num');
    click(num());
    click(num());                              // lands on the rebuilt, now open number
    await settle();
    assert.equal(sent(calls, 'untick_plan_task').length, 1);
    assert.equal(sent(calls, 'update_task').length, 0);
  });

  test('right after taking one tick back, another row can be ticked', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.tasks.L1[2].completed = false;
    });
    const num = (index) => day(card, MON).querySelectorAll('.plan-row')[index].querySelector('.plan-num');
    click(num(2));                             // takes back the done of row 3
    click(num(1));                             // and at once ticks row 2 off
    await settle();
    assert.equal(sent(calls, 'untick_plan_task').length, 1);
    const update = sent(calls, 'update_task').at(-1);
    assert.equal(update.task_id, 'A');
    assert.equal(update.completed, true);
  });

  test('taking a tick back that the plan refuses does not stay shown', async () => {
    const { card, calls, hass } = await makeCard({}, (data) => {
      data.tasks.L1[2].completed = false;
    });
    const answer = hass.callWS;
    hass.callWS = async (msg) => {
      if (msg.type === 'home_tasks/untick_plan_task') {
        calls.push(msg);
        throw { code: 'invalid_request', message: 'Call back is completed: reopen the task itself' };
      }
      // Every answer is new objects, as over a real connection.
      return JSON.parse(JSON.stringify(await answer(msg)));
    };
    // Read once through that connection, so that the card holds copies and
    // not the objects this test's backend answers from.
    card._planJson = null;
    card._columns.forEach((cs) => { cs.stale = true; });
    await card._loadAllTasks();
    const num = () => day(card, MON).querySelectorAll('.plan-row')[2].querySelector('.plan-num');
    click(num());
    assert.equal(num().classList.contains('done'), false, 'open at once');
    await settle();
    // The plan answered what it had answered before: the row is done there, and here again.
    assert.ok(num().classList.contains('done'));
    assert.equal(sent(calls, 'untick_plan_task').length, 1);
  });

  test('a tick shows at once, also after a look in the background that found nothing new', async () => {
    const { card, hass } = await makeCard();
    // Every answer is new objects, as over a real connection.
    const answer = hass.callWS;
    hass.callWS = async (msg) => JSON.parse(JSON.stringify(await answer(msg)));
    card._columns.forEach((cs) => { cs.stale = true; });
    await card._loadAllTasks(true);            // the same plan, the same tasks: nothing is rebuilt
    await card._loadAllTasks(true);
    const num = () => day(card, MON).querySelectorAll('.plan-row')[1].querySelector('.plan-num');
    click(num());
    // Not after the list has answered: now.
    assert.ok(num().classList.contains('done'));
    assert.equal(text(day(card, MON).querySelector('.plan-progress-text')), '2 of 3 done');
    await settle();
  });

  test('a tick the list refuses is taken back, on the row and on the card\'s copy of the task', async () => {
    const { card, calls, hass } = await makeCard();
    const answer = hass.callWS;
    hass.callWS = async (msg) => {
      if (msg.type === 'home_tasks/update_task') {
        calls.push(msg);
        throw { code: 'invalid_request', message: 'Refused' };
      }
      return answer(msg);
    };
    const num = () => day(card, MON).querySelectorAll('.plan-row')[1].querySelector('.plan-num');
    click(num());
    assert.ok(num().classList.contains('done'), 'shown at once');
    await settle();
    assert.equal(num().classList.contains('done'), false);
    assert.equal(card._columns[0].tasks.find((t) => t.id === 'A').completed, false);
    // The list was read again, though the plan did not say it changed.
    assert.ok(sent(calls, 'get_tasks').filter((c) => c.list_id === 'L1').length >= 2);
    // So the next tap completes it, instead of sending "open" for a task that is open.
    hass.callWS = answer;
    click(num());
    await settle();
    assert.equal(sent(calls, 'update_task').at(-1).completed, true);
  });

  test('a done row whose task is completed is un-ticked in its list, as before', async () => {
    const { card, calls } = await makeCard();
    click(day(card, MON).querySelectorAll('.plan-row')[2].querySelector('.plan-num'));
    await settle();
    assert.equal(sent(calls, 'untick_plan_task').length, 0);
    const update = sent(calls, 'update_task').at(-1);
    assert.equal(update.task_id, 'C');
    assert.equal(update.completed, false);
  });

  test('a row whose list has not answered shows what the plan knows', async () => {
    const { card } = await makeCard({}, (data) => { data.tasks.L2 = []; });
    const rowEl = day(card, TUE).querySelector('.plan-row');
    assert.equal(text(rowEl.querySelector('.task-title')), 'Buy milk');
    assert.equal(rowEl.querySelector('.expand-btn'), null);
  });
});

describe('day plan: changing the plan', () => {
  test('an open recurrence tomorrow gets its own actions after completion today', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.tasks.L1[2].completed = false;
      data.tasks.L1[2].due_date = TUE;
      data.plan.days[1].items = [row('C', 'L1', 'Work', 'Call back', { kind: 'due', due_date: TUE })];
    });
    click(day(card, TUE).querySelector('.task-content'));
    await settle();
    const today = day(card, MON).querySelector('.plan-row[data-task-id="C"]');
    const tomorrow = day(card, TUE).querySelector('.plan-row[data-task-id="C"]');
    assert.equal(today.querySelector('.plan-actions'), null);
    assert.ok(tomorrow.querySelector('.plan-due-hint'));
    assert.equal(tomorrow.querySelector('.plan-remove-btn'), null);
    const next = tomorrow.querySelector('.plan-next-btn');
    assert.ok(next, 'the open recurrence has a next-day action');
    click(next);
    await settle();
    same(sent(calls, 'plan_task').at(-1), {
      type: 'home_tasks/plan_task', task_id: 'C', entry_id: 'L1', date: WED, plan: 'P1',
    });
  });

  async function opened(taskIndex) {
    const made = await makeCard();
    click(day(made.card, MON).querySelectorAll('.plan-row')[taskIndex].querySelector('.task-content'));
    await settle();
    return made;
  }

  test('a planned row: to the next day, to another day, off the plan', async () => {
    const { card, calls } = await opened(1);
    // Right under the row's title, above the task's fields.
    const labels = qa(card, '.plan-actions button').map(text);
    assert.deepEqual(labels, ['→ Tomorrow', '→ Other day…', 'Remove from plan']);
    assert.equal(q(card, '.plan-due-hint'), null);
    const rowEl = q(card, '.plan-row.is-expanded');
    assert.equal(rowEl.children[1].className, 'plan-actions');
    assert.ok(rowEl.children[2].classList.contains('task-details'));
    assert.equal(qa(card, '.detail-actions .plan-next-btn, .detail-actions .plan-remove-btn').length, 0);

    click(q(card, '.plan-next-btn'));
    await settle();
    same(sent(calls, 'plan_task').at(-1), {
      type: 'home_tasks/plan_task', task_id: 'A', entry_id: 'L1', date: TUE, plan: 'P1',
    });
  });

  test('a row that is there through its due date can only be moved, and says so', async () => {
    const { card } = await opened(0);
    assert.ok(q(card, '.plan-next-btn'));
    assert.equal(q(card, '.plan-remove-btn'), null);
    // Where the button would be: why there is none.
    assert.match(text(q(card, '.plan-actions .plan-due-hint')), /through its due date/);
  });

  test('a done row has no plan actions', async () => {
    const { card } = await opened(2);
    assert.equal(q(card, '.plan-next-btn'), null);
    assert.equal(q(card, '.plan-remove-btn'), null);
    assert.equal(q(card, '.plan-actions'), null);
  });

  test('the fields of an open row follow the card config: which, and in which order', async () => {
    const fields = async (config) => {
      const { card } = await makeCard(config);
      click(day(card, MON).querySelectorAll('.plan-row')[1].querySelector('.task-content'));
      await settle();
      return qa(card, '.plan-row.is-expanded [data-detail-key]').map((el) => el.dataset.detailKey);
    };
    const standard = await fields({});
    assert.deepEqual(standard.slice(0, 2), ['notes', 'sub_tasks']);
    assert.ok(standard.includes('reminders') && standard.includes('tags'));

    const fewer = await fields({ show_notes: false, show_reminders: false });
    assert.deepEqual(fewer, standard.filter((key) => key !== 'notes' && key !== 'reminders'));

    const reordered = await fields({ detail_order: ['tags', 'priority'] });
    assert.deepEqual(reordered.slice(0, 2), ['tags', 'priority']);
    assert.deepEqual([...reordered].sort(), [...standard].sort(), 'the same fields, another order');
  });

  test('"Remove from plan" takes the reference off', async () => {
    const { card, calls } = await opened(1);
    click(q(card, '.plan-remove-btn'));
    await settle();
    same(sent(calls, 'unplan_task').at(-1), {
      type: 'home_tasks/unplan_task', task_id: 'A', entry_id: 'L1', plan: 'P1',
    });
  });

  test('a task deleted from its details leaves the plan at once', async () => {
    const { card, calls, hass } = await opened(1);
    // The backend takes its time: what shows meanwhile is what matters.
    let release;
    const callWS = hass.callWS;
    hass.callWS = (msg) => {
      if (msg.type !== 'home_tasks/delete_task') return callWS(msg);
      calls.push(msg);
      return new Promise((resolve) => { release = () => resolve({}); });
    };
    click(q(card, '.delete-task-btn'));
    await new Promise((r) => setTimeout(r, 350));     // the row's exit animation
    assert.ok(release, 'the delete went out');
    const titles = [...day(card, MON).querySelectorAll('.plan-row .task-title')].map(text);
    assert.deepEqual(titles, ['Send offer', 'Call back'], 'no leftover row for the deleted task');
    assert.equal(text(day(card, MON).querySelector('.plan-progress-text')), '1 of 2 done');
    release();
    await settle();
  });

  test('"Other day…" asks for the day', async () => {
    const { card, calls } = await opened(1);
    click(q(card, '.plan-move-btn'));
    await settle(2);
    const options = qa(card, 'dialog .ht-move-select option');
    assert.equal(options.length, 6, 'every day of the plan but its own');
    assert.equal(text(options[0]), 'Tomorrow, Nov 17');
    q(card, 'dialog .ht-move-select').value = WED;
    click(q(card, 'dialog .ht-confirm-btn.primary'));
    await settle();
    assert.equal(sent(calls, 'plan_task').at(-1).date, WED);
  });

  test('the note is edited in place', async () => {
    const { card, calls } = await makeCard();
    click(day(card, MON).querySelector('.plan-note'));
    await settle(2);
    const input = q(card, '.plan-note-input');
    assert.equal(input.value, 'Focus: release');
    input.value = 'Focus: tests';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    same(sent(calls, 'set_plan_day').at(-1), {
      type: 'home_tasks/set_plan_day', date: MON, note: 'Focus: tests', plan: 'P1',
    });
    assert.equal(q(card, '.plan-note-input'), null);
  });

  test('Escape leaves the note as it was', async () => {
    const { card, calls } = await makeCard();
    click(day(card, TUE).querySelector('.plan-note'));
    await settle(2);
    const input = q(card, '.plan-note-input');
    input.value = 'Never mind';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    assert.equal(sent(calls, 'set_plan_day').length, 0);
  });

  test('"Plan a task" searches the open tasks of the plan\'s lists', async () => {
    const { card, calls } = await makeCard();
    click(day(card, MON).querySelector('.plan-add-btn'));
    await settle(2);
    const titles = () => qa(card, '.plan-candidate-title').map(text);
    // Not what is on the day already, not what is done.
    assert.deepEqual(titles(), ['Unplanned idea', 'Buy milk', 'Water plants']);

    const input = q(card, '.plan-add-input');
    input.value = 'wat';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.deepEqual(titles(), ['Water plants']);
    assert.equal(q(card, '.plan-add-input'), input, 'typing does not rebuild the field');

    click(q(card, '.plan-candidate'));
    await settle();
    same(sent(calls, 'plan_task').at(-1), {
      type: 'home_tasks/plan_task', task_id: 'F', entry_id: 'L2', date: MON, plan: 'P1',
    });
  });

  test('the lists with something to plan filter the search', async () => {
    const { card } = await makeCard();
    click(day(card, MON).querySelector('.plan-add-btn'));
    await settle(2);
    const chips = qa(card, '.plan-list-chip');
    assert.deepEqual(chips.map(text), ['Work', 'Home']);
    const titles = () => qa(card, '.plan-candidate-title').map(text);

    click(chips[1]);                                   // only "Home"
    assert.ok(chips[1].classList.contains('active'));
    assert.deepEqual(titles(), ['Buy milk', 'Water plants']);
    click(chips[0]);                                   // both picked = both shown
    assert.deepEqual(titles(), ['Unplanned idea', 'Buy milk', 'Water plants']);
    click(chips[1]);                                   // only "Work"
    assert.deepEqual(titles(), ['Unplanned idea']);
    assert.equal(q(card, '.plan-add-input').isConnected, true, 'the panel is not rebuilt');
  });

  test('a list with nothing left to plan gets no chip', async () => {
    const { card } = await makeCard({}, (data) => { data.tasks.L2.forEach((t) => { t.completed = true; }); });
    click(day(card, MON).querySelector('.plan-add-btn'));
    await settle(2);
    assert.equal(qa(card, '.plan-list-chip').length, 0, 'one list left: nothing to choose');
  });

  test('a search without a hit says so', async () => {
    const { card } = await makeCard();
    click(day(card, WED).querySelector('.plan-add-btn'));
    await settle(2);
    const input = q(card, '.plan-add-input');
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(text(q(card, '.plan-no-results')), 'No matching open tasks');
  });

  test('what is left from the last planned day is offered', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.plan.days[0].carry_over = {
        date: '2026-11-13',
        items: [row('D', 'L1', 'Work', 'Unplanned idea'), row('F', 'L2', 'Home', 'Water plants')],
      };
    });
    const offer = day(card, MON).querySelector('.plan-carry');
    assert.equal(text(offer), 'Carry over open tasks from Nov 13 (2)');
    click(offer);
    await settle();
    same(sent(calls, 'set_plan_day').at(-1), {
      type: 'home_tasks/set_plan_day', date: MON, plan: 'P1',
      items: [{ task_id: 'D', entry_id: 'L1' }, { task_id: 'F', entry_id: 'L2' }],
    });
  });

  test('a refusal of the plan is shown, and the plan read again', async () => {
    const { card, calls, hass } = await makeCard();
    const callWS = hass.callWS;
    hass.callWS = async (msg) => {
      if (msg.type === 'home_tasks/unplan_task') {
        calls.push(msg);
        throw { code: 'invalid_request', message: 'No task with id A on the plan' };
      }
      return callWS(msg);
    };
    const before = sent(calls, 'get_plan').length;
    await card._planWrite('home_tasks/unplan_task', { task_id: 'A' });
    assert.equal(text(q(card, '.toast-error')), 'No task with id A on the plan');
    assert.equal(sent(calls, 'get_plan').length, before + 1);
  });
});

describe('day plan: dragging', () => {
  for (const input of ['desktop', 'touch']) {
    for (const destination of ['reorder', 'another day']) {
      test(`${input}: drag tomorrow's recurrence ${destination} without moving today's done row`, async () => {
        const { card, calls } = await makeCard({}, (data) => {
          data.tasks.L1[2].completed = false;
          data.plan.days[1].items.unshift(row('C', 'L1', 'Work', 'Call back'));
        });
        const done = day(card, MON).querySelector('.plan-row[data-task-id="C"]');
        const recurrence = day(card, TUE).querySelector('.plan-row[data-task-id="C"]');
        if (input === 'desktop') {
          const start = new Event('dragstart', { bubbles: true });
          Object.defineProperty(start, 'dataTransfer', { value: {} });
          recurrence.dispatchEvent(start);
        } else {
          const start = new Event('touchstart', { bubbles: true });
          Object.defineProperty(start, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
          recurrence.dispatchEvent(start);
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
        assert.ok(recurrence.classList.contains('dragging'));
        assert.ok(!done.classList.contains('dragging'));
        if (destination === 'reorder') {
          const target = day(card, TUE).querySelector('.plan-row[data-task-id="E"]');
          if (input === 'desktop') {
            const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
            Object.defineProperty(over, 'dataTransfer', { value: {} });
            target.dispatchEvent(over);
          } else {
            card.shadowRoot.elementFromPoint = () => target;
            const move = new Event('touchmove', { bubbles: true, cancelable: true });
            Object.defineProperty(move, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
            recurrence.dispatchEvent(move);
          }
          assert.equal(target.nextElementSibling, recurrence);
        } else {
          const target = q(card, `.plan-day-list[data-plan-date="${WED}"]`);
          card._planDropInto(target);
          assert.equal(recurrence.parentNode, target);
        }
        assert.equal(done.closest('.plan-day-list').dataset.planDate, MON);
        card._finishDrag();
        await settle();
        same(sent(calls, 'set_plan_day').at(-1), {
          type: 'home_tasks/set_plan_day', date: destination === 'reorder' ? TUE : WED, plan: 'P1',
          items: destination === 'reorder'
            ? [{ task_id: 'E', entry_id: 'L2' }, { task_id: 'C', entry_id: 'L1' }]
            : [{ task_id: 'C', entry_id: 'L1' }],
        });
        assert.equal(card._draggedTaskId, null);
        assert.equal(card._draggedTaskElement, null);
      });
    }
  }

  for (const input of ['desktop', 'touch']) {
    test(`${input}: dragging over a row with the same ID keeps both lists distinct`, async () => {
      const { card, calls } = await makeCard({}, (data) => {
        data.tasks.L2[0].id = 'A';
        data.plan.days[1].items[0].task_id = 'A';
      });
      const first = q(card, '.plan-row[data-task-id="A"][data-plan-entry="L1"]');
      const second = q(card, '.plan-row[data-task-id="A"][data-plan-entry="L2"]');
      if (input === 'desktop') {
        const start = new Event('dragstart', { bubbles: true });
        Object.defineProperty(start, 'dataTransfer', { value: {} });
        second.dispatchEvent(start);
        const over = new MouseEvent('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(over, 'dataTransfer', { value: {} });
        first.dispatchEvent(over);
      } else {
        const touch = (type) => {
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: [{ clientX: 0, clientY: 0 }] });
          second.dispatchEvent(event);
        };
        touch('touchstart');
        await new Promise((resolve) => setTimeout(resolve, 180));
        assert.ok(second.classList.contains('dragging'));
        assert.ok(!first.classList.contains('dragging'));
        card.shadowRoot.elementFromPoint = () => first;
        touch('touchmove');
      }
      assert.equal(second.parentNode, first.parentNode);
      assert.equal(first.nextElementSibling, second);
      card._finishDrag();
      await settle();
      same(sent(calls, 'set_plan_day').at(-1), {
        type: 'home_tasks/set_plan_day', date: MON, plan: 'P1',
        items: [
          { task_id: 'B', entry_id: 'L1' }, { task_id: 'A', entry_id: 'L1' },
          { task_id: 'A', entry_id: 'L2' }, { task_id: 'C', entry_id: 'L1' },
        ],
      });
    });
  }

  test('identical IDs in different lists: move and save the dragged row', async () => {
    const { card, calls } = await makeCard({}, (data) => {
      data.tasks.L2[0].id = 'A';
      data.plan.days[1].items[0].task_id = 'A';
    });
    const first = q(card, '.plan-row[data-task-id="A"][data-plan-entry="L1"]');
    const second = q(card, '.plan-row[data-task-id="A"][data-plan-entry="L2"]');
    const target = q(card, `.plan-day-list[data-plan-date="${WED}"]`);
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', { value: {} });
    second.dispatchEvent(start);
    card._planDropInto(target);
    assert.equal(second.parentNode, target);
    assert.equal(first.closest('.plan-day-list').dataset.planDate, MON);
    card._finishDrag();
    await settle();
    same(sent(calls, 'set_plan_day').at(-1), {
      type: 'home_tasks/set_plan_day', date: WED, plan: 'P1',
      items: [{ task_id: 'A', entry_id: 'L2' }],
    });
  });

  function drag(card, taskId, colIdx) {
    card._draggedTaskId = taskId;
    card._draggedColIdx = colIdx;
  }

  test('within a day: the day gets its rows in the new order', async () => {
    const { card, calls } = await makeCard();
    const list = q(card, `.plan-day-list[data-plan-date="${MON}"]`);
    const [first, second] = list.querySelectorAll('.plan-row');
    drag(card, 'A', 0);
    list.insertBefore(second, first);
    card._finishDrag();
    await settle();
    same(sent(calls, 'set_plan_day').at(-1), {
      type: 'home_tasks/set_plan_day', date: MON, plan: 'P1',
      items: [
        { task_id: 'A', entry_id: 'L1' }, { task_id: 'B', entry_id: 'L1' }, { task_id: 'C', entry_id: 'L1' },
      ],
    });
    assert.equal(card._draggedTaskId, null);
  });

  test('onto another day: that day is written, which re-plans the row', async () => {
    const { card, calls } = await makeCard();
    const rowEl = day(card, MON).querySelectorAll('.plan-row')[1];
    const target = q(card, `.plan-day-list[data-plan-date="${WED}"]`);
    drag(card, 'A', 0);
    card._planDropInto(target);       // what dragging over an empty day does
    assert.equal(rowEl.parentNode, target);
    assert.equal(target.lastElementChild.className, 'plan-empty', 'rows stay above the empty note');
    card._finishDrag();
    await settle();
    same(sent(calls, 'set_plan_day').at(-1), {
      type: 'home_tasks/set_plan_day', date: WED, plan: 'P1', items: [{ task_id: 'A', entry_id: 'L1' }],
    });
  });

  test('dropped where it was: nothing is written', async () => {
    const { card, calls } = await makeCard();
    drag(card, 'A', 0);
    card._finishDrag();
    await settle();
    assert.equal(sent(calls, 'set_plan_day').length, 0);
  });

  test('a done row stays where it is', async () => {
    const { card } = await makeCard();
    const rows = day(card, MON).querySelectorAll('.plan-row');
    assert.equal(rows[1].draggable, true);
    assert.equal(rows[2].draggable, false);
  });
});

describe('a list in two columns of one card', () => {
  test('the dragged row is the one of its column, and then the one being dragged', async () => {
    const { card } = await makeCard({ columns: [{ list_id: 'L1' }, { list_id: 'L1' }] });
    const twins = qa(card, '.task[data-task-id="A"]');
    assert.equal(twins.length, 2);
    assert.equal(card._taskDragElement('A', 0), twins[0]);
    assert.equal(card._taskDragElement('A', 1), twins[1]);
    // Dragged into the other column, it is still the one being dragged.
    twins[1].classList.add('dragging');
    twins[0].parentNode.appendChild(twins[1]);
    assert.equal(card._taskDragElement('A', 1), twins[1]);
    // A list shown once: simply its row.
    assert.equal(card._taskDragElement('D', 0), q(card, '.task[data-task-id="D"]'));
  });
});

describe('day plan: staying current', () => {
  test('the plan\'s sensor changing reads the plan again', async () => {
    const { card, calls, hass } = await makeCard();
    const before = sent(calls, 'get_plan').length;
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: '1' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, before + 1);
  });

  test('a plan that was away for a moment comes back', async () => {
    // Its entry reloading, Home Assistant restarting: the read is refused once.
    const { card, calls, data, hass } = await makeCard();
    const plan = data.plan;
    data.plan = null;
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: 'unavailable' } } };
    await settle();
    assert.match(text(q(card, '.plan-missing')), /No day plan found/);
    assert.equal(qa(card, '.plan-day').length, 0);

    data.plan = plan;
    const before = sent(calls, 'get_plan').length;
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: '2' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, before + 1, 'its sensor is still watched');
    assert.equal(qa(card, '.plan-day').length, 3);
    assert.equal(qa(card, '.plan-row').length, 4);
  });

  test('a refused read asks again on its own', async () => {
    const { card, data, hass } = await makeCard();
    data.plan = null;
    card._listsRetryTimer = null;
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: 'unavailable' } } };
    await settle();
    assert.ok(card._listsRetryTimer, 'a retry is scheduled');
  });

  test('a list changing reloads once, through the plan\'s sensor', async () => {
    // A change to a task updates the list's sensor and the plan's sensor.
    // The plan's follows every list, so the list's own is not watched too.
    const { card, calls, hass } = await makeCard();
    const before = sent(calls, 'get_plan').length;
    card.hass = { ...hass, states: { ...hass.states, 'sensor.work_open_tasks': { state: '3' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, before, 'the list sensor alone reloads nothing');
    card.hass = { ...hass, states: { 'sensor.work_open_tasks': { state: '3' }, 'sensor.today_open_items': { state: '1' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, before + 1);
  });

  test('without the plan\'s sensor the lists are watched instead', async () => {
    // The sensor's entity can be disabled: then there is no state to watch.
    const { card, calls, hass } = await makeCard();
    const before = sent(calls, 'get_plan').length;
    card.hass = { ...hass, states: {} };                // the plan's sensor is gone
    await settle();
    const gone = sent(calls, 'get_plan').length;
    assert.equal(gone, before + 1, 'its disappearing is a change of its own');
    card.hass = { ...hass, states: { 'sensor.work_open_tasks': { state: '3' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, gone + 1);
  });

  test('only a list whose tasks changed is loaded again', async () => {
    const { card, calls, data, hass } = await makeCard();
    const tasksFor = (id) => sent(calls, 'get_tasks').filter((c) => c.list_id === id).length;
    const before = { L1: tasksFor('L1'), L2: tasksFor('L2') };
    data.plan.sources[0].stamp = 'w2';                 // something changed in "Work"
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: '3' } } };
    await settle();
    assert.equal(tasksFor('L1'), before.L1 + 1);
    assert.equal(tasksFor('L2'), before.L2, 'the other list is left alone');
  });

  test('a look that finds nothing new leaves the card as it is', async () => {
    // The sensor can change for what this card does not show (a day further
    // out). A rebuild under the pointer for that would only be a flicker.
    const { card, calls, hass } = await makeCard();
    const rowEl = day(card, MON).querySelector('.plan-row');
    const before = sent(calls, 'get_tasks').length;
    card.hass = { ...hass, states: { 'sensor.today_open_items': { state: '2', last_updated: 'later' } } };
    await settle();
    assert.equal(sent(calls, 'get_tasks').length, before, 'no list is loaded');
    assert.equal(day(card, MON).querySelector('.plan-row'), rowEl, 'the rows are the same elements');
  });

  test('a linked list is asked again when its todo entity changes', async () => {
    const { card, calls, hass } = await makeCard({}, (data) => {
      data.plan.sources[1] = { entry_id: 'L2', name: 'Home', kind: 'external', entity_id: 'todo.home', stamp: 'h1' };
    });
    const external = () => sent(calls, 'get_external_tasks').length;
    const before = external();
    assert.equal(before, 1);
    card.hass = { ...hass, states: { ...hass.states, 'todo.home': { state: '5' } } };
    await settle();
    assert.equal(external(), before + 1);
  });

  test('the poll doubts only linked lists with a row on the days shown', async () => {
    const { card } = await makeCard({}, (data) => {
      data.plan.sources[1] = { entry_id: 'L2', name: 'Home', kind: 'external', entity_id: 'todo.home', stamp: 'h1' };
      data.plan.sources.push({ entry_id: 'L3', name: 'Far', kind: 'external', entity_id: 'todo.far', stamp: 'f1' });
    });
    card._planDoubtShown();
    assert.deepEqual(card._columns.map((cs) => !!cs.stale), [false, true, false]);
  });

  test('compact: true makes the days compact', async () => {
    const compact = await makeCard({ compact: true });
    assert.ok(q(compact.card, '.plan-view').classList.contains('compact'));
    const normal = await makeCard();
    assert.ok(!q(normal.card, '.plan-view').classList.contains('compact'));
  });

  test('an unrelated state change does not', async () => {
    const { card, calls, hass } = await makeCard();
    const before = sent(calls, 'get_plan').length;
    card.hass = { ...hass, states: { ...hass.states, 'light.kitchen': { state: 'on' } } };
    await settle();
    assert.equal(sent(calls, 'get_plan').length, before);
  });

  test('a plan card stays one: a config with columns does not turn it into lists', async () => {
    const { card } = await makeCard();
    card.setConfig({ type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3, columns: [{ list_id: 'L1' }] });
    await settle();
    assert.equal(qa(card, '.plan-day').length, 3);
    assert.equal(qa(card, '.card-column').length, 0);
  });
});

describe('"Plan for…" in a list', () => {
  async function listCard(mutate = null) {
    const { HomeTasksCard } = await freshCard();
    const data = fixture();
    if (mutate) mutate(data);
    const calls = [];
    const hass = {
      language: 'en', states: {}, auth: {},
      callWS: async (msg) => {
        calls.push(msg);
        switch (msg.type) {
          case 'home_tasks/get_lists': return { lists: [{ id: 'L1', name: 'Work' }, { id: 'L9', name: 'Other' }] };
          case 'home_tasks/get_external_lists': return { external_lists: [] };
          case 'home_tasks/get_plans': return { plans: data.plans };
          case 'home_tasks/get_tasks': return { tasks: data.tasks[msg.list_id] || [] };
          default: return {};
        }
      },
      callService: async () => {},
    };
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: mutate && mutate.list ? mutate.list : 'L1' }] });
    document.body.appendChild(card);
    card.hass = hass;
    await settle();
    return { card, calls };
  }
  const plans = (data) => {
    const { days: _d, ...plan } = data.plan;
    data.plans = [plan];
  };
  const open = async (card, index) => {
    click(qa(card, '.task')[index].querySelector('.task-content'));
    await settle();
  };

  test('offered on a list a plan draws from', async () => {
    const { card, calls } = await listCard(plans);
    await open(card, 0);
    const btn = q(card, '.plan-for-btn');
    assert.equal(text(btn), 'Plan for…');

    click(btn);
    await settle();
    const options = qa(card, 'dialog .day-pick option').map(text);
    assert.equal(options.length, 7);
    assert.deepEqual(options.slice(0, 3), ['Today, Nov 16', 'Tomorrow, Nov 17', 'Wednesday, Nov 18']);
    assert.equal(q(card, 'dialog .plan-pick'), null, 'one plan: nothing to choose');
    q(card, 'dialog .day-pick').value = TUE;
    click(q(card, 'dialog .ht-confirm-btn.primary'));
    await settle();
    same(sent(calls, 'plan_task').at(-1), {
      type: 'home_tasks/plan_task', plan: 'P1', task_id: 'A', entry_id: 'L1', date: TUE,
    });
  });

  test('with several plans the plan is chosen first', async () => {
    const { card, calls } = await listCard((data) => {
      plans(data);
      data.plans.push({ ...data.plans[0], id: 'P2', name: 'Private', horizon: [MON, TUE] });
    });
    await open(card, 0);
    click(q(card, '.plan-for-btn'));
    await settle();
    const planPick = q(card, 'dialog .plan-pick');
    assert.deepEqual([...planPick.options].map(text), ['Today', 'Private']);
    planPick.value = '1';
    planPick.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(qa(card, 'dialog .day-pick option').length, 2, 'the days of the plan picked');
    click(q(card, 'dialog .ht-confirm-btn.primary'));
    await settle();
    assert.equal(sent(calls, 'plan_task').at(-1).plan, 'P2');
  });

  test('not on a completed task', async () => {
    const { card } = await listCard(plans);
    const done = qa(card, '.task').findIndex((el) => el.classList.contains('completed'));
    await open(card, done);
    assert.equal(q(card, '.plan-for-btn'), null);
  });

  test('not when no plan draws from the list', async () => {
    const without = await listCard((data) => { data.plans = []; });
    await open(without.card, 0);
    assert.equal(q(without.card, '.plan-for-btn'), null);

    const elsewhere = await listCard((data) => {
      plans(data);
      data.plans[0].sources = [{ entry_id: 'L2', name: 'Home', kind: 'native', entity_id: null }];
    });
    await open(elsewhere.card, 0);
    assert.equal(q(elsewhere.card, '.plan-for-btn'), null);
  });
});

describe('editor of the day plan card', () => {
  async function makeEditor(config, planList, hassExtra = {}, writeLists = null) {
    const loads = [];
    const { window } = await freshCard();
    // A config with columns is edited by the list card's editor.
    const Editor = window.customElements.get(
      config.columns ? 'home-tasks-card-editor' : 'home-tasks-day-plan-card-editor');
    const editor = new Editor();
    const fired = [];
    const wsCalls = [];
    let refuse = false;
    editor.addEventListener('config-changed', (e) => fired.push(e.detail.config));
    editor.setConfig(config);
    editor.hass = {
      language: 'en', states: {}, auth: {}, ...hassExtra,
      callWS: async (msg) => {
        loads.push(msg.type);
        if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Work' }] };
        if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
        if (msg.type === 'home_tasks/get_plans') return { plans: planList, lists: LISTS };
        if (msg.type === 'home_tasks/set_plan_lists') {
          wsCalls.push(msg);
          if (writeLists) return writeLists(msg);
          if (refuse) throw { code: 'unauthorized', message: 'Unauthorized' };
          return { id: msg.plan, source_lists: msg.source_lists };
        }
        if (msg.type === 'home_tasks/set_plan_workdays') {
          wsCalls.push(msg);
          if (refuse) throw { code: 'unauthorized', message: 'Unauthorized' };
          return { id: msg.plan, workdays: msg.workdays.length === 7 ? [] : msg.workdays };
        }
        return {};
      },
    };
    await settle();
    return { editor, fired, wsCalls, loads, window, refuseWrites: () => { refuse = true; } };
  }
  const PLANS = [{ id: 'P1', name: 'Today' }, { id: 'P2', name: 'Private' }];
  const LISTS = [
    { entry_id: 'L1', name: 'Work', kind: 'native' },
    { entry_id: 'L2', name: 'Home', kind: 'native' },
    { entry_id: 'L3', name: 'Shared', kind: 'external' },
  ];
  const pick = (editor, cls, value) => {
    const sel = editor.shadowRoot.querySelector(`.${cls}`);
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };

  test('the list card\'s editor has no view to switch any more', async () => {
    const { editor } = await makeEditor({ type: 'custom:home-tasks-card', columns: [{ list_id: 'L1' }] }, PLANS);
    assert.equal(editor.shadowRoot.querySelector('.view-select'), null);
    assert.equal(editor.shadowRoot.querySelector('.plan-editor'), null);
    assert.ok(editor.shadowRoot.querySelector('.editor-tabs-row'));
  });

  test('the plan card\'s editor is the title and the plan, without columns', async () => {
    const { editor, fired } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, PLANS);
    assert.ok(editor.shadowRoot.querySelector('.card-title-input'));
    assert.ok(editor.shadowRoot.querySelector('.plan-editor .plan-select'));
    assert.equal(editor.shadowRoot.querySelector('.editor-tabs-row'), null);
    assert.equal(editor.shadowRoot.querySelector('.view-select'), null);
    assert.equal(fired.length, 0, 'opening the editor changes nothing');
  });

  test('a config without a plan gets the first one when there are several', async () => {
    const several = await makeEditor({ type: 'custom:home-tasks-day-plan-card', days: 3 }, PLANS);
    same(several.fired.at(-1), { type: 'custom:home-tasks-day-plan-card', days: 3, plan: 'P1' });
    // One plan only: the card finds it by itself, nothing is written.
    const one = await makeEditor({ type: 'custom:home-tasks-day-plan-card', days: 3 }, [PLANS[0]]);
    assert.equal(one.fired.length, 0);
  });

  test('a view key left in the config does not come back out', async () => {
    // Written while the plan was a view of the list card.
    const { editor, fired } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', view: 'day_plan', plan: 'P1', days: 3 }, PLANS);
    pick(editor, 'days-select', '5');
    same(fired.at(-1), { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 5 });
  });

  test('plan and days are picked', async () => {
    const { editor, fired } = await makeEditor({ type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, PLANS);
    assert.equal(fired.length, 0, 'opening the editor changes nothing');
    pick(editor, 'plan-select', 'P2');
    pick(editor, 'days-select', '5');
    same(fired.at(-1), { type: 'custom:home-tasks-day-plan-card', plan: 'P2', days: 5 });
  });

  test('the plan\'s lists are chosen here, and saved in the plan', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [] }];
    const { editor, fired, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const chips = () => [...editor.shadowRoot.querySelectorAll('.plan-lists .assignee-chip')];
    assert.deepEqual(chips().map((c) => c.textContent), ['All lists', 'Work', 'Home', 'Shared']);
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [true, false, false, false]);

    chips()[1].click();
    await settle();
    same(wsCalls.at(-1), { type: 'home_tasks/set_plan_lists', plan: 'P1', source_lists: ['L1'] });
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, true, false, false]);
    chips()[3].click();
    await settle();
    same(wsCalls.at(-1).source_lists, ['L1', 'L3']);

    chips()[0].click();                                 // "All lists" clears the choice
    await settle();
    same(wsCalls.at(-1).source_lists, []);
    assert.equal(fired.length, 0, 'a setting of the plan, not of the card config');
  });

  test('two quick list taps both count, written one after the other', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [] }];
    const { editor, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const chips = () => [...editor.shadowRoot.querySelectorAll('.plan-lists .assignee-chip')];
    const before = wsCalls.length;
    chips()[1].click();                                 // Work
    chips()[2].click();                                 // Home, before the first write is back
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, true, true, false], 'shown at once');
    await settle();
    same(wsCalls.slice(before).map((c) => c.source_lists), [['L1'], ['L1', 'L2']]);
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, true, true, false]);
  });

  test('a refused change of the lists is said, not swallowed', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [] }];
    const { editor, refuseWrites } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    refuseWrites();
    editor.shadowRoot.querySelector('.plan-lists .plan-list').click();
    await settle();
    assert.match(editor.shadowRoot.querySelector('.plan-lists-error').textContent, /Unauthorized/);
    assert.ok(editor.shadowRoot.querySelector('.plan-all-lists').classList.contains('active'));
  });

  test('an earlier failed write leaves newer queued list choices intact', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [] }];
    const pending = [];
    const { editor, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1' }, plans, {},
      (msg) => new Promise((resolve, reject) => pending.push({
        resolve: () => resolve({ source_lists: msg.source_lists }), reject,
      })),
    );
    const tap = (id) => editor.shadowRoot.querySelector(`[data-entry-id="${id}"]`).click();
    tap('L1');
    tap('L2');
    await settle();
    assert.equal(pending.length, 1, 'the second write waits for the first');
    pending[0].reject(new Error('Temporary write failure'));
    await settle();
    tap('L3');
    pending[1].resolve();
    await settle();
    pending[2].resolve();
    await settle();
    same(wsCalls.map((msg) => msg.source_lists), [['L1'], ['L1', 'L2'], ['L1', 'L2', 'L3']]);
    same(plans[0].source_lists, ['L1', 'L2', 'L3']);
    assert.equal(editor.shadowRoot.querySelector('.plan-lists-error'), null);
  });

  test('when every queued list write fails, the saved choice is restored', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: ['L3'] }];
    const pending = [];
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1' }, plans, {},
      () => new Promise((_resolve, reject) => pending.push(reject)),
    );
    editor.shadowRoot.querySelector('[data-entry-id="L1"]').click();
    editor.shadowRoot.querySelector('[data-entry-id="L2"]').click();
    await settle();
    pending[0](new Error('First failure'));
    await settle();
    pending[1](new Error('Last failure'));
    await settle();
    same(plans[0].source_lists, ['L3']);
    assert.match(editor.shadowRoot.querySelector('.plan-lists-error').textContent, /Last failure/);
  });

  test('pending list writes and failures stay with their plan after switching', async () => {
    const plans = [
      { id: 'P1', name: 'Work plan', source_lists: ['L3'] },
      { id: 'P2', name: 'Home plan', source_lists: [] },
    ];
    const pending = [];
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1' }, plans, {},
      (msg) => new Promise((resolve, reject) => pending.push({
        resolve: () => resolve({ source_lists: msg.source_lists }), reject,
      })),
    );
    editor.shadowRoot.querySelector('[data-entry-id="L1"]').click();
    pick(editor, 'plan-select', 'P2');
    editor.shadowRoot.querySelector('[data-entry-id="L2"]').click();
    await settle();
    pending[0].reject(new Error('Work plan refused'));
    await settle();
    assert.equal(editor.shadowRoot.querySelector('.plan-lists-error'), null);
    pending[1].resolve();
    await settle();
    same(plans.map((plan) => plan.source_lists), [['L3'], ['L2']]);
    pick(editor, 'plan-select', 'P1');
    assert.match(editor.shadowRoot.querySelector('.plan-lists-error').textContent, /Work plan refused/);
  });

  test('compact is a switch', async () => {
    const { editor, fired } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, PLANS);
    const sw = editor.shadowRoot.querySelector('.compact-switch');
    assert.equal(sw.checked, false);
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    same(fired.at(-1), { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3, compact: true });
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    same(fired.at(-1), { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 });
  });

  test('it is laid out like a list column: the plan on top, then sections', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [] }];
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const root = editor.shadowRoot.querySelector('.visual-editor.plan-editor');
    assert.ok(root);
    // The plan where a column has its list: a dropdown with its label inside.
    assert.ok(root.firstElementChild.querySelector('.field-wrap > .plan-select'));
    assert.equal(root.firstElementChild.querySelector('.field-wrap > span').textContent, 'Day plan');
    const sections = [...root.querySelectorAll(':scope > details')];
    assert.deepEqual(sections.map((d) => d.querySelector('summary').textContent), ['Display', 'Task features', 'Lists']);
    assert.deepEqual(sections.map((d) => d.open), [false, false, false], 'closed until opened, as in a list');
    assert.deepEqual(
      [...sections[0].querySelectorAll('.group-label')].map((g) => g.textContent), ['Card', 'Workdays', 'Header']);
    assert.deepEqual(
      [...sections[0].querySelectorAll('.toggle-grid .toggle-label')].map((l) => l.textContent),
      ['Compact', 'Date', 'Progress', 'Focus for the day']);
    assert.ok(sections[0].querySelector('.field-wrap > .days-select'));
    assert.ok(sections[2].querySelector('.plan-lists'));
    assert.equal(sections[2].querySelector('.hint'), null);
  });

  test('the title fields are inputs of the editor\'s own, not ha-textfield', async () => {
    // ha-textfield is gone in Home Assistant 2026.11; an element that is not
    // defined has no size, and the field was simply not there.
    const forPlan = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3, title: 'My day' }, PLANS);
    assert.equal(forPlan.editor.shadowRoot.querySelector('ha-textfield'), null);
    const title = forPlan.editor.shadowRoot.querySelector('.editor-card-title-row .field-wrap > input.card-title-input');
    assert.equal(title.value, 'My day');
    assert.equal(title.nextElementSibling.textContent, 'Card title (optional)');
    title.value = 'Today';
    title.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(forPlan.fired.at(-1).title, 'Today');
    title.value = '';
    title.dispatchEvent(new Event('change', { bubbles: true }));
    // Emptied, the title is not saved (an undefined key does not reach the YAML).
    assert.equal('title' in JSON.parse(JSON.stringify(forPlan.fired.at(-1))), false);

    const forList = await makeEditor({ type: 'custom:home-tasks-card', columns: [{ list_id: 'L1' }] }, []);
    assert.equal(forList.editor.shadowRoot.querySelector('ha-textfield'), null);
    const colTitle = forList.editor.shadowRoot.querySelector('input.column-title-input');
    colTitle.value = 'Work things';
    colTitle.dispatchEvent(new Event('change', { bubbles: true }));
    same(forList.fired.at(-1).columns, [{ list_id: 'L1', title: 'Work things' }]);
  });

  test('an administrator gets a link to where a new list or plan is made', async () => {
    const PATH = '/config/integrations/integration/home_tasks';
    const ADMIN = { user: { is_admin: true } };
    const planConfig = { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 };
    const listConfig = { type: 'custom:home-tasks-card', columns: [{ list_id: 'L1' }] };

    // In the plan's editor, under the plan; in a list's, where the sentence was.
    const forPlan = await makeEditor(planConfig, PLANS, ADMIN);
    const link = forPlan.editor.shadowRoot.querySelector('.plan-editor > .field > .new-entry-link');
    assert.equal(link.textContent, '+ Create a new list or day plan');
    assert.equal(link.getAttribute('href'), PATH);
    // A new tab: the editor stays open with what was changed in it.
    assert.equal(link.getAttribute('target'), '_blank');

    const forList = await makeEditor(listConfig, [], ADMIN);
    const listLink = forList.editor.shadowRoot.querySelector('.visual-editor > .field > .new-entry-link');
    assert.equal(listLink.getAttribute('href'), PATH);
    assert.equal(forList.editor.shadowRoot.querySelector('.visual-editor > .field > .hint'), null);

    // Nobody else can add one: the sentence stays, there is no link.
    const other = await makeEditor(listConfig, []);
    assert.equal(other.editor.shadowRoot.querySelector('.new-entry-link'), null);
    assert.match(other.editor.shadowRoot.querySelector('.visual-editor > .field > .hint').textContent, /New lists can be created/);
    const otherPlan = await makeEditor(planConfig, PLANS);
    assert.equal(otherPlan.editor.shadowRoot.querySelector('.new-entry-link'), null);
  });

  test('back from the settings, the editor reads lists and plans again', async () => {
    const { editor, loads, window } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, PLANS, { user: { is_admin: true } });
    window.document.body.appendChild(editor);
    const before = loads.filter((t) => t === 'home_tasks/get_plans').length;
    const link = editor.shadowRoot.querySelector('.new-entry-link');
    link.addEventListener('click', (e) => e.preventDefault());      // no new tab in the test
    link.click();
    window.dispatchEvent(new window.Event('focus'));
    await settle();
    assert.equal(loads.filter((t) => t === 'home_tasks/get_plans').length, before + 1);
    // Once: coming back a second time reads nothing.
    window.dispatchEvent(new window.Event('focus'));
    await settle();
    assert.equal(loads.filter((t) => t === 'home_tasks/get_plans').length, before + 1);
  });

  test('a chosen list that is not there stays in the choice, and shows', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: ['L1', 'GONE'] }];
    const { editor, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const chips = () => [...editor.shadowRoot.querySelectorAll('.plan-lists .assignee-chip')];
    assert.deepEqual(chips().map((c) => c.textContent), ['All lists', 'Work', 'Home', 'Shared', 'List not available']);
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, true, false, false, true]);

    chips()[2].click();                                  // one more list: the missing one is kept
    await settle();
    same(wsCalls.at(-1).source_lists, ['L1', 'L2', 'GONE']);
    chips()[1].click();
    await settle();
    chips()[2].click();
    await settle();
    // Only the missing one left: that is not "all lists".
    same(wsCalls.at(-1).source_lists, ['GONE']);
    assert.deepEqual(chips().map((c) => c.classList.contains('active')), [false, false, false, false, true]);

    chips()[4].click();                                  // taken out on purpose
    await settle();
    same(wsCalls.at(-1).source_lists, []);
    assert.deepEqual(chips().map((c) => c.textContent), ['All lists', 'Work', 'Home', 'Shared']);
    assert.ok(chips()[0].classList.contains('active'));
  });

  // The plan's days as chips, Monday to Sunday.
  const workdayChips = (editor) => [...editor.shadowRoot.querySelectorAll('.plan-workdays .plan-workday')];
  const activeDays = (editor) => workdayChips(editor).filter((c) => c.classList.contains('active')).map((c) => c.dataset.day);

  test('the workdays are a setting of the plan itself, one chip per day', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [], workdays: [] }];
    const { editor, fired, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    assert.deepEqual(workdayChips(editor).map((c) => c.textContent), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    same(activeDays(editor), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], 'no days chosen: all of them');

    workdayChips(editor)[6].click();                      // Sunday off
    await settle();
    same(wsCalls.at(-1), {
      type: 'home_tasks/set_plan_workdays', plan: 'P1', workdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
    });
    same(activeDays(editor), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
    workdayChips(editor)[6].click();                      // and back
    await settle();
    same(wsCalls.at(-1).workdays, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    assert.equal(fired.length, 0, 'a setting of the plan, not of the card config');
  });

  test('a part-time week: any days, but never none', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [], workdays: ['mon', 'wed'] }];
    const { editor, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    same(activeDays(editor), ['mon', 'wed']);
    workdayChips(editor)[3].click();                      // Thursday on
    await settle();
    same(wsCalls.at(-1).workdays, ['mon', 'wed', 'thu']);
    workdayChips(editor)[0].click();                      // Monday off
    await settle();
    workdayChips(editor)[2].click();                      // Wednesday off
    await settle();
    same(activeDays(editor), ['thu']);
    const calls = wsCalls.length;
    const last = workdayChips(editor)[3];
    assert.equal(last.disabled, true, 'the last day cannot be taken out');
    last.click();
    await settle();
    assert.equal(wsCalls.length, calls);
  });

  test('two quick taps both count, written one after the other', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [], workdays: ['mon', 'tue', 'wed', 'thu', 'fri'] }];
    const { editor, wsCalls } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const before = wsCalls.length;
    workdayChips(editor)[0].click();                      // Monday off
    workdayChips(editor)[1].click();                      // Tuesday off, before the first write is back
    same(activeDays(editor), ['wed', 'thu', 'fri'], 'shown at once');
    await settle();
    same(wsCalls.slice(before).map((c) => c.workdays), [
      ['tue', 'wed', 'thu', 'fri'], ['wed', 'thu', 'fri'],
    ]);
    same(activeDays(editor), ['wed', 'thu', 'fri']);
  });

  test('an earlier failed workday write leaves a newer choice intact', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [], workdays: ['mon', 'tue', 'wed', 'thu', 'fri'] }];
    const pending = [];
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const callWS = editor._hass.callWS;
    editor._hass.callWS = (msg) => (msg.type === 'home_tasks/set_plan_workdays'
      ? new Promise((resolve, reject) => pending.push({
        resolve: () => resolve({ id: msg.plan, workdays: msg.workdays }), reject,
      }))
      : callWS(msg));
    workdayChips(editor)[0].click();                      // Monday off
    workdayChips(editor)[1].click();                      // Tuesday off, queued
    await settle();
    pending[0].reject(new Error('Temporary failure'));
    await settle();
    same(activeDays(editor), ['wed', 'thu', 'fri'], 'the newer choice still shows');
    assert.equal(editor.shadowRoot.querySelector('.plan-days-error'), null);
    pending[1].resolve();
    await settle();
    same(activeDays(editor), ['wed', 'thu', 'fri']);
  });

  test('refused workdays are said and taken back', async () => {
    const plans = [{ id: 'P1', name: 'Today', source_lists: [], workdays: [] }];
    const { editor, refuseWrites } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    refuseWrites();
    workdayChips(editor)[5].click();
    await settle();
    assert.match(editor.shadowRoot.querySelector('.plan-days-error').textContent, /Unauthorized/);
    same(activeDays(editor), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  });

  test('task features: every field of an open row has a switch and can be moved', async () => {
    const base = { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 };
    const { editor, fired } = await makeEditor(base, PLANS);
    const section = () => editor.shadowRoot.querySelectorAll('.plan-editor > details')[1];
    const rows = () => [...section().querySelectorAll('.detail-field-row')];
    const keys = () => rows().map((r) => r.dataset.key);
    assert.deepEqual(keys(), [
      'notes', 'sub_tasks', 'person', 'section', 'priority', 'tags', 'due_date', 'reminders',
      'recurrence', 'history', 'images',
    ]);
    const on = () => Object.fromEntries(rows().map((r) => [r.dataset.key, r.querySelector('ha-switch').checked]));
    assert.equal(on().notes, true);
    assert.equal(on().history, false, 'off unless switched on, as in a list');

    // Off: written at the root of the card config, where the plan reads it.
    const notes = rows()[0].querySelector('ha-switch');
    notes.checked = false;
    notes.dispatchEvent(new Event('change', { bubbles: true }));
    same(fired.at(-1), { ...base, show_notes: false });

    // Moved up: the shortest detail_order that gives the new order.
    rows()[5].querySelectorAll('button')[0].click();      // tags, one up
    assert.deepEqual(keys().slice(3, 6), ['section', 'tags', 'priority']);
    same(fired.at(-1), { ...base, show_notes: false, detail_order: ['notes', 'sub_tasks', 'person', 'section', 'tags'] });
    rows()[4].querySelectorAll('button')[1].click();      // and back down
    same(fired.at(-1), { ...base, show_notes: false });
  });

  test('task features: the move button has its switch too', async () => {
    const base = { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 };
    const { editor, fired } = await makeEditor(base, PLANS);
    const sw = editor.shadowRoot.querySelector('.move-switch');
    assert.equal(sw.checked, true);
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    same(fired.at(-1), { ...base, show_move: false });
  });

  test('the list editor still writes its fields into the column', async () => {
    const { editor, fired } = await makeEditor({ type: 'custom:home-tasks-card', columns: [{ list_id: 'L1' }] }, []);
    const rows = [...editor.shadowRoot.querySelectorAll('.visual-editor .detail-field-row')];
    assert.equal(rows.length, 11);
    const tags = rows.find((r) => r.dataset.key === 'tags').querySelector('ha-switch');
    tags.checked = false;
    tags.dispatchEvent(new Event('change', { bubbles: true }));
    same(fired.at(-1).columns, [{ list_id: 'L1', show_tags: false }]);
  });

  test('a section opens on a click and stays open when the editor redraws', async () => {
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, PLANS);
    const section = () => editor.shadowRoot.querySelector('.plan-editor > details');
    section().querySelector('summary').click();
    assert.equal(section().open, true);
    pick(editor, 'plan-select', 'P2');                   // redraws the editor
    assert.equal(section().open, true);
  });

  test('date, progress and focus are switches; only "off" is written', async () => {
    const base = { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 };
    const { editor, fired } = await makeEditor(base, PLANS);
    const flip = (cls, on) => {
      const sw = editor.shadowRoot.querySelector(`.${cls}`);
      sw.checked = on;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
    };
    for (const cls of ['date-switch', 'progress-switch', 'focus-switch']) {
      assert.equal(editor.shadowRoot.querySelector(`.${cls}`).checked, true, `${cls} is on by default`);
    }
    flip('date-switch', false);
    same(fired.at(-1), { ...base, show_date: false });
    flip('focus-switch', false);
    flip('progress-switch', false);
    same(fired.at(-1), { ...base, show_date: false, show_focus: false, show_progress: false });
    flip('date-switch', true);
    flip('focus-switch', true);
    flip('progress-switch', true);
    same(fired.at(-1), base);
  });

  test('the switches show what the config says', async () => {
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3, show_focus: false, compact: true }, PLANS);
    assert.equal(editor.shadowRoot.querySelector('.focus-switch').checked, false);
    assert.equal(editor.shadowRoot.querySelector('.date-switch').checked, true);
    assert.equal(editor.shadowRoot.querySelector('.compact-switch').checked, true);
  });

  test('another plan shows that plan\'s lists', async () => {
    const plans = [
      { id: 'P1', name: 'Today', source_lists: [] },
      { id: 'P2', name: 'Private', source_lists: ['L2'] },
    ];
    const { editor } = await makeEditor(
      { type: 'custom:home-tasks-day-plan-card', plan: 'P1', days: 3 }, plans);
    const active = () => [...editor.shadowRoot.querySelectorAll('.plan-lists .assignee-chip.active')].map((c) => c.textContent);
    assert.deepEqual(active(), ['All lists']);
    pick(editor, 'plan-select', 'P2');
    assert.deepEqual(active(), ['Home']);
  });

});
