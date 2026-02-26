import "dotenv/config";
import { Bot, GrammyError } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

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

async function clearWebhook() {
  const r = await tgGet("setWebhook?url=");
  console.log("clearWebhook =>", r);
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

bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("start", async (ctx) => {
  await ctx.reply("Bot is live ✅\nTry /ping");
});

bot.on("message", (ctx) => {
  console.log("INCOMING MESSAGE VIA GRAMMY =>", {
    instance: INSTANCE,
    text: ctx.message?.text,
    from: ctx.message?.from?.username,
  });
});

bot.catch((err) => {
  console.error("bot error:", err);
});

async function startPollingWithRetry() {
  while (true) {
    try {
      console.log("STARTING POLLING =>", INSTANCE);
      await bot.start(); // long-polling
      console.log("bot.start exited (unexpected). Restarting in 5s…");
      await sleep(5000);
    } catch (e) {
      // grammY wraps Telegram API errors as GrammyError
      if (e instanceof GrammyError && e.error_code === 409) {
        console.log("⚠️ 409 Conflict: another poller is active. Retrying in 35s…");
        await sleep(35000); // wait for the other long poll to end
        continue;
      }
      console.log("❌ Polling failed:", e?.message || e);
      throw e;
    }
  }
}

console.log("BOOTING INSTANCE =>", INSTANCE);
await clearWebhook();
await logIdentity();
await startPollingWithRetry();
