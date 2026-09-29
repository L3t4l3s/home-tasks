/**
 * The card hands every list it shows its AI entity and prompt prefix.
 *
 * The queue used to keep one global pair, and every card with an entity
 * overwrote it on load - so a second dashboard without a prefix stripped
 * the style off pictures made for a list it does not even show. Now each
 * list remembers its own, the card only writes what the list does not
 * already know, and the card-wide sync stays as the fallback.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCard } from './setup.mjs';

function makeHass(listInfo) {
  const calls = [];
  return {
    language: 'en', states: {}, auth: {}, calls,
    callWS: async (msg) => {
      calls.push(msg);
      switch (msg.type) {
        case 'home_tasks/get_lists': return { lists: [{ id: 'L1', name: 'Native', ...listInfo }] };
        case 'home_tasks/get_external_lists': return { external_lists: [] };
        case 'home_tasks/get_tasks': return { tasks: [], sections: [] };
        case 'home_tasks/set_list_settings': return { settings: {} };
        case 'home_tasks/sync_image_config': return { config: {} };
        default: return null;
      }
    },
    callService: async () => null,
  };
}

const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

async function mount({ listInfo = {}, imageGeneration } = {}) {
  const { HomeTasksCard } = await loadCard({ force: true });
  const hass = makeHass(listInfo);
  const card = new HomeTasksCard();
  card.setConfig({
    columns: [{ list_id: 'L1', auto_generate_image: true, show_images: true }],
    image_generation: imageGeneration,
  });
  card.hass = hass;
  await flush();
  hass.calls.length = 0;
  await card._syncImageGenerationConfig();
  return { card, hass };
}

const OWN = { ai_task_entity_id: 'ai_task.openai', prompt_prefix: 'Neon cyberpunk scene of ' };
const settingsCalls = (hass) => hass.calls.filter((c) => c.type === 'home_tasks/set_list_settings');

describe('handing the image settings to the lists', () => {
  test('a list that knows nothing gets entity, prefix and the switch', async () => {
    const { hass } = await mount({
      listInfo: { auto_generate_images: false, ai_task_entity_id: null, prompt_prefix: null },
      imageGeneration: { entity_id: OWN.ai_task_entity_id, prompt_prefix: OWN.prompt_prefix },
    });

    const [call] = settingsCalls(hass);
    assert.ok(call, 'one settings write');
    assert.equal(call.list_id, 'L1');
    assert.equal(call.auto_generate_images, true);
    assert.equal(call.ai_task_entity_id, OWN.ai_task_entity_id);
    assert.equal(call.prompt_prefix, OWN.prompt_prefix);
    assert.ok(hass.calls.some((c) => c.type === 'home_tasks/sync_image_config'), 'the card-wide fallback still goes out');
  });

  test('a list that already knows all this is left alone', async () => {
    const { hass } = await mount({
      listInfo: { auto_generate_images: true, ...OWN },
      imageGeneration: { entity_id: OWN.ai_task_entity_id, prompt_prefix: OWN.prompt_prefix },
    });

    assert.deepEqual(settingsCalls(hass), [], 'nothing to write, so nothing written');
  });

  test('a changed prefix reaches the list, and only the prefix', async () => {
    const { hass } = await mount({
      listInfo: { auto_generate_images: true, ai_task_entity_id: OWN.ai_task_entity_id, prompt_prefix: 'Old style ' },
      imageGeneration: { entity_id: OWN.ai_task_entity_id, prompt_prefix: OWN.prompt_prefix },
    });

    const [call] = settingsCalls(hass);
    assert.equal(call.prompt_prefix, OWN.prompt_prefix);
    assert.equal(call.auto_generate_images, undefined, 'the switch was already on');
  });

  test('a card without an entity does not touch what the list has', async () => {
    const { hass } = await mount({
      listInfo: { auto_generate_images: false, ...OWN },
      imageGeneration: undefined,
    });

    const [call] = settingsCalls(hass);
    assert.equal(call.auto_generate_images, true, 'the switch is still synced');
    assert.equal(call.ai_task_entity_id, undefined, 'but the entity the list knows stays');
    assert.equal(call.prompt_prefix, undefined);
    assert.ok(!hass.calls.some((c) => c.type === 'home_tasks/sync_image_config'));
  });

  test('a card with an entity and no prefix tells the list "no prefix"', async () => {
    // That is the answer for this list - not a gap the other dashboard's
    // style should fill.
    const { hass } = await mount({
      listInfo: { auto_generate_images: true, ...OWN },
      imageGeneration: { entity_id: OWN.ai_task_entity_id },
    });

    const [call] = settingsCalls(hass);
    assert.equal(call.prompt_prefix, '');
  });

  test('switching automatic generation on in the editor hands the settings over too', async () => {
    const { card, hass } = await mount({
      listInfo: { auto_generate_images: false, ai_task_entity_id: null, prompt_prefix: null },
      imageGeneration: { entity_id: OWN.ai_task_entity_id, prompt_prefix: OWN.prompt_prefix },
    });
    hass.calls.length = 0;

    await card._syncAutoGenerate({ list_id: 'L1' }, true);

    const [call] = settingsCalls(hass);
    assert.equal(call.auto_generate_images, true);
    assert.equal(call.ai_task_entity_id, OWN.ai_task_entity_id);
    assert.equal(call.prompt_prefix, OWN.prompt_prefix);
  });
});
