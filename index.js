import { Bot, InlineKeyboard } from "grammy";
import { appendJournal, tailJournal, resolveUpDown } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ---- Config ----
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

function compactStatusText() {
  return [
    "📊 *Status*",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
  ].join("\n");
}

function detailedStatusText() {
  return [
    "📊 *Status (details)*",
    "",
    `Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    "",
    `AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"}`,
    `AI model: \`${AI_MODEL}\``,
    "",
    "_Data: Gamma event-by-slug + CLOB midpoints (public reads)._",
  ].join("\n");
}

// ---- Startup: clear webhook so polling works ----
async function boot() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("✅ Webhook cleared. Polling should work.");
  } catch (e) {
    console.log("⚠️ deleteWebhook failed (usually fine):", e?.message ?? e);
  }

  console.log("BOOT ✅", {
    SIMULATION_ON,
    SIM_CASH,
    AI_ENABLED,
    AI_MODEL,
  });

  console.log("Bot running ✅ (polling)");
  bot.start();
}

bot.command("ping", async (ctx) => {
  await ctx.reply("pong ✅");
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "Try:",
      "• /status",
      "• /updownbtc5m",
      "• /updownbtc15m",
      "• /updowneth5m",
      "• /updowneth15m",
      "• /updownsol5m",
      "• /updownxrp5m",
      "",
      "Note: 60m is disabled for now (later update).",
    ].join("\n")
  );
});

bot.command("status", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details ▾", "status:details");
  await ctx.reply(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
});

bot.callbackQuery("status:details", async (ctx) => {
  const kb = new InlineKeyboard().text("Hide details ▴", "status:compact");
  await ctx.editMessageText(detailedStatusText(), { parse_mode: "Markdown", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("status:compact", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details ▾", "status:details");
  await ctx.editMessageText(compactStatusText(), { parse_mode: "Markdown", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// Show last journal lines
bot.command("log", async (ctx) => {
  const lines = await tailJournal(30);
  if (!lines.length) return ctx.reply("No journal entries yet.");
  await ctx.reply("🧾 Last activity:\n\n" + lines.join("\n"));
});

// No-space command: /updownbtc5m, /updowneth15m, /updownsol5m, /updownxrp15m
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m|60m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  if (interval === "60m") {
    await ctx.reply("⏸️ 60m is disabled for now. We’ll add it later after the concept is proven.");
    return;
  }

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  const startedAt = Date.now();
  await appendJournal(`CMD updown ${asset} ${interval}`);

  try {
    const out = await resolveUpDown({ asset, interval });

    if (!out.found) {
      await appendJournal(`MISS updown ${asset} ${interval} tried=${out.triedSlugs?.length ?? 0}`);

      const msg = [
        "❌ Up/Down not found yet.",
        `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
        "",
        "Tried slugs (latest 6):",
        ...(out.triedSlugs ?? []).slice(0, 6).map((s) => `- ${s}`),
        "",
        `Last error: ${out.lastError ?? "unknown"}`,
        "",
        "Tip: try again in 10-20 seconds (indexing delay happens).",
      ].join("\n");

      await ctx.reply(msg);
      return;
    }

    const up = out.upMid != null ? `${Math.round(out.upMid * 100)}¢` : "—";
    const down = out.downMid != null ? `${Math.round(out.downMid * 100)}¢` : "—";

    const tookMs = Date.now() - startedAt;
    await appendJournal(
      `HIT ${asset} ${interval} slug=${out.slug} up=${up} down=${down} ms=${tookMs}`
    );

    await ctx.reply(
      [
        `📈 *${out.title}*`,
        `Slug: \`${out.slug}\``,
        "",
        `UP (mid): ${up}`,
        `DOWN (mid): ${down}`,
        "",
        "_Source: Gamma event-by-slug + CLOB midpoints_",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("updown error:", e);
    await appendJournal(`ERR updown ${asset} ${interval} ${e?.message ?? e}`);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

boot();
