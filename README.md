# Zion Translation Bot

A Telegram bot that translates between **English, Korean, and Spanish** in both directions, using the surrounding conversation so that short replies, dropped subjects, and honorifics come out right.

Send a message; the bot replies with it in the other two languages.

---

## Why context matters

Most translation bots translate one message at a time, in isolation. That fails constantly in real group chats:

| Someone writes | Isolated translation | This bot (with context) |
|---|---|---|
| "6 works" | "6 작동합니다" (nonsense) | "6시 괜찮아요" — understands it answers a question about time |
| "네, 갈게요" | "Yes, I will go" | "Yes, I'll be there" — knows it's an RSVP to the potluck |
| "¿Y el otro?" | "And the other?" | "And what about the other room?" — resolves the referent |

Korean drops subjects and objects almost everywhere, so context is not a nice-to-have — it's the difference between a usable bot and a confusing one. The bot keeps a rolling window of the last `CONTEXT_TURNS` messages per chat and shows them to the engine on every translation.

It also handles:

- **Korean speech levels** — 해요체 for conversation, 합쇼체 for announcements, 반말 only when the source is clearly casual. Titles like 목사님 and 집사님 are preserved.
- **Spanish tú vs. usted** — chosen from the relationship visible in the conversation.
- **Scripture references** — John 3:16 / 요한복음 3:16 / Juan 3:16, never translated as prose.
- **A glossary** ([glossary.json](glossary.json)) that pins ministry names and recurring terms so they never drift between renderings.
- **Prompt injection** — text in a message is treated as content to translate, never as instructions.

---

## Choosing an engine

Set `ENGINE` in `.env`, or switch per chat at runtime with `/engine`.

| Engine | `ENGINE=` | Cost / message | 1,000 messages | Context-aware |
|---|---|---|---|---|
| Claude Sonnet 5 | `sonnet` | ~$0.0012 | **~$1.20** | Yes |
| Claude Opus 5 | `opus` | ~$0.0031 | **~$3.10** | Yes |
| Google Translate | `google` | ~$0.005 | **~$4.80** | **No** |

*Claude figures are measured against this bot's actual prompt, not estimated: a 1,716-token cached system prompt, ~150 tokens of context, ~60 tokens out. Google's is arithmetic from its published rate.*

### How to think about token cost

**1 MTok = 1 million tokens ≈ 750,000 English words.** A typical chat message is 30–50 tokens. Korean and Spanish run roughly 1.5–2× denser per character than English.

A measured Sonnet 5 translation of a real Korean message breaks down as:

| | Tokens | Rate | Cost |
|---|---|---|---|
| System prompt (cached read) | 1,716 | $0.20/MTok | $0.00034 |
| Context + message | ~150 | $2.00/MTok | $0.00030 |
| Translations out | ~60 | $10.00/MTok | $0.00060 |
| **Total** | | | **~$0.0012** |

**The cache is what makes this cheap.** The 1,716-token system prompt is byte-identical on every request, so it bills at the cache-read rate — 10× cheaper than sending it fresh. `/usage` reports the hit rate per chat; if it is not well above zero, something is invalidating the prefix.

### Cache TTL matters more than you would think

A cache *write* costs far more than a read, so the question is whether the cache survives between messages:

| | Cost of that message |
|---|---|
| Cache hit (warm) | ~$0.0012 |
| Cache miss, 5m TTL write | ~$0.0053 |
| Cache miss, 1h TTL write | ~$0.0077 |

Church chat is **bursty** — an announcement, then a flurry of replies, then hours of silence. With the 5-minute default, nearly every burst starts by paying a fresh write. `ANTHROPIC_CACHE_TTL=1h` (the default here) costs more per write but survives the gaps, so a whole evening of conversation pays for one write instead of several.

Switch to `5m` only if the chat is busy continuously, or so sparse that even an hour lapses between messages.

**The counterintuitive part:** Google Translate is *not* the cheap option here. It bills $20 per million characters **per target language**, and you have two, so a message costs about the same as Opus while throwing away all conversation context. `sonnet` is the best default on both quality and price.

To trade cost for depth on the Claude engines, set `EFFORT` to `low` (default), `medium`, or `high`. `low` is right for everyday chat; raise it if you translate dense theological or legal wording.

