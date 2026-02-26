import "dotenv/config";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import { resolveLiveUpDown, formatUpDownLiveMessage } from "./src/polymarket.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL || "unset";

const MODE_RAW = String(process.env.MODE || "SIMULATION").toUpperCase();
const SIM_ON = MODE_RAW === "SIM" || MODE_RAW === "SIMULATION";
const SIM_START_CASH = Number(process.env.SIM_START_CASH || 50);

function keyOn(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0;
}

const KEYS = {
  bankr: keyOn("BANKR_API_KEY"),
  anthropic: keyOn("ANTHROPIC_API_KEY"),
  openai: keyOn("OPENAI_API_KEY"),
  gemini: keyOn("GEMINI_API_KEY") || keyOn("GOOGLE_API_KEY"),
};

const bot = new Bot(token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * IMPORTANT: This MUST be a string template (backticks).
 * If the backticks go missing, Railway will crash exactly like your logs.
 */
async function tgGet(path) {
  const url = `https://api.telegram.org/bot${token}/${path}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function ensurePollingMode() {
  const del = await tgGet("setWebhook?url=");
  console.log("Telegram setWebhook?url= =>", del?.json || del);

  const info = await tgGet("getWebhookInfo");
  console.log("Telegram getWebhookInfo =>", info?.json || info);

  const hookUrl = info?.json?.result?.url;
  if (typeof hookUrl === "string" && hookUrl.length === 0) {
    console.log("✅ Webhook cleared. Polling should work.");
  }
}

// ----- STATUS (compact + expand) -----
function statusCompact() {
  return [
    "📊 Status",
    `Simulation: ${SIM_ON ? "✅ ON" : "❌ OFF"}   Cash: $${SIM_START_CASH}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}   Model: ${AI_MODEL}`,
    "Data: Polymarket CLOB (public reads)",
  ].join("\n");
}

function statusDetails() {
  const keysLine = [
    `Telegram: ✅`,
    `Bankr: ${KEYS.bankr ? "✅" : "❌"}`,
    `Anthropic: ${KEYS.anthropic ? "✅" : "❌"}`,
    `OpenAI: ${KEYS.openai ? "✅" : "❌"}`,
    `Gemini: ${KEYS.gemini ? "✅" : "❌"}`,
  ].join(" | ");

  return [
    "📊 Status (details)",
    "",
    `Simulation: ${SIM_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${SIM_START_CASH}`,
    "",
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: ${AI_MODEL}`,
    "",
    `Keys present: ${keysLine}`,
    "",
    "Trading: OFF (data-only)",
  ].join("\n");
}

function statusKeyboard(expanded = false) {
  return expanded
    ? new InlineKeyboard().text("Hide details ▴", "status:less")
    : new InlineKeyboard().text("Show details ▾", "status:more");
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "No-space Up/Down commands:",
      "• /updownbtc5m  • /updownbtc15m  • /updownbtc60m",
      "• /updowneth5m  • /updowneth15m  • /updowneth60m",
      "",
      "Other:",
      "• /ping",
      "• /status",
    ].join("\n"),
  );
});

bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.command("status", async (ctx) => {
  await ctx.reply(statusCompact(), { reply_markup: statusKeyboard(false) });
});

bot.callbackQuery("status:more", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusDetails(), { reply_markup: statusKeyboard(true) });
});

bot.callbackQuery("status:less", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(statusCompact(), { reply_markup: statusKeyboard(false) });
});

// ----- NO-SPACE UPDOWN COMMANDS -----
// /updownbtc5m, /updowneth15m, etc.
bot.hears(/^\/updown(btc|eth)(5m|15m|60m)$/i, async (ctx) => {
  const [, asset, intervalStr] = ctx.match;

  await ctx.reply(`🔎 Finding LIVE ${asset.toUpperCase()} Up/Down ${intervalStr} via CLOB…`);

  try {
    const res = await resolveLiveUpDown(asset.toLowerCase(), intervalStr.toLowerCase());
    await ctx.reply(formatUpDownLiveMessage(res, asset, intervalStr));
  } catch (e) {
    console.error("updown resolver error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

bot.on("message:text", async (ctx) => {
  const t = (ctx.message?.text || "").trim();
  if (t.startsWith("/updown") && !/^\/updown(btc|eth)(5m|15m|60m)$/i.test(t)) {
    await ctx.reply(
      "Use:\n/updownbtc5m\n/updownbtc15m\n/updownbtc60m\n/updowneth5m\n/updowneth15m\n/updowneth60m",
    );
  }
});

bot.catch((err) => {
  const e = err.error;
  console.error("bot.catch =>", err);

  if (e instanceof GrammyError) console.error("GrammyError =>", e.description);
  else if (e instanceof HttpError) console.error("HttpError =>", e.error);
  else console.error("Unknown error =>", e);
});

async function startPollingWithRetry() {
  while (true) {
    try {
      await bot.start();
      console.log("bot.start exited unexpectedly; restarting in 5s…");
      await sleep(5000);
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 409) {
        console.log("⚠️ 409 Conflict: another poller is active. Retrying in 35s…");
        await sleep(35000);
        continue;
      }
      console.log("❌ Polling failed:", e?.message || e);
      throw e;
    }
  }
}

console.log("BOOT ✅", { SIM_ON, SIM_START_CASH, AI_ENABLED, AI_MODEL });
await ensurePollingMode();
console.log("Bot running ✅ (polling)");

await startPollingWithRetry();
