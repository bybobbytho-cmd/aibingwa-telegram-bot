import { Bot } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

// Accept either env var name (prevents “missing token” confusion)
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN (or BOT_TOKEN) env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --------------------
// Commands
// --------------------
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    [
      "📊 Status",
      `Simulation: ${(process.env.SIMULATION ?? "true").toLowerCase() === "true" ? "✅ ON" : "❌ OFF"}`,
      `Sim cash: $${Number(process.env.SIM_CASH ?? "50")}`,
      `AI: ${(process.env.AI_ENABLED ?? "false").toLowerCase() === "true" ? "✅ ON" : "❌ OFF"}`,
      `AI model: ${process.env.AI_MODEL ?? "unset"}`,
      "",
      "Data: Gamma (events/markets) + CLOB (midpoints), public only",
    ].join("\n")
  );
});

// No-space Up/Down commands: /updownbtc5m /updownbtc15m /updowneth5m /updowneth15m
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out || !out.found) {
      await ctx.reply(`❌ Up/Down not found.\nAsset: ${asset.toUpperCase()} | Interval: ${interval}`);
      return;
    }

    const up = out.upMid != null ? `${Math.round(out.upMid * 100)}¢` : "—";
    const down = out.downMid != null ? `${Math.round(out.downMid * 100)}¢` : "—";

    await ctx.reply(
      [
        `📈 ${out.title}`,
        `Slug: ${out.slug ?? "—"}`,
        "",
        `UP (mid): ${up}`,
        `DOWN (mid): ${down}`,
        "",
        "Source: Gamma event-by-slug + CLOB midpoints",
      ].join("\n")
    );
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Clean start + graceful stop (Railway-safe)
// --------------------
async function start() {
  try {
    // This helps prevent “ghost” webhook/polling states
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    console.log("🤖 Bot running ✅ (polling)");
    bot.start();
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  console.log("🛑 SIGTERM received, stopping bot...");
  bot.stop();
});

process.once("SIGINT", () => {
  console.log("🛑 SIGINT received, stopping bot...");
  bot.stop();
});

start();