---

## The spend cap

The bot ships with a **$10 monthly cap** on Claude spend:

```env
ANTHROPIC_MAX_COST_USD=10
ANTHROPIC_BUDGET_PERIOD=monthly   # or "total" for a lifetime cap
```

It totals the real token counts returned by every API call, and once spend reaches the cap it stops calling Claude and tells people translations are paused. The counter is persisted, so a restart does not hand you a fresh $10. Monthly budgets reset on the 1st (UTC) to match API billing.

Members get a heads-up in-chat at 50%, 80%, and 95%, so the bot does not go dark without warning. `/budget` shows where things stand:

```
Anthropic budget
[████░░░░░░] 42.5%
Spent: $4.2500 of $10.00
Remaining: $5.7500
Period: 2026-09
Resets: 2026-10-01
```

At $10/month the cap allows roughly **8,000 messages on Sonnet 5** or **3,200 on Opus 5**, assuming a warm cache.

If Google Translate is also configured, a chat can keep working past the cap with `/engine google`, which bills separately and is not covered by this limit.

### Admin alerts

Admins get a **direct message** when the budget runs low — by default when **$5 or less remains**:

```env
ANTHROPIC_ALERT_REMAINING_USD=5
ADMIN_USER_IDS=123456789
```

The DM tells you what is left, how many more translations that buys at the rate this deployment is actually running at, when the budget resets, and what your options are:

```
⚠️ Zion Translation Bot - Anthropic budget running low

Only $4.87 of the $10.00 cap remains (51.3% used).

Translations this period: 2,340
Roughly 2,210 more before the cap.
Period: 2026-09
Resets automatically: 2026-10-01

Options: raise ANTHROPIC_MAX_COST_USD and redeploy, run /budget reset,
or switch a chat to /engine google if it is configured.
```

A second DM goes out when the cap is actually reached and translations pause. Each fires **once per period**, so a busy Sunday will not flood your inbox.

> **Telegram will not let a bot message someone who has never messaged it first.** Every admin must send `/start` to the bot in a private chat once, or the alert silently fails when you most need it. Run **`/budget test`** to send yourself a sample alert and confirm delivery — do this when you first deploy, not when the budget is at 95%.

