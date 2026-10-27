/**
 * list_columns (multi-column list view) and tile_size (tiles view).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

function hassWith(tasks) {
  return {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'List' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks, sections: [] };
      return null;
    },
    callService: async () => null,
  };
}

const TASKS = [
  { id: 'T1', title: 'One', sort_order: 0, sub_items: [] },
  { id: 'T2', title: 'Two', sort_order: 1, sub_items: [] },
];

async function render(colConfig) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colConfig }] });
  card.hass = hassWith(TASKS);
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return card.shadowRoot.querySelector('.card-column');
}

describe('list_columns', () => {
  test('unset: single column, no multi-col class', async () => {
    const col = await render({});
    assert.ok(!col.classList.contains('multi-col'));
    assert.equal(col.style.getPropertyValue('--ht-list-cols'), '');
  });

  test('2: multi-col class and the column count variable', async () => {
    const col = await render({ list_columns: 2 });
    assert.ok(col.classList.contains('multi-col'));
    assert.equal(col.style.getPropertyValue('--ht-list-cols'), '2');
  });

  test('clamped to 1-4', async () => {
    assert.equal((await render({ list_columns: 9 })).style.getPropertyValue('--ht-list-cols'), '4');
    assert.ok(!(await render({ list_columns: 0 })).classList.contains('multi-col'));
  });

  test('list_column_min_width sets the minimum, clamped to 80-600', async () => {
    assert.equal((await render({ list_columns: 2 })).style.getPropertyValue('--ht-list-min-width'), '');
    assert.equal((await render({ list_columns: 2, list_column_min_width: 120 })).style.getPropertyValue('--ht-list-min-width'), '120px');
    assert.equal((await render({ list_columns: 2, list_column_min_width: 5 })).style.getPropertyValue('--ht-list-min-width'), '80px');
  });

  test('the stylesheet lays multi-col lists out as a grid with full-width headers', async () => {
    const col = await render({ list_columns: 2 });
    const css = [...col.getRootNode().querySelectorAll('style')].map((s) => s.textContent).join('\n');
    assert.match(css, /\.multi-col \.task-list,/);
    assert.match(css, /\.multi-col \.task-list > :not\(\.task\) \{ grid-column: 1 \/ -1; \}/);
  });
});

describe('tile_size', () => {
  test('presets map to a minimum tile width', async () => {
    for (const [size, px] of [['small', '80px'], ['medium', '140px'], ['large', '200px']]) {
      const col = await render({ view_mode: 'tiles', tile_size: size });
      assert.equal(col.style.getPropertyValue('--ht-tile-min'), px, size);
    }
  });

  test('a number is a width in px, clamped to 60-400', async () => {
    assert.equal((await render({ view_mode: 'tiles', tile_size: 95 })).style.getPropertyValue('--ht-tile-min'), '95px');
    assert.equal((await render({ view_mode: 'tiles', tile_size: 10 })).style.getPropertyValue('--ht-tile-min'), '60px');
  });

  test('unset or unknown keeps the built-in size', async () => {
    assert.equal((await render({ view_mode: 'tiles' })).style.getPropertyValue('--ht-tile-min'), '');
    assert.equal((await render({ view_mode: 'tiles', tile_size: 'huge' })).style.getPropertyValue('--ht-tile-min'), '');
  });
});
