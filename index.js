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

// Flags (DATA FIRST)
const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL || "unset";
const MODE = String(process.env.MODE || "SIM").toUpperCase(); // SIM / REAL later

// Helps detect “multiple Railway instances”
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
    "• /status",
    "• /markets bitcoin",
    "• /markets eth",
    "• /markets trending",
    "• /updown btc 5m",
    "• /updown btc 15m",
    "• /updown btc 60m",
  ].join("\n");
}

// IMPORTANT: Clear webhook on Railway startup so long polling works (prevents 409 conflicts)
async function ensurePollingMode() {
  const base = `https://api.telegram.org/bot${token}`;

  try {
    const del = await fetch(`${base}/setWebhook?url=`, { method: "GET" });
    const delJson = await del.json().catch(() => null);
    console.log("Telegram setWebhook?url= =>", delJson || { ok: false });
  } catch (e) {
    console.log("Webhook delete failed (network):", e?.message || e);
  }

  try {
    const info = await fetch(`${base}/getWebhookInfo`, { method: "GET" });
    const infoJson = await info.json().catch(() => null);
    console.log("Telegram getWebhookInfo =>", infoJson || { ok: false });

    const url = infoJson?.result?.url;
    if (typeof url === "string" && url.length > 0) {
      console.log("⚠️ Webhook still set to:", url);
    } else {
      console.log("✅ Webhook cleared. Polling should work.");
    }
  } catch (e) {
    console.log("getWebhookInfo failed (network):", e?.message || e);
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(helpText());
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

bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const queryRaw = parts.slice(1).join(" ").trim();

  if (!queryRaw) {
    await ctx.reply("Usage: /markets bitcoin  (or /markets eth /markets trending)");
    return;
  }

  const qLower = queryRaw.toLowerCase();
  const query =
    qLower === "btc" ? "bitcoin" :
    qLower === "eth" ? "ethereum" :
    queryRaw;

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

  const asset = (parts[1] || "").toLowerCase(); // btc, eth
  const horizon = (parts[2] || "").toLowerCase(); // 5m, 15m, 60m

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
      await ctx.reply(
        [
          "No matching Up/Down market found right now.",
          "Try:",
          "• /markets bitcoin",
          "• /markets eth",
          "• /markets trending",
        ].join("\n"),
      );
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

console.log("Bot running ✅ (polling)", { INSTANCE });
bot.start();