Find your numeric user ID by messaging [@userinfobot](https://t.me/userinfobot).

`/budget reset` clears the counter early, but only for a user listed in `ADMIN_USER_IDS`. With no admins configured the command is disabled outright.

> ### ⚠️ This is not a hard limit
>
> The cap is enforced **by this bot, from its own accounting** — the Anthropic API has no per-key spend limit the SDK can set. It therefore:
>
> - does **not** cover anything else using the same API key,
> - is an **estimate** from a local price table, which drifts if prices change,
> - can be bypassed if the state file is lost or the volume is not persisted.
>
> **Also set a real limit in the [Anthropic Console](https://console.anthropic.com) → Settings → Limits.** That one is enforced server-side and is what actually protects your card. Treat this bot's cap as the early-warning system, not the backstop.

---

## Quick start (local)

```bash
git clone <this repo> && cd ZionTelegramBot
npm install
cp .env.example .env
```

Fill in `.env`:

1. **Bot token** — message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. **API key** — get one at [console.anthropic.com](https://console.anthropic.com) and put it in `ANTHROPIC_API_KEY`.

Then:

```bash
npm run dev      # watch mode
# or
npm run build && npm start
```

The bot starts in polling mode, which needs no public URL. Message it directly, or add it to a group.

> **For group chats:** by default Telegram only shows bots messages that mention them. To let the bot translate everything, message @BotFather → `/setprivacy` → select your bot → **Disable**. Then remove and re-add the bot to the group for the change to take effect.

---

## Deployment

The same image works in both delivery modes. An HTTP server always binds `PORT` and serves `/health`, even in polling mode, so platform health checks pass either way.

### Docker (anywhere)

```bash
docker compose up -d --build
```

State (per-chat settings, context, usage counters) persists in the `bot-data` volume.

### Fly.io

```bash
fly launch --no-deploy          # uses the included fly.toml
fly volumes create bot_data --size 1
fly secrets set TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=...
fly deploy
```

### Railway / Render

Point the service at this repo — both detect the `Dockerfile` automatically. Set `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` as environment variables, and mount a persistent volume at `/app/data`. Leave `MODE=polling` for the simplest setup.

### Webhook mode

Cheaper at idle and scales to zero, but needs a public HTTPS origin:

```env
MODE=webhook
WEBHOOK_DOMAIN=https://your-app.fly.dev
WEBHOOK_SECRET=some-random-string
```

The bot registers the webhook with Telegram at startup. `WEBHOOK_SECRET` is echoed back by Telegram in a header and verified on every request — set it, or anyone who finds the URL can inject fake updates.

---

## Commands

| Command | What it does |
|---|---|
| `/tr <text>` | Translate one message explicitly |
| `/languages en,ko,es` | Set which languages this chat uses |
| `/engine [opus\|sonnet\|google]` | Show or switch the translation engine |
| `/mode all\|mention\|command` | When to translate in group chats |
| `/reset` | Forget the conversation context |
| `/usage` | Tokens, cache hit rate, and cost for this chat |
| `/budget` | Anthropic spend against the cap |
| `/budget reset` | Clear the spend counter (admins only) |
| `/budget test` | Send yourself a test alert DM (admins only) |
| `/status` | Current settings |
| `/help` | Usage help |

Settings are **per chat**, so your Korean-English small group and your trilingual announcements channel can be configured independently.

---

## Configuration

Every setting lives in [.env.example](.env.example) with inline notes. The ones worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `ENGINE` | `sonnet` | `opus`, `sonnet`, or `google` |
| `EFFORT` | `low` | Thinking depth for Claude engines |
| `ANTHROPIC_CACHE_TTL` | `1h` | `1h` or `5m`. See cache TTL above |
| `LANGUAGES` | `en,ko,es` | At least two |
| `CONTEXT_TURNS` | `6` | Messages of context. `0` disables context |
| `GROUP_MODE` | `all` | `all`, `mention`, or `command` |
| `ALLOWED_CHAT_IDS` | *(empty)* | Empty means anyone can use the bot |
| `MODE` | `polling` | `polling` or `webhook` |
| `ANTHROPIC_MAX_COST_USD` | `10` | Claude spend cap. `0` disables |
| `ANTHROPIC_BUDGET_PERIOD` | `monthly` | `monthly` or `total` |
| `ANTHROPIC_ALERT_REMAINING_USD` | `5` | DM admins at this much left. `0` disables |
| `ADMIN_USER_IDS` | *(empty)* | Who gets alerts and may run `/budget reset` |

### Controlling cost

- `CONTEXT_TURNS=3` roughly halves the context tokens per message.
- `GROUP_MODE=mention` translates only when asked, instead of every message.
- `ALLOWED_CHAT_IDS` prevents strangers from spending your API budget.
- `ANTHROPIC_MAX_COST_USD` is the backstop if all of the above are too generous.

---

## Customising the glossary

Edit [glossary.json](glossary.json) to pin terms that must translate the same way every time:

```json
[
  {
    "term": "Zion Church",
    "translations": { "en": "Zion Church", "ko": "시온교회", "es": "Iglesia Sion" }
  }
]
```

Add ministry names, recurring events, and the names of people who appear often. The glossary is embedded in the cached system prompt, so entries cost essentially nothing per message after the first. Restart the bot to pick up changes.

---

## Project layout

```
src/
  index.ts            entry point; polling/webhook switch and health server
  config.ts           environment parsing and validation
  bot.ts              commands, group rules, message pipeline
  store.ts            per-chat settings, context window, usage counters
  budget.ts           spend cap accounting, period rollover, admin alerts
  glossary.ts         glossary loading and prompt rendering
  languages.ts        language table and script-based detection
  providers/
    types.ts          the TranslationProvider interface
    claude.ts         Opus 5 / Sonnet 5, with context and structured output
    google.ts         Google Translate v2
    index.ts          engine factory
```

Adding a fourth language means adding one entry to `LANGUAGES` in `languages.ts` and one field to the output schema in `providers/claude.ts`. Adding a new engine means implementing `TranslationProvider` and registering it in `providers/index.ts`.
