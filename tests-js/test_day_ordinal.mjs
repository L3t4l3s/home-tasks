/**
 * Recurrence badge day of month: English ordinals (1st, 2nd, 3rd, 11th, 22nd).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function card(language) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const c = new HomeTasksCard();
  c.setConfig({ columns: [{ list_id: 'L1' }] });
  c.hass = makeMockHass({ language, locale: { language } });
  return c;
}

test('English days get the right ordinal suffix', async () => {
  const c = await card('en');
  const got = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 24, 31].map((d) => c._dayOrdinal(d));
  assert.deepEqual(got, ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '24th', '31st']);
});

test('the badge uses it', async () => {
  const c = await card('en');
  const badge = c._buildRecurrenceBadge({ recurrence_enabled: true, recurrence_unit: 'months', recurrence_value: 1,
    recurrence_month_pattern: 'day_of_month', recurrence_day_of_month: 22 });
  assert.match(badge.textContent, /22nd/);
});

test('other languages keep their suffix', async () => {
  const c = await card('de');
  assert.equal(c._dayOrdinal(22), '22.');
});
