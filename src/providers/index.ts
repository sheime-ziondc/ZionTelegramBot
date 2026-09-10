import { ENGINE_MODELS, config, type Engine } from "../config.js";
import { ClaudeProvider } from "./claude.js";
import { GoogleProvider } from "./google.js";
import type { TranslationProvider } from "./types.js";

export * from "./types.js";

/**
 * Providers are built lazily and cached, so a deployment that only ever uses
 * one engine never constructs a client for the others (and never needs their
 * API keys). Switching engines at runtime via /engine is therefore cheap.
 */
const cache = new Map<Engine, TranslationProvider>();

export function getProvider(engine: Engine): TranslationProvider {
  const existing = cache.get(engine);
  if (existing) return existing;

  const provider = build(engine);
  cache.set(engine, provider);
  return provider;
}

function build(engine: Engine): TranslationProvider {
  if (engine === "google") {
    if (!config.GOOGLE_TRANSLATE_API_KEY) {
      throw new Error("Google Translate is not configured (GOOGLE_TRANSLATE_API_KEY is unset).");
    }
    return new GoogleProvider();
  }

  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("Claude engines are not configured (ANTHROPIC_API_KEY is unset).");
  }

  const label = engine === "opus" ? "Claude Opus 5" : "Claude Sonnet 5";
  return new ClaudeProvider(engine, label, ENGINE_MODELS[engine]);
}

/** Engines that have the credentials they need, for the /engine picker. */
export function availableEngines(): Engine[] {
  const engines: Engine[] = [];
  if (config.ANTHROPIC_API_KEY) engines.push("opus", "sonnet");
  if (config.GOOGLE_TRANSLATE_API_KEY) engines.push("google");
  return engines;
}
