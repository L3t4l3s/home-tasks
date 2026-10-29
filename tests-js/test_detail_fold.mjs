/**
 * Folding the task-details fields: a tap on a field's heading folds it to
 * that heading plus a one-line summary of what is set; the card remembers
 * which fields are folded, per list. (Grew out of collapse_recurrence, PR #82.)
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function build(task, colConfig = {}) {
  const { HomeTasksCard, window } = await loadCard({ force: true });
  window.localStorage.clear();
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = makeMockHass({
    language: 'en',
    states: { 'person.kevin': { attributes: { friendly_name: 'Kevin' } } },
  });
  card._render = () => {};
  card._columns[0].tasks = [task];
  card._columns[0].sections = [{ id: 'S1', name: 'Bakery', sort_order: 0 }];
  return { card, window };
}

const T = (extra = {}) => ({
  id: 'T1', title: 'Bins', completed: false, notes: '', sub_items: [], tags: [], reminders: [],
  assigned_persons: [], recurrence_value: 1, ...extra,
});

const field = (details, key) => details.querySelector(`.detail-section[data-detail-key="${key}"]`);
const head = (section) => section.querySelector('.detail-fold-head');
const summary = (section) => section.querySelector('.detail-fold-summary').textContent;

describe('folding the task-details fields', () => {
  test('every field opens by default, with a caret in its heading', async () => {
    const { card } = await build(T());
    const details = card._buildTaskDetails(T(), 0);
    const sections = [...details.querySelectorAll('.detail-section[data-detail-key]')];
    assert.ok(sections.length >= 8, `foldable fields: ${sections.length}`);
    for (const s of sections) {
      assert.ok(!s.classList.contains('folded'), s.dataset.detailKey);
      assert.ok(s.querySelector('.detail-fold-caret'), s.dataset.detailKey);
      assert.equal(s.querySelector('[aria-expanded]').getAttribute('aria-expanded'), 'true');
    }
    assert.equal(details.querySelector('.detail-actions [data-detail-key]'), null, 'the action row is not a field');
  });

  test('a tap folds the field to its heading and a summary; the card remembers it', async () => {
    const task = T({ tags: ['bins', 'weekly'] });
    const { card, window } = await build(task);
    const tags = field(card._buildTaskDetails(task, 0), 'tags');
    head(tags).click();
    assert.ok(tags.classList.contains('folded'));
    assert.equal(summary(tags), '#bins #weekly');
    assert.deepEqual(JSON.parse(window.localStorage.getItem('home_tasks_card:detail_fold:L1')), ['tags']);

    // Another task, and a fresh card in the same browser, start folded too.
    const other = field(card._buildTaskDetails(T({ id: 'T2', tags: ['x'] }), 0), 'tags');
    assert.ok(other.classList.contains('folded'));
    const { HomeTasksCard } = await loadCard();
    const card2 = new HomeTasksCard();
    card2.setConfig({ columns: [{ list_id: 'L1' }] });
    card2.hass = makeMockHass();
    assert.ok(card2._foldedDetails(0).has('tags'));

    head(other).click();
    assert.ok(!other.classList.contains('folded'));
    assert.equal(summary(other), '', 'no summary while open');
    assert.deepEqual(JSON.parse(window.localStorage.getItem('home_tasks_card:detail_fold:L1')), []);
  });

  test('nothing set: folded without a summary', async () => {
    const { card } = await build(T());
    const details = card._buildTaskDetails(T(), 0);
    for (const key of ['notes', 'person', 'priority', 'tags', 'due_date', 'reminders', 'recurrence']) {
      const s = field(details, key);
      head(s).click();
      assert.equal(summary(s), '', key);
    }
  });

  test('summaries of what is set', async () => {
    const task = T({
      notes: 'Blue bin\nthen the green one', assigned_persons: ['person.kevin'], priority: 3,
      reminders: [0], section_id: 'S1', sub_items: [{ title: 'a', completed: true }, { title: 'b', completed: false }],
    });
    const { card } = await build(task);
    for (const key of ['notes', 'person', 'priority', 'reminders', 'section', 'sub_tasks']) card._setDetailFolded(0, key, true);
    const details = card._buildTaskDetails(task, 0);
    assert.equal(summary(field(details, 'notes')), 'Blue bin');
    assert.equal(summary(field(details, 'person')), 'Kevin');
    assert.equal(summary(field(details, 'priority')), 'High');
    assert.equal(summary(field(details, 'reminders')), card._t('rem_at_due'));
    assert.equal(summary(field(details, 'section')), 'Bakery');
    assert.equal(summary(field(details, 'sub_tasks')), '1/2');
  });

  test('recurrence folded: its switch stays usable, the rule shows when on', async () => {
    const on = T({ recurrence_enabled: true, recurrence_unit: 'weeks', recurrence_value: 2 });
    const { card } = await build(on);
    card._setDetailFolded(0, 'recurrence', true);
    const rec = field(card._buildTaskDetails(on, 0), 'recurrence');
    assert.ok(rec.classList.contains('folded'));
    assert.match(summary(rec), /^2 /);
    const sw = head(rec).querySelector('ha-switch');
    assert.ok(sw, 'the switch is in the heading');
    sw.click();
    assert.ok(rec.classList.contains('folded'), 'the switch does not fold or unfold');

    const off = field(card._buildTaskDetails(T(), 0), 'recurrence');
    assert.equal(summary(off), '', 'off: the switch says it, no text');
  });

  test('the keyboard folds too', async () => {
    const { card, window } = await build(T());
    const notes = field(card._buildTaskDetails(T(), 0), 'notes');
    const label = notes.querySelector('[role="button"]');
    label.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    assert.ok(notes.classList.contains('folded'));
    assert.equal(label.getAttribute('aria-expanded'), 'false');
  });

  test('storage blocked: folding still works for the session', async () => {
    const { card, window } = await build(T());
    const proto = Object.getPrototypeOf(window.localStorage);
    const { getItem, setItem } = proto;
    proto.getItem = () => { throw new Error('blocked'); };
    proto.setItem = () => { throw new Error('blocked'); };
    try {
      const notes = field(card._buildTaskDetails(T(), 0), 'notes');
      head(notes).click();
      assert.ok(notes.classList.contains('folded'));
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });
  test('two cards with the same list share the folds: neither writes back a stale copy, both follow', async () => {
    const task = T({ tags: ['x'], notes: 'n' });
    const { card: a, window } = await build(task);
    const { HomeTasksCard } = await loadCard();
    const b = new HomeTasksCard();
    b.setConfig({ columns: [{ list_id: 'L1' }] });
    b.hass = makeMockHass({ language: 'en' });
    b._render = () => {};
    b._columns[0].tasks = [task];
    window.document.body.append(a, b);
    try {
      a.shadowRoot.append(a._buildTaskDetails(task, 0));
      b.shadowRoot.append(b._buildTaskDetails(task, 0));
      head(field(a.shadowRoot, 'tags')).click();
      assert.ok(field(b.shadowRoot, 'tags').classList.contains('folded'), 'b follows a');
      head(field(b.shadowRoot, 'notes')).click();
      assert.deepEqual(JSON.parse(window.localStorage.getItem('home_tasks_card:detail_fold:L1')).sort(), ['notes', 'tags']);
      assert.ok(field(a.shadowRoot, 'notes').classList.contains('folded'), 'a follows b');
    } finally {
      a.remove();
      b.remove();
    }
  });

  test('every open task of the card folds together', async () => {
    const { card } = await build(T());
    card.shadowRoot.append(card._buildTaskDetails(T(), 0), card._buildTaskDetails(T({ id: 'T2' }), 0));
    const [first, second] = card.shadowRoot.querySelectorAll('.detail-section[data-detail-key="tags"]');
    head(first).click();
    assert.ok(second.classList.contains('folded'));
  });

  test('switching the folded recurrence on shows its rule at once', async () => {
    const task = T({ recurrence_unit: 'weeks', recurrence_value: 2 });
    const { card, window } = await build(task);
    card._setDetailFolded(0, 'recurrence', true);
    const rec = field(card._buildTaskDetails(task, 0), 'recurrence');
    assert.equal(summary(rec), '');
    const sw = head(rec).querySelector('ha-switch');
    sw.checked = true;
    sw.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.match(summary(rec), /^2 /);
  });
  test('another list keeps its own folds', async () => {
    const task = T({ tags: ['x'] });
    const { card: a, window } = await build(task);
    const { HomeTasksCard } = await loadCard();
    const b = new HomeTasksCard();
    b.setConfig({ columns: [{ list_id: 'L2' }] });
    b.hass = makeMockHass({ language: 'en' });
    b._render = () => {};
    window.document.body.append(a, b);
    try {
      a.shadowRoot.append(a._buildTaskDetails(task, 0));
      b.shadowRoot.append(b._buildTaskDetails(task, 0));
      head(field(a.shadowRoot, 'tags')).click();
      assert.ok(!field(b.shadowRoot, 'tags').classList.contains('folded'), 'L2 stays open');
      assert.ok(!b._foldedDetails(0).has('tags'));
      assert.equal(window.localStorage.getItem('home_tasks_card:detail_fold:L2'), null);
    } finally {
      a.remove();
      b.remove();
    }
  });
});
