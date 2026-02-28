import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDownViaSlug } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Env flags (simple)
const SIMULATION_ON = String(process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = String(process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = String(process.env.AI_MODEL ?? "unset");

function compactStatusText() {
  return [
    "Status",
    "",
    "Simulation: " + (SIMULATION_ON ? "ON" : "OFF"),
    "Sim cash: $" + (Number.isFinite(SIM_CASH) ? SIM_CASH : 0),
    "AI: " + (AI_ENABLED ? "ON" : "OFF"),
    "AI model: " + AI_MODEL,
  ].join("\n");
}

function detailedStatusText() {
  const keys = [
    ["Telegram", !!process.env.TELEGRAM_BOT_TOKEN],
    ["Bankr", !!process.env.BANKR_API_KEY],
    ["Anthropic", !!process.env.ANTHROPIC_API_KEY],
    ["OpenAI", !!process.env.OPENAI_API_KEY],
    ["Gemini", !!process.env.GEMINI_API_KEY],
  ];

  const keyLines = keys.map(([k, ok]) => `${k}: ${ok ? "OK" : "MISSING"}`);

  return [
    "Status (details)",
    "",
    "Simulation: " + (SIMULATION_ON ? "ON" : "OFF"),
    "Sim cash: $" + (Number.isFinite(SIM_CASH) ? SIM_CASH : 0),
    "",
    "AI: " + (AI_ENABLED ? "ON" : "OFF"),
    "AI model: " + AI_MODEL,
    "",
    "Keys present (Railway env):",
    ...keyLines,
    "",
    "Data: Gamma event-by-slug + CLOB midpoints",
  ].join("\n");
}

bot.command("ping", async (ctx) => {
  await ctx.reply("pong");
});

bot.command("status", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details", "status:details");
  await ctx.reply(compactStatusText(), { reply_markup: kb });
});

bot.callbackQuery("status:details", async (ctx) => {
  const kb = new InlineKeyboard().text("Hide details", "status:compact");
  await ctx.editMessageText(detailedStatusText(), { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("status:compact", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details", "status:details");
  await ctx.editMessageText(compactStatusText(), { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// No-space commands only (your preference)
// /updownbtc5m, /updownbtc15m, /updowneth5m, /updowneth15m, /updowneth60m, etc.
bot.hears(/^\/updown(btc|eth)(5m|15m|60m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  await ctx.reply(`Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownViaSlug({ asset, interval });

    if (!out.found) {
      await ctx.reply(
        [
          "Up/Down not found yet.",
          `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
          "",
          "Tried slugs (latest 6):",
          ...out.triedSlugs.slice(0, 6).map((s) => "- " + s),
          "",
          "Last error: " + (out.lastError || "unknown"),
          "",
          "Tip: try again in 10-20 seconds (indexing delay happens).",
        ].join("\n")
      );
      return;
    }

    const up = out.upMid != null ? Math.round(out.upMid * 100) + "c" : "NA";
    const down = out.downMid != null ? Math.round(out.downMid * 100) + "c" : "NA";

    await ctx.reply(
      [
        out.title,
        "Slug: " + out.slug,
        "",
        "UP (mid): " + up,
        "DOWN (mid): " + down,
        "",
        "Source: Gamma event-by-slug + CLOB midpoints",
      ].join("\n")
    );
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("Up/Down failed. Check Railway logs.");
  }
});

console.log("Bot running (polling)");
bot.start();
