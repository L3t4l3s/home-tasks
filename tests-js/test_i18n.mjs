// Translation parity: every language block must define exactly the same keys
// as English, so no string silently falls back to English in the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD = join(__dirname, "..", "custom_components", "home_tasks", "home-tasks-card.js");

function loadTranslations() {
  const src = readFileSync(CARD, "utf8");
  const m = src.match(/const _TRANSLATIONS = (\{[\s\S]*?\n\});/);
  assert.ok(m, "could not locate _TRANSLATIONS object");
  // The literal is pure data (identifier keys + string values) from our own
  // source file — safe to evaluate to get the exact object.
  return new Function("return " + m[1])();
}

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
    "ed_ai_image_section", "ed_ai_image_entity", "ed_show_voice", "duplicate_task",
    "img_generate", "img_from_media", "mb_title", "voice_input",
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
