import { Bot } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

// Accept either env var name
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
  console.log(`[JOURNAL] /ping received from ${ctx.from?.username}`);
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  console.log(`[JOURNAL] /status requested`);
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

// No-space Up/Down commands: /updownbtc5m etc.
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match[1] ?? "").toLowerCase();
  const interval = String(ctx.match[2] ?? "").toLowerCase();
  
  console.log(`[JOURNAL] Command: /updown${asset}${interval} | User: ${ctx.from?.username}`);

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out || !out.found) {
      console.warn(`[JOURNAL] Result: NOT_FOUND | Asset: ${asset} | Interval: ${interval}`);
      await ctx.reply(`❌ Up/Down not found.\nAsset: ${asset.toUpperCase()} | Interval: ${interval}\n\nTip: Polymarket indexing often delays 30s. Try again.`);
      return;
    }

    console.log(`[JOURNAL] Result: SUCCESS | Slug: ${out.slug}`);

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
    console.error(`[JOURNAL] Error in /updown:`, e.message);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Clean start + graceful stop (Railway-safe)
// --------------------
async function start() {
  try {
    // This removes the "409 Conflict" by clearing old sessions
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("🤖 [JOURNAL] Webhook cleared. Starting polling...");
    
    bot.start({
      onStart: (botInfo) => {
        console.log(`🤖 [JOURNAL] Bot @${botInfo.username} is ONLINE ✅`);
      },
    });
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
}

process.once("SIGTERM", () => {
  console.log("🛑 SIGTERM: Stopping bot...");
  bot.stop();
});

process.once("SIGINT", () => {
  console.log("🛑 SIGINT: Stopping bot...");
  bot.stop();
});

start();

