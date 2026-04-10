/**
 * jsdom bootstrap for testing home-tasks-card.js with node:test.
 *
 * The card is a vanilla custom element that depends on a complete browser
 * environment (window, document, customElements, HTMLElement, CSS, etc.).
 * We set up jsdom, install its globals on globalThis, then load the card
 * source code into the jsdom realm via vm.runInContext.
 *
 * Usage in a test file:
 *   import { loadCard } from './setup.mjs';
 *   const { HomeTasksCard, window } = await loadCard();
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARD_PATH = path.resolve(
  __dirname,
  '../custom_components/home_tasks/home-tasks-card.js'
);

let _cached = null;

/**
 * Load the card.js source into a fresh jsdom realm and return the
 * HomeTasksCard class plus the window/document for assertions.
 *
 * The result is cached so subsequent calls reuse the same realm.
 * Pass force=true to get a fresh one.
 *
 * Pass `frozenNow` (Date or ISO string) to replace `window.Date` with
 * a stub that always returns that moment for `new Date()` (no args).
 * Used by tests that depend on "today" / relative date arithmetic.
 */
export async function loadCard({ force = false, frozenNow = null } = {}) {
  if (_cached && !force) return _cached;

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  if (frozenNow != null) {
    const fixedTs = (frozenNow instanceof Date ? frozenNow : new Date(frozenNow)).getTime();
    const RealDate = dom.window.Date;
    const FrozenDate = function (...args) {
      if (args.length === 0) return new RealDate(fixedTs);
      return new RealDate(...args);
    };
    FrozenDate.now = () => fixedTs;
    FrozenDate.parse = RealDate.parse;
    FrozenDate.UTC = RealDate.UTC;
    Object.setPrototypeOf(FrozenDate, RealDate);
    Object.setPrototypeOf(FrozenDate.prototype, RealDate.prototype);
    dom.window.Date = FrozenDate;
  }

  // Install jsdom globals on Node's globalThis so test code can use them
  // without window. prefixes if needed.
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.customElements = dom.window.customElements;
  globalThis.CSS = dom.window.CSS;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);

  // The card uses ha-icon (a Home Assistant component). We don't render it,
  // just define a stub so createElement('ha-icon') doesn't blow up.
  if (!dom.window.customElements.get('ha-icon')) {
    class HaIconStub extends dom.window.HTMLElement {}
    dom.window.customElements.define('ha-icon', HaIconStub);
  }
  if (!dom.window.customElements.get('ha-card')) {
    class HaCardStub extends dom.window.HTMLElement {}
    dom.window.customElements.define('ha-card', HaCardStub);
  }

  // Read the card source and execute it inside the jsdom realm so it
  // sees its globals (HTMLElement, customElements, etc.).
  const src = fs.readFileSync(CARD_PATH, 'utf8');
  const script = new dom.window.Function(src);
  script.call(dom.window);

  const HomeTasksCard = dom.window.customElements.get('home-tasks-card');
  if (!HomeTasksCard) {
    throw new Error(
      'Failed to load HomeTasksCard — customElements.get returned null. ' +
      'Check that home-tasks-card.js calls customElements.define("home-tasks-card", …)'
    );
  }

  _cached = { HomeTasksCard, window: dom.window, dom };
  return _cached;
}

/**
 * Build a minimal mock `hass` object suitable for setting on a card.
 */
export function makeMockHass(overrides = {}) {
  return {
    language: 'en',
    states: {},
    callWS: async () => null,
    callService: async () => null,
    auth: {},
    ...overrides,
  };
}
