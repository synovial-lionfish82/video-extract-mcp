export type AsrEngine = 'sensevoice' | 'whisper';

/** Spec §9: an explicit language set, not a vague "CJK-heavy" heuristic. */
const SENSEVOICE_LANGS = new Set(['zh', 'yue', 'ja', 'ko']);

function baseLang(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return tag.toLowerCase().split(/[-_]/)[0] ?? null;
}

export function chooseAsrEngine(
  input: { preferredLanguage?: string; languageHint?: string | null },
): AsrEngine {
  const lang = baseLang(input.preferredLanguage) ?? baseLang(input.languageHint);
  return lang && SENSEVOICE_LANGS.has(lang) ? 'sensevoice' : 'whisper';
}
