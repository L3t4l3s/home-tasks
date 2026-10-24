// ui_translations.json is the single source for frontend and calendar strings.
// Embed it in the distributed card so loading the UI needs no extra request.
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../custom_components/home_tasks/', import.meta.url);
const translations = JSON.parse(await readFile(new URL('ui_translations.json', root), 'utf8'));
const cardPath = new URL('home-tasks-card.js', root);
const source = await readFile(cardPath, 'utf8');
const pattern = /const _TRANSLATIONS = (\{[\s\S]*?\n\});/;
if (!pattern.test(source)) throw new Error('Cannot locate embedded translations');
await writeFile(cardPath, source.replace(pattern, () => `const _TRANSLATIONS = ${JSON.stringify(translations, null, 2)};`));
