import "dotenv/config";
import http from "node:http";
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

const PORT = Number(process.env.PORT || 3000);

const AI_ENABLED = String(process.env.AI_ENABLED || "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL || "unset";
const MODE = String(process.env.MODE || "SIM").toUpperCase();

const INSTANCE =
  process.env.RAILWAY_REPLICA_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.HOSTNAME ||
  "unknown";

const bot = new Bot(token);

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---- 1) Tiny HTTP server (proves app is alive on Railway) ----
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    return json(res, 200, { ok: true, instance: INSTANCE, mode: MODE, ai: AI_ENABLED, ai_model: AI_MODEL });
  }
  if (req.url === "/telegram-check") {
    try {
      const me = await bot.api.getMe();
      return json(res, 200, { ok: true, me, instance: INSTANCE });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e), instance: INSTANCE });
    }
  }
  return json(res, 404, { ok: false, message: "not found" });
});

server.listen(PORT, () => {
  console.log("HTTP server ✅", { port: PORT, instance: INSTANCE });
});

// ---- Telegram helpers ----
async function tgGet(path) {
  const url = `https://api.telegram.org/bot${token}/${path}`;
  const res = await fetch(url, { method: "GET" });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// Clears webhook so polling works
async function ensurePollingMode() {
  const del = await tgGet("setWebhook?url=");
  console.log("Telegram setWebhook?url= =>", del);

  const info = await tgGet("getWebhookInfo");
  console.log("Telegram getWebhookInfo =>", info);
}

// Key diagnostic: are updates queued at Telegram?
async function logUpdateQueueSnapshot() {
  const snap = await tgGet("getUpdates?limit=5&timeout=0");
  const result = Array.isArray(snap?.json?.result) ? snap.json.result : [];
  const summaries = result.map((u) => ({
    update_id: u.update_id,
    text: u.message?.text,
    chat_id: u.message?.chat?.id,
    from: u.message?.from?.username,
  }));
  console.log("Telegram getUpdates snapshot =>", { status: snap.status, ok: snap.json?.ok, count: summaries.length, summaries });
}

// ---- 2) Log bot identity at startup ----
async function logBotIdentity() {
  try {
    const me = await bot.api.getMe();
    console.log("✅ TOKEN BOT IDENTITY =>", { id: me.id, username: me.username, first_name: me.first_name, instance: INSTANCE });
  } catch (e) {
    console.log("❌ getMe failed:", e?.message || e);
  }
}

// ---- 3) Log any message that reaches grammy ----
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
  await ctx.reply("Bot is live ✅\nTry /ping");
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
      "Polling: ON",
    ].join("\n"),
  );
});

bot.command("debug_poll", async (ctx) => {
  await ctx.reply("🧪 Running getUpdates probe… check Railway logs.");
  await logUpdateQueueSnapshot();
  await ctx.reply("✅ Probe complete (see Railway logs).");
});

bot.command("markets", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);
  const queryRaw = parts.slice(1).join(" ").trim();

  if (!queryRaw) return ctx.reply("Usage: /markets bitcoin");

  const qLower = queryRaw.toLowerCase();
  const query = qLower === "btc" ? "bitcoin" : qLower === "eth" ? "ethereum" : queryRaw;

  await ctx.reply("🔎 Fetching LIVE markets from Polymarket (Gamma API)...");
  try {
    if (query.toLowerCase() === "trending") {
      const markets = await getTrendingActiveMarkets({ limit: 10 });
      return ctx.reply(formatMarketListMessage("trending", markets));
    }

    const markets = await searchActiveMarkets(query, { limit: 10 });
    if (!markets.length) return ctx.reply(`No active markets found for: ${query}`);
    return ctx.reply(formatMarketListMessage(query, markets));
  } catch (e) {
    console.error("markets error:", e);
    return ctx.reply("⚠️ markets failed (see Railway logs).");
  }
});

bot.command("updown", async (ctx) => {
  const text = ctx.message?.text || "";
  const parts = text.trim().split(/\s+/);

  const asset = (parts[1] || "").toLowerCase();
  const horizon = (parts[2] || "").toLowerCase();

  if (!asset || !horizon) return ctx.reply("Usage: /updown btc 5m");

  const normalizedAsset = asset === "bitcoin" ? "btc" : asset === "ethereum" ? "eth" : asset;

  await ctx.reply("📈 Searching LIVE Up/Down market...");
  try {
    const result = await findBestUpDownMarket(normalizedAsset, horizon);
    if (!result) return ctx.reply("No matching Up/Down market found right now.");
    return ctx.reply(formatUpDownMessage(result, normalizedAsset, horizon));
  } catch (e) {
    console.error("updown error:", e);
    return ctx.reply("⚠️ updown failed (see Railway logs).");
  }
});

bot.catch((err) => console.error("bot error:", err));

console.log("Boot ✅", { MODE, AI_ENABLED, AI_MODEL, INSTANCE });

// Startup diagnostics
await ensurePollingMode();
await logBotIdentity();
await logUpdateQueueSnapshot();

console.log("Bot running ✅ (polling)", { INSTANCE });
bot.start();
