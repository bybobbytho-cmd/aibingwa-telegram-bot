import "dotenv/config";
import { Bot } from "grammy";
import { AgentBingwa } from "@0xMgwan/aibingwa-agent";
import { searchMarkets, formatMarkets } from "./src/polymarket.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in environment");

const bot = new Bot(token);

// ---------- ENV / FLAGS ----------
const MODE = (process.env.MODE || "SIMULATION").toUpperCase(); // SIMULATION | LIVE (later)
const SIM_MODE = (process.env.SIM_MODE || "ON").toUpperCase(); // ON | OFF
const SIM_CASH = Number(process.env.SIM_CASH || 50);

const AI_ENABLED = String(process.env.AI_ENABLED || "off").toLowerCase() === "on";
const AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase();
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";

// Keys (only used if AI is enabled OR specific integrations are used)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BANKR_API_KEY = process.env.BANKR_API_KEY;

// ---------- HELPERS ----------
function yesNo(v) {
  return v ? "SET ✅" : "NOT SET ❌";
}

function statusText() {
  return [
    `Status ✅`,
    `AI: ${AI_ENABLED ? "on ✅" : "off"}`,
    `Provider: ${AI_PROVIDER}`,
    `Model: ${AI_MODEL}`,
    `Mode: ${MODE}`,
    `Simulation: ${SIM_MODE} (cash: $${SIM_CASH})`,
    `Keys:`,
    `- Bankr: ${yesNo(BANKR_API_KEY)}`,
    `- Anthropic: ${yesNo(ANTHROPIC_API_KEY)}`,
    `- OpenAI: ${yesNo(OPENAI_API_KEY)}`,
    `- Gemini: ${yesNo(GEMINI_API_KEY)}`,
  ].join("\n");
}

function aiIsConfigured() {
  if (!AI_ENABLED) return { ok: false, reason: "AI is OFF" };

  if (AI_PROVIDER === "claude" && !ANTHROPIC_API_KEY)
    return { ok: false, reason: "ANTHROPIC_API_KEY missing" };

  if (AI_PROVIDER === "openai" && !OPENAI_API_KEY)
    return { ok: false, reason: "OPENAI_API_KEY missing" };

  if (AI_PROVIDER === "gemini" && !GEMINI_API_KEY)
    return { ok: false, reason: "GEMINI_API_KEY missing" };

  return { ok: true };
}

// ---------- AGENT (only used when AI ON) ----------
const agent = new AgentBingwa({
  anthropicApiKey: ANTHROPIC_API_KEY,
  openaiApiKey: OPENAI_API_KEY,
  geminiApiKey: GEMINI_API_KEY,
  provider: AI_PROVIDER, // "claude" | "openai" | "gemini"
  model: AI_MODEL,
  bankrApiKey: BANKR_API_KEY,
  mode: MODE, // SIMULATION for now
});

// ---------- COMMANDS ----------
bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      `Bot is live ✅`,
      `AI: ${AI_ENABLED ? "on ✅" : "off"}`,
      `Mode: ${MODE}`,
      `Bankr key set: ${BANKR_API_KEY ? "✅" : "❌"}`,
    ].join("\n")
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(statusText());
});

// /markets <query>
// Example: /markets bitcoin
bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const query = text.replace("/markets", "").trim();

  if (!query) {
    return ctx.reply("Usage: /markets <keyword>\nExample: /markets bitcoin");
  }

  try {
    const markets = await searchMarkets(query, 5);
    const msg = formatMarkets(markets);
    await ctx.reply(msg);
  } catch (err) {
    await ctx.reply(`Polymarket fetch error ❌\n${String(err?.message || err)}`);
  }
});

// /market <query> (same as /markets but returns fewer lines if you want later)
bot.command("market", async (ctx) => {
  const text = ctx.message?.text || "";
  const query = text.replace("/market", "").trim();

  if (!query) {
    return ctx.reply("Usage: /market <keyword>\nExample: /market bitcoin");
  }

  try {
    const markets = await searchMarkets(query, 3);
    const msg = formatMarkets(markets);
    await ctx.reply(msg);
  } catch (err) {
    await ctx.reply(`Polymarket fetch error ❌\n${String(err?.message || err)}`);
  }
});

// /ping
bot.command("ping", async (ctx) => {
  await ctx.reply("Pong ✅");
});

// ---------- TEXT MESSAGES ----------
bot.on("message:text", async (ctx) => {
  // If user is chatting normally, only use AI if enabled & configured.
  const cfg = aiIsConfigured();
  if (!cfg.ok) {
    // Don’t crash; keep it friendly.
    return ctx.reply(
      `🧪 Simulation is ON. AI is OFF.\nUse /markets bitcoin to fetch data.\nUse /status to confirm settings.`
    );
  }

  try {
    const reply = await agent.processMessage(
      String(ctx.chat.id),
      ctx.from?.first_name || "anon",
      ctx.message.text
    );
    await ctx.reply(reply);
  } catch (err) {
    await ctx.reply(`Hmm, my brain glitched 🤔 Error: ${String(err?.message || err)}`);
  }
});

// ---------- START ----------
bot.start();
console.log("Bot running ✅");
