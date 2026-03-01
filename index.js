import { Bot, InlineKeyboard, GrammyError, HttpError } from "grammy";
import { resolveUpDownMarketAndPrice } from "./src/polymarket.js";

const TOKEN =
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.BOT_TOKEN; // fallback only (doesn't change your Railway setup)

if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --------------------
// Config (read-only)
// --------------------
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

// --------------------
// Helpers
// --------------------
function compactStatusText() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
  ].join("\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------
// Commands (keep simple)
// --------------------
bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("status", async (ctx) => {
  const kb = new InlineKeyboard();
  await ctx.reply(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
});

// --------------------
// UP / DOWN (unchanged logic call)
// --------------------
bot.hears(/^\/updown(btc|eth)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  await ctx.reply(`🔎 Fetching LIVE ${asset.toUpperCase()} ${interval} market...`);

  try {
    const result = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!result || !result.found) {
      await ctx.reply(`❌ Up/Down not found.\nAsset: ${asset.toUpperCase()} | Interval: ${interval}`);
      return;
    }

    const up = result.upMid != null ? `${Math.round(result.upMid * 100)}¢` : "—";
    const down = result.downMid != null ? `${Math.round(result.downMid * 100)}¢` : "—";

    await ctx.reply(
      [`📈 *${result.title}*`, "", `UP (mid): ${up}`, `DOWN (mid): ${down}`, "", `_Source: Gamma + CLOB_`].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("🔥 ERROR in /updown handler:", err);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs.");
  }
});

// --------------------
// Global error log (doesn't crash the process)
// --------------------
bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("GrammyError:", e.description);
  } else if (e instanceof HttpError) {
    console.error("HttpError contacting Telegram:", e);
  } else {
    console.error("Unknown error:", e);
  }
});

// --------------------
// Railway-safe polling loop (fixes 409 loops)
// --------------------
async function startPollingForever() {
  // Clean start: ensure webhook is off + drop backlog
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("✅ Webhook cleared, pending updates dropped.");
  } catch (e) {
    console.log("⚠️ deleteWebhook failed (continuing):", e?.message ?? e);
  }

  // If Telegram returns 409 due to overlap, retry instead of crashing
  // Backoff grows a bit to reduce thrashing during deploy overlaps
  let backoffMs = 2500;

  while (true) {
    try {
      console.log("🤖 Bot running ✅ (polling)");
      await bot.start({
        allowed_updates: ["message", "callback_query"],
      });

      // bot.start only returns when stopped
      console.log("🛑 Bot stopped. Restarting polling in 2s...");
      await sleep(2000);
    } catch (e) {
      const msg = String(e?.description ?? e?.message ?? e);

      if (msg.includes("terminated by other getUpdates request") || msg.includes("409")) {
        console.warn(`⚠️ Telegram 409 conflict. Retrying in ${Math.round(backoffMs / 1000)}s...`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs + 1500, 12000);
        continue;
      }

      console.error("🔥 Polling crashed with non-409 error:", e);
      // Give it a short cooldown then retry anyway (keeps bot alive)
      await sleep(5000);
    }
  }
}

// Graceful shutdown (helps Railway handover)
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

startPollingForever();
