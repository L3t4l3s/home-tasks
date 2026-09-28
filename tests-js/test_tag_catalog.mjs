/**
 * Fixed tags per list in the tag input (issue #61): always offered, first,
 * and a "did you mean" for near-miss typos.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function makeCard({ catalog = [], tasks = [] } = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  card.hass = makeMockHass();
  card._columns[0].tasks = tasks;
  card._columns[0].tagCatalog = catalog;
  card._render = () => {};              // no full re-render in these unit tests
  card._updateTaskRouted = async () => {};
  return card;
}

function openInput(card, task, typed = '') {
  const section = card._buildTagsSection(task, 0);
  document.body.appendChild(section);
  const input = section.querySelector('input[data-focus-key="tag_input"]');
  input.value = typed;
  input.dispatchEvent(new Event(typed ? 'input' : 'focus'));
  const items = [...section.querySelectorAll('.tag-autocomplete-item')];
  return { section, input, items, texts: items.map(i => i.textContent), tags: items.map(i => i.dataset.tag) };
}

const T = (id, tags = []) => ({ id, title: id, tags, sub_items: [] });

describe('fixed tags in the tag input', () => {
  test('offered even when no task carries them, before the other known tags', async () => {
    const card = await makeCard({ catalog: ['kitchen', 'garden'], tasks: [T('a', ['alpha'])] });
    const { tags } = openInput(card, T('new'));
    assert.deepEqual(tags, ['kitchen', 'garden', 'alpha']);
  });

  test('a tag the task already has is not offered again', async () => {
    const card = await makeCard({ catalog: ['kitchen', 'garden'] });
    const { tags } = openInput(card, T('new', ['kitchen']));
    assert.deepEqual(tags, ['garden']);
  });

  test('typing filters by prefix, fixed tags included', async () => {
    const card = await makeCard({ catalog: ['kitchen', 'garden'], tasks: [T('a', ['kids'])] });
    const { tags } = openInput(card, T('new'), 'ki');
    assert.deepEqual(tags, ['kitchen', 'kids']);
  });

  test('a near-miss typo gets a "did you mean" for the fixed tag', async () => {
    const card = await makeCard({ catalog: ['kitchen', 'garden'] });
    const { texts, tags, items } = openInput(card, T('new'), 'kitchn');
    assert.deepEqual(tags, ['kitchen']);
    assert.equal(texts[0], 'Did you mean #kitchen?');
    assert.ok(items[0].classList.contains('did-you-mean'));
  });

  test('picking the suggestion adds the fixed tag, not the typo', async () => {
    const card = await makeCard({ catalog: ['kitchen'] });
    const task = T('new');
    const { items } = openInput(card, task, 'kichen');
    items[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    assert.deepEqual([...task.tags], ['kitchen']);
  });

  test('unrelated new tags get no hint — free text stays free', async () => {
    const card = await makeCard({ catalog: ['kitchen'] });
    const { items } = openInput(card, T('new'), 'car');
    assert.equal(items.length, 0);
  });
});

describe('_isNearMiss', () => {
  test('one or two edits for longer tags, one for short ones', async () => {
    const card = await makeCard();
    assert.equal(card._isNearMiss('kitchn', 'kitchen'), true);
    assert.equal(card._isNearMiss('kichten', 'kitchen'), true);   // two edits
    assert.equal(card._isNearMiss('kit', 'kitchen'), false);
    assert.equal(card._isNearMiss('car', 'cat'), true);
    assert.equal(card._isNearMiss('cow', 'cat'), false);           // short: only one edit
    assert.equal(card._isNearMiss('kitchen', 'kitchen'), false);
  });
});
