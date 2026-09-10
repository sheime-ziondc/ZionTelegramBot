import { config } from "../config.js";
import { LANGUAGES, isLangCode, type LangCode } from "../languages.js";
import type {
  TranslateRequest,
  TranslateResult,
  TranslationProvider,
  UsageRecord,
} from "./types.js";

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";

/** USD per million characters, billed once per target language. */
const PRICE_PER_MILLION_CHARS = 20;

interface GoogleTranslateResponse {
  data?: {
    translations?: Array<{
      translatedText?: string;
      detectedSourceLanguage?: string;
    }>;
  };
  error?: { message?: string };
}

/**
 * Sentence-in, sentence-out. Google's API has no notion of the surrounding
 * conversation, so `context` is ignored here - that is the tradeoff of this
 * engine, not an oversight.
 */
export class GoogleProvider implements TranslationProvider {
  readonly id = "google";
  readonly label = "Google Translate";
  readonly usesContext = false;
  readonly billsTo = "google" as const;

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const translations: Partial<Record<LangCode, string>> = {};
    let detected: LangCode | null = req.sourceHint;
    let billedCharacters = 0;

    // One request per target: v2 accepts a single `target` per call.
    for (const target of req.targets) {
      const result = await this.callApi(req.text, target, req.sourceHint);
      if (result.text) translations[target] = result.text;
      if (!detected && result.detected) detected = result.detected;
      billedCharacters += req.text.length;
    }

    return {
      sourceLang: detected ?? "en",
      translations,
      usage: this.recordUsage(billedCharacters),
    };
  }

  private async callApi(
    text: string,
    target: LangCode,
    sourceHint: LangCode | null,
  ): Promise<{ text: string | null; detected: LangCode | null }> {
    const body = new URLSearchParams({
      q: text,
      target: LANGUAGES[target].googleCode,
      format: "text",
    });
    if (sourceHint) body.set("source", LANGUAGES[sourceHint].googleCode);

    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(config.GOOGLE_TRANSLATE_API_KEY!)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    const payload = (await response.json()) as GoogleTranslateResponse;

    if (!response.ok) {
      throw new Error(
        `Google Translate error ${response.status}: ${payload.error?.message ?? "unknown"}`,
      );
    }

    const first = payload.data?.translations?.[0];
    const detectedRaw = first?.detectedSourceLanguage;

    return {
      text: first?.translatedText ?? null,
      detected: detectedRaw && isLangCode(detectedRaw) ? detectedRaw : null,
    };
  }

  private recordUsage(characters: number): UsageRecord {
    return {
      engine: this.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      characters,
      costUsd: (characters * PRICE_PER_MILLION_CHARS) / 1_000_000,
    };
  }
}
