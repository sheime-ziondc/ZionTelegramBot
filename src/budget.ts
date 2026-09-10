import { config } from "./config.js";
import { store } from "./store.js";

/** Percentages at which the bot announces that spend is getting close. */
const WARN_THRESHOLDS = [50, 80, 95] as const;

export interface BudgetStatus {
  /** False when ANTHROPIC_MAX_COST_USD is 0, i.e. the guard is off. */
  enabled: boolean;
  limitUsd: number;
  spentUsd: number;
  remainingUsd: number;
  percentUsed: number;
  /** True once spend has reached the limit; Claude calls are refused. */
  exhausted: boolean;
  periodLabel: string;
  /** When the budget next resets on its own, or null for a lifetime cap. */
  resetsAt: Date | null;
  /** Claude translations made this period. */
  messages: number;
  /**
   * Rough number of further translations the remaining budget affords, based on
   * this period's own average cost. Null until there is data to average.
   */
  estimatedMessagesLeft: number | null;
}

/**
 * Identifies the current budget period. Monthly budgets use a UTC year-month so
 * that the rollover is unambiguous regardless of where the bot is deployed.
 */
function currentPeriodKey(now: Date): string {
  if (config.ANTHROPIC_BUDGET_PERIOD === "total") return "total";
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function nextResetDate(now: Date): Date | null {
  if (config.ANTHROPIC_BUDGET_PERIOD === "total") return null;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Rolls the counter over when the period changes. Called before every read and
 * write so a long-running process picks up the month boundary without a restart.
 */
function syncPeriod(now: Date): void {
  const key = currentPeriodKey(now);
  const state = store.global();
  if (state.periodKey === key) return;

  const previous = state.periodKey;
  store.updateGlobal((s) => {
    s.periodKey = key;
    s.anthropicSpendUsd = 0;
    s.anthropicMessages = 0;
    s.warnedThresholds = [];
    s.adminAlertsSent = [];
  });
  if (previous) {
    console.log(`[budget] period rolled over from ${previous} to ${key}; spend reset to $0`);
  }
}

export function getStatus(now: Date = new Date()): BudgetStatus {
  syncPeriod(now);
  const state = store.global();
  const spentUsd = state.anthropicSpendUsd;
  const messages = state.anthropicMessages;
  const limitUsd = config.ANTHROPIC_MAX_COST_USD;
  const enabled = limitUsd > 0;
  const remainingUsd = enabled ? Math.max(limitUsd - spentUsd, 0) : Infinity;

  // Project runway from this deployment's own observed cost per message, which
  // is more honest than a hardcoded estimate: it reflects the actual engine,
  // message lengths and cache hit rate in use.
  const averageCost = messages > 0 ? spentUsd / messages : 0;
  const estimatedMessagesLeft =
    enabled && averageCost > 0 ? Math.floor(remainingUsd / averageCost) : null;

  return {
    messages,
    estimatedMessagesLeft,
    enabled,
    limitUsd,
    spentUsd,
    remainingUsd,
    percentUsed: enabled ? (spentUsd / limitUsd) * 100 : 0,
    exhausted: enabled && spentUsd >= limitUsd,
    periodLabel:
      config.ANTHROPIC_BUDGET_PERIOD === "total" ? "all time" : state.periodKey,
    resetsAt: nextResetDate(now),
  };
}

/** True when another Claude call is allowed to be made. */
export function canSpend(): boolean {
  return !getStatus().exhausted;
}

/**
 * Adds an actual call's cost to the period total. Returns any warning threshold
 * newly crossed, so the caller can announce it once.
 */
export function recordSpend(costUsd: number): number | null {
  if (costUsd <= 0) return null;
  syncPeriod(new Date());

  const limitUsd = config.ANTHROPIC_MAX_COST_USD;
  let crossed: number | null = null;

  store.updateGlobal((s) => {
    s.anthropicSpendUsd += costUsd;
    s.anthropicMessages += 1;
    if (limitUsd <= 0) return;

    const percent = (s.anthropicSpendUsd / limitUsd) * 100;
    for (const threshold of WARN_THRESHOLDS) {
      if (percent >= threshold && !s.warnedThresholds.includes(threshold)) {
        s.warnedThresholds.push(threshold);
        crossed = threshold;
      }
    }
  });

  if (crossed !== null) {
    const status = getStatus();
    console.warn(
      `[budget] Anthropic spend has passed ${crossed}% of the $${limitUsd.toFixed(2)} cap ` +
        `($${status.spentUsd.toFixed(4)} used, $${status.remainingUsd.toFixed(4)} left)`,
    );
  }
  return crossed;
}

/** Alerts sent directly to admins, at most once each per budget period. */
export type AdminAlert = "low" | "exhausted";

/**
 * Returns the admin alerts that have just become due and marks them as sent, so
 * a caller can deliver each exactly once per period. Call after recordSpend.
 */
export function takeDueAdminAlerts(): AdminAlert[] {
  const status = getStatus();
  if (!status.enabled) return [];

  const threshold = config.ANTHROPIC_ALERT_REMAINING_USD;
  const due: AdminAlert[] = [];

  if (status.exhausted) {
    due.push("exhausted");
  } else if (threshold > 0 && status.remainingUsd <= threshold) {
    due.push("low");
  }

  const fresh = due.filter((a) => !store.global().adminAlertsSent.includes(a));
  if (fresh.length === 0) return [];

  store.updateGlobal((s) => {
    for (const alert of fresh) {
      if (!s.adminAlertsSent.includes(alert)) s.adminAlertsSent.push(alert);
    }
    // Reaching the cap supersedes the low warning; never send it afterwards.
    if (fresh.includes("exhausted") && !s.adminAlertsSent.includes("low")) {
      s.adminAlertsSent.push("low");
    }
  });
  return fresh;
}

/** The DM an admin receives. Plain text, no HTML parse mode needed. */
export function formatAdminAlert(alert: AdminAlert, status: BudgetStatus): string {
  const lines: string[] = [];

  if (alert === "exhausted") {
    lines.push(
      "🛑 Zion Translation Bot - Anthropic budget exhausted",
      "",
      `The $${status.limitUsd.toFixed(2)} cap has been reached. Claude translations are now paused.`,
    );
  } else {
    lines.push(
      "⚠️ Zion Translation Bot - Anthropic budget running low",
      "",
      `Only $${status.remainingUsd.toFixed(2)} of the $${status.limitUsd.toFixed(2)} cap remains ` +
        `(${status.percentUsed.toFixed(1)}% used).`,
    );
  }

  lines.push("", `Translations this period: ${status.messages}`);
  if (alert === "low" && status.estimatedMessagesLeft !== null && status.estimatedMessagesLeft >= 1) {
    lines.push(`Roughly ${status.estimatedMessagesLeft.toLocaleString()} more before the cap.`);
  }
  lines.push(`Period: ${status.periodLabel}`);
  if (status.resetsAt) {
    lines.push(`Resets automatically: ${status.resetsAt.toISOString().slice(0, 10)}`);
  }

  lines.push(
    "",
    "Options: raise ANTHROPIC_MAX_COST_USD and redeploy, run /budget reset, " +
      "or switch a chat to /engine google if it is configured.",
  );
  return lines.join("\n");
}

export function resetBudget(): void {
  store.updateGlobal((s) => {
    s.anthropicSpendUsd = 0;
    s.anthropicMessages = 0;
    s.warnedThresholds = [];
    s.adminAlertsSent = [];
  });
  console.log("[budget] spend counter manually reset to $0");
}

export function formatStatus(status: BudgetStatus): string {
  if (!status.enabled) {
    return [
      "<b>Anthropic budget</b>",
      "No spend cap is set on this deployment (ANTHROPIC_MAX_COST_USD=0).",
      `Spent so far: $${status.spentUsd.toFixed(4)}`,
    ].join("\n");
  }

  const bar = renderBar(status.percentUsed);
  const lines = [
    "<b>Anthropic budget</b>",
    `${bar} ${status.percentUsed.toFixed(1)}%`,
    `Spent: $${status.spentUsd.toFixed(4)} of $${status.limitUsd.toFixed(2)}`,
    `Remaining: $${status.remainingUsd.toFixed(4)}`,
    `Period: ${status.periodLabel}`,
    `Translations: ${status.messages}`,
  ];

  if (status.estimatedMessagesLeft !== null && status.estimatedMessagesLeft >= 1 && !status.exhausted) {
    lines.push(`Roughly ${status.estimatedMessagesLeft.toLocaleString()} messages left at the current rate`);
  }

  if (status.resetsAt) {
    lines.push(`Resets: ${status.resetsAt.toISOString().slice(0, 10)}`);
  }
  if (status.exhausted) {
    lines.push("", "⚠️ The cap has been reached. Claude translations are paused.");
  }
  lines.push(
    "",
    "<i>This is the bot's own estimate. Your authoritative spend and hard limit live in the Anthropic Console.</i>",
  );
  return lines.join("\n");
}

function renderBar(percent: number, width = 10): string {
  const filled = Math.min(Math.round((percent / 100) * width), width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
