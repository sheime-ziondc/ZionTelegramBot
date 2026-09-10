import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { ENGINES, config, type Engine } from "./config.js";
import {
  LANGUAGES,
  guessLanguage,
  isLangCode,
  targetsFor,
  type LangCode,
} from "./languages.js";
import { availableEngines, getProvider } from "./providers/index.js";
import {
  canSpend,
  formatAdminAlert,
  formatStatus,
  getStatus,
  recordSpend,
  resetBudget,
  takeDueAdminAlerts,
} from "./budget.js";
import { store } from "./store.js";

const TELEGRAM_MAX_LENGTH = 4096;

export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, {
  telegram: { apiRoot: config.TELEGRAM_API_ROOT },
});

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function speakerName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "Unknown";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  return full || from.username || `User ${from.id}`;
}

/**
 * A chat can hold a saved engine whose API key has since been removed from the
 * deployment. Fall back to a configured one instead of throwing on every
 * message for the rest of that chat's life.
 */
function resolveEngine(saved: Engine): Engine {
  const available = availableEngines();
  if (available.includes(saved)) return saved;
  const fallback = available.includes(config.ENGINE) ? config.ENGINE : available[0];
  if (!fallback) {
    throw new Error("No translation engine is configured on this deployment.");
  }
  console.warn(`[bot] engine "${saved}" is unavailable; falling back to "${fallback}"`);
  return fallback;
}

/**
 * DMs every configured admin. Telegram forbids a bot from opening a chat with
 * someone who has never messaged it, so a 403 here means that admin still needs
 * to press Start - it is a setup problem, not a transient failure.
 */
export async function notifyAdmins(text: string): Promise<void> {
  if (config.ADMIN_USER_IDS.length === 0) {
    console.warn("[alert] budget alert raised but ADMIN_USER_IDS is empty; nobody was notified");
    return;
  }

  await Promise.all(
    config.ADMIN_USER_IDS.map(async (adminId) => {
      try {
        await bot.telegram.sendMessage(adminId, text);
        console.log(`[alert] notified admin ${adminId}`);
      } catch (err) {
        const description = String(
          (err as { description?: string }).description ?? (err as Error).message ?? err,
        );
        if (description.includes("bot can't initiate conversation") || description.includes("403")) {
          console.error(
            `[alert] could not DM admin ${adminId}: they must send /start to the bot once first`,
          );
        } else {
          console.error(`[alert] could not DM admin ${adminId}:`, description);
        }
      }
    }),
  );
}

function isAdmin(ctx: Context): boolean {
  const userId = ctx.from?.id;
  return userId !== undefined && config.ADMIN_USER_IDS.includes(String(userId));
}

function isAllowed(ctx: Context): boolean {
  if (config.ALLOWED_CHAT_IDS.length === 0) return true;
  const chatId = ctx.chat?.id;
  return chatId !== undefined && config.ALLOWED_CHAT_IDS.includes(String(chatId));
}

/**
 * Messages with no letters in any script - a bare "👍", "+1", "2026" - have
 * nothing to translate, and sending them to an engine is pure cost.
 */
function hasTranslatableContent(text: string): boolean {
  return /\p{L}/u.test(text);
}

/** Splits an over-long reply on paragraph boundaries where possible. */
function chunk(text: string, limit = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function replyLong(ctx: Context, html: string, replyTo?: number): Promise<void> {
  for (const part of chunk(html)) {
    await ctx.reply(part, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
    });
  }
}

/**
 * Serializes work per chat. Two members posting at once would otherwise race on
 * the shared context window and produce translations built from a half-updated
 * history.
 */
const chatQueues = new Map<number, Promise<unknown>>();

function enqueue(chatId: number, task: () => Promise<void>): Promise<void> {
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task, task);
  chatQueues.set(
    chatId,
    next.catch(() => undefined),
  );
  return next;
}

// Without this, a throw inside any handler becomes an unhandled rejection.
bot.catch((err, ctx) => {
  console.error(`[bot] unhandled error while processing ${ctx.updateType}:`, err);
});

/* -------------------------------------------------------------------------- */
/* commands                                                                    */
/* -------------------------------------------------------------------------- */

