import "dotenv/config";
import { z } from "zod";
import { LANGUAGE_CODES, type LangCode } from "./languages.js";

/**
 * Engine ids exposed to operators. `opus` and `sonnet` both go through the
 * Claude provider and differ only by model id; `google` is a separate provider
 * with no conversation context.
 */
export const ENGINES = ["opus", "sonnet", "google"] as const;
export type Engine = (typeof ENGINES)[number];

export const ENGINE_MODELS: Record<Exclude<Engine, "google">, string> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
};

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((raw) => raw.split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  // Override only when running against a self-hosted Telegram Bot API server.
  TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),

  MODE: z.enum(["polling", "webhook"]).default("polling"),
  PORT: z.coerce.number().int().positive().default(8080),
  // Public HTTPS origin Telegram will call, e.g. https://zion-bot.fly.dev
  WEBHOOK_DOMAIN: z.string().url().optional(),
  WEBHOOK_PATH: z.string().default("/telegraf/webhook"),
  // Telegram echoes this back in a header so you can reject forged updates.
  WEBHOOK_SECRET: z.string().optional(),

  ENGINE: z.enum(ENGINES).default("sonnet"),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),

  // Thinking depth for Claude. Translation is a well-specified task, so `low`
  // is the right default; raise it for dense theological or legal wording.
  EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  /**
   * How long the cached system prompt survives between messages.
   *
   * "1h" costs more to write (2x input rate vs 1.25x) but survives the gaps
   * between bursts of chat, which is the normal pattern for a church group.
   * "5m" is cheaper per write and better only for continuously busy chats.
   */
  ANTHROPIC_CACHE_TTL: z.enum(["5m", "1h"]).default("1h"),

  /**
   * Spend ceiling for the Claude engines, in USD. The bot stops calling the API
   * once estimated spend reaches this. 0 disables the guard.
   *
   * This is enforced by this process from its own accounting - it is not an
   * Anthropic-side limit. Set a hard cap in the Anthropic Console as well.
   */
  ANTHROPIC_MAX_COST_USD: z.coerce.number().min(0).default(10),

  /**
   * monthly - the budget resets on the 1st (UTC), matching API billing
   * total   - a lifetime cap that never resets on its own
   */
  ANTHROPIC_BUDGET_PERIOD: z.enum(["monthly", "total"]).default("monthly"),

  /**
   * DM the admins once remaining Anthropic budget falls to or below this many
   * USD. 0 disables the low-budget alert (the exhausted alert still fires).
   */
  ANTHROPIC_ALERT_REMAINING_USD: z.coerce.number().min(0).default(5),

  /** Telegram user IDs that receive budget alerts and may run /budget reset. */
  ADMIN_USER_IDS: csv("").pipe(z.array(z.string())),

  LANGUAGES: csv("en,ko,es").pipe(
    z.array(z.enum(LANGUAGE_CODES)).min(2, "Need at least 2 languages"),
  ),

  /** How many earlier messages are shown to the model as context. */
  CONTEXT_TURNS: z.coerce.number().int().min(0).max(30).default(6),

  /**
   * all     - translate every message in a group
   * mention - only when the bot is @mentioned or replied to
   * command - only on /tr
   */
  GROUP_MODE: z.enum(["all", "mention", "command"]).default("all"),

  /** Empty means anyone can use the bot. */
  ALLOWED_CHAT_IDS: csv("").pipe(z.array(z.string())),

  /** Where per-chat settings and usage counters are persisted. */
  STATE_FILE: z.string().default("./data/state.json"),

  GLOSSARY_FILE: z.string().default("./glossary.json"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = Omit<z.infer<typeof schema>, "LANGUAGES"> & {
  LANGUAGES: LangCode[];
};

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data as Config;

  // Fail at startup rather than on the first message a member sends.
  if (cfg.ENGINE === "google" && !cfg.GOOGLE_TRANSLATE_API_KEY) {
    throw new Error("ENGINE=google requires GOOGLE_TRANSLATE_API_KEY");
  }
  if (cfg.ENGINE !== "google" && !cfg.ANTHROPIC_API_KEY) {
    throw new Error(`ENGINE=${cfg.ENGINE} requires ANTHROPIC_API_KEY`);
  }
  if (cfg.MODE === "webhook" && !cfg.WEBHOOK_DOMAIN) {
    throw new Error("MODE=webhook requires WEBHOOK_DOMAIN (a public https:// origin)");
  }
  return cfg;
}

/**
 * Config problems are almost always a missing env var on a fresh deployment, so
 * print the reason plainly and exit rather than dumping a stack trace.
 */
export const config: Config = (() => {
  try {
    return load();
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
    console.error("See .env.example for every supported setting.\n");
    process.exit(1);
  }
})();
