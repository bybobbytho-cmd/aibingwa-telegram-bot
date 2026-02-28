import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDownViaSlug } from "./src/polymarket.js";
import { journal, tailJournalText } from "./src/journal.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// -------- Config --------
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

function compactStatusText() {
  return [
    "📊 Status",
    ⁠ Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"} ⁠,
    ⁠ Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0} ⁠,
    ⁠ AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"} ⁠,
    ⁠ AI model: \ ⁠${AI_MODEL}\``,
    "",
    "Up/Down: slug → Gamma event-by-slug → CLOB midpoints",
    "Intervals: 5m, 15m (60m disabled for stability)",
  ].join("\n");
}

function detailedStatusText() {
  const inst = process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "unknown";
  return [
    "📊 Status (details)",
    "",
    ⁠ Instance: \ ⁠${inst}\``,
    ⁠ Simulation: ${SIMULATION_ON ? "✅ ON" : "❌ OFF"} ⁠,
    ⁠ Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0} ⁠,
    ⁠ AI: ${AI_ENABLED ? "✅ ON" : "❌ OFF"} ⁠,
    ⁠ AI model: \ ⁠${AI_MODEL}\``,
    "",
    "Note: If Railway logs show ⁠ 409 Conflict getUpdates ⁠, you have more than one bot instance running.",
  ].join("\n");
}

// -------- Commands --------
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
      "• /updownsol5m",
      "• /updownxrp5m",
      "• /log",
    ].join("\n")
  );
});

// /status with toggle
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

// Journaling: /log
bot.command("log", async (ctx) => {
  await ctx.reply(tailJournalText(20), { parse_mode: "Markdown" });
});

// Up/Down no-space commands
// ✅ support: btc, eth, sol, xrp
// ✅ support: 5m, 15m
// ❌ 60m disabled (stability first)
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  journal({
    level: "info",
    event: "updown_command",
    asset,
    interval,
  });

  await ctx.reply(⁠ 🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}... ⁠);

  try {
    const out = await resolveUpDownViaSlug({ asset, interval });

    if (!out.found) {
      journal({
        level: "warn",
        event: "updown_not_found",
        asset,
        interval,
        triedSlugs: out.triedSlugs,
        lastError: out.lastError,
      });

      const msg = [
        ⁠ ❌ Up/Down not found yet. ⁠,
        ⁠ Asset: ${asset.toUpperCase()} | Interval: ${interval} ⁠,
        out.windowStart ? ⁠ WindowStart: ${out.windowStart} ⁠ : "",
        "",
        ⁠ Tried slugs (latest ${Math.min(out.triedSlugs.length, 6)}): ⁠,
        ...out.triedSlugs.slice(0, 6).map((s) => ⁠ - ${s} ⁠),
        "",
        out.lastError ? ⁠ Last error: ${out.lastError} ⁠ : "Last error: (none)",
        "",
        "Tip: if you ran this exactly on the boundary, try again in ~10 seconds.",
      ]
        .filter(Boolean)
        .join("\n");

      await ctx.reply(msg);
      return;
    }

    const up = out.upMid != null ? ⁠ ${Math.round(out.upMid * 100)}¢ ⁠ : "—";
    const down = out.downMid != null ? ⁠ ${Math.round(out.downMid * 100)}¢ ⁠ : "—";

    journal({
      level: "info",
      event: "updown_found",
      asset,
      interval,
      title: out.title,
      slug: out.slug,
      upMid: out.upMid,
      downMid: out.downMid,
    });

    await ctx.reply(
      [
        ⁠ 📈 *${out.title}* ⁠,
        ⁠ Slug: \ ⁠${out.slug}\``,
        "",
        ⁠ UP (mid): ${up} ⁠,
        ⁠ DOWN (mid): ${down} ⁠,
        "",
        ⁠ _Source: Gamma event-by-slug + CLOB midpoints_ ⁠,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    journal({
      level: "error",
      event: "updown_exception",
      asset,
      interval,
      error: String(e?.message || e),
    });

    console.error("updown error:", e);
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

// If someone tries 60m, be explicit
bot.hears(/^\/updown(btc|eth|sol|xrp)60m$/i, async (ctx) => {
  await ctx.reply("⚠️ 60m is disabled for now (stability first). Use 5m or 15m.");
});

console.log("Bot running ✅ (polling)");
bot.start();
