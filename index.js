// index.js
import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ---- Flags
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

const hasTelegramToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
const hasBankrKey = Boolean(process.env.BANKR_API_KEY);
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);

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
    "*Keys present in Railway env*",
    `Telegram: ${yn(hasTelegramToken)}  Bankr: ${yn(hasBankrKey)}`,
    `Anthropic: ${yn(hasAnthropicKey)}  OpenAI: ${yn(hasOpenAIKey)}  Gemini: ${yn(hasGeminiKey)}`,
    "",
    "_Up/Down pipeline:_ CLOB time → Gamma event-by-slug → CLOB midpoints",
    "_Note:_ 60m temporarily disabled (we’ll add later).",
  ].join("\n");
}

// ---- Basic commands
bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "Up/Down commands (no spaces):",
      "• /updownbtc5m  /updownbtc15m",
      "• /updowneth5m  /updowneth15m",
      "• /updownsol5m  /updownsol15m",
      "• /updownxrp5m  /updownxrp15m",
      "",
      "Try /status",
    ].join("\n")
  );
});

// /status dropdown
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

// Up/Down no-space commands:
// /updownbtc5m, /updowneth15m, /updownsol5m, /updownxrp15m
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m|60m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  if (interval === "60m") {
    await ctx.reply("⏸️ 60m is disabled for now. Use 5m or 15m (we’ll add 60m later).");
    return;
  }

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out.found) {
      const lines = [
        `❌ Up/Down not found yet.`,
        `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
      ];

      if (out.reason) lines.push(`Reason: ${out.reason}`);

      // keep debug short (not messy)
      if (out.debug?.windowStart) lines.push(`WindowStart: ${out.debug.windowStart}`);
      if (out.debug?.triedSlugs?.length) {
        lines.push("", "Tried slugs (latest 4):");
        for (const s of out.debug.triedSlugs.slice(-4)) lines.push(`- ${s}`);
      }
      if (out.debug?.lastError) {
        lines.push("", `Last error: ${String(out.debug.lastError).slice(0, 160)}`);
      }

      await ctx.reply(lines.join("\n"));
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
        "_Source: Gamma event-by-slug + CLOB midpoints_",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

console.log("Bot running ✅ (polling)");
bot.start();
