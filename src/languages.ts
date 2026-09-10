/** The languages this bot translates between. */
export const LANGUAGE_CODES = ["en", "ko", "es"] as const;

export type LangCode = (typeof LANGUAGE_CODES)[number];

interface LanguageInfo {
  /** Human-readable name, used in prompts and in the reply header. */
  name: string;
  /** Flag shown next to each translation in the reply. */
  flag: string;
  /** Google Translate v2 language code. */
  googleCode: string;
}

export const LANGUAGES: Record<LangCode, LanguageInfo> = {
  en: { name: "English", flag: "\u{1F1FA}\u{1F1F8}", googleCode: "en" },
  ko: { name: "Korean", flag: "\u{1F1F0}\u{1F1F7}", googleCode: "ko" },
  es: { name: "Spanish", flag: "\u{1F1EA}\u{1F1F8}", googleCode: "es" },
};

export function isLangCode(value: string): value is LangCode {
  return (LANGUAGE_CODES as readonly string[]).includes(value);
}

const HANGUL_GLOBAL = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g;
const LETTER_GLOBAL = /\p{L}/gu;
/** Characters that only appear in Spanish, never in English. */
const SPANISH_ONLY = /[\u00E1\u00E9\u00ED\u00F3\u00FA\u00F1\u00FC\u00BF\u00A1]/i;

/** Below this share of Hangul, treat the message as mixed rather than Korean. */
const HANGUL_THRESHOLD = 0.3;

/**
 * Cheap script-based guess, used only to skip work and to pick targets before
 * calling a provider. It is deliberately conservative: returning `null` costs
 * one extra target language, while returning the WRONG language suppresses a
 * translation someone needed.
 *
 * Korean is judged by proportion, not presence - mixed messages like
 * "Pastor\uB2D8 what time is \uC608\uBC30?" are common in this community and are mostly
 * English. English vs. Spanish share an alphabet, so unaccented Spanish falls
 * through to `null` and the provider does the real detection.
 */
export function guessLanguage(text: string): LangCode | null {
  const letters = text.match(LETTER_GLOBAL)?.length ?? 0;
  if (letters === 0) return null;

  const hangul = text.match(HANGUL_GLOBAL)?.length ?? 0;
  if (hangul / letters >= HANGUL_THRESHOLD) return "ko";

  if (SPANISH_ONLY.test(text)) return "es";
  return null;
}

/** Every configured language except the one the message was written in. */
export function targetsFor(source: LangCode, enabled: readonly LangCode[]): LangCode[] {
  return enabled.filter((code) => code !== source);
}
