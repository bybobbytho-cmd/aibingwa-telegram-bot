import "dotenv/config";
import { Bot } from "grammy";
import { AgentBingwa } from "@0xMgwan/aibingwa-agent";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");

const bot = new Bot(token);

const agent = new AgentBingwa({
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-3-5-sonnet-20241022",
  bankrApiKey: process.env.BANKR_API_KEY,
});

bot.command("start", (ctx) => {
  ctx.reply("Bot is live ✅");
});

bot.on("message:text", async (ctx) => {
  const reply = await agent.processMessage(
    String(ctx.chat.id),
    ctx.from?.first_name || "anon",
    ctx.message.text
  );
  await ctx.reply(reply);
});

bot.start();
console.log("Bot running ✅");
