/**
 * Timezone regression tests for Europe/Berlin.
 *
 * REGRESSION: _isDueDateToday compared against UTC date string. For users
 * east of UTC right after midnight local time, UTC was still on the
 * previous day, so today's tasks lost their "today" badge until ~02:00 CEST.
 */
process.env.TZ = 'Europe/Berlin';

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


describe('Berlin (UTC+2 CEST) — _isDueDateOverdue / _isDueDateToday', () => {
  test('12:00 local — sanity baseline', async () => {
    // 2026-04-11 12:00 CEST  →  2026-04-11T10:00:00Z
    const card = await makeCard('2026-04-11T10:00:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true);
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
    assert.equal(card._isDueDateOverdue('2026-04-10'), true);
    assert.equal(card._isDueDateToday('2026-04-12'), false);
    assert.equal(card._isDueDateOverdue('2026-04-12'), false);
  });

  test('00:30 local — today task is correctly today', async () => {
    // 2026-04-11 00:30 CEST  →  2026-04-10T22:30:00Z (UTC still on yesterday)
    const card = await makeCard('2026-04-10T22:30:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true,
      '00:30 Berlin: 2026-04-11 must register as today');
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
    assert.equal(card._isDueDateToday('2026-04-10'), false,
      '00:30 Berlin: 2026-04-10 must NOT be today');
    assert.equal(card._isDueDateOverdue('2026-04-10'), true);
  });

  test('23:30 local — today task is still today', async () => {
    // 2026-04-11 23:30 CEST  →  2026-04-11T21:30:00Z
    const card = await makeCard('2026-04-11T21:30:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true);
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
  });
});
