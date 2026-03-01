import { Bot, InlineKeyboard } from "grammy";
import {
  searchMarkets,
  getTrendingMarkets,
  resolveUpDownMarketAndPrice,
} from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  // If you truly see this in Railway logs, bot should NOT be working.
  // If Telegram still responds, it means Railway is running a different deploy/build
  // or the env var name differs in that running version.
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --------------------
// Config (Stage 1 only)
// --------------------
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

// Basic “key presence” checks (not “connected”, just present in env)
const hasTelegramToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
const hasBankrKey = Boolean(process.env.BANKR_API_KEY);
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);

// --------------------
// Helpers
// --------------------
function yn(b) {
  return b ? "✅" : "❌";
}

function compactStatusText() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
  ].join("\n");
}

function detailedStatusText() {
  return [
    "📊 *Status (details)*",
    "",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    "",
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
    "",
    "*Keys present in Railway env (not “connected”)*",
    `Telegram: ${yn(hasTelegramToken)}  Bankr: ${yn(hasBankrKey)}`,
    `Anthropic: ${yn(hasAnthropicKey)}  OpenAI: ${yn(hasOpenAIKey)}  Gemini: ${yn(hasGeminiKey)}`,
    "",
    "_Data:_ Gamma + CLOB, public only.",
  ].join("\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------
// Commands
// --------------------
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "Try:",
      "• /status",
      "• /updownbtc5m",
      "• /updownbtc15m",
      "• /updowneth5m",
      "• /updowneth15m",
    ].join("\n")
  );
});

// /status with dropdown toggle
bot.command("status", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details ▾", "status:details");
  await ctx.reply(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
});

bot.callbackQuery("status:details", async (ctx) => {
  const kb = new InlineKeyboard().text("Hide details ▴", "status:compact");
  await ctx.editMessageText(detailedStatusText(), { parse_mode: "Markdown", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("status:compact", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details ▾", "status:details");
  await ctx.editMessageText(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// Optional: /markets (keep, but not required)
bot.command("markets", async (ctx) => {
  const arg = (ctx.match ?? "").trim();
  if (!arg) {
    await ctx.reply("Usage: /markets bitcoin");
    return;
  }

  await ctx.reply("🔎 Searching LIVE markets...");
  try {
    const results = await searchMarkets(arg, 8);
    if (!results.length) {
      await ctx.reply(`No markets found for: ${arg}`);
      return;
    }

    const msg = results
      .map((m, i) => {
        const p = m.priceMid != null ? `${Math.round(m.priceMid * 100)}¢` : "—";
        const vol = m.volume != null ? `$${Math.round(m.volume).toLocaleString()}` : "—";
        return `${i + 1}) ${m.title}\n   Price: ${p}  Vol: ${vol}`;
      })
      .join("\n\n");

    await ctx.reply(msg);
  } catch (e) {
    console.error("markets error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs.");
  }
});

// Up/Down commands: /updownbtc5m, /updowneth15m, etc.
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out?.found) {
      await ctx.reply(
        [
          `❌ Up/Down not found.`,
          `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
          out?.reason ? `Reason: ${out.reason}` : "",
        ].filter(Boolean).join("\n")
      );
      return;
    }

    const up = out.upMid != null ? `${Math.round(out.upMid * 100)}¢` : "—";
    const down = out.downMid != null ? `${Math.round(out.downMid * 100)}¢` : "—";

    await ctx.reply(
      [
        `📈 *${out.title}*`,
        `Slug: \`${out.slug}\``,
        "",
        `UP (mid): ${up}`,
        `DOWN (mid): ${down}`,
        "",
        `_Source: Gamma event-by-slug + CLOB midpoints_`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Start polling (WITH RETRY so Railway never “dies”)
// --------------------
async function startWithRetry() {
  while (true) {
    try {
      console.log("Bot running ✅ (polling)");
      await bot.start();
      // If bot.start() ever returns, restart loop after a pause
      console.warn("bot.start() returned unexpectedly, restarting...");
      await sleep(2000);
    } catch (err) {
      const msg = String(err?.description || err?.message || err);

      // This is the exact Telegram issue in your Railway logs
      const is409 =
        msg.includes("409") ||
        msg.toLowerCase().includes("terminated by other getUpdates request") ||
        msg.toLowerCase().includes("conflict");

      console.error("Bot polling crashed:", err);

      if (is409) {
        console.warn("409 conflict detected. Waiting 6s then retrying...");
        await sleep(6000);
        continue;
      }

      console.warn("Non-409 error. Waiting 6s then retrying...");
      await sleep(6000);
    }
  }
}

startWithRetry();
