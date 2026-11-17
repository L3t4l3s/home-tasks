/**
 * Column visibility: a column's `visibility` takes the conditions of a
 * card's own Visibility tab and is judged as Home Assistant judges them -
 * user, screen and time in the browser, the rest by core through
 * subscribe_condition. Plus the "current user" entry of the preset assignee
 * filter, which shows each viewer their own tasks.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

const plain = (o) => JSON.parse(JSON.stringify(o));

// Cards put in the page; taken out after each test, which stops their
// watchers (subscriptions, media listeners, the minute timer of time).
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().remove(); });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

// A connection that records every subscription and lets the test push.
function makeConnection({ refuse = false } = {}) {
  const subs = [];
  return {
    subs,
    addEventListener() {},
    subscribeMessage(cb, msg) {
      const sub = { cb, msg, closed: false };
      subs.push(sub);
      if (refuse) return Promise.reject({ code: 'unknown_command', message: 'Unknown command.' });
      return Promise.resolve(() => { sub.closed = true; });
    },
    open() { return subs.filter((s) => !s.closed); },
  };
}

const PEOPLE = {
  'person.anna': { entity_id: 'person.anna', state: 'home', attributes: { friendly_name: 'Anna', user_id: 'u-anna' } },
  'person.ben': { entity_id: 'person.ben', state: 'home', attributes: { friendly_name: 'Ben', user_id: 'u-ben' } },
};

function makeHass({ user = 'u-anna', states = {}, connection = makeConnection(), extra = {} } = {}) {
  return makeMockHass({
    user: { id: user, is_admin: false },
    states: { ...PEOPLE, ...states },
    connection,
    callWS: async (msg) => {
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'One' }, { id: 'L2', name: 'Two' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [] };
      return null;
    },
    ...extra,
  });
}

async function mount(columns, hassOpts = {}, { preview = false, frozenNow = null } = {}) {
  const { HomeTasksCard, window } = await loadCard({ force: true, frozenNow });
  const card = new HomeTasksCard();
  if (preview) card.preview = true;
  card.setConfig({ columns });
  const events = [];
  card.addEventListener('card-visibility-changed', (e) => events.push(e.detail.value));
  window.document.body.appendChild(card);
  mounted.push(card);
  const hass = makeHass(hassOpts);
  card.hass = hass;
  await flush();
  return { card, window, hass, events };
}

const shownTitles = (card) =>
  [...card.shadowRoot.querySelectorAll('.card-column .title')].map((t) => t.textContent.trim());

const col = (title, visibility, extra = {}) => ({ list_id: 'L1', title, ...(visibility ? { visibility } : {}), ...extra });

describe('user condition', () => {
  const COLUMNS = [
    col('Anna', [{ condition: 'user', users: ['u-anna'] }]),
    col('Family'),
  ];

  test('a column for one user shows to that user', async () => {
    const { card } = await mount(COLUMNS, { user: 'u-anna' });
    assert.deepEqual(shownTitles(card), ['Anna', 'Family']);
  });

  test('and is left out for everybody else', async () => {
    const { card } = await mount(COLUMNS, { user: 'u-ben' });
    assert.deepEqual(shownTitles(card), ['Family']);
  });

  test('a user condition needs no subscription to core', async () => {
    const { hass } = await mount(COLUMNS);
    assert.equal(hass.connection.subs.length, 0);
  });
});

describe('the card as a whole', () => {
  const ONLY_ANNA = [col('Anna', [{ condition: 'user', users: ['u-anna'] }])];

  test('with no column left the card hides itself and says so', async () => {
    const { card, events } = await mount(ONLY_ANNA, { user: 'u-ben' });
    assert.equal(card.hidden, true);
    assert.deepEqual(events, [false]);
    assert.equal(card.connectedWhileHidden, true);
  });

  test('and shows again once a column does', async () => {
    const { card, events, hass } = await mount(ONLY_ANNA, { user: 'u-ben' });
    card.hass = { ...hass, user: { id: 'u-anna' } };
    await flush();
    assert.equal(card.hidden, false);
    assert.deepEqual(events, [false, true]);
    assert.deepEqual(shownTitles(card), ['Anna']);
  });

  test('while the dashboard is edited every column shows, the hidden ones dimmed', async () => {
    const { card } = await mount([...ONLY_ANNA, col('Family')], { user: 'u-ben' }, { preview: true });
    assert.equal(card.hidden, false);
    assert.deepEqual(shownTitles(card), ['Anna', 'Family']);
    const dimmed = [...card.shadowRoot.querySelectorAll('.card-column.visibility-hidden .title')].map((t) => t.textContent.trim());
    assert.deepEqual(dimmed, ['Anna']);
  });
});

describe('conditions core judges', () => {
  test('a state condition is asked of core in core\'s shape, and judged in the browser until it answers', async () => {
    const { card, hass } = await mount(
      [col('Vacation', [{ condition: 'state', entity: 'input_boolean.vacation', state: 'on' }]), col('Family')],
      { states: { 'input_boolean.vacation': { entity_id: 'input_boolean.vacation', state: 'on', attributes: {} } } },
    );
    assert.deepEqual(plain(hass.connection.subs.map((s) => s.msg)), [{
      type: 'subscribe_condition',
      condition: { condition: 'state', entity_id: 'input_boolean.vacation', state: 'on' },
    }]);
    assert.deepEqual(shownTitles(card), ['Vacation', 'Family']);
    hass.connection.subs[0].cb({ result: false });
    await flush();
    assert.deepEqual(shownTitles(card), ['Family']);
  });

  test('a template stays hidden until core says it holds', async () => {
    const { card, hass } = await mount([
      col('Templated', [{ condition: 'template', value_template: '{{ true }}' }]), col('Family'),
    ]);
    assert.deepEqual(shownTitles(card), ['Family']);
    hass.connection.subs[0].cb({ result: true });
    await flush();
    assert.deepEqual(shownTitles(card), ['Templated', 'Family']);
  });

  test('an error from core hides the column', async () => {
    const { card, hass } = await mount([col('Sun', [{ condition: 'sun', after: 'sunset' }]), col('Family')]);
    hass.connection.subs[0].cb({ result: true });
    await flush();
    assert.deepEqual(shownTitles(card), ['Sun', 'Family']);
    hass.connection.subs[0].cb({ error: 'Template error' });
    await flush();
    assert.deepEqual(shownTitles(card), ['Family']);
  });

  test('"not" over a condition nobody has judged yet hides, it does not show', async () => {
    const { card } = await mount([col('Not', [{ condition: 'not', conditions: [{ condition: 'template', value_template: '{{ false }}' }] }]), col('Family')]);
    assert.deepEqual(shownTitles(card), ['Family']);
  });

  test('"or" with a user who matches shows before core answers', async () => {
    const { card } = await mount([col('Either', [{ condition: 'or', conditions: [
      { condition: 'user', users: ['u-anna'] },
      { condition: 'template', value_template: '{{ false }}' },
    ] }]), col('Family')], { user: 'u-anna' });
    assert.deepEqual(shownTitles(card), ['Either', 'Family']);
  });

  test('sibling server conditions share one subscription', async () => {
    const { hass } = await mount([col('Both', [
      { condition: 'template', value_template: '{{ true }}' },
      { condition: 'sun', after: 'sunrise' },
      { condition: 'user', users: ['u-anna'] },
    ])]);
    assert.equal(hass.connection.subs.length, 1);
    assert.deepEqual(plain(hass.connection.subs[0].msg.condition), {
      condition: 'and',
      conditions: [
        { condition: 'template', value_template: '{{ true }}' },
        { condition: 'sun', after: 'sunrise' },
      ],
    });
  });

  test('the subscriptions close when the card leaves the page', async () => {
    const { card, hass } = await mount([col('T', [{ condition: 'template', value_template: '{{ true }}' }])]);
    assert.equal(hass.connection.open().length, 1);
    card.remove();
    await flush();
    assert.equal(hass.connection.open().length, 0);
  });

  test('a Home Assistant without subscribe_condition judges state in the browser', async () => {
    const connection = makeConnection({ refuse: true });
    const vac = (state) => ({ 'input_boolean.vacation': { entity_id: 'input_boolean.vacation', state, attributes: {} } });
    const { card, hass } = await mount(
      [col('Vacation', [{ condition: 'state', entity: 'input_boolean.vacation', state: 'on' }]), col('Family')],
      { connection, states: vac('on') },
    );
    assert.deepEqual(shownTitles(card), ['Vacation', 'Family']);
    card.hass = { ...hass, states: { ...hass.states, ...vac('off') } };
    await flush();
    assert.deepEqual(shownTitles(card), ['Family']);
  });
});

describe('screen and time', () => {
  test('a screen condition follows its media query', async () => {
    const { HomeTasksCard, window } = await loadCard({ force: true });
    let matches = false;
    const listeners = new Set();
    window.matchMedia = (q) => ({
      media: q,
      get matches() { return matches; },
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
    });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [col('Wide', [{ condition: 'screen', media_query: '(min-width: 1024px)' }]), col('Family')] });
    window.document.body.appendChild(card);
    mounted.push(card);
    card.hass = makeHass();
    await flush();
    assert.deepEqual(shownTitles(card), ['Family']);
    matches = true;
    for (const fn of listeners) fn();
    await flush();
    assert.deepEqual(shownTitles(card), ['Wide', 'Family']);
  });

  test('a time condition is judged in the server time zone when the profile says so', async () => {
    // Tuesday 13:00 in Berlin.
    const frozenNow = '2026-11-17T12:00:00Z';
    const extra = { locale: { time_zone: 'server' }, config: { time_zone: 'Europe/Berlin' } };
    const { card } = await mount([
      col('Tue noon', [{ condition: 'time', after: '12:30', before: '14:00', weekdays: ['tue'] }]),
      col('Wed', [{ condition: 'time', weekdays: ['wed'] }]),
      col('Night', [{ condition: 'time', after: '22:00', before: '06:00' }]),
    ], { extra }, { frozenNow });
    assert.deepEqual(shownTitles(card), ['Tue noon']);
  });
});

describe('current user in the preset assignee filter', () => {
  const T = (id, extra = {}) => ({ id, title: id, completed: false, sub_items: [], tags: [], ...extra });
  const TASKS = [
    T('anna', { assigned_person: 'person.anna' }),
    T('ben', { assigned_person: 'person.ben' }),
    T('nobody', { assigned_person: null }),
  ];

  async function shown(filters, user) {
    const { HomeTasksCard } = await loadCard({ force: true });
    const card = new HomeTasksCard();
    card.setConfig({ columns: [{ list_id: 'L1', filters }] });
    card.hass = makeHass({ user });
    card._render = () => {};
    card._columns[0].tasks = TASKS;
    return { card, ids: card._preFilteredTasks(0).map((t) => t.id).sort() };
  }

  test('each viewer sees the tasks of their own person', async () => {
    assert.deepEqual((await shown({ assignees: ['current_user'] }, 'u-anna')).ids, ['anna']);
    assert.deepEqual((await shown({ assignees: ['current_user'] }, 'u-ben')).ids, ['ben']);
  });

  test('next to "unassigned": theirs and the unclaimed ones', async () => {
    assert.deepEqual((await shown({ assignees: ['current_user', 'unassigned'] }, 'u-ben')).ids, ['ben', 'nobody']);
  });

  test('a user without a person sees nobody\'s tasks, not everybody\'s', async () => {
    assert.deepEqual((await shown({ assignees: ['current_user'] }, 'u-kiosk')).ids, []);
  });

  test('a new task in such a column goes to whoever adds it', async () => {
    const { card } = await shown({ assignees: ['current_user'] }, 'u-ben');
    assert.equal(card._autoAssignPerson(0), 'person.ben');
  });
});

describe('visibility in the editor', () => {
  async function editor(colConfig, { defineConditionsEditor = true } = {}) {
    const { window } = await loadCard({ force: true });
    if (defineConditionsEditor && !window.customElements.get('ha-card-conditions-editor')) {
      window.customElements.define('ha-card-conditions-editor', class extends window.HTMLElement {});
    }
    const ed = new (window.customElements.get('home-tasks-card-editor'))();
    ed.hass = makeMockHass({ states: PEOPLE });
    ed.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
    ed._listMeta = { 'list:L1': { tags: [], persons: [] } };
    ed._sourceKeyForCol = () => 'list:L1';
    const events = [];
    ed._fireChanged = () => events.push(plain(ed._config.columns[0]));
    const root = ed._buildVisualEditor(0);
    return { window, ed, root, events };
  }

  test('a column has a Visibility section with Home Assistant\'s own editor', async () => {
    const conditions = [{ condition: 'user', users: ['u-anna'] }];
    const { root, events, window } = await editor({ visibility: conditions });
    const summaries = [...root.querySelectorAll('summary')].map((s) => s.textContent.trim());
    assert.ok(summaries.includes('Visibility'), summaries.join(', '));
    const ce = root.querySelector('ha-card-conditions-editor');
    assert.ok(ce, 'conditions editor');
    assert.deepEqual(plain(ce.conditions), conditions);
    const next = [...conditions, { condition: 'screen', media_query: '(min-width: 1024px)' }];
    ce.dispatchEvent(new window.CustomEvent('value-changed', { detail: { value: next }, bubbles: true, composed: true }));
    assert.deepEqual(events.at(-1).visibility, next);
    assert.deepEqual(plain(ce.conditions), next);
  });

  test('removing the last condition removes the key', async () => {
    const { root, events, window } = await editor({ visibility: [{ condition: 'user', users: ['u-anna'] }] });
    root.querySelector('ha-card-conditions-editor')
      .dispatchEvent(new window.CustomEvent('value-changed', { detail: { value: [] } }));
    assert.equal('visibility' in events.at(-1), false);
  });

  test('without Home Assistant\'s editor the conditions are edited as YAML', async () => {
    const { root } = await editor({}, { defineConditionsEditor: false });
    assert.equal(root.querySelector('ha-card-conditions-editor'), null);
    const section = [...root.querySelectorAll('details')].find((d) => d.querySelector('summary').textContent.trim() === 'Visibility');
    assert.ok(section.querySelector('ha-yaml-editor'));
  });
});
