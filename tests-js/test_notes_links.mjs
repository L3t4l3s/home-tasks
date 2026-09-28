/**
 * Notes show as text with clickable links; a click switches to editing (#62).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

async function makeCard() {
  const { HomeTasksCard } = await loadCard({ force: true });
  const calls = [];
  const hass = {
    language: 'en', states: {}, auth: {},
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type === 'home_tasks/get_lists') return { lists: [{ id: 'L1', name: 'Test' }] };
      if (msg.type === 'home_tasks/get_external_lists') return { external_lists: [] };
      if (msg.type === 'home_tasks/get_tasks') return { tasks: [] };
      return null;
    },
    callService: async () => {},
  };
  const card = new HomeTasksCard();
  card.setConfig({ columns: [{ list_id: 'L1' }] });
  card.hass = hass;
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
  return { card, calls };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// Build the notes section attached to the document, so focus/isConnected work.
function mount(card, task) {
  card._columns[0].tasks = [task];
  const section = card._buildNotesSection(task, 0);
  document.body.appendChild(section);
  return section;
}

describe('_findUrls', () => {
  const urls = async (text) => {
    const { card } = await makeCard();
    // JSON round trip: the array comes from the jsdom realm.
    return JSON.parse(JSON.stringify(card._findUrls(text).map(u => u.url)));
  };

  test('finds http and https links in text', async () => {
    assert.deepEqual(await urls('see https://example.com/a?b=1 and http://x.org'), [
      'https://example.com/a?b=1', 'http://x.org',
    ]);
  });

  test('sentence punctuation after a link is not part of it', async () => {
    assert.deepEqual(await urls('Open https://example.com/doc. Then https://a.b/c, ok?'), [
      'https://example.com/doc', 'https://a.b/c',
    ]);
  });

  test('brackets: closing one only belongs to the link when it opened one', async () => {
    assert.deepEqual(await urls('(see https://example.com/x)'), ['https://example.com/x']);
    assert.deepEqual(await urls('https://en.wikipedia.org/wiki/Foo_(bar)'), [
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  test('other schemes and bare hosts are not links', async () => {
    assert.deepEqual(await urls('javascript:alert(1) www.example.com ftp://x.y https://'), []);
  });
});

describe('notes view', () => {
  test('notes with a URL render as text with a safe, clickable link', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'Pay', notes: 'Invoice: https://bank.example/pay?id=7\nthanks' });
    const view = section.querySelector('.notes-view');
    assert.ok(view, 'read view shown');
    assert.equal(section.querySelector('textarea'), null);
    const a = view.querySelector('a');
    assert.equal(a.getAttribute('href'), 'https://bank.example/pay?id=7');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(view.textContent, 'Invoice: https://bank.example/pay?id=7\nthanks');
  });

  test('markup in notes stays text', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: '<img src=x onerror="alert(1)"> https://a.example' });
    const view = section.querySelector('.notes-view');
    assert.equal(view.querySelector('img'), null);
    assert.ok(view.textContent.startsWith('<img src=x'));
    assert.equal(view.querySelectorAll('a').length, 1);
  });

  test('empty notes go straight to the textarea', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: '  ' });
    assert.ok(section.querySelector('textarea'));
    assert.equal(section.querySelector('.notes-view'), null);
  });

  test('clicking the text switches to editing, with the notes in the textarea', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'call https://a.example' });
    section.querySelector('.notes-view').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ta = section.querySelector('textarea');
    assert.ok(ta, 'textarea shown');
    assert.equal(ta.value, 'call https://a.example');
    assert.equal(document.activeElement, ta);
  });

  test('Enter on the focused view switches to editing', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'text' });
    section.querySelector('.notes-view').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.ok(section.querySelector('textarea'));
  });

  test('clicking a link opens it and does not switch to editing', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'go https://a.example now' });
    const a = section.querySelector('.notes-view a');
    a.addEventListener('click', (e) => e.preventDefault());  // jsdom can't navigate
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.ok(section.querySelector('.notes-view'));
    assert.equal(section.querySelector('textarea'), null);
  });

  test('editing survives a re-render of the card', async () => {
    const { card } = await makeCard();
    const task = { id: 'T1', title: 'X', notes: 'text' };
    const section = mount(card, task);
    section.querySelector('.notes-view').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The card tears its DOM down and builds the section again.
    section.remove();
    await tick();
    const rebuilt = mount(card, task);
    assert.ok(rebuilt.querySelector('textarea'), 'still editing after the rebuild');
  });

  test('leaving the field saves and goes back to the view with the new links', async () => {
    const { card, calls } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'old' });
    section.querySelector('.notes-view').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ta = section.querySelector('textarea');
    ta.value = 'new https://b.example';
    ta.dispatchEvent(new Event('blur'));
    await tick(); await tick();
    const update = calls.find(c => c.type === 'home_tasks/update_task' && 'notes' in c);
    assert.equal(update.notes, 'new https://b.example');
    const view = section.querySelector('.notes-view');
    assert.ok(view, 'back to the view');
    assert.equal(view.querySelector('a').getAttribute('href'), 'https://b.example');
  });

  test('Enter on a focused link is left to the link', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'go https://a.example' });
    const a = section.querySelector('.notes-view a');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    assert.equal(ev.defaultPrevented, false);
    assert.ok(section.querySelector('.notes-view'));
  });

  test('a drag across the text (selecting it) does not switch to editing', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'copy this text' });
    const view = section.querySelector('.notes-view');
    const down = new window.Event('pointerdown', { bubbles: true });
    Object.assign(down, { clientX: 10, clientY: 10 });
    view.dispatchEvent(down);
    view.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 80, clientY: 12 }));
    assert.ok(section.querySelector('.notes-view'));
  });

  test('the view reads the current task, not a stale copy (tile detail sheet)', async () => {
    const { card } = await makeCard();
    const stale = { id: 'T1', title: 'X', notes: 'old' };
    card._columns[0].tasks = [{ ...stale, notes: 'reloaded' }];  // a reload replaced the object
    const section = card._buildNotesSection(stale, 0);
    document.body.appendChild(section);
    assert.equal(section.querySelector('.notes-view').textContent, 'reloaded');
  });

  test('typing into empty notes survives the re-render after the auto-save', async () => {
    const { card } = await makeCard();
    const task = { id: 'T1', title: 'X', notes: '' };
    const section = mount(card, task);
    const ta = section.querySelector('textarea');
    ta.focus();
    ta.value = 'first words';
    task.notes = 'first words';          // what the optimistic save does
    section.remove();                    // the card rebuilds its DOM
    await tick();
    const rebuilt = mount(card, task);
    assert.ok(rebuilt.querySelector('textarea'), 'still the textarea, not the read view');
  });

  test('clearing the notes keeps the textarea', async () => {
    const { card } = await makeCard();
    const section = mount(card, { id: 'T1', title: 'X', notes: 'old' });
    section.querySelector('.notes-view').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const ta = section.querySelector('textarea');
    ta.value = '';
    ta.dispatchEvent(new Event('blur'));
    await tick(); await tick();
    assert.ok(section.querySelector('textarea'));
  });
});
