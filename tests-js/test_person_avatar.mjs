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
  TASK({ id: 'T4', title: 'Mow the lawn', sort_order: 3, assigned_person: 'person.otto' }),
];

const STATES = {
  'person.kevin': {
    attributes: { friendly_name: 'Kevin Schimnick', entity_picture: '/api/image/serve/abc123/512x512' },
  },
  'person.lisa': { attributes: { friendly_name: 'Lisa' } },
  'person.otto': {
    // A perfectly valid picture that happens to have a size in its path.
    attributes: { friendly_name: 'Otto', entity_picture: '/local/people/512x512/otto.jpg' },
  },
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

describe('the picture can stand in for the chip', () => {
  test('row chips off, picture on: the face stays, the pill goes', async () => {
    const card = await mount({ show_person_avatar: true, badge_person: false });
    const b = badge(card, 'person.kevin');
    assert.ok(b, 'the face is still there');
    assert.ok(b.classList.contains('avatar-only'));
    assert.equal(b.textContent.trim(), '', 'no name, no pill');
    assert.equal(b.getAttribute('title'), 'Kevin Schimnick', 'the name is one hover away');
    assert.equal(avatarIn(b).tagName, 'IMG');
  });

  test('and it still filters when clicked', async () => {
    const card = await mount({ show_person_avatar: true, badge_person: false });
    const win = card.ownerDocument.defaultView;
    badge(card, 'person.kevin').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await flush();
    assert.ok(card._columns[0].personFilters.has('person.kevin'));
  });

  test('filter chips off, picture on: the same, one size up', async () => {
    const card = await mount({ show_person_avatar: true, show_person_chips: false });
    const chip = card.shadowRoot.querySelector('.person-chip[data-eid="person.kevin"]');
    assert.ok(chip);
    assert.ok(chip.classList.contains('avatar-only'));
    assert.equal(chip.textContent.trim(), '');
  });

  test('with the picture off, switching chips off still removes them', async () => {
    const withoutRowChips = await mount({ badge_person: false });
    assert.equal(badge(withoutRowChips, 'person.kevin'), null);
    const withoutFilterChips = await mount({ show_person_chips: false });
    assert.equal(withoutFilterChips.shadowRoot.querySelector('.person-chip'), null);
  });

  test('turning the person feature off takes the pictures with it', async () => {
    const card = await mount({ show_person_avatar: true, show_assigned_person: false });
    assert.equal(badge(card, 'person.kevin'), null);
    assert.equal(card.shadowRoot.querySelector('.person-chip'), null);
  });

  test('the switch is called what people call it', async () => {
    const card = await mount();
    assert.equal(card._t('ed_show_person_avatar'), 'Profile picture');
  });
});

// ---------------------------------------------------------------------------
// One dropdown instead of two switches: Off / Profile picture / Name / Both.
// ---------------------------------------------------------------------------

const chipOf = (card, eid) => card.shadowRoot.querySelector(`.person-chip[data-eid="${eid}"]`);

describe('person display modes', () => {
  const shape = (el) => {
    if (!el) return 'off';
    const hasPic = !!el.querySelector('.person-avatar');
    const hasName = el.textContent.trim().length > 0;
    return hasPic && hasName ? 'both' : hasPic ? 'picture' : hasName ? 'name' : '?';
  };

  for (const mode of ['off', 'picture', 'name', 'both']) {
    test(`task row: ${mode}`, async () => {
      const card = await mount({ person_badge: mode });
      assert.equal(shape(badge(card, 'person.kevin')), mode);
    });

    test(`filter row: ${mode}`, async () => {
      const card = await mount({ person_filter: mode });
      assert.equal(shape(chipOf(card, 'person.kevin')), mode);
    });
  }

  test('the two rows are independent', async () => {
    const card = await mount({ person_badge: 'picture', person_filter: 'name' });
    assert.equal(shape(badge(card, 'person.kevin')), 'picture');
    assert.equal(shape(chipOf(card, 'person.kevin')), 'name');
  });

  test('the master person switch still wins over both', async () => {
    const card = await mount({ person_badge: 'both', person_filter: 'both', show_assigned_person: false });
    assert.equal(badge(card, 'person.kevin'), null);
    assert.equal(card.shadowRoot.querySelector('.person-chip'), null);
  });
});

describe('configs written before the dropdown', () => {
  // Nothing on screen may change when a card is updated, so the old keys
  // have to land on the mode that used to draw the same thing.
  const cases = [
    [{}, 'name', 'the default: chip with the name'],
    [{ show_person_avatar: true }, 'both', 'picture switch on'],
    [{ badge_person: false }, 'off', 'chip off, no picture'],
    [{ badge_person: false, show_person_avatar: true }, 'picture', 'chip off, picture on'],
  ];
  for (const [col, expected, why] of cases) {
    test(`task row: ${why}`, async () => {
      const card = await mount(col);
      assert.equal(card._personMode(0, 'badge'), expected);
    });
  }

  test('filter row reads its own old key', async () => {
    const card = await mount({ show_person_chips: false, show_person_avatar: true });
    assert.equal(card._personMode(0, 'filter'), 'picture');
    assert.equal(card._personMode(0, 'badge'), 'both', 'the picture switch was shared');
  });

  test('an explicit mode beats the old keys', async () => {
    const card = await mount({ person_badge: 'off', badge_person: true, show_person_avatar: true });
    assert.equal(card._personMode(0, 'badge'), 'off');
  });
});

describe('reading the picture and the name (review follow-up)', () => {
  test('only the serve path Home Assistant owns gets the smaller size', async () => {
    const card = await mount({ show_person_avatar: true });
    const img = avatarIn(badge(card, 'person.otto'));
    assert.equal(img.tagName, 'IMG');
    assert.equal(img.getAttribute('src'), '/local/people/512x512/otto.jpg',
      'a folder named after a size is not a size to swap');
    assert.equal(card._personPictureUrl('person.kevin'), '/api/image/serve/abc123/256x256',
      'the one HA really serves still gets swapped');
  });

  test('initials take the first letter of a word, not its first character', async () => {
    const card = await mount();
    // A Todoist collaborator with no HA person reads "Unknown (Alice)".
    assert.equal(card._personInitials('Unknown (Alice)'), 'UA');
    assert.equal(card._personInitials('(((  )))'), '?');
    assert.equal(card._personInitials('Kevin Schimnick'), 'KS');
    assert.equal(card._personInitials('Ben'), 'B');
  });
});

