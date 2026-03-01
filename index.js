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
// Config (read-only)
// --------------------
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

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
    `Sim cash: $${SIM_CASH}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
  ].join("\n");
}

// --------------------
// Commands
// --------------------
bot.command("ping", async (ctx) => {
  console.log("📥 /ping received");
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  console.log("📥 /status received");
  await ctx.reply(compactStatusText(), { parse_mode: "Markdown" });
});

// --------------------
// UP / DOWN (WORKING LOGIC – LOGS ADDED ONLY)
// --------------------
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = ctx.match[1];
  const interval = ctx.match[2];

  console.log("📥 /updown command received");
  console.log("➡️ Asset:", asset);
  console.log("➡️ Interval:", interval);

  await ctx.reply(`🔎 Fetching LIVE ${asset.toUpperCase()} ${interval} market...`);

  try {
    const result = await resolveUpDownMarketAndPrice({ asset, interval });

    console.log("✅ resolveUpDownMarketAndPrice result:");
    console.log(JSON.stringify(result, null, 2));

    if (!result || !result.found) {
      console.warn("⚠️ Up/Down market NOT found");
      await ctx.reply(`❌ Up/Down not found.\nAsset: ${asset.toUpperCase()} | Interval: ${interval}`);
      return;
    }

    const up = result.upMid != null ? `${Math.round(result.upMid * 100)}¢` : "—";
    const down = result.downMid != null ? `${Math.round(result.downMid * 100)}¢` : "—";

    await ctx.reply(
      [
        `📈 *${result.title}*`,
        "",
        `UP (mid): ${up}`,
        `DOWN (mid): ${down}`,
        "",
        `_Source: Gamma + CLOB_`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("🔥 ERROR in /updown handler");
    console.error(err);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Start polling
// --------------------
console.log("🤖 Bot running ✅ (polling)");
bot.start();
