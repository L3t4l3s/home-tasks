// Translation parity: every language block must define exactly the same keys
// as English, so no string silently falls back to English in the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCard, makeMockHass } from "./setup.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = join(__dirname, "..", "custom_components", "home_tasks", "home-tasks-card.js");

function loadTranslations() {
  const src = readFileSync(CARD, "utf8");
  const m = src.match(/const _TRANSLATIONS = (\{[\s\S]*?\n\});/);
  assert.ok(m, "could not locate _TRANSLATIONS object");
  // The literal is pure data (identifier keys + string values) from our own
  // source file — safe to evaluate to get the exact object.
  const embedded = new Function("return " + m[1])();
  const shared = JSON.parse(readFileSync(join(dirname(CARD), "ui_translations.json"), "utf8"));
  assert.deepEqual(embedded, shared, "Run npm run build:i18n after editing shared translations");
  return shared;
}

test("Brazilian Portuguese preserves interpolation placeholders", () => {
  const t = loadTranslations();
  assert.ok(t["pt-BR"], "Brazilian Portuguese block missing");
  const placeholders = (value) => (value.match(/\{(?:\d+|value)\}|%s/g) || []).sort();
  for (const [key, value] of Object.entries(t.en)) {
    assert.deepEqual(placeholders(t["pt-BR"][key]), placeholders(value), key);
  }
});

test("Brazilian Portuguese integration translation covers the English config flow", () => {
  const folder = join(__dirname, "..", "custom_components", "home_tasks", "translations");
  const english = JSON.parse(readFileSync(join(folder, "en.json"), "utf8"));
  const portuguese = JSON.parse(readFileSync(join(folder, "pt-BR.json"), "utf8"));
  function check(source, translated, path = "") {
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(source).sort(), path);
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "object") check(value, translated[key], `${path}.${key}`);
      else assert.ok(typeof translated[key] === "string" && translated[key].trim(), `${path}.${key}`);
    }
  }
  check(english, portuguese);
});

test("card and editor resolve pt-BR from the HA profile and retain other languages", async () => {
  const { HomeTasksCard, window } = await loadCard({ force: true });
  const card = new HomeTasksCard();
  const Editor = window.customElements.get("home-tasks-card-editor");
  const editor = new Editor();
  for (const element of [card, editor]) {
    // Avoid a data load: only the real locale/translation methods are exercised.
    element._hass = makeMockHass({ language: "en", locale: { language: "pt-BR" } });
    assert.equal(element._t("ed_defaults_saved"), "Salvo");
    assert.equal(element._t("ed_share_images"), "Compartilhar imagens com outras listas");
    assert.equal(element._t("hist_by_user"), "Usuário");
    assert.equal(element._t("progress", 2, 5), "2 de 5 concluídas");
    element._hass = makeMockHass({ language: "pt-BR" });
    assert.equal(element._t("my_tasks"), "Minhas tarefas");
    element._hass = makeMockHass({ language: "pt" });
    assert.equal(element._t("ed_defaults_saved"), "Guardado");
    element._hass = makeMockHass({ language: "en" });
    assert.equal(element._t("my_tasks"), "My Tasks");
  }
});

test("every language defines the same keys as English (no silent fallback)", () => {
  const t = loadTranslations();
  assert.ok(t.en, "English block missing");
  const enKeys = new Set(Object.keys(t.en));

  const problems = [];
  for (const [lang, dict] of Object.entries(t)) {
    if (lang === "en") continue;
    const keys = new Set(Object.keys(dict));
    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));
    if (missing.length) problems.push(`${lang} missing: ${missing.join(", ")}`);
    if (extra.length) problems.push(`${lang} has extra keys not in en: ${extra.join(", ")}`);
  }
  assert.equal(problems.length, 0, "\n" + problems.join("\n"));
});

test("recent feature keys are translated in every language", () => {
  const t = loadTranslations();
  const required = [
    "ed_view_mode", "ed_view_mode_tiles", "ed_show_images", "ed_auto_image",
    // The AI settings live in the column's Images section now, so
    // ed_ai_image_section is gone and ed_sec_images names that section.
    "ed_sec_images", "ed_ai_image_entity", "ed_show_voice", "duplicate_task",
    "img_generate", "img_from_media", "mb_title", "voice_input",
    "ed_queue_running", "ed_queue_cancel", "ed_share_images",
  ];
  for (const lang of Object.keys(t)) {
    for (const key of required) {
      assert.ok(
        typeof t[lang][key] === "string" && t[lang][key].length > 0,
        `${lang} is missing translation for "${key}"`
      );
    }
  }
});
