import "dotenv/config";
import { Bot } from "grammy";
import { AgentBingwa } from "@0xMgwan/aibingwa-agent";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const bot = new Bot(token);

// Switches (Railway Variables)
const AI_PROVIDER = (process.env.AI_PROVIDER || "claude").toLowerCase(); // claude | openai | off
const SIM_MODE = (process.env.SIM_MODE || "true").toLowerCase() === "true";

// pick model defaults (cheap)
const MODEL =
  process.env.AI_MODEL ||
  (AI_PROVIDER === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet-20241022");

// build agent only if AI is ON
const agent =
  AI_PROVIDER === "off"
    ? null
    : new AgentBingwa({
        anthropicApiKey:
          AI_PROVIDER === "claude" ? process.env.ANTHROPIC_API_KEY : undefined,

        openaiApiKey:
          AI_PROVIDER === "openai" ? process.env.OPENAI_API_KEY : undefined,

        model: MODEL,

        bankrApiKey: process.env.BANKR_API_KEY,

        // IMPORTANT: this keeps you safe while testing
        simulation: SIM_MODE,
      });

bot.command("start", async (ctx) => {
  await ctx.reply(
    `Bot is live ✅\nAI: ${AI_PROVIDER}\nMode: ${SIM_MODE ? "SIMULATION" : "LIVE"}`
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    `Status ✅\nAI: ${AI_PROVIDER}\nModel: ${MODEL}\nMode: ${
      SIM_MODE ? "SIMULATION" : "LIVE"
    }\nBankr key: ${process.env.BANKR_API_KEY ? "SET ✅" : "NOT SET ❌"}`
  );
});

bot.on("message:text", async (ctx) => {
  // If AI is OFF, do not call any paid API
  if (AI_PROVIDER === "off" || !agent) {
    await ctx.reply(
      "🧪 Simulation is ON, but AI is OFF.\nSet AI_PROVIDER=claude or openai to enable responses."
    );
    return;
  }

  try {
    const reply = await agent.processMessage(
      String(ctx.chat.id),
      ctx.from?.first_name || "anon",
      ctx.message.text
    );
    await ctx.reply(reply);
  } catch (err) {
    const msg = String(err?.message || err);

    // Common: out of credits / billing / auth errors
    if (
      msg.includes("credit balance is too low") ||
      msg.includes("insufficient") ||
      msg.includes("billing") ||
      msg.includes("401") ||
      msg.includes("403")
    ) {
      await ctx.reply(
        "⚠️ AI provider failed (credits/auth).\nI’m still online though.\nTry /status or switch AI_PROVIDER=off."
      );
      return;
    }

    console.error(err);
    await ctx.reply("⚠️ Error. Check Railway logs.");
  }
});

// IMPORTANT: drop old pending updates so 409 is less likely
bot.start({ drop_pending_updates: true });

console.log("Bot running ✅");
