/**
 * The Display section of the editor: two groups, and one dropdown per person
 * row instead of a pair of switches nine rows apart (issue #48 follow-up).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function editor(colExtra = {}) {
  const { window } = await loadCard({ force: true });
  const Editor = window.customElements.get('home-tasks-card-editor');
  const ed = new Editor();
  ed.hass = makeMockHass({
    callWS: async (m) => {
      if (m.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Household' }] };
      if (m.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      return null;
    },
  });
  ed.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
  window.document.body.appendChild(ed);
  await new Promise((r) => setTimeout(r, 150));

  const changes = [];
  ed.addEventListener('config-changed', (e) => changes.push(e.detail.config));
  return { ed, changes, window };
}

// The two person dropdowns are the only selects with an "off" option.
const personSelects = (ed) =>
  [...ed.shadowRoot.querySelectorAll('select')].filter(
    (s) => [...s.options].some((o) => o.value === 'off'));

const groupLabels = (ed) =>
  [...ed.shadowRoot.querySelectorAll('.group-label')].map((e) => e.textContent.trim());

describe('person dropdowns', () => {
  test('there are two, each with the same four options', async () => {
    const { ed } = await editor();
    const sels = personSelects(ed);
    assert.equal(sels.length, 2, 'one for the filter row, one for the task row');
    for (const sel of sels) {
      assert.deepEqual([...sel.options].map((o) => o.value), ['off', 'picture', 'name', 'both']);
      assert.deepEqual([...sel.options].map((o) => o.textContent),
        ['Off', 'Profile picture', 'Name', 'Picture and name']);
    }
  });

  test('they open on what the card is doing now', async () => {
    const { ed } = await editor({ person_filter: 'picture', person_badge: 'off' });
    assert.deepEqual(personSelects(ed).map((s) => s.value), ['picture', 'off']);
  });

  test('an old config opens on the mode that draws the same thing', async () => {
    const { ed } = await editor({ badge_person: false, show_person_avatar: true });
    assert.deepEqual(personSelects(ed).map((s) => s.value), ['both', 'picture'],
      'filter row was chip+picture, task row was picture only');
  });

  test('changing one writes both keys and drops the three old ones', async () => {
    const { ed, changes, window } = await editor({ badge_person: false, show_person_avatar: true });
    const [filterSel] = personSelects(ed);
    filterSel.value = 'name';
    filterSel.dispatchEvent(new window.Event('change'));

    assert.equal(changes.length, 1);
    const col = changes[0].columns[0];
    assert.equal(col.person_filter, 'name');
    assert.equal(col.person_badge, 'picture', 'the other row keeps what it had');
    for (const legacy of ['badge_person', 'show_person_chips', 'show_person_avatar']) {
      assert.equal(col[legacy], undefined, `${legacy} must not linger and contradict the modes`);
    }
  });
});

describe('the Display section is split into groups', () => {
  test('card, header, tasks', async () => {
    const { ed } = await editor();
    assert.deepEqual(groupLabels(ed), ['Card', 'Header', 'Tasks']);
  });

  test('the person dropdowns sit one per group, filter first', async () => {
    const { ed } = await editor();
    const labels = [...ed.shadowRoot.querySelectorAll('.group-label, .field-wrap')]
      .filter((e) => e.classList.contains('group-label') || e.querySelector('select option[value="off"]'))
      .map((e) => e.classList.contains('group-label') ? e.textContent.trim() : 'person-select');
    assert.deepEqual(labels, ['Card', 'Header', 'person-select', 'Tasks', 'person-select']);
  });
});

describe('what sits in which group', () => {
  // Reads the Display section top to bottom and notes only the landmarks.
  const outline = (ed) => {
    const section = [...ed.shadowRoot.querySelectorAll('details')].find(
      (d) => (d.querySelector('summary')?.textContent || '').includes('Display'));
    const marks = [];
    for (const el of section.querySelectorAll('.group-label, .field, .field-wrap')) {
      if (el.classList.contains('group-label')) marks.push(el.textContent.trim());
      else if (el.querySelector('ha-icon-picker')) marks.push('icon');
      else if (el.querySelector('ha-textfield')) marks.push('title');
      else if (el.querySelector('select option[value="tiles"]')) marks.push('view-mode');
    }
    return marks;
  };

  test('view mode leads the card group, title and icon belong to the header', async () => {
    const { ed } = await editor();
    const marks = outline(ed);
    assert.deepEqual(marks.slice(0, 2), ['Card', 'view-mode'], 'view mode comes first');
    const header = marks.indexOf('Header');
    assert.ok(header > 0);
    assert.deepEqual(marks.slice(header, header + 3), ['Header', 'title', 'icon']);
    assert.ok(marks.indexOf('Tasks') > marks.indexOf('icon'), 'and Tasks comes after');
  });
});

