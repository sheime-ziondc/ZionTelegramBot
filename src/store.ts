import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, type Engine } from "./config.js";
import type { LangCode } from "./languages.js";
import type { ContextMessage, UsageRecord } from "./providers/types.js";

export interface UsageTotals {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  characters: number;
  costUsd: number;
}

export interface ChatState {
  languages: LangCode[];
  engine: Engine;
  groupMode: "all" | "mention" | "command";
  /** Oldest-first rolling window of recent messages, used as translation context. */
  history: ContextMessage[];
  usage: UsageTotals;
}

/**
 * Deployment-wide spend accounting, kept outside `chats` so the budget cannot be
 * reset by a chat being removed, and so one chat cannot see another's activity.
 */
export interface GlobalState {
  /** Estimated Anthropic spend in USD for the current budget period. */
  anthropicSpendUsd: number;
  /** Identifies the period the figure above belongs to, e.g. "2026-09". */
  periodKey: string;
  /** Number of Claude translations this period, used to project runway. */
  anthropicMessages: number;
  /** Percentage thresholds already announced this period, so each fires once. */
  warnedThresholds: number[];
  /** Admin alerts already sent this period, so each fires once. */
  adminAlertsSent: string[];
}

interface PersistedState {
  version: 1;
  chats: Record<string, ChatState>;
  global?: GlobalState;
}

const emptyUsage = (): UsageTotals => ({
  messages: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  characters: 0,
  costUsd: 0,
});

function defaultChatState(): ChatState {
  return {
    languages: [...config.LANGUAGES],
    engine: config.ENGINE,
    groupMode: config.GROUP_MODE,
    history: [],
    usage: emptyUsage(),
  };
}

function defaultGlobalState(): GlobalState {
  return {
    anthropicSpendUsd: 0,
    anthropicMessages: 0,
    periodKey: "",
    warnedThresholds: [],
    adminAlertsSent: [],
  };
}

class Store {
  private chats = new Map<string, ChatState>();
  private globalState: GlobalState = defaultGlobalState();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  global(): GlobalState {
    return this.globalState;
  }

  updateGlobal(mutate: (state: GlobalState) => void): GlobalState {
    mutate(this.globalState);
    this.scheduleFlush();
    return this.globalState;
  }

  get(chatId: number | string): ChatState {
    const key = String(chatId);
    let state = this.chats.get(key);
    if (!state) {
      state = defaultChatState();
      this.chats.set(key, state);
    }
    return state;
  }

  update(chatId: number | string, mutate: (state: ChatState) => void): ChatState {
    const state = this.get(chatId);
    mutate(state);
    this.scheduleFlush();
    return state;
  }

  /**
   * Appends to the chat's rolling context window. Stored regardless of engine so
   * that switching from Google to Claude mid-conversation still has history to
   * work with. Long messages are clipped: context only needs the gist.
   */
  remember(chatId: number | string, message: ContextMessage): void {
    this.update(chatId, (state) => {
      state.history.push({
        speaker: message.speaker,
        text: message.text.length > 500 ? `${message.text.slice(0, 500)}...` : message.text,
      });
      const limit = Math.max(config.CONTEXT_TURNS, 1);
      if (state.history.length > limit) {
        state.history.splice(0, state.history.length - limit);
      }
    });
  }

  recordUsage(chatId: number | string, usage: UsageRecord): void {
    this.update(chatId, (state) => {
      const totals = state.usage;
      totals.messages += 1;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheReadTokens += usage.cacheReadTokens;
      totals.cacheWriteTokens += usage.cacheWriteTokens;
      totals.characters += usage.characters;
      totals.costUsd += usage.costUsd;
    });
  }

  clearHistory(chatId: number | string): void {
    this.update(chatId, (state) => {
      state.history = [];
    });
  }

  private load(): void {
    try {
      const raw = readFileSync(config.STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const [key, value] of Object.entries(parsed.chats ?? {})) {
        this.chats.set(key, { ...defaultChatState(), ...value });
      }
      if (parsed.global) {
        this.globalState = { ...defaultGlobalState(), ...parsed.global };
      }
      console.log(`[store] loaded ${this.chats.size} chat(s) from ${config.STATE_FILE}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(`[store] could not read ${config.STATE_FILE}, starting fresh:`, err);
      }
    }
  }

  /**
   * Coalesces the many small writes a busy group chat produces into one write
   * per second, so a single message never costs several disk round-trips.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 1000);
    this.flushTimer.unref();
  }

  flush(): void {
    const payload: PersistedState = {
      version: 1,
      chats: Object.fromEntries(this.chats),
      global: this.globalState,
    };
    try {
      mkdirSync(dirname(config.STATE_FILE), { recursive: true });
      // Write-then-rename so a crash mid-write cannot truncate the state file.
      const temp = `${config.STATE_FILE}.tmp`;
      writeFileSync(temp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(temp, config.STATE_FILE);
    } catch (err) {
      console.error("[store] failed to persist state:", err);
    }
  }
}

export const store = new Store();
