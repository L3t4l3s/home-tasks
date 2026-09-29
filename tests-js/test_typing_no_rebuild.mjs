/**
 * Typing in a task's notes must not be interrupted by the
 * background reload its own auto-save sets off: on iOS every rebuild closes and
 * reopens the keyboard. The rebuild waits until the user leaves the field.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const tick = () => new Promise(r => setTimeout(r, 0));

async function makeCard() {
  const { HomeTasksCard } = await loadCard({ force: true });
  // jsdom has no CSS.escape; the focus restore after a rebuild uses it.
  if (!window.CSS) window.CSS = { escape: (v) => String(v) };
  if (!globalThis.CSS) globalThis.CSS = window.CSS;
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') {
        return { tasks: [{ id: 'T1', title: 'Bins', sort_order: 0, completed: false, notes: '', sub_items: [], tags: [], reminders: [] }] };
      }
      return null;
    },
    callService: async () => {},
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  document.body.appendChild(card);
  card.hass = hass;
  for (let i = 0; i < 6; i++) await tick();
  card._expandedTasks.add('T1');
  card._render();
  return card;
}

// What the store event after an auto-save does: a background reload's render.
function backgroundRender(card) {
  card._bgUpdates = (card._bgUpdates || 0) + 1;
  try { card._render(); } finally { card._bgUpdates -= 1; }
}

const notes = (card) => card.shadowRoot.querySelector('textarea[data-focus-key="notes"]');

describe('background reload while typing in a task field', () => {
  test('the focused notes field is left alone', async () => {
    const card = await makeCard();
    const ta = notes(card);
    ta.focus();
    ta.value = 'Buy milk';
    backgroundRender(card);
    assert.equal(notes(card), ta, 'same element — no rebuild under the user');
    assert.equal(card._pendingRender, true);
    card.remove();
  });

  test('the held-back rebuild runs once the user leaves the field', async () => {
    const card = await makeCard();
    const ta = notes(card);
    ta.focus();
    backgroundRender(card);
    ta.blur();
    await tick(); await tick();
    assert.equal(card._pendingRender, false);
    assert.notEqual(notes(card), ta, 'rebuilt after the blur');
    card.remove();
  });

  test('without focus in a task field the reload rebuilds right away', async () => {
    const card = await makeCard();
    const ta = notes(card);
    backgroundRender(card);
    assert.notEqual(notes(card), ta);
    card.remove();
  });

  test('a blur from pressing a button waits for the release, so the click lands', async () => {
    const card = await makeCard();
    const ta = notes(card);
    ta.focus();
    backgroundRender(card);
    const btn = card.shadowRoot.querySelector('.expand-btn');
    btn.dispatchEvent(new window.Event('pointerdown', { bubbles: true, composed: true }));
    ta.blur();
    await tick(); await tick();
    assert.equal(notes(card), ta, 'not rebuilt while the button is held');
    assert.ok(btn.isConnected);
    window.dispatchEvent(new window.Event('pointerup'));
    await tick(); await tick();
    assert.equal(card._pendingRender, false, 'rebuilt after the release');
    card.remove();
  });

  test('only the notes hold it back — the tag input rebuilds (it holds the task object)', async () => {
    const card = await makeCard();
    const tagInput = card.shadowRoot.querySelector('input[data-focus-key="tag_input"]');
    assert.ok(tagInput, 'tag input present in the details');
    tagInput.focus();
    backgroundRender(card);
    assert.equal(card._pendingRender, false);
    assert.notEqual(card.shadowRoot.querySelector('input[data-focus-key="tag_input"]'), tagInput);
    card.remove();
  });
});
