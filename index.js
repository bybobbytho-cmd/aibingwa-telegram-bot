import "dotenv/config";
import { Bot } from "grammy";
import { AgentBingwa } from "@0xMgwan/aibingwa-agent";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const bot = new Bot(token);

// ---- CONFIG ----
const BANKR_KEY_PRESENT = Boolean(process.env.BANKR_API_KEY && process.env.BANKR_API_KEY.trim().length > 10);
const MODE = process.env.MODE || "SIMULATION";
const AI_ENABLED = (process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_PROVIDER = process.env.AI_PROVIDER || "none";
const AI_MODEL = process.env.AI_MODEL || "none";
// ---------------

console.log("✅ Booting bot...");
console.log(`Mode: ${MODE}`);
console.log(`AI: ${AI_ENABLED ? "on" : "off"} | Provider: ${AI_PROVIDER} | Model: ${AI_MODEL}`);
console.log(`Bankr key set: ${BANKR_KEY_PRESENT ? "✅" : "❌"}`);

const agent = new AgentBingwa({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  model: process.env.AI_MODEL || "claude-3-5-sonnet-20241022",
  bankrApiKey: process.env.BANKR_API_KEY,
});

// Start command
bot.command("start", async (ctx) => {
  const msg = [
    "Bot is live ✅",
    `AI: ${AI_ENABLED ? "on" : "off"}`,
    `Mode: ${MODE}`,
    `Bankr key set: ${BANKR_KEY_PRESENT ? "✅" : "❌"}`,
  ].join("\n");
  await ctx.reply(msg);
});

// Text handler
bot.on("message:text", async (ctx) => {
  try {
    // quick diagnostics if user types /status (even without slash)
    if (ctx.message.text.trim().toLowerCase() === "status") {
      const msg = [
        "STATUS ✅",
        `AI: ${AI_ENABLED ? "on" : "off"}`,
        `Mode: ${MODE}`,
        `Bankr key set: ${BANKR_KEY_PRESENT ? "✅" : "❌"}`,
      ].join("\n");
      await ctx.reply(msg);
      return;
    }

    const reply = await agent.processMessage(
      String(ctx.chat.id),
      ctx.from?.first_name || "anon",
      ctx.message.text
    );

    await ctx.reply(reply);
  } catch (err) {
    console.error("❌ Handler error:", err);
    await ctx.reply("Hmm, something failed. Check logs.");
  }
});

bot.start();
console.log("Bot running ✅");


