import "dotenv/config";
import { Bot, GrammyError, HttpError, InlineKeyboard } from "grammy";
import {
  searchActiveMarkets,
  getTrendingActiveMarkets,
  findBestUpDownMarket,
  formatMarketListMessage,
  formatUpDownMessage,
} from "./src/polymarket.js";

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

const INSTANCE =
  process.env.RAILWAY_REPLICA_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.HOSTNAME ||
  "unknown";

const bot = new Bot(token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const url = info?.json?.result?.url;
  if (typeof url === "string" && url.length === 0) console.log("✅ Webhook cleared. Polling should work.");
}

async function logIdentity() {
  try {
    const me = await bot.api.getMe();
    console.log("✅ TOKEN BOT IDENTITY =>", {
      id: me.id,
      username: me.username,
      first_name: me.first_name,
      instance: INSTANCE, // log-only, not shown to user
    });
  } catch (e) {
    console.log("❌ getMe failed:", e?.message || e);
  }
}

// ----- STATUS UI (compact + “dropdown” button) -----
function statusCompact() {
  return [
    "📊 Status",
    `Simulation: ${SIM_ON ? "✅ ON" : "❌ OFF"}   Cash: $${SIM_START_CASH}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}   Model: ${AI_MODEL}`,
    "Data: Polymarket (Gamma + CLOB reads)",
  ].join("\n");
}

function statusDetails() {
  const keysLine = [
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

function helpText() {
  return [
    "Bot is live ✅",
    "",
    "Commands:",
    "• /ping",
    "• /status",
    "• /markets bitcoin",
    "• /markets eth",
    "• /markets trending",
    "• /marketsbtc (alias)",
    "• /marketseth (alias)",
    "• /marketstrending (alias)",
    "• /updown btc 5m",
    "• /updown btc 15m",
    "• /updown btc 60m",
  ].join("\n");
}

bot.command("start", async (ctx) => ctx.reply(helpText()));
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

// ----- MARKETS -----
async function handleMarkets(ctx, queryRaw) {
  if (!queryRaw) {
    await ctx.reply("Usage: /markets bitcoin  (or /markets eth /markets trending)");
    return;
  }

  const q = queryRaw.toLowerCase();
  const query = q === "btc" ? "bitcoin" : q === "eth" ? "ethereum" : queryRaw;

  await ctx.reply("🔎 Fetching markets from Polymarket…");

  try {
    if (query.toLowerCase() === "trending") {
      const markets = await getTrendingActiveMarkets({ limit: 10 });
      if (!markets.length) {
        await ctx.reply("No trending markets returned right now. Try again in a minute.");
        return;
      }
      await ctx.reply(formatMarketListMessage("trending", markets));
      return;
    }

    const markets = await searchActiveMarkets(query, { limit: 10 });
    if (!markets.length) {
      await ctx.reply(
        `No markets found for: ${query}\n\nTry:\n• /markets crypto\n• /markets price\n• /markets election`,
      );
      return;
    }

    await ctx.reply(formatMarketListMessage(query, markets));
  } catch (e) {
    console.error("markets error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs for the error.");
  }
}

bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const queryRaw = parts.slice(1).join(" ").trim();
  await handleMarkets(ctx, queryRaw);
});

// Aliases (no space)
bot.command("marketsbtc", async (ctx) => handleMarkets(ctx, "bitcoin"));
bot.command("marketseth", async (ctx) => handleMarkets(ctx, "ethereum"));
bot.command("marketstrending", async (ctx) => handleMarkets(ctx, "trending"));

// ----- UPDOWN (Gamma discovery now; next step will add CLOB live odds) -----
bot.command("updown", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);

  const asset = (parts[1] || "").toLowerCase();
  const horizon = (parts[2] || "").toLowerCase();

  if (!asset || !horizon) {
    await ctx.reply("Usage: /updown btc 5m  (also 15m, 60m)");
    return;
  }

  if (!["btc", "eth", "bitcoin", "ethereum"].includes(asset)) {
    await ctx.reply("Supported assets for now: btc, eth");
    return;
  }

  if (!["5m", "15m", "60m"].includes(horizon)) {
    await ctx.reply("Supported horizons: 5m, 15m, 60m");
    return;
  }

  const normalizedAsset = asset === "bitcoin" ? "btc" : asset === "ethereum" ? "eth" : asset;

  await ctx.reply("📈 Finding best LIVE Up/Down market…");

  try {
    const result = await findBestUpDownMarket(normalizedAsset, horizon);
    if (!result) {
      await ctx.reply("No matching Up/Down market found right now. Try /markets crypto");
      return;
    }
    await ctx.reply(formatUpDownMessage(result, normalizedAsset, horizon));
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ updown failed. Check Railway logs for the error.");
  }
});

// ----- Errors -----
bot.catch((err) => {
  const e = err.error;
  console.error("bot.catch =>", err);

  if (e instanceof GrammyError) console.error("GrammyError =>", e.description);
  else if (e instanceof HttpError) console.error("HttpError =>", e.error);
  else console.error("Unknown error =>", e);
});

// ----- Start (409 retry safe) -----
async function startPollingWithRetry() {
  while (true) {
    try {
      console.log("STARTING POLLING =>", INSTANCE);
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

console.log("BOOT ✅", { SIM_ON, SIM_START_CASH, AI_ENABLED, AI_MODEL, INSTANCE });
await ensurePollingMode();
await logIdentity();
console.log("Bot running ✅ (polling)", { INSTANCE });

await startPollingWithRetry();
