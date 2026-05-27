/**
 * ISO-639-1 code → English language name. Single source of truth for
 * surfaces that need a human-readable label alongside the canonical
 * wire-format code: language-clause builder, WebUI / TUI pickers, CLI
 * error messages. Codes not in this map degrade gracefully via the
 * raw-code fallback in `buildLanguageClause`.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fi: 'Finnish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese',
}
