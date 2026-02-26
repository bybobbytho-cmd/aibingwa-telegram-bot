import "dotenv/config";
import { Bot } from "grammy";
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
    "• /debug_poll (prints getUpdates result to Railway logs)",
  ].join("\n");
}

async function tgGet(path) {
  const url = `https://api.telegram.org/bot${token}/${path}`;
  const res = await fetch(url, { method: "GET" });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.ok) {
    throw new Error(`Telegram API failed for ${path}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}

async function ensurePollingMode() {
  try {
    const del = await tgGet("setWebhook?url=");
    console.log("Telegram setWebhook?url= =>", del);
  } catch (e) {
    console.log("Webhook delete failed:", e?.message || e);
  }

  try {
    const info = await tgGet("getWebhookInfo");
    console.log("Telegram getWebhookInfo =>", info);
    const url = info?.result?.url;
    if (typeof url === "string" && url.length > 0) {
      console.log("⚠️ Webhook still set to:", url);
    } else {
      console.log("✅ Webhook cleared. Polling should work.");
    }
  } catch (e) {
    console.log("getWebhookInfo failed:", e?.message || e);
  }
}

async function logBotIdentity() {
  try {
    const me = await bot.api.getMe();
    console.log("✅ TOKEN BOT IDENTITY =>", {
      id: me.id,
      username: me.username,
      first_name: me.first_name,
      instance: INSTANCE,
    });
  } catch (e) {
    console.log("❌ getMe failed.", e?.message || e);
  }
}

// DEBUG: log anything that reaches grammy
bot.on("message", async (ctx) => {
  const msg = ctx.message;
  console.log("INCOMING MESSAGE ✅", {
    instance: INSTANCE,
    chat_id: msg?.chat?.id,
    chat_type: msg?.chat?.type,
    from_id: msg?.from?.id,
    from_username: msg?.from?.username,
    text: msg?.text || "",
  });
});

bot.command("start", async (ctx) => {
  await ctx.reply(helpText());
});

bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    [
      "📊 Status",
      `Mode: ${MODE}`,
      `AI: ${AI_ENABLED ? "on" : "off"}`,
      `AI_MODEL: ${AI_MODEL}`,
      `Instance: ${INSTANCE}`,
      "",
      "Data source: Gamma API (public)",
      "Polling: ON (webhook cleared at startup)",
    ].join("\n"),
  );
});

// NEW: direct Telegram getUpdates probe (prints to Railway logs)
bot.command("debug_poll", async (ctx) => {
  await ctx.reply("🧪 Running getUpdates probe… check Railway logs.");

  try {
    const r = await tgGet("getUpdates?limit=5&timeout=0");
    // Print only summaries (avoid huge logs)
    const summaries = (r.result || []).map((u) => ({
      update_id: u.update_id,
      message_text: u.message?.text,
      chat_id: u.message?.chat?.id,
      from_username: u.message?.from?.username,
    }));
    console.log("DEBUG getUpdates =>", { count: summaries.length, summaries });

    await ctx.reply(`✅ getUpdates returned ${summaries.length} updates (see Railway logs).`);
  } catch (e) {
    console.log("DEBUG getUpdates failed =>", e?.message || e);
    await ctx.reply("❌ getUpdates probe failed. Check Railway logs.");
  }
});

bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const queryRaw = parts.slice(1).join(" ").trim();

  if (!queryRaw) {
    await ctx.reply("Usage: /markets bitcoin  (or /markets eth /markets trending)");
    return;
  }

  const qLower = queryRaw.toLowerCase();
  const query = qLower === "btc" ? "bitcoin" : qLower === "eth" ? "ethereum" : queryRaw;

  await ctx.reply("🔎 Fetching LIVE markets from Polymarket (Gamma API)...");

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
  } catch (err) {
    console.error("markets error:", err);
    await ctx.reply("⚠️ Failed to fetch markets. Check Railway logs for details.");
  }
});

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

  await ctx.reply("📈 Searching LIVE Up/Down market on Polymarket...");

  try {
    const result = await findBestUpDownMarket(normalizedAsset, horizon);
    if (!result) {
      await ctx.reply("No matching Up/Down market found right now. Try /markets bitcoin");
      return;
    }
    await ctx.reply(formatUpDownMessage(result, normalizedAsset, horizon));
  } catch (err) {
    console.error("updown error:", err);
    await ctx.reply("⚠️ Failed to fetch Up/Down market. Check Railway logs for details.");
  }
});

bot.catch((err) => {
  console.error("bot error:", err);
});

console.log("Boot ✅", { MODE, AI_ENABLED, AI_MODEL, INSTANCE });

await ensurePollingMode();
await logBotIdentity();

console.log("Bot running ✅ (polling)", { INSTANCE });
bot.start();


