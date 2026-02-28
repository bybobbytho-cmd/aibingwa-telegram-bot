import { Bot } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ----------------
// Commands
// ----------------
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  const SIMULATION_ON = String(process.env.SIMULATION || "true").toLowerCase() === "true";
  const SIM_CASH = Number(process.env.SIM_CASH || "50");
  const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
  const AI_MODEL = process.env.AI_MODEL || "unset";

  await ctx.reply(
    [
      "📊 Status",
      `Simulation: ${SIMULATION_ON ? "ON ✅" : "OFF ❌"}`,
      `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
      `AI: ${AI_ENABLED ? "ON ✅" : "OFF ❌"}`,
      `AI model: ${AI_MODEL}`,
      "",
      "Data: Polymarket (Gamma search + CLOB midpoints)",
      "Trading: OFF (data-only)",
    ].join("\n")
  );
});

// ----------------------------
// Up/Down commands (NO SPACE)
// ----------------------------
// Supported now: btc/eth/sol/xrp + 5m/15m
// 60m intentionally disabled to avoid breakage
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const asset = ctx.match[1].toLowerCase();
  const interval = ctx.match[2].toLowerCase();

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out.found) {
      await ctx.reply(
        [
          "❌ Up/Down not found.",
          `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
          "",
          "Tried queries:",
          ...out.debug.queries.map((q) => `- ${q}`),
        ].join("\n")
      );
      return;
    }

    await ctx.reply(
      [
        `📈 *${out.title}*`,
        "",
        `UP (mid): ${Math.round(out.upMid * 100)}¢`,
        `DOWN (mid): ${Math.round(out.downMid * 100)}¢`,
        "",
        "_Source: Gamma discovery + CLOB midpoints_",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("updown error:", err);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// -------------
// Start bot
// -------------
console.log("Bot running ✅ (polling)");
bot.start();