const HELP = [
  "<b>Zion Translation Bot</b>",
  "",
  "I translate between English, Korean, and Spanish, using the recent conversation so that short replies, dropped subjects, and honorifics come out right.",
  "",
  "Just send a message and I will post it in the other languages.",
  "",
  "<b>Commands</b>",
  "/tr &lt;text&gt; - translate one message explicitly",
  "/languages en,ko,es - set which languages this chat uses",
  "/engine - show or switch the translation engine",
  "/mode all|mention|command - when I translate in group chats",
  "/reset - forget the conversation context",
  "/usage - tokens and cost for this chat",
  "/budget - Anthropic spend against the cap",
  "/budget test - send yourself a test alert (admins)",
  "/status - current settings",
  "/help - this message",
].join("\n");

bot.start(async (ctx) => {
  await ctx.reply(HELP, { parse_mode: "HTML" });
});

bot.help(async (ctx) => {
  await ctx.reply(HELP, { parse_mode: "HTML" });
});

bot.command("languages", async (ctx) => {
  const state = store.get(ctx.chat.id);
  const arg = ctx.payload.trim();

  if (!arg) {
    const current = state.languages.map((c) => `${LANGUAGES[c].flag} ${LANGUAGES[c].name}`).join(", ");
    await ctx.reply(
      `This chat translates between: ${current}\n\nChange it with e.g. <code>/languages en,ko</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const requested = arg.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const invalid = requested.filter((code) => !isLangCode(code));
  if (invalid.length > 0) {
    await ctx.reply(`Unknown language code(s): ${invalid.join(", ")}. Valid codes: en, ko, es`);
    return;
  }

  const unique = [...new Set(requested)] as LangCode[];
  if (unique.length < 2) {
    await ctx.reply("Pick at least two languages, e.g. /languages en,ko");
    return;
  }

  store.update(ctx.chat.id, (s) => {
    s.languages = unique;
  });
  const label = unique.map((c) => `${LANGUAGES[c].flag} ${LANGUAGES[c].name}`).join(", ");
  await ctx.reply(`Now translating between: ${label}`);
});

bot.command("engine", async (ctx) => {
  const state = store.get(ctx.chat.id);
  const arg = ctx.payload.trim().toLowerCase();
  const available = availableEngines();

  if (!arg) {
    const lines = available.map((e) => {
      const marker = e === state.engine ? "→" : "  ";
      const provider = getProvider(e);
      const context = provider.usesContext ? "context-aware" : "no context";
      return `${marker} <code>${e}</code> - ${provider.label} (${context})`;
    });
    await ctx.reply(
      [`<b>Translation engine</b>`, ...lines, "", "Switch with e.g. <code>/engine sonnet</code>"].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (!ENGINES.includes(arg as Engine)) {
    await ctx.reply(`Unknown engine. Options: ${available.join(", ")}`);
    return;
  }
  if (!available.includes(arg as Engine)) {
    await ctx.reply(`The "${arg}" engine has no API key configured on this deployment.`);
    return;
  }

  store.update(ctx.chat.id, (s) => {
    s.engine = arg as Engine;
  });
  await ctx.reply(`Engine set to ${getProvider(arg as Engine).label}.`);
});

bot.command("mode", async (ctx) => {
  const state = store.get(ctx.chat.id);
  const arg = ctx.payload.trim().toLowerCase();

  if (!arg) {
    await ctx.reply(
      [
        `Group mode: <code>${state.groupMode}</code>`,
        "",
        "<code>all</code> - translate every message",
        "<code>mention</code> - only when you @mention or reply to me",
        "<code>command</code> - only on /tr",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
    return;
  }

  if (arg !== "all" && arg !== "mention" && arg !== "command") {
    await ctx.reply("Options: all, mention, command");
    return;
  }

  store.update(ctx.chat.id, (s) => {
    s.groupMode = arg;
  });
  await ctx.reply(`Group mode set to ${arg}.`);
});

bot.command("reset", async (ctx) => {
  store.clearHistory(ctx.chat.id);
  await ctx.reply("Conversation context cleared. The next message starts fresh.");
});

bot.command("usage", async (ctx) => {
  const { usage, engine } = store.get(ctx.chat.id);
  if (usage.messages === 0) {
    await ctx.reply("No translations recorded for this chat yet.");
    return;
  }

  const lines = [
    "<b>Usage for this chat</b>",
    `Messages translated: ${usage.messages}`,
    `Current engine: ${getProvider(resolveEngine(engine)).label}`,
  ];

  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const cached = usage.cacheReadTokens;
    const totalInput = usage.inputTokens + cached + usage.cacheWriteTokens;
    const cacheRate = totalInput > 0 ? Math.round((cached / totalInput) * 100) : 0;
    lines.push(
      `Input tokens: ${totalInput.toLocaleString()} (${cacheRate}% served from cache)`,
      `Output tokens: ${usage.outputTokens.toLocaleString()}`,
    );
  }
  if (usage.characters > 0) {
    lines.push(`Characters billed: ${usage.characters.toLocaleString()}`);
  }

  lines.push(
    `Estimated cost: $${usage.costUsd.toFixed(4)}`,
    `Average per message: $${(usage.costUsd / usage.messages).toFixed(5)}`,
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

bot.command("status", async (ctx) => {
  const state = store.get(ctx.chat.id);
  const provider = getProvider(resolveEngine(state.engine));
  await ctx.reply(
    [
      "<b>Status</b>",
      `Engine: ${provider.label}`,
      `Context: ${provider.usesContext ? `${state.history.length}/${config.CONTEXT_TURNS} messages remembered` : "not used by this engine"}`,
      `Languages: ${state.languages.map((c) => LANGUAGES[c].name).join(", ")}`,
      `Group mode: ${state.groupMode}`,
      `Delivery: ${config.MODE}`,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

bot.command("budget", async (ctx) => {
  const arg = ctx.payload.trim().toLowerCase();

  // Delivery is easy to get wrong (Telegram blocks unsolicited bot DMs), so let
  // an admin prove it works now rather than discovering it at 95% spend.
  if (arg === "test") {
    if (!isAdmin(ctx)) {
      await ctx.reply("Only a configured administrator can send a test alert.");
      return;
    }
    const sample = formatAdminAlert("low", getStatus());
    await notifyAdmins(`[TEST ALERT - no action needed]

${sample}`);
    await ctx.reply(
      `Test alert sent to ${config.ADMIN_USER_IDS.length} admin(s). ` +
        "If you did not receive a DM, send /start to this bot in a private chat and try again.",
    );
    return;
  }

  if (arg === "reset") {
    if (config.ADMIN_USER_IDS.length === 0) {
      await ctx.reply(
        "No administrators are configured, so /budget reset is disabled. Set ADMIN_USER_IDS to enable it.",
      );
      return;
    }
    if (!isAdmin(ctx)) {
      await ctx.reply("Only a configured administrator can reset the budget.");
      return;
    }
    resetBudget();
    await ctx.reply("Anthropic spend counter reset to $0.00.");
    return;
  }

  await ctx.reply(formatStatus(getStatus()), { parse_mode: "HTML" });
});

bot.command("tr", async (ctx) => {
  const text = ctx.payload.trim();
  if (!text) {
    await ctx.reply("Usage: /tr <text to translate>");
    return;
  }
  await enqueue(ctx.chat.id, () => handleTranslation(ctx, text, ctx.message.message_id));
});

/* -------------------------------------------------------------------------- */
/* message pipeline                                                            */
/* -------------------------------------------------------------------------- */

bot.on(message("text"), async (ctx) => {
  if (!isAllowed(ctx)) return;

  const text = ctx.message.text.trim();
  // Commands are handled above; anything still starting with "/" is not for us.
  if (!text || text.startsWith("/")) return;
  if (!hasTranslatableContent(text)) return;

  const state = store.get(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

  if (isGroup) {
    if (state.groupMode === "command") return;
    if (state.groupMode === "mention" && !isDirectedAtBot(ctx, text)) {
      // Still worth remembering, so context stays continuous when it is our turn.
      store.remember(ctx.chat.id, { speaker: speakerName(ctx), text });
      return;
    }
  }

  await enqueue(ctx.chat.id, () => handleTranslation(ctx, text, ctx.message.message_id));
});

function isDirectedAtBot(ctx: Context, text: string): boolean {
  const username = ctx.botInfo?.username;
  if (username && text.includes(`@${username}`)) return true;

  const msg = ctx.message;
  if (msg && "reply_to_message" in msg && msg.reply_to_message) {
    return msg.reply_to_message.from?.id === ctx.botInfo?.id;
  }
  return false;
}

async function handleTranslation(
  ctx: Context,
  text: string,
  replyToMessageId: number,
): Promise<void> {
  const chatId = ctx.chat!.id;
  const state = store.get(chatId);
  const speaker = speakerName(ctx);

  const sourceHint = guessLanguage(text);
  // Without a confident guess, translate into everything except nothing and let
  // the engine report what it detected; we drop the echo below.
  const targets = sourceHint ? targetsFor(sourceHint, state.languages) : [...state.languages];

  if (targets.length === 0) {
    store.remember(chatId, { speaker, text });
    return;
  }

  let typing: NodeJS.Timeout | null = null;
  try {
    await ctx.sendChatAction("typing");
    // Telegram clears the indicator after ~5s; refresh it for slower engines.
    typing = setInterval(() => {
      void ctx.sendChatAction("typing").catch(() => undefined);
    }, 4500);

    const provider = getProvider(resolveEngine(state.engine));

    // Refuse before spending, not after. Google has its own billing and is not
    // covered by the Anthropic cap.
    if (provider.billsTo === "anthropic" && !canSpend()) {
      const status = getStatus();
      const alternative = availableEngines().includes("google")
        ? " You can switch this chat to Google Translate with /engine google."
        : "";
      await ctx.reply(
        `The $${status.limitUsd.toFixed(2)} Anthropic spend cap has been reached, so translations are paused.` +
          ` See /budget for details.${alternative}`,
        { reply_parameters: { message_id: replyToMessageId } },
      );
      return;
    }

    const result = await provider.translate({
      text,
      sourceHint,
      targets,
      context: provider.usesContext ? [...state.history] : [],
      speaker,
    });

    store.recordUsage(chatId, result.usage);
    store.remember(chatId, { speaker, text });

    const crossed =
      provider.billsTo === "anthropic" ? recordSpend(result.usage.costUsd) : null;

    // Admin DMs are independent of the in-chat percentage notice: they are
    // driven by dollars remaining, which is what an operator actually acts on.
    if (provider.billsTo === "anthropic") {
      const due = takeDueAdminAlerts();
      if (due.length > 0) {
        const status = getStatus();
        for (const alert of due) {
          void notifyAdmins(formatAdminAlert(alert, status));
        }
      }
    }

    const rendered = renderTranslations(result.sourceLang, result.translations, result.note);
    if (!rendered) return;

    await replyLong(ctx, rendered, replyToMessageId);

    if (crossed !== null) {
      const status = getStatus();
      await ctx
        .reply(
          `⚠️ Anthropic spend has passed ${crossed}% of the $${status.limitUsd.toFixed(2)} cap.` +
            ` $${status.remainingUsd.toFixed(2)} remaining. See /budget.`,
        )
        .catch(() => undefined);
    }
  } catch (err) {
    console.error("[translate] failed:", err);
    await ctx
      .reply(friendlyError(err), { reply_parameters: { message_id: replyToMessageId } })
      .catch(() => undefined);
  } finally {
    if (typing) clearInterval(typing);
  }
}

function renderTranslations(
  sourceLang: LangCode,
  translations: Partial<Record<LangCode, string>>,
  note: string | undefined,
): string | null {
  const blocks: string[] = [];

  for (const [code, value] of Object.entries(translations) as [LangCode, string][]) {
    // The engine detects the true source language; if it differs from our guess
    // we may have asked for a translation into the language it was already in.
    if (code === sourceLang || !value.trim()) continue;
    const info = LANGUAGES[code];
    blocks.push(`${info.flag} ${escapeHtml(value.trim())}`);
  }

  if (blocks.length === 0) return null;
  if (note) blocks.push(`<i>${escapeHtml(note)}</i>`);
  return blocks.join("\n\n");
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/rate.?limit|429/i.test(raw)) {
    return "The translation service is rate limited right now. Please try again in a moment.";
  }
  if (/authentication|api key|401/i.test(raw)) {
    return "The translation service rejected our credentials. An administrator needs to check the API key.";
  }
  if (/timeout|abort/i.test(raw)) {
    return "The translation timed out. Please try again.";
  }
  return "Sorry, I could not translate that message. Please try again.";
}
