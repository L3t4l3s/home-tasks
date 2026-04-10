/**
 * Smoke test: the home-tasks-card.js file loads into a jsdom realm
 * and registers HomeTasksCard as a custom element.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

test('card source loads into jsdom and defines home-tasks-card', async () => {
  const { HomeTasksCard, window } = await loadCard();
  assert.ok(HomeTasksCard, 'HomeTasksCard class is defined');
  assert.ok(
    HomeTasksCard.prototype instanceof window.HTMLElement,
    'HomeTasksCard extends HTMLElement'
  );
});

test('card can be instantiated and given config + hass', async () => {
  const { HomeTasksCard } = await loadCard();
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{}] });
  card.hass = makeMockHass();
  assert.ok(card.shadowRoot, 'shadowRoot is attached');
});
