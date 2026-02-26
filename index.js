import "dotenv/config";
import { Bot } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const INSTANCE =
  process.env.RAILWAY_REPLICA_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.HOSTNAME ||
  "unknown";

const bot = new Bot(token);

// --- helper to call Telegram directly ---
async function tgGet(path) {
  const url = `https://api.telegram.org/bot${token}/${path}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// --- CLEAR WEBHOOK ---
async function clearWebhook() {
  const r = await tgGet("setWebhook?url=");
  console.log("clearWebhook =>", r);
}

// --- THIS IS THE IMPORTANT DIAGNOSTIC ---
async function snapshotUpdates() {
  const r = await tgGet("getUpdates?limit=5&timeout=0");
  const summaries = (r.json?.result || []).map((u) => ({
    update_id: u.update_id,
    text: u.message?.text,
    chat_id: u.message?.chat?.id,
    from: u.message?.from?.username,
  }));

  console.log("Telegram getUpdates snapshot =>", {
    instance: INSTANCE,
    status: r.status,
    ok: r.json?.ok,
    count: summaries.length,
    summaries,
  });
}

// --- BASIC COMMAND ---
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

// --- LOG ANY MESSAGE THAT REACHES GRAMMY ---
bot.on("message", (ctx) => {
  console.log("INCOMING MESSAGE VIA GRAMMY =>", {
    instance: INSTANCE,
    text: ctx.message?.text,
    from: ctx.message?.from?.username,
  });
});

// --- STARTUP SEQUENCE ---
console.log("BOOTING INSTANCE =>", INSTANCE);

await clearWebhook();
await snapshotUpdates();

console.log("STARTING POLLING =>", INSTANCE);
bot.start();
