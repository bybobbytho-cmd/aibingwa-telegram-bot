import { Bot } from "grammy";
import express from "express";
import fetch from "node-fetch";

// ========== CONFIG ==========
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN missing!");
  process.exit(1);
}

// ========== LOGGING ==========
function log(message, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, message, ...data }));
}

// ========== BOT SETUP ==========
const bot = new Bot(BOT_TOKEN);

// ========== CLEAR WEBHOOK ==========
async function setupBot() {
  try {
    log("Clearing webhook...");
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    log("Webhook cleared");
  } catch (error) {
    log("Setup error", { error: error.message });
  }
}

// ========== SLUG GENERATION ==========
function getSlug(asset, interval) {
  const now = Math.floor(Date.now() / 1000);
  const seconds = interval === "5m" ? 300 : 900;
  const rounded = Math.floor(now / seconds) * seconds;
  return `${asset.toLowerCase()}-updown-${interval}-${rounded}`;
}

// ========== FETCH MARKET ==========
async function getMarketData(slug) {
  try {
    log("Fetching", { slug });
    
    const eventRes = await fetch(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    if (!eventRes.ok) {
      log("Not found", { slug });
      return null;
    }
    
    const event = await eventRes.json();
    const markets = event.markets || [];
    
    const tokenIds = [];
    for (const market of markets) {
      if (market.clobTokenIds && market.clobTokenIds[0]) {
        tokenIds.push(market.clobTokenIds[0]);
      }
    }
    
    if (tokenIds.length < 2) {
      log("No token IDs");
      return null;
    }
    
    const priceRes = await fetch(`https://clob.polymarket.com/midpoints?token_ids=${tokenIds.join(",")}`);
    const midpoints = await priceRes.json();
    
    return {
      title: event.title || slug,
      tokenIds,
      midpoints
    };
  } catch (error) {
    log("Error", { error: error.message });
    return null;
  }
}

// ========== COMMAND HANDLER ==========
async function handleUpDown(ctx, asset, interval) {
  const command = `/updown${asset}${interval}`;
  log("Command", { command });
  
  await ctx.reply(`🔍 Looking up ${asset} ${interval}...`);
  
  const slug = getSlug(asset, interval);
  const data = await getMarketData(slug);
  
  if (!data) {
    await ctx.reply(`❌ ${asset} ${interval} not found. Try again in 10-20 seconds.`);
    return;
  }
  
  const upPrice = (data.midpoints[data.tokenIds[0]] * 100).toFixed(1);
  const downPrice = (data.midpoints[data.tokenIds[1]] * 100).toFixed(1);
  
  const response = 
    `${data.title}\n\n` +
    `Slug: ${slug}\n\n` +
    `UP (mid): ${upPrice}¢\n` +
    `DOWN (mid): ${downPrice}¢\n\n` +
    `Source: Gamma event-by-slug + CLOB midpoints`;
  
  log("Success", { asset, interval, up: upPrice, down: downPrice });
  await ctx.reply(response);
}

// ========== COMMANDS ==========
bot.command("ping", async (ctx) => {
  log("Ping");
  await ctx.reply("pong");
});

bot.command("status", async (ctx) => {
  log("Status");
  await ctx.reply("🤖 Bot running\n\n✅ /updownbtc5m\n✅ /updownbtc15m\n✅ /updowneth5m\n✅ /updowneth15m");
});

bot.command("updownbtc5m", async (ctx) => handleUpDown(ctx, "BTC", "5m"));
bot.command("updownbtc15m", async (ctx) => handleUpDown(ctx, "BTC", "15m"));
bot.command("updowneth5m", async (ctx) => handleUpDown(ctx, "ETH", "5m"));
bot.command("updowneth15m", async (ctx) => handleUpDown(ctx, "ETH", "15m"));

// ========== ERROR HANDLING ==========
bot.catch((err) => log("Bot error", { error: err.message }));

// ========== EXPRESS SERVER ==========
const app = express();
app.get("/", (req, res) => res.send("AIBINGWA Bot Running"));

const server = app.listen(PORT, () => {
  log(`Server on port ${PORT}`);
});

// ========== START BOT ==========
setupBot().then(() => {
  bot.start({ onStart: (info) => log(`Bot started as @${info.username}`) });
});

// ========== GRACEFUL SHUTDOWN ==========
async function shutdown(signal) {
  log(`Shutdown: ${signal}`);
  await bot.stop();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
