/**
 * Unit tests for the pure helper methods on HomeTasksCard.
 *
 * These don't render anything — they just instantiate the element and
 * call individual methods directly with crafted input.
 *
 * We freeze the jsdom realm's `window.Date` to noon UTC of a known
 * date so the local-vs-UTC date arithmetic in _isDueDateToday /
 * _formatDueDate is deterministic regardless of the host timezone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

// Pick noon UTC so all major timezones are still on the same calendar day.
const FROZEN_NOW = '2027-06-15T12:00:00Z';

async function makeCard() {
  // force=true so this realm gets a frozen Date — separate from the
  // cached realm used by other test files.
  const { HomeTasksCard } = await loadCard({ force: true, frozenNow: FROZEN_NOW });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{}] });
  card.hass = makeMockHass();
  return card;
}


// With FROZEN_NOW = 2027-06-15T12:00:00Z, "today" is 2027-06-15 in any
// timezone (since noon UTC is the same calendar day everywhere).

describe('_isDueDateOverdue', () => {
  test('returns false for empty input', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateOverdue(null), false);
    assert.equal(card._isDueDateOverdue(''), false);
    assert.equal(card._isDueDateOverdue(undefined), false);
  });

  test('returns false for today', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateOverdue('2027-06-15'), false);
  });

  test('returns false for future date', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateOverdue('2099-01-01'), false);
  });

  test('returns true for past date', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateOverdue('2000-01-01'), true);
  });

  test('returns true for yesterday', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateOverdue('2027-06-14'), true);
  });
});


describe('_isDueDateToday', () => {
  test('returns false for empty input', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateToday(null), false);
    assert.equal(card._isDueDateToday(''), false);
  });

  test('returns true only for today\'s ISO date', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateToday('2027-06-15'), true);
    assert.equal(card._isDueDateToday('2000-01-01'), false);
    assert.equal(card._isDueDateToday('2099-01-01'), false);
  });
});


// With FROZEN_NOW = 2027-06-15, "within 7 days" means 2027-06-15 .. 2027-06-22.
describe('_isDueDateWithinDays', () => {
  test('returns false for empty input', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateWithinDays(null, 7), false);
    assert.equal(card._isDueDateWithinDays('', 7), false);
  });

  test('returns true for today', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateWithinDays('2027-06-15', 0), true);
    assert.equal(card._isDueDateWithinDays('2027-06-15', 7), true);
  });

  test('returns true for date within range', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateWithinDays('2027-06-18', 7), true);  // 3 days ahead
    assert.equal(card._isDueDateWithinDays('2027-06-22', 7), true);  // exactly 7 days
  });

  test('returns false for date beyond range', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateWithinDays('2027-06-23', 7), false); // 8 days ahead
    assert.equal(card._isDueDateWithinDays('2099-01-01', 7), false);
  });

  test('returns false for past dates', async () => {
    const card = await makeCard();
    assert.equal(card._isDueDateWithinDays('2027-06-14', 7), false); // yesterday
    assert.equal(card._isDueDateWithinDays('2000-01-01', 7), false);
  });
});


describe('_getSubTaskProgress', () => {
  test('returns null when there are no sub_items', async () => {
    const card = await makeCard();
    assert.equal(card._getSubTaskProgress({}), null);
    assert.equal(card._getSubTaskProgress({ sub_items: [] }), null);
  });

  test('formats as "done/total"', async () => {
    const card = await makeCard();
    assert.equal(
      card._getSubTaskProgress({ sub_items: [
        { id: 'a', completed: true },
        { id: 'b', completed: false },
        { id: 'c', completed: true },
      ] }),
      '2/3'
    );
  });

  test('handles all-done', async () => {
    const card = await makeCard();
    assert.equal(
      card._getSubTaskProgress({ sub_items: [
        { id: 'a', completed: true },
        { id: 'b', completed: true },
      ] }),
      '2/2'
    );
  });

  test('handles none-done', async () => {
    const card = await makeCard();
    assert.equal(
      card._getSubTaskProgress({ sub_items: [
        { id: 'a', completed: false },
      ] }),
      '0/1'
    );
  });
});


describe('_buildSortComparator', () => {
  async function cardWithSort(sortBy) {
    const card = await makeCard();
    card._columns[0].sortBy = sortBy;
    return card;
  }

  test('manual sort uses sort_order', async () => {
    const card = await cardWithSort('manual');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { sort_order: 2 },
      { sort_order: 0 },
      { sort_order: 1 },
    ];
    tasks.sort(cmp);
    assert.deepEqual(tasks.map(t => t.sort_order), [0, 1, 2]);
  });

  test('priority sort puts highest first, missing last', async () => {
    const card = await cardWithSort('priority');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { priority: 1 },
      { priority: null },
      { priority: 3 },
      { priority: 2 },
    ];
    tasks.sort(cmp);
    assert.deepEqual(tasks.map(t => t.priority), [3, 2, 1, null]);
  });

  test('title sort is case-insensitive A→Z', async () => {
    const card = await cardWithSort('title');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { title: 'Banana' },
      { title: 'apple' },
      { title: 'Cherry' },
    ];
    tasks.sort(cmp);
    assert.deepEqual(tasks.map(t => t.title), ['apple', 'Banana', 'Cherry']);
  });

  test('due sort puts earliest first, undated last', async () => {
    const card = await cardWithSort('due');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { due_date: '2027-06-01' },
      { due_date: null },
      { due_date: '2027-01-15' },
      { due_date: '2027-03-10', due_time: '14:00' },
    ];
    tasks.sort(cmp);
    assert.deepEqual(tasks.map(t => t.due_date), [
      '2027-01-15', '2027-03-10', '2027-06-01', null,
    ]);
  });

  test('due sort with same date orders by time', async () => {
    const card = await cardWithSort('due');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { due_date: '2027-06-01', due_time: '14:00' },
      { due_date: '2027-06-01', due_time: '09:00' },
      { due_date: '2027-06-01' },  // no time → sorts as 00:00
    ];
    tasks.sort(cmp);
    assert.deepEqual(
      tasks.map(t => t.due_time ?? null),
      [null, '09:00', '14:00']
    );
  });

  test('person sort puts unassigned at the end', async () => {
    const card = await cardWithSort('person');
    const cmp = card._buildSortComparator(0);
    const tasks = [
      { assigned_person: 'person.charlie' },
      { assigned_person: null },
      { assigned_person: 'person.alice' },
    ];
    tasks.sort(cmp);
    assert.deepEqual(
      tasks.map(t => t.assigned_person),
      ['person.alice', 'person.charlie', null]
    );
  });
});


describe('_formatDueDate', () => {
  test('returns empty string for no date', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate(null), '');
    assert.equal(card._formatDueDate(''), '');
  });

  test('returns "Today" for today', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2027-06-15'), 'Today');
  });

  test('returns "Tomorrow" for tomorrow', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2027-06-16'), 'Tomorrow');
  });

  test('returns "Yesterday" for yesterday', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2027-06-14'), 'Yesterday');
  });

  test('returns "In 2 days" for +2 days (EN translation)', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2027-06-17'), 'In 2 days');
  });

  test('returns "2 days ago" for -2 days (EN translation)', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2027-06-13'), '2 days ago');
  });

  test('returns formatted day+month for further dates same year (en order)', async () => {
    const card = await makeCard();
    // en → month-first via Intl (issue #30); same year → no year suffix
    assert.equal(card._formatDueDate('2027-08-20'), 'Aug 20');
  });

  test('returns formatted day+month+year for different year (en order)', async () => {
    const card = await makeCard();
    assert.equal(card._formatDueDate('2029-03-10'), 'Mar 10, 29');
  });

  test('day-first ordering for German HA profile language', async () => {
    const card = await makeCard();
    card.hass = makeMockHass({ language: 'de' });
    assert.equal(card._formatDueDate('2027-08-20'), '20. Aug.');
  });

  test('hass.locale.language wins over hass.language', async () => {
    const card = await makeCard();
    card.hass = makeMockHass({ language: 'en', locale: { language: 'de' } });
    assert.equal(card._formatDueDate('2027-08-20'), '20. Aug.');
  });
});


describe('_advanceDateClamped', () => {
  // Regression: bare setMonth/setFullYear overflow month-end dates
  // (Jan 31 + 1 month -> Mar 3), inflating the recurrence end-date minimum
  // and silently clearing stored valid end dates.
  test('clamps Jan 31 + 1 month to Feb 28', async () => {
    const card = await makeCard();
    const r = card._advanceDateClamped(new Date(2027, 0, 31), 'months', 1);
    assert.equal(card._localDateStr(r), '2027-02-28');
  });

  test('clamps leap-day Feb 29 + 1 year to Feb 28', async () => {
    const card = await makeCard();
    const r = card._advanceDateClamped(new Date(2028, 1, 29), 'years', 1);
    assert.equal(card._localDateStr(r), '2029-02-28');
  });

  test('keeps in-range days across month/year advance', async () => {
    const card = await makeCard();
    assert.equal(card._localDateStr(card._advanceDateClamped(new Date(2027, 5, 15), 'months', 2)), '2027-08-15');
    assert.equal(card._localDateStr(card._advanceDateClamped(new Date(2027, 5, 15), 'years', 3)), '2030-06-15');
  });

  test('days and weeks advance plainly; hours leaves the date unchanged', async () => {
    const card = await makeCard();
    assert.equal(card._localDateStr(card._advanceDateClamped(new Date(2027, 5, 15), 'days', 20)), '2027-07-05');
    assert.equal(card._localDateStr(card._advanceDateClamped(new Date(2027, 5, 15), 'weeks', 2)), '2027-06-29');
    assert.equal(card._localDateStr(card._advanceDateClamped(new Date(2027, 5, 15), 'hours', 5)), '2027-06-15');
  });
});


describe('_fmtTimestamp', () => {
  const TS = new Date(2026, 7, 22, 14, 5); // local 2026-08-22 14:05

  test('follows HA profile language, not the browser', async () => {
    const card = await makeCard();
    card.hass = makeMockHass({ language: 'de' });
    assert.equal(card._fmtTimestamp(TS), '22.8.2026, 14:05');
  });

  test('date_format DMY/MDY/YMD force the numeric ordering', async () => {
    const card = await makeCard();
    card.hass = makeMockHass({ language: 'de', locale: { language: 'de', date_format: 'DMY' } });
    assert.match(card._fmtTimestamp(TS), /^22\/08\/2026, /);
    card.hass = makeMockHass({ language: 'de', locale: { language: 'de', date_format: 'MDY' } });
    assert.match(card._fmtTimestamp(TS), /^8\/22\/2026, /);
    card.hass = makeMockHass({ language: 'de', locale: { language: 'de', date_format: 'YMD' } });
    assert.match(card._fmtTimestamp(TS), /^2026-08-22, /);
  });

  test('time_format am_pm/24 override the language default', async () => {
    const card = await makeCard();
    card.hass = makeMockHass({ language: 'de', locale: { language: 'de', time_format: 'am_pm' } });
    assert.match(card._fmtTimestamp(TS), /2:05 PM$/);
    card.hass = makeMockHass({ language: 'en', locale: { language: 'en', time_format: '24' } });
    assert.match(card._fmtTimestamp(TS), /14:05$/);
  });
});


// Timezone regression tests are in separate files (test_tz_*.mjs) because
// V8 caches TZ data per isolate, so changing process.env.TZ between tests
// in the same file doesn't take effect. Each test_tz_*.mjs sets its TZ
// once at module top level before any Date instance is created.


describe('_thumbUrl', () => {
  test('maps a local image to its _thumb.webp', async () => {
    const card = await makeCard();
    assert.equal(
      card._thumbUrl('/local/home_tasks/abc123.png'),
      '/local/home_tasks/abc123_thumb.webp'
    );
  });

  test('preserves the ?v= cache-bust query', async () => {
    const card = await makeCard();
    assert.equal(
      card._thumbUrl('/local/home_tasks/abc123.png?v=42'),
      '/local/home_tasks/abc123_thumb.webp?v=42'
    );
  });

  test('leaves non-local URLs untouched', async () => {
    const card = await makeCard();
    assert.equal(card._thumbUrl('https://cdn.x/y.png'), 'https://cdn.x/y.png');
    assert.equal(card._thumbUrl('/media/local/home_tasks/x.png'), '/media/local/home_tasks/x.png');
    assert.equal(card._thumbUrl(''), '');
    assert.equal(card._thumbUrl(null), null);
  });
});


describe('_autoGrowTextarea (issue #32)', () => {
  const fakeTextarea = (scrollHeight, border) => {
    const seen = [];
    return { seen, el: {
      style: { set height(v) { seen.push(v); }, get height() { return seen.length ? seen[seen.length - 1] : ''; } },
      dataset: {}, scrollHeight, offsetHeight: 100 + border, clientHeight: 100,
    } };
  };

  test('sets height from scrollHeight + border (box-sizing: border-box) after resetting to auto', async () => {
    const card = await makeCard();
    const { seen, el } = fakeTextarea(123, 2);
    card._autoGrowTextarea(el);
    assert.deepEqual(seen, ['auto', '125px']);
    assert.equal(el.dataset.autoH, '125px');
  });

  test('respects a manual resize: a foreign inline height stops auto-sizing', async () => {
    const card = await makeCard();
    const { seen, el } = fakeTextarea(123, 2);
    card._autoGrowTextarea(el);           // → 125px
    seen.push('240px');                   // the user dragged the resize handle
    card._autoGrowTextarea(el);           // must leave it alone
    assert.equal(el.style.height, '240px');
  });

  test('tolerates a missing element', async () => {
    const card = await makeCard();
    assert.doesNotThrow(() => card._autoGrowTextarea(null));
  });
});


describe('theme hooks (issue #31)', () => {
  test('task title exposes --ht-task-title-* CSS custom properties with fallbacks', async () => {
    const card = await makeCard();
    const css = card._getStyles();
    for (const v of ['--ht-task-title-font-family', '--ht-task-title-font-size', '--ht-task-title-font-weight', '--ht-task-title-color']) {
      assert.ok(css.includes(`var(${v},`), `${v} must be declared with a fallback`);
    }
    // Fallbacks keep today's look: 14px and the todo text color.
    assert.ok(css.includes('var(--ht-task-title-font-size, 14px)'));
    assert.ok(css.includes('var(--ht-task-title-color, var(--todo-text))'));
  });
});
