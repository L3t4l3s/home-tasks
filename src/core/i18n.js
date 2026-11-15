// Every text of the card, its editors and the card picker, in all
// languages. The table is ui_translations.json - the one source for these
// texts, also for the calendar's - and the build puts it into the card.
import translations from "../../custom_components/home_tasks/ui_translations.json";

export const _TRANSLATIONS = translations;

// One lookup for every text of the card, its editors and the card picker:
// the language's own table, else its base language's ("de-CH" reads "de"),
// else English. Norwegian's two written forms share one table.
export function _htText(lang, key, args = []) {
  lang = String(lang || "en");
  if (lang === "nb" || lang === "nn") lang = "no";
  const table = _TRANSLATIONS[lang] || _TRANSLATIONS[lang.split("-")[0]] || _TRANSLATIONS.en;
  const str = table[key] || _TRANSLATIONS.en[key] || key;
  return args.length ? str.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? "") : str;
}
