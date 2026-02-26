import "dotenv/config";
import { Bot } from "grammy";
import { fetchMarkets, formatMarketsResult } from "./src/polymarket.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const bot = new Bot(token);

bot.catch((err) => {
  console.error("BOT_ERROR:", err.error);
});

// Force-clear any webhook so polling works (runs on Railway)
async function clearWebhook() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=",
    });
    const txt = await r.text();
    console.log("Webhook cleared:", txt);
  } catch (e) {
    console.log("Webhook clear failed:", e?.message || e);
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply("Bot is live ✅\nTry: /markets bitcoin\nUse: /status");
});

bot.command("status", async (ctx) => {
  const sim = process.env.SIMULATION_MODE === "true" ? "ON" : "OFF";
  const aiEnabled = process.env.AI_ENABLED === "true" ? "ON" : "OFF";
  const model = process.env.AI_MODEL || "none";
  await ctx.reply(`🧪 Simulation: ${sim}\n🤖 AI: ${aiEnabled}\n🧠 Model: ${model}`);
});

bot.command("markets", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ");
    const query = parts.slice(1).join(" ").trim() || "bitcoin";
    const result = await fetchMarkets(query, 5);
    const msg = formatMarketsResult(query, result);
    await ctx.reply(msg);
  } catch (err) {
    await ctx.reply(`❌ Error fetching markets: ${err.message}`);
  }
});

await clearWebhook();
bot.start();
console.log("Bot running ✅ IDX-GAMMA-LIVE");
