import "dotenv/config";
import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { resolveUpDownEventBySlug, formatUpDownMessage } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ----------
// Flags/env (read-only display)
// ----------
const SIMULATION_ON = String(process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? process.env.SIM_START_CASH ?? "50");
const AI_ENABLED = String(process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

function hasKey(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

const KEYS = {
  telegram: hasKey("TELEGRAM_BOT_TOKEN"),
  bankr: hasKey("BANKR_API_KEY"),
  anthropic: hasKey("ANTHROPIC_API_KEY"),
  openai: hasKey("OPENAI_API_KEY"),
  gemini: hasKey("GEMINI_API_KEY") || hasKey("GOOGLE_API_KEY"),
};

function yn(v) {
  return v ? "✅" : "❌";
}

// ----------
// Status UI (compact + dropdown)
// ----------
function statusCompact() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    "",
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
    "",
    "_Data: Polymarket (public)_",
    "_Trading: OFF (data only)_",
  ].join("\n");
}

function statusDetails() {
  const keysLine = [
    `Telegram: ${yn(KEYS.telegram)}`,
    `Bankr: ${yn(KEYS.bankr)}`,
    `Anthropic: ${yn(KEYS.anthropic)}`,
    `OpenAI: ${yn(KEYS.openai)}`,
    `Gemini: ${yn(KEYS.gemini)}`,
  ].join(" | ");

  return [
    "📊 *Status (details)*",
    "",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    "",
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
    "",
    "*Keys present in Railway env* (presence only)",
    keysLine,
    "",
    "_Data: Polymarket Gamma + CLOB (public)_",
    "_Trading: OFF (data only)_",
  ].join("\n");
}

function statusKb(expanded) {
  return expanded
    ? new InlineKeyboard().text("Hide details ▴", "status:less")
    : new InlineKeyboard().text("Show details ▾", "status:more");
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "Up/Down commands (NO SPACES):",
      "• /updownbtc5m   • /updownbtc15m",
      "• /updowneth5m   • /updowneth15m",
      "• /updownsol5m   • /updownsol15m",
      "• /updownxrp5m   • /updownxrp15m",
      "",
      "Other:",
      "• /ping",
      "• /status",
      "",
      "Note: 60m/hourly is disabled for now (we’ll add later).",
    ].join("\n")
  );
});

bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  await ctx.reply(statusCompact(), {
    parse_mode: "Markdown",
    reply_markup: statusKb(false),
  });
});

bot.callbackQuery("status:more", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusDetails(), {
    parse_mode: "Markdown",
    reply_markup: statusKb(true),
  });
});

bot.callbackQuery("status:less", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusCompact(), {
    parse_mode: "Markdown",
    reply_markup: statusKb(false),
  });
});

// ----------
// Up/Down — LAST KNOWN-GOOD BEHAVIOR
// Gamma event-by-slug + CLOB midpoints
// ONLY 5m / 15m for now
// ----------
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const [, assetRaw, intervalRaw] = ctx.match;
  const asset = String(assetRaw).toLowerCase();
  const interval = String(intervalRaw).toLowerCase();

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const res = await resolveUpDownEventBySlug({ asset, interval });

    if (!res.found) {
      await ctx.reply(
        [
          `❌ Up/Down market not found yet.`,
          `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
          `Tried slugs: ${res.triedSlugs.join(", ")}`,
          res.lastError ? `Last error: ${res.lastError}` : null,
          "",
          "Tip: if you run this exactly on the boundary, try again in ~10 seconds.",
        ]
          .filter(Boolean)
          .join("\n")
      );
      return;
    }

    await ctx.reply(formatUpDownMessage(res), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("updown error:", e);
    const msg = String(e?.message || e || "unknown error");
    await ctx.reply(["⚠️ Up/Down failed. Check Railway logs.", `Error: ${msg}`].join("\n"));
  }
});

// Hint if user types spaces like "/updown btc 5m"
bot.on("message:text", async (ctx) => {
  const t = (ctx.message?.text || "").trim();
  if (/^\/updown\s+/i.test(t)) {
    await ctx.reply(
      "Use no-space commands like:\n/updownbtc5m\n/updownbtc15m\n/updowneth5m\n/updownsol15m"
    );
  }
});

// ----------
// Error handler
// ----------
bot.catch((err) => {
  const e = err.error;
  console.error("bot.catch =>", err);

  if (e instanceof GrammyError) console.error("GrammyError =>", e.description);
  else if (e instanceof HttpError) console.error("HttpError =>", e.error);
  else console.error("Unknown error =>", e);
});

console.log("Bot running ✅ (polling)");
bot.start();
