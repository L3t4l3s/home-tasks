/**
 * Timezone regression tests for Pacific Time (America/Los_Angeles).
 *
 * Lives in its own file because V8 caches timezone data per isolate, so
 * changing process.env.TZ mid-process from another file is unreliable.
 * This file sets TZ at the very top, before any Date instance is created.
 *
 * REGRESSION: _isDueDateOverdue used `new Date(dateString)` which parses
 * date-only strings as UTC midnight. For users west of UTC, the parsed
 * value is then BEFORE local midnight on the same day, causing today's
 * tasks to be classified as overdue all day long.
 */
process.env.TZ = 'America/Los_Angeles';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';


async function makeCard(frozenIso) {
  const { HomeTasksCard } = await loadCard({ force: true, frozenNow: frozenIso });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{}] });
  card.hass = makeMockHass();
  return card;
}


describe('Pacific Time (UTC-7 PDT) — _isDueDateOverdue / _isDueDateToday', () => {
  test('14:00 local — today task is NOT overdue', async () => {
    // 2026-04-11 14:00 PDT  →  2026-04-11T21:00:00Z
    const card = await makeCard('2026-04-11T21:00:00Z');
    assert.equal(card._isDueDateOverdue('2026-04-11'), false,
      'a task due today must not show as overdue at 14:00 Pacific');
    assert.equal(card._isDueDateToday('2026-04-11'), true);
  });

  test('14:00 local — yesterday task IS overdue', async () => {
    const card = await makeCard('2026-04-11T21:00:00Z');
    assert.equal(card._isDueDateOverdue('2026-04-10'), true);
    assert.equal(card._isDueDateToday('2026-04-10'), false);
  });

  test('14:00 local — tomorrow task is neither', async () => {
    const card = await makeCard('2026-04-11T21:00:00Z');
    assert.equal(card._isDueDateOverdue('2026-04-12'), false);
    assert.equal(card._isDueDateToday('2026-04-12'), false);
  });

  test('23:30 local — today task is still today, not overdue', async () => {
    // 2026-04-11 23:30 PDT  →  2026-04-12T06:30:00Z (UTC already next day)
    const card = await makeCard('2026-04-12T06:30:00Z');
    assert.equal(card._isDueDateOverdue('2026-04-11'), false,
      '23:30 Pacific: 2026-04-11 must not be overdue (still today locally)');
    assert.equal(card._isDueDateToday('2026-04-11'), true,
      '23:30 Pacific: 2026-04-11 must register as today');
  });

  test('00:30 local — today is the new day', async () => {
    // 2026-04-11 00:30 PDT  →  2026-04-11T07:30:00Z
    const card = await makeCard('2026-04-11T07:30:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true);
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
    assert.equal(card._isDueDateOverdue('2026-04-10'), true);
  });
});


describe('Pacific Time — _localDateStr (recurrence date-input min)', () => {
  // REGRESSION: the recurrence start/end date-input `min` used
  // new Date().toISOString().slice(0, 10) — the UTC date. From 17:00
  // PDT onward that is already *tomorrow*, so users could no longer
  // pick today as a start date, and _updateEndDateMin silently cleared
  // valid end dates that fell below the off-by-one minimum.
  test('23:30 local — local date string is still today, not the UTC tomorrow', async () => {
    // 2026-04-11 23:30 PDT  →  2026-04-12T06:30:00Z
    const card = await makeCard('2026-04-12T06:30:00Z');
    // Use the card realm's frozen Date, not the test realm's live one.
    const RealmDate = card.ownerDocument.defaultView.Date;
    assert.equal(card._localDateStr(new RealmDate()), '2026-04-11');
  });
});
