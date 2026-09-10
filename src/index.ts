import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { bot } from "./bot.js";
import { availableEngines, getProvider } from "./providers/index.js";
import { store } from "./store.js";
import { getStatus } from "./budget.js";

/**
 * The state file holds the spend counter. If it silently fails to persist, the
 * budget cap resets on every restart and stops protecting anything - so prove
 * the directory is writable at startup and say so loudly if it is not.
 *
 * The usual cause is a mounted volume owned by root while the container runs as
 * an unprivileged user, which is the default on several hosts.
 */
function verifyStateWritable(): void {
  const dir = dirname(config.STATE_FILE);
  const probe = join(dir, ".write-probe");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
    console.log(`[store] state directory is writable: ${dir}`);
  } catch (err) {
    console.error("");
    console.error("=".repeat(72));
    console.error(`[store] CANNOT WRITE TO ${dir}`);
    console.error(`[store] ${err instanceof Error ? err.message : String(err)}`);
    console.error("");
    console.error("The bot will still translate, but nothing will persist:");
    console.error("  - the Anthropic spend cap resets to $0 on every restart");
    console.error("  - per-chat settings and conversation context are lost");
    console.error("");
    console.error("Fix: mount a writable volume at this path, or set STATE_FILE");
    console.error("to somewhere the container user can write.");
    console.error("=".repeat(72));
    console.error("");
  }
}

async function registerCommands(): Promise<void> {
  await bot.telegram.setMyCommands([
    { command: "tr", description: "Translate a message explicitly" },
    { command: "languages", description: "Set the languages for this chat" },
    { command: "engine", description: "Show or switch the translation engine" },
    { command: "mode", description: "When to translate in group chats" },
    { command: "reset", description: "Forget the conversation context" },
    { command: "usage", description: "Tokens and cost for this chat" },
    { command: "budget", description: "Anthropic spend against the cap" },
    { command: "status", description: "Show current settings" },
    { command: "help", description: "How to use this bot" },
  ]);
}

type WebhookHandler = (
  req: Parameters<Awaited<ReturnType<typeof bot.createWebhook>>>[0],
  res: Parameters<Awaited<ReturnType<typeof bot.createWebhook>>>[1],
) => Promise<void>;

/**
 * The HTTP server runs in BOTH modes. In webhook mode it receives updates; in
 * polling mode it exists purely so platform health checks and port scans
 * (Fly, Render, Cloud Run, Railway) see a live listener. Without this, a
 * polling deployment gets killed as unhealthy.
 */
async function startServer(webhook: WebhookHandler | null): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }
    if (webhook) {
      void webhook(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(config.PORT, resolve));
  return server;
}

async function startPolling(): Promise<Server> {
  // launch() only resolves when the bot stops, so it is intentionally not awaited.
  void bot.launch({ dropPendingUpdates: true }, () => {
    console.log(`[bot] @${bot.botInfo?.username} is running in polling mode`);
  });
  const server = await startServer(null);
  console.log(`[bot] health endpoint listening on port ${config.PORT}`);
  return server;
}

async function startWebhook(): Promise<Server> {
  const path = config.WEBHOOK_PATH.startsWith("/")
    ? config.WEBHOOK_PATH
    : `/${config.WEBHOOK_PATH}`;

  const callback = await bot.createWebhook({
    domain: config.WEBHOOK_DOMAIN!,
    path,
    drop_pending_updates: true,
    ...(config.WEBHOOK_SECRET ? { secret_token: config.WEBHOOK_SECRET } : {}),
  });

  const server = await startServer(callback);
  console.log(
    `[bot] @${bot.botInfo?.username} is running in webhook mode on port ${config.PORT}`,
  );
  console.log(`[bot] webhook registered at ${config.WEBHOOK_DOMAIN}${path}`);
  return server;
}

async function main(): Promise<void> {
  const provider = getProvider(config.ENGINE);

  console.log("[bot] starting Zion Translation Bot");
  verifyStateWritable();
  console.log(`[bot] engine: ${provider.label} (effort: ${config.EFFORT})`);
  console.log(`[bot] engines available: ${availableEngines().join(", ") || "none"}`);
  console.log(`[bot] languages: ${config.LANGUAGES.join(", ")}`);
  console.log(`[bot] context window: ${config.CONTEXT_TURNS} messages`);

  const budget = getStatus();
  if (budget.enabled) {
    console.log(
      `[bot] Anthropic cap: $${budget.limitUsd.toFixed(2)} ${config.ANTHROPIC_BUDGET_PERIOD}` +
        ` ($${budget.spentUsd.toFixed(4)} used, $${budget.remainingUsd.toFixed(4)} left)`,
    );
    if (budget.exhausted) {
      console.warn("[bot] the spend cap is already reached; Claude translations are paused");
    }
    if (config.ADMIN_USER_IDS.length > 0) {
      console.log(
        `[bot] budget alerts go to ${config.ADMIN_USER_IDS.length} admin(s) ` +
          `when under $${config.ANTHROPIC_ALERT_REMAINING_USD.toFixed(2)} remains ` +
          "(each admin must /start the bot once to receive DMs)",
      );
    } else {
      console.warn(
        "[bot] ADMIN_USER_IDS is empty - nobody will be alerted when the budget runs low",
      );
    }
  } else {
    console.warn("[bot] no Anthropic spend cap is set (ANTHROPIC_MAX_COST_USD=0)");
  }

  await bot.telegram.getMe().then((me) => {
    bot.botInfo = me;
  });
  await registerCommands();

  const server =
    config.MODE === "webhook" ? await startWebhook() : await startPolling();

  const shutdown = (signal: string) => {
    console.log(`[bot] ${signal} received, shutting down`);
    bot.stop(signal);
    server.close();
    // Persist immediately rather than waiting on the debounce timer.
    store.flush();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[bot] fatal startup error:", err);
  process.exit(1);
});
