import "dotenv/config";
import { Bot, GrammyError, HttpError } from "grammy";
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
const MODE = String(process.env.MODE || "SIM").toUpperCase();

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
  if (typeof url === "string" && url.length === 0) {
    console.log("✅ Webhook cleared. Polling should work.");
  } else {
    console.log("⚠️ Webhook still set to:", url);
  }
}

async function logIdentity() {
  try {
    const me = await bot.api.getMe();
    console.log("✅ TOKEN BOT IDENTITY =>", {
      id: me.id,
      username: me.username,
      first_name: me.first_name,
      instance: INSTANCE,
    });
  } catch (e) {
    console.log("❌ getMe failed:", e?.message || e);
  }
}

function helpText() {
  return [
    "Bot is live ✅",
    "",
    `Mode: ${MODE}`,
    `AI: ${AI_ENABLED ? "on" : "off"}`,
    `AI_MODEL: ${AI_MODEL}`,
    `Instance: ${INSTANCE}`,
    "",
    "Commands:",
    "• /ping",
    "• /status",
    "• /markets bitcoin",
    "• /markets eth",
    "• /markets trending",
    "• /updown btc 5m",
    "• /updown btc 15m",
    "• /updown btc 60m",
  ].join("\n");
}

// ---- Commands ----
bot.command("start", async (ctx) => ctx.reply(helpText()));

bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.command("status", async (ctx) => {
  await ctx.reply(
    [
      "📊 Status",
      `Mode: ${MODE}`,
      `AI: ${AI_ENABLED ? "on" : "off"}`,
      `AI_MODEL: ${AI_MODEL}`,
      `Instance: ${INSTANCE}`,
      "",
      "Data: Polymarket Gamma API (public)",
      "Trading: OFF (data only)",
    ].join("\n"),
  );
});

bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const queryRaw = parts.slice(1).join(" ").trim();

  if (!queryRaw) {
    await ctx.reply("Usage: /markets bitcoin   (or /markets eth /markets trending)");
    return;
  }

  const q = queryRaw.toLowerCase();
  const query = q === "btc" ? "bitcoin" : q === "eth" ? "ethereum" : queryRaw;

  await ctx.reply("🔎 Fetching LIVE markets from Polymarket (Gamma API)…");

  try {
    if (query.toLowerCase() === "trending") {
      const markets = await getTrendingActiveMarkets({ limit: 10 });
      await ctx.reply(formatMarketListMessage("trending", markets));
      return;
    }

    const markets = await searchActiveMarkets(query, { limit: 10 });
    if (!markets.length) {
      await ctx.reply(`No active markets found for: ${query}`);
      return;
    }
    await ctx.reply(formatMarketListMessage(query, markets));
  } catch (e) {
    console.error("markets error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs for the error.");
  }
});

bot.command("updown", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);

  const asset = (parts[1] || "").toLowerCase();
  const horizon = (parts[2] || "").toLowerCase();

  if (!asset || !horizon) {
    await ctx.reply("Usage: /updown btc 5m   (also 15m, 60m)");
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

  await ctx.reply("📈 Searching LIVE Up/Down market on Polymarket…");

  try {
    const result = await findBestUpDownMarket(normalizedAsset, horizon);
    if (!result) {
      await ctx.reply("No matching Up/Down market found right now. Try /markets bitcoin");
      return;
    }
    await ctx.reply(formatUpDownMessage(result, normalizedAsset, horizon));
  } catch (e) {
    console.error("updown error:", e);
    await ctx.reply("⚠️ updown failed. Check Railway logs for the error.");
  }
});

// ---- Error handling ----
bot.catch((err) => {
  const e = err.error;
  console.error("bot.catch =>", err);

  if (e instanceof GrammyError) {
    console.error("GrammyError =>", e.description);
  } else if (e instanceof HttpError) {
    console.error("HttpError =>", e.error);
  } else {
    console.error("Unknown error =>", e);
  }
});

// ---- Start (with 409 retry so it doesn't die) ----
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

console.log("BOOT ✅", { MODE, AI_ENABLED, AI_MODEL, INSTANCE });
await ensurePollingMode();
await logIdentity();
console.log("Bot running ✅ (polling)", { INSTANCE });

await startPollingWithRetry();
