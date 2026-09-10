import type { LangCode } from "../languages.js";

/** One earlier message from the same chat, shown to the engine as context. */
export interface ContextMessage {
  speaker: string;
  text: string;
}

export interface TranslateRequest {
  text: string;
  /** Set when the caller already knows the source language; otherwise detect. */
  sourceHint: LangCode | null;
  targets: LangCode[];
  /** Oldest-first. Empty for engines that do not use context. */
  context: ContextMessage[];
  /** Display name of whoever sent the message being translated. */
  speaker: string;
}

export interface TranslateResult {
  sourceLang: LangCode;
  translations: Partial<Record<LangCode, string>>;
  /**
   * Short translator's note, only when a phrase genuinely does not carry over
   * (an idiom, a pun, an honorific with no English equivalent).
   */
  note?: string;
  usage: UsageRecord;
}

export interface UsageRecord {
  engine: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Billable characters, for the Google provider. */
  characters: number;
  costUsd: number;
}

/** Which account a provider's spend lands on. Drives budget enforcement. */
export type BillingAccount = "anthropic" | "google";

export interface TranslationProvider {
  /** Stable id shown in /status and recorded in usage stats. */
  readonly id: string;
  /** Which billing account this provider spends against. */
  readonly billsTo: BillingAccount;
  /** Human-readable label for the /engine command. */
  readonly label: string;
  /** False for engines that translate each message in isolation. */
  readonly usesContext: boolean;
  translate(req: TranslateRequest): Promise<TranslateResult>;
}

export const EMPTY_USAGE = (engine: string): UsageRecord => ({
  engine,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  characters: 0,
  costUsd: 0,
});
