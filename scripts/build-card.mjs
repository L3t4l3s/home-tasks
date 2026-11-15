// Builds custom_components/home_tasks/home-tasks-card.js from src/.
//
// The card ships as one file at one URL: only that URL carries the version
// (?v=<mtime>) that gets past the browser's 31-day cache, so a file the card
// imported on its own would be served stale. esbuild puts the modules of
// src/ together into that file, the texts of ui_translations.json included.
//
// The built file is committed: HACS installs it from the release zip, and CI
// checks that it is what src/ builds to. The version in its first line comes
// from manifest.json - the release workflow bumps both.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("../custom_components/home_tasks/manifest.json", import.meta.url), "utf8"),
);

const banner = `/**
 * Home Tasks Card for Home Assistant
 * A feature-rich todo list with drag & drop, sub-tasks, notes, and due dates.
 *
 * Security: All user-controlled content is set via textContent or DOM properties,
 * never via innerHTML with unsanitized data.
 *
 * Built from src/ by scripts/build-card.mjs. Edit the sources there and run
 * \`npm run build\` - this file is written over.
 */
console.info("%c HOME-TASKS-CARD %c v${manifest.version} ", "color: white; background: #03a9f4; font-weight: bold;", "color: #03a9f4; background: white; font-weight: bold;");`;

const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/index.js"],
  outfile: "custom_components/home_tasks/home-tasks-card.js",
  bundle: true,
  // Loaded by Home Assistant as a module; nothing is exported.
  format: "esm",
  // What the browsers get stays as it is written: no syntax is lowered.
  target: "esnext",
  // Umlauts and the like as they are, not as \u escapes.
  charset: "utf8",
  legalComments: "none",
  minify: false,
  banner: { js: banner },
  logLevel: "warning",
});
if (result.warnings.length) process.exitCode = 1;
