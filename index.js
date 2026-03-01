import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --------------------
// Config (read-only)
// --------------------
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

// --------------------
// Helpers
// --------------------
function compactStatusText() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${SIM_CASH}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
  ].join("\n");
}

// Attempts to extract a “price to beat” from event text
function extractPriceToBeat(text) {
  if (!text) return null;

  const patterns = [
    /price (?:to beat|above|below)[^\d]*([\d,]+\.?\d*)/i,
    /([\d,]+\.?\d*)\s*(?:USD|USDT|USD\.|dollars)/i,
    /\$([\d,]+\.?\d*)/,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) {
      return m[1].replace(/,/g, "");
    }
  }
  return null;
}

// --------------------
// Commands
// --------------------
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  const kb = new InlineKeyboard();
  await ctx.reply(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
});

// --------------------
// UP / DOWN (WORKING + ENRICHED)
// --------------------
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = ctx.match[1];
  const interval = ctx.match[2];

  await ctx.reply(`🔎 Fetching LIVE ${asset.toUpperCase()} ${interval} market...`);

  try {
    const result = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!result || !result.found) {
      await ctx.reply(
        `❌ Up/Down not found.\nAsset: ${asset.toUpperCase()} | Interval: ${interval}`
      );
      return;
    }

    const up = result.upMid != null ? `${Math.round(result.upMid * 100)}¢` : "—";
    const down = result.downMid != null ? `${Math.round(result.downMid * 100)}¢` : "—";

    // Try to extract “price to beat” from metadata
    const metaText = [
      result.title,
      result.description,
      result.rules,
    ]
      .filter(Boolean)
      .join(" ");

    const priceToBeat = extractPriceToBeat(metaText);

    const lines = [
      `📈 *${result.title}*`,
      "",
      priceToBeat ? `🎯 *Price to beat:* $${priceToBeat}` : null,
      `📈 UP (mid): ${up}`,
      `📉 DOWN (mid): ${down}`,
      "",
      `_Source: Gamma + CLOB (read-only)_`,
    ].filter(Boolean);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Up/Down error:", err);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Start polling (UNCHANGED)
// --------------------
console.log("🤖 Bot running ✅ (polling)");
bot.start();
