import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import {
  searchMarkets,
  getTrendingMarkets,
  resolveUpDownMarketAndPrice,
} from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --------------------
// Config (Stage 1 only)
// --------------------
const SIMULATION_ON = String(process.env.SIMULATION || "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH || "50");
const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL || "unset";

// Basic “key presence” checks (not “connected”, just present in env)
function hasEnv(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

const hasTelegramToken = hasEnv("TELEGRAM_BOT_TOKEN");
const hasBankrKey = hasEnv("BANKR_API_KEY");
const hasAnthropicKey = hasEnv("ANTHROPIC_API_KEY");
const hasOpenAIKey = hasEnv("OPENAI_API_KEY");
const hasGeminiKey = hasEnv("GEMINI_API_KEY") || hasEnv("GOOGLE_API_KEY");

// --------------------
// Helpers
// --------------------
function yn(b) {
  return b ? "✅" : "❌";
}

function compactStatusText() {
  return [
    "📊 *Status*",
    "Simulation: " + (SIMULATION_ON ? "✅ ON" : "❌ OFF"),
    "Sim cash: $" + (Number.isFinite(SIM_CASH) ? SIM_CASH : 0),
    "AI: " + (AI_ENABLED ? "✅ ON" : "❌ OFF"),
    "AI model: `" + AI_MODEL + "`",
  ].join("\n");
}

function detailedStatusText() {
  return [
    "📊 *Status (details)*",
    "",
    "Simulation: " + (SIMULATION_ON ? "✅ ON" : "❌ OFF"),
    "Sim cash: $" + (Number.isFinite(SIM_CASH) ? SIM_CASH : 0),
    "",
    "AI: " + (AI_ENABLED ? "✅ ON" : "❌ OFF"),
    "AI model: `" + AI_MODEL + "`",
    "",
    "*Keys present in Railway env (presence only)*",
    "Telegram: " + yn(hasTelegramToken) + "  Bankr: " + yn(hasBankrKey),
    "Anthropic: " + yn(hasAnthropicKey) + "  OpenAI: " + yn(hasOpenAIKey) + "  Gemini: " + yn(hasGeminiKey),
    "",
    "_Data:_ Gamma (discovery) + CLOB (prices), public endpoints only.",
    "_Trading:_ OFF (data-only)",
  ].join("\n");
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
      "• /marketsbtc",
      "• /marketscrypto",
      "• /marketstrending",
      "• /updownbtc5m",
      "• /updowneth15m",
      "• /updownsol5m",
      "• /updownxrp15m",
      "",
      "Note: 60m/hourly is disabled for now.",
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

// /markets <query> (space version)
bot.command("markets", async (ctx) => {
  const arg = String(ctx.match || "").trim();
  if (!arg) {
    await ctx.reply("Usage: /markets bitcoin  (or try /marketsbtc /marketscrypto /marketstrending)");
    return;
  }

  await ctx.reply("🔎 Searching LIVE markets (Gamma public-search)...");
  try {
    const results = await searchMarkets(arg, 8);
    if (!results.length) {
      await ctx.reply("No markets found for: " + arg);
      return;
    }

    const msg = results
      .map((m, i) => {
        const p = m.priceMid != null ? String(Math.round(m.priceMid * 100)) + "¢" : "—";
        const vol = m.volume != null ? "$" + Math.round(m.volume).toLocaleString() : "—";
        return String(i + 1) + ") " + m.title + "\n   Price: " + p + "  Vol: " + vol;
      })
      .join("\n\n");

    await ctx.reply(msg);
  } catch (e) {
    console.error("markets error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs for the error.");
  }
});

// No-space markets shortcuts: /marketsbtc, /marketseth, /marketscrypto, /marketstrending
bot.hears(/^\/markets([a-z0-9_-]+)$/i, async (ctx) => {
  const query = String(ctx.match && ctx.match[1] ? ctx.match[1] : "").trim().toLowerCase();
  if (!query) return;

  if (query === "trending") {
    await ctx.reply("🔥 Fetching trending ACTIVE markets (Gamma events active=true)...");
    try {
      const results = await getTrendingMarkets(8);
      const msg = results.map((m, i) => String(i + 1) + ") " + m.title).join("\n");
      await ctx.reply(msg || "No trending markets returned.");
    } catch (e) {
      console.error("trending error:", e);
      await ctx.reply("⚠️ trending failed. Check Railway logs.");
    }
    return;
  }

  await ctx.reply("🔎 Searching LIVE markets (Gamma public-search)...");
  try {
    const results = await searchMarkets(query, 8);
    if (!results.length) {
      await ctx.reply("No markets found for: " + query);
      return;
    }

    const msg = results
      .map((m, i) => {
        const p = m.priceMid != null ? String(Math.round(m.priceMid * 100)) + "¢" : "—";
        const vol = m.volume != null ? "$" + Math.round(m.volume).toLocaleString() : "—";
        return String(i + 1) + ") " + m.title + "\n   Price: " + p + "  Vol: " + vol;
      })
      .join("\n\n");

    await ctx.reply(msg);
  } catch (e) {
    console.error("markets shortcut error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs for the error.");
  }
});

// Up/Down no-space commands: /updownbtc5m, /updowneth15m, /updownsol5m, /updownxrp15m
// IMPORTANT: 60m is removed for now.
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match && ctx.match[1] ? ctx.match[1] : "").toLowerCase();
  const interval = String(ctx.match && ctx.match[2] ? ctx.match[2] : "").toLowerCase();

  await ctx.reply("🔎 Finding LIVE " + asset.toUpperCase() + " Up/Down " + interval + "...");

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out.found) {
      const lines = [
        "❌ Up/Down not found.",
        "Asset: " + asset.toUpperCase() + " | Interval: " + interval,
      ];

      if (out.debug && Array.isArray(out.debug.queries) && out.debug.queries.length) {
        lines.push("", "Tried search queries:");
        out.debug.queries.forEach((q) => lines.push("- " + q));
      }

      if (out.debug && Array.isArray(out.debug.topTitles) && out.debug.topTitles.length) {
        lines.push("", "Top matches Gamma returned (for tuning):");
        out.debug.topTitles.slice(0, 6).forEach((t) => lines.push("- " + t));
      }

      await ctx.reply(lines.join("\n"));
      return;
    }

    const up = out.upMid != null ? String(Math.round(out.upMid * 100)) + "¢" : "—";
    const down = out.downMid != null ? String(Math.round(out.downMid * 100)) + "¢" : "—";

    await ctx.reply(
      [
        "📈 *" + out.title + "*",
        out.slug ? ("Slug: `" + out.slug + "`") : null,
        "",
        "UP (mid): " + up,
        "DOWN (mid): " + down,
        "",
        "_Source: Gamma discovery + CLOB midpoints_",
      ].filter(Boolean).join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

// -------------
// Start polling
// -------------
console.log("Bot running ✅ (polling)");
bot.start();
