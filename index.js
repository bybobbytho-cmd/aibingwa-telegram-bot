import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDownMarketAndPrice, searchMarketsBasic } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Settings (Stage 1)
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
    "",
    "_Data: Gamma (events/markets) + CLOB (midpoints), public only_",
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
    "_Commands (no spaces):_",
    "• /ping",
    "• /status",
    "• /marketsbtc  /marketseth  /marketscrypto",
    "• /updownbtc5m  /updownbtc15m  /updownbtc60m",
    "• /updowneth5m  /updowneth15m  /updowneth60m",
  ].join("\n");
}

bot.command("ping", async (ctx) => ctx.reply("pong ✅"));

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Bot is live ✅",
      "",
      "Try:",
      "• /status",
      "• /marketsbtc",
      "• /updownbtc5m",
    ].join("\n")
  );
});

// Status dropdown
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

// No-space markets commands: /marketsbtc /marketscrypto etc
bot.hears(/^\/markets([a-z0-9_-]+)$/i, async (ctx) => {
  const q = String(ctx.match?.[1] ?? "").trim().toLowerCase();
  if (!q) return;

  await ctx.reply("🔎 Fetching LIVE markets (Gamma /markets active=true)...");
  try {
    const results = await searchMarketsBasic(q, 8);
    if (!results.length) {
      await ctx.reply(`No markets found for: ${q}`);
      return;
    }

    const msg = results
      .map((m, i) => {
        const vol = m.volume != null ? `$${Math.round(Number(m.volume)).toLocaleString()}` : "—";
        const liq = m.liquidity != null ? `$${Math.round(Number(m.liquidity)).toLocaleString()}` : "—";
        return `${i + 1}) ${m.title}\n   Vol: ${vol}  Liq: ${liq}\n   Slug: ${m.slug || "—"}`;
      })
      .join("\n\n");

    await ctx.reply(msg);
  } catch (e) {
    console.error("markets error:", e);
    await ctx.reply("⚠️ markets failed. Check Railway logs.");
  }
});

// Up/Down no-space commands: /updownbtc5m /updowneth15m etc
bot.hears(/^\/updown(btc|eth)(5m|15m|60m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1]).toLowerCase();
  const interval = String(ctx.match?.[2]).toLowerCase();

  await ctx.reply(`🔎 Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDownMarketAndPrice({ asset, interval });

    if (!out.found) {
      const lines = [
        `❌ Up/Down not found yet.`,
        `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
      ];

      if (out.debug?.tried?.length) {
        lines.push("", "Tried slugs:");
        for (const s of out.debug.tried) lines.push(`- ${s}`);
      }

      if (out.debug?.lastError) {
        lines.push(
          "",
          `Last error: ${out.debug.lastError.message}`,
          out.debug.lastError.status ? `HTTP status: ${out.debug.lastError.status}` : "",
          out.debug.lastError.bodySnippet ? `Body: ${out.debug.lastError.bodySnippet}` : ""
        );
      }

      await ctx.reply(lines.filter(Boolean).join("\n"));
      return;
    }

    const up = out.upMid != null ? `${Math.round(out.upMid * 100)}¢` : "—";
    const down = out.downMid != null ? `${Math.round(out.downMid * 100)}¢` : "—";

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
    await ctx.reply("⚠️ Up/Down failed. Check Railway logs for details.");
  }
});

console.log("Bot running ✅ (polling)");
bot.start();
