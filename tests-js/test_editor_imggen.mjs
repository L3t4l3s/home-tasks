/**
 * The image-generation form in the editor.
 *
 * A dashboard lost its AI entity without anyone removing it: ha-form emits
 * value-changed on its own now and then (settling after opening, or a
 * selector normalising an entity it does not know yet), the handler took
 * the empty field at face value and wrote the config. Only the user clears
 * a field now - nothing is written before the form has been touched, and a
 * field the event leaves out or reports unchanged is left alone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard, makeMockHass } from './setup.mjs';

async function mount(imageGeneration) {
  const { window } = await loadCard({ force: true });
  const Editor = window.customElements.get('home-tasks-card-editor');
  const ed = new Editor();
  ed.hass = makeMockHass();
  ed.setConfig({ columns: [{ list_id: 'L1' }], image_generation: imageGeneration });
  ed.fired = 0;
  ed._fireChanged = () => { ed.fired += 1; };
  const form = ed._buildImgGenForm();
  const emit = (value) => form.dispatchEvent(new window.CustomEvent('value-changed', { detail: { value } }));
  const touch = () => form.dispatchEvent(new window.Event('focusin', { bubbles: true, composed: true }));
  return { ed, form, emit, touch };
}

// Config objects live in the jsdom realm; compare shape, not prototype.
const plain = (o) => JSON.parse(JSON.stringify(o));

const CFG = { entity_id: 'ai_task.openai', prompt_prefix: 'Neon cyberpunk scene of ' };

describe('the image-generation form', () => {
  test('an event before the user touched the form changes nothing', async () => {
    const { ed, emit } = await mount({ ...CFG });

    emit({ entity_id: '', prompt_prefix: CFG.prompt_prefix });

    assert.deepEqual(plain(ed._config.image_generation), CFG, 'the entity is still there');
    assert.equal(ed.fired, 0);
  });

  test('the user clearing the entity is honoured', async () => {
    const { ed, emit, touch } = await mount({ ...CFG });

    touch();
    emit({ entity_id: '', prompt_prefix: CFG.prompt_prefix });

    assert.deepEqual(plain(ed._config.image_generation), { prompt_prefix: CFG.prompt_prefix });
    assert.equal(ed.fired, 1);
  });

  test('a field the event leaves out is left alone', async () => {
    const { ed, emit, touch } = await mount({ ...CFG });

    touch();
    emit({ prompt_prefix: 'Watercolour of ' });

    assert.deepEqual(plain(ed._config.image_generation), { entity_id: CFG.entity_id, prompt_prefix: 'Watercolour of ' });
  });

  test('an event that repeats the config does not write', async () => {
    const { ed, emit, touch } = await mount({ ...CFG });

    touch();
    emit({ ...CFG });

    assert.equal(ed.fired, 0);
  });

  test('the prefix keeps its trailing space', async () => {
    // The prompt is prefix + title with no separator of its own.
    const { ed, emit, touch } = await mount({ entity_id: CFG.entity_id });

    touch();
    emit({ entity_id: CFG.entity_id, prompt_prefix: 'Minimalist icon of ' });

    assert.equal(ed._config.image_generation.prompt_prefix, 'Minimalist icon of ');
  });

  test('clearing both removes the block', async () => {
    const { ed, emit, touch } = await mount({ ...CFG });

    touch();
    emit({ entity_id: '', prompt_prefix: '' });

    assert.equal(ed._config.image_generation, undefined);
    assert.equal(ed.fired, 1);
  });
});
