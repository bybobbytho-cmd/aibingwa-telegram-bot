import "dotenv/config";
import { Bot } from "grammy";
import { AgentBingwa } from "@0xMgwan/aibingwa-agent";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const bot = new Bot(token);

// --- Read Railway/.env vars ---
const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase(); // anthropic | openai | gemini
const AI_MODEL = process.env.AI_MODEL || "claude-3-5-sonnet-20241022";
const MODE = process.env.MODE || "SIMULATION";

function mask(val) {
  return val ? "SET ✅" : "NOT SET ❌";
}

// --- Create agent only if AI is enabled ---
let agent = null;

if (AI_ENABLED) {
  agent = new AgentBingwa({
    // Provider selection (the agent package should pick based on provider/model)
    provider: AI_PROVIDER,
    model: AI_MODEL,

    // Keys (only one needs to be valid for the chosen provider)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,

    // Other integrations
    bankrApiKey: process.env.BANKR_API_KEY,
  });
}

// --- Commands ---
bot.command("start", (ctx) => ctx.reply("Bot is live ✅"));

bot.command("status", (ctx) => {
  ctx.reply(
`Status ✅
AI: ${AI_ENABLED ? "on" : "off"}
Provider: ${AI_PROVIDER}
Model: ${AI_MODEL}
Mode: ${MODE}
Keys:
- Bankr: ${mask(process.env.BANKR_API_KEY)}
- Anthropic: ${mask(process.env.ANTHROPIC_API_KEY)}
- OpenAI: ${mask(process.env.OPENAI_API_KEY)}
- Gemini: ${mask(process.env.GEMINI_API_KEY)}`
  );
});

bot.command("ping", (ctx) => ctx.reply("Pong 🏓 (no AI used)"));

// --- Message handling ---
bot.on("message:text", async (ctx) => {
  // HARD STOP: AI is disabled → never call any provider
  if (!AI_ENABLED) {
    return ctx.reply("🧪 Simulation is ON. AI is OFF.\nUse /status.");
  }

  // AI path
  try {
    const reply = await agent.processMessage(
      String(ctx.chat.id),
      ctx.from?.first_name || "anon",
      ctx.message.text
    );
    await ctx.reply(reply);
  } catch (err) {
    console.error(err);
    await ctx.reply("⚠️ AI error. Check Railway logs.");
  }
});

bot.start();
console.log("Bot running ✅");
