import "dotenv/config";
import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { resolveUpDownViaGammaSearch, formatUpDownMessage } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ----------
// Flags/env
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
// Status UI
// ----------
function statusCompact() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
    "",
    "_Data: Polymarket (public reads)_",
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
    "*Keys present in Railway env* (presence only)*",
    keysLine,
    "",
    "Trading: *OFF* (data-only)",
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
      "Up/Down (no spaces):",
      "• /updownbtc5m  • /updownbtc15m",
      "• /updowneth5m  • /updowneth15m",
      "• /updownsol5m  • /updownsol15m",
      "• /updownxrp5m  • /updownxrp15m",
      "",
      "Other:",
      "• /ping",
      "• /status",
      "",
      "Note: 60m/hourly is disabled for now (we’ll add it later).",
    ].join("\n")
  );
});

bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.command("status", async (ctx) => {
  await ctx.reply(statusCompact(), { parse_mode: "Markdown", reply_markup: statusKb(false) });
});
bot.callbackQuery("status:more", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusDetails(), { parse_mode: "Markdown", reply_markup: statusKb(true) });
});
bot.callbackQuery("status:less", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusCompact(), { parse_mode: "Markdown", reply_markup: statusKb(false) });
});

// ----------
// Up/Down (no-space) — 5m/15m only
// ----------
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const [, assetRaw, intervalRaw] = ctx.match;
  const asset = String(assetRaw).toLowerCase();
  const interval = String(intervalRaw).toLowerCase();

  await ctx.reply(`🔎 Finding LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const res = await resolveUpDownViaGammaSearch({ asset, interval });

    if (!res.found) {
      const lines = [
        `❌ Up/Down not found.`,
        `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
        `Reason: ${res.reason || "No match discovered via Gamma search."}`,
      ];

      if (res.debug?.queries?.length) {
        lines.push("", "Tried queries:");
        for (const q of res.debug.queries) lines.push(`- ${q}`);
      }

      if (res.debug?.topTitles?.length) {
        lines.push("", "Top matches returned (for tuning):");
        for (const t of res.debug.topTitles.slice(0, 8)) lines.push(`- ${t}`);
      }

      await ctx.reply(lines.join("\n"));
      return;
    }

    await ctx.reply(formatUpDownMessage(res), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("updown error:", e);
    const msg = String(e?.message || e || "unknown error");
    await ctx.reply(["⚠️ Up/Down failed.", `Error: ${msg.slice(0, 220)}`].join("\n"));
  }
});

bot.on("message:text", async (ctx) => {
  const t = (ctx.message?.text || "").trim();
  if (/^\/updown\s+/i.test(t)) {
    await ctx.reply("Use no-space commands like /updownbtc5m or /updowneth15m");
  }
});

bot.catch((err) => {
  const e = err.error;
  console.error("bot.catch =>", err);
  if (e instanceof GrammyError) console.error("GrammyError =>", e.description);
  else if (e instanceof HttpError) console.error("HttpError =>", e.error);
  else console.error("Unknown error =>", e);
});

console.log("Bot running ✅ (polling)");
bot.start();
