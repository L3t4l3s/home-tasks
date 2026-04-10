/**
 * Timezone regression tests for Asia/Tokyo (UTC+9, no DST).
 *
 * The largest east-of-UTC offset for which the _isDueDateToday bug is most
 * pronounced — the bug window after midnight is up to 9 hours wide.
 */
process.env.TZ = 'Asia/Tokyo';

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


describe('Tokyo (UTC+9 JST) — _isDueDateOverdue / _isDueDateToday', () => {
  test('09:00 local — sanity baseline (UTC midnight)', async () => {
    // 2026-04-11 09:00 JST  →  2026-04-11T00:00:00Z
    const card = await makeCard('2026-04-11T00:00:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true);
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
  });

  test('05:00 local — UTC still 8 hours behind, today must work', async () => {
    // 2026-04-11 05:00 JST  →  2026-04-10T20:00:00Z
    const card = await makeCard('2026-04-10T20:00:00Z');
    assert.equal(card._isDueDateToday('2026-04-11'), true,
      '05:00 Tokyo: 2026-04-11 must register as today');
    assert.equal(card._isDueDateOverdue('2026-04-11'), false);
  });
});
