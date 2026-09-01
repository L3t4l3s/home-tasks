/**
 * Profile picture for the assigned person (issue #48).
 *
 * The picture comes from Home Assistant's person entity and nowhere else: a
 * same-origin path, or initials when there is none. An absolute URL in
 * entity_picture points at a host we do not control, so it is treated like no
 * picture at all — that is the part these tests are really guarding.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

const LISTS = [{ id: 'L1', name: 'Household', sensor_entity_id: null }];

const TASK = (over) => ({
  completed: false, notes: '', due_date: null, due_time: null, sub_items: [],
  priority: null, reminders: [], recurrence_enabled: false, tags: [],
  assigned_person: null, image_url: null, history: [], section_id: null, ...over,
});

const TASKS = [
  TASK({ id: 'T1', title: 'Take out the bins', sort_order: 0, assigned_person: 'person.kevin' }),
  TASK({ id: 'T2', title: 'Water the plants', sort_order: 1, assigned_person: 'person.lisa' }),
  TASK({ id: 'T3', title: 'Sort the recycling', sort_order: 2, assigned_person: 'person.mallory' }),
];

const STATES = {
  'person.kevin': {
    attributes: { friendly_name: 'Kevin Schimnick', entity_picture: '/api/image/serve/abc123/512x512' },
  },
  'person.lisa': { attributes: { friendly_name: 'Lisa' } },
  'person.mallory': {
    // A picture somewhere else on the internet: not ours to show.
    attributes: { friendly_name: 'Mallory', entity_picture: 'https://example.com/m.jpg' },
  },
};

function makeHass() {
  return {
    language: 'en', states: STATES, auth: {},
    callWS: async (msg) => {
      if (msg.type === 'home_tasks/get_lists') return { lists: LISTS };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: TASKS.map((t) => ({ ...t })), sections: [] };
      return null;
    },
    callService: async () => null,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount(colExtra = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1', ...colExtra }] });
  card.hass = makeHass();
  await flush();
  return card;
}

const badge = (card, eid) =>
  card.shadowRoot.querySelector(`.assigned-badge[data-eid="${eid}"]`);
const avatarIn = (el) => el && el.querySelector('.person-avatar');

describe('assignee avatars', () => {
  test('off by default — the badge is exactly what it was', async () => {
    const card = await mount();
    const b = badge(card, 'person.kevin');
    assert.ok(b, 'the badge is still there');
    assert.equal(avatarIn(b), null, 'no avatar unless asked for');
    assert.match(b.textContent, /Kevin Schimnick/);
  });

  test('a person with a picture gets it, at the small size', async () => {
    const card = await mount({ show_person_avatar: true });
    const img = avatarIn(badge(card, 'person.kevin'));
    assert.equal(img.tagName, 'IMG');
    assert.equal(img.getAttribute('src'), '/api/image/serve/abc123/256x256',
      'HA serves 256 and 512 only; 256 is plenty for a 16px circle');
  });

  test('a person without a picture gets initials, not an empty circle', async () => {
    const card = await mount({ show_person_avatar: true });
    const el = avatarIn(badge(card, 'person.lisa'));
    assert.equal(el.tagName, 'SPAN');
    assert.equal(el.textContent, 'L');
    assert.ok(el.style.background, 'and a colour of their own');
  });

  test('two names give two initials', async () => {
    const card = await mount({ show_person_avatar: true });
    // Kevin has a picture, so ask the helper directly for the naming rule.
    assert.equal(card._personInitials('Kevin Schimnick'), 'KS');
    assert.equal(card._personInitials('Ben'), 'B');
    assert.equal(card._personInitials('   '), '?');
  });

  test('an off-site picture is never loaded', async () => {
    const card = await mount({ show_person_avatar: true });
    const el = avatarIn(badge(card, 'person.mallory'));
    assert.equal(el.tagName, 'SPAN', 'an absolute URL is not our picture to show');
    assert.equal(el.textContent, 'M');
    assert.equal(card.shadowRoot.querySelector('img[src^="http"]'), null,
      'nothing in the card reaches out to another host');
  });

  test('the same person keeps the same colour', async () => {
    const card = await mount({ show_person_avatar: true });
    const a = card._personColor('person.lisa');
    const b = card._personColor('person.lisa');
    assert.equal(a, b);
    assert.notEqual(a, card._personColor('person.kevin'));
  });

  test('a picture that has gone missing falls back to initials', async () => {
    const card = await mount({ show_person_avatar: true });
    const b = badge(card, 'person.kevin');
    const img = avatarIn(b);
    img.dispatchEvent(new card.ownerDocument.defaultView.Event('error'));
    const el = avatarIn(b);
    assert.equal(el.tagName, 'SPAN', 'no hole in the row');
    assert.equal(el.textContent, 'KS');
  });

  test('the filter chips carry the same faces', async () => {
    const card = await mount({ show_person_avatar: true });
    const chip = card.shadowRoot.querySelector('.person-chip[data-eid="person.kevin"]');
    assert.ok(chip, 'chip rendered');
    assert.equal(avatarIn(chip).tagName, 'IMG');
    assert.match(chip.textContent, /Kevin Schimnick/, 'the name stays next to the face');
  });

  test('clicking the badge still filters', async () => {
    const card = await mount({ show_person_avatar: true });
    const win = card.ownerDocument.defaultView;
    badge(card, 'person.kevin').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush();
    assert.ok(card._columns[0].personFilters.has('person.kevin'), 'the avatar must not eat the click');
  });
});
