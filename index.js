import { Bot, InlineKeyboard } from "grammy";
import { resolveUpDown } from "./src/polymarket.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// --- config flags (Railway vars) ---
const SIMULATION_ON = (process.env.SIMULATION ?? "true").toLowerCase() === "true";
const SIM_CASH = Number(process.env.SIM_CASH ?? "50");
const AI_ENABLED = (process.env.AI_ENABLED ?? "false").toLowerCase() === "true";
const AI_MODEL = process.env.AI_MODEL ?? "unset";

// --- simple in-memory journal (progress log) ---
const JOURNAL = [];
function logEvent(type, data) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    data,
  };
  JOURNAL.push(entry);
  if (JOURNAL.length > 60) JOURNAL.shift(); // keep last 60
  console.log("[JOURNAL]", JSON.stringify(entry));
}

function yn(b) {
  return b ? "YES" : "NO";
}

function statusCompact() {
  return [
    "Status",
    `Simulation: ${SIMULATION_ON ? "ON" : "OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    `AI: ${AI_ENABLED ? "ON" : "OFF"}`,
  ].join("\n");
}

function statusDetails() {
  const hasTelegram = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const hasBankr = Boolean(process.env.BANKR_API_KEY);
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);

  return [
    "Status (details)",
    "",
    `Simulation: ${SIMULATION_ON ? "ON" : "OFF"}`,
    `Sim cash: $${Number.isFinite(SIM_CASH) ? SIM_CASH : 0}`,
    "",
    `AI: ${AI_ENABLED ? "ON" : "OFF"}`,
    `AI model: ${AI_MODEL}`,
    "",
    "Keys present (just presence check):",
    `Telegram: ${yn(hasTelegram)} | Bankr: ${yn(hasBankr)}`,
    `OpenAI: ${yn(hasOpenAI)} | Anthropic: ${yn(hasAnthropic)} | Gemini: ${yn(hasGemini)}`,
    "",
    "Data: Gamma (event-by-slug) + CLOB (midpoints)",
  ].join("\n");
}

// ---- commands ----
bot.command("start", async (ctx) => {
  logEvent("start", { user: ctx.from?.id });
  await ctx.reply(
    [
      "Number48 is live.",
      "",
      "Try:",
      "/ping",
      "/status",
      "/updownbtc5m",
      "/updowneth15m",
      "/updownsol5m",
      "/updownxrp15m",
      "",
      "Note: 60m is disabled for now (we add later).",
    ].join("\n")
  );
});

bot.command("ping", async (ctx) => {
  logEvent("ping", { user: ctx.from?.id });
  await ctx.reply("pong");
});

// /status with dropdown toggle
bot.command("status", async (ctx) => {
  logEvent("status", { user: ctx.from?.id });
  const kb = new InlineKeyboard().text("Show details", "status:details");
  await ctx.reply(statusCompact(), { reply_markup: kb });
});

bot.callbackQuery("status:details", async (ctx) => {
  const kb = new InlineKeyboard().text("Hide details", "status:compact");
  await ctx.editMessageText(statusDetails(), { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("status:compact", async (ctx) => {
  const kb = new InlineKeyboard().text("Show details", "status:details");
  await ctx.editMessageText(statusCompact(), { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// /log (show last 12 journal entries)
bot.command("log", async (ctx) => {
  const last = JOURNAL.slice(-12);
  if (!last.length) return ctx.reply("No log entries yet.");
  const msg = last
    .map((e) => `${e.ts} | ${e.type} | ${JSON.stringify(e.data)}`)
    .join("\n");
  await ctx.reply(msg);
});

// Up/Down no-space commands: /updownbtc5m, /updowneth15m, /updownsol5m, /updownxrp15m
// 60m intentionally removed for now
bot.hears(/^\/updown(btc|eth|sol|xrp)(5m|15m)$/i, async (ctx) => {
  const asset = String(ctx.match?.[1] ?? "").toLowerCase();
  const interval = String(ctx.match?.[2] ?? "").toLowerCase();

  logEvent("updown_request", { asset, interval, user: ctx.from?.id });

  await ctx.reply(`Resolving LIVE ${asset.toUpperCase()} Up/Down ${interval}...`);

  try {
    const out = await resolveUpDown({ asset, interval });

    if (!out.found) {
      logEvent("updown_not_found", { asset, interval, tried: out.triedSlugs, lastError: out.lastError });
      const lines = [
        "Up/Down not found yet.",
        `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
        "",
        "Tried slugs (latest 6):",
        ...(out.triedSlugs || []).slice(0, 6).map((s) => `- ${s}`),
        "",
        `Last error: ${out.lastError || "none"}`,
        "",
        "Tip: try again in 10-20 seconds (indexing delay happens).",
      ];
      return ctx.reply(lines.join("\n"));
    }

    logEvent("updown_success", {
      asset,
      interval,
      slug: out.slug,
      upMid: out.upMid,
      downMid: out.downMid,
    });

    const up = out.upMid != null ? `${Math.round(out.upMid * 100)}c` : "N/A";
    const down = out.downMid != null ? `${Math.round(out.downMid * 100)}c` : "N/A";

    const msg = [
      out.title,
      `Slug: ${out.slug}`,
      "",
      `UP (mid): ${up}`,
      `DOWN (mid): ${down}`,
      "",
      "Source: Gamma event-by-slug + CLOB midpoints",
    ].join("\n");

    await ctx.reply(msg);
  } catch (e) {
    console.error("updown handler error:", e);
    logEvent("updown_error", { asset, interval, err: String(e?.message || e) });
    await ctx.reply("Up/Down failed. Check Railway logs.");
  }
});

console.log("Bot running (polling)");
bot.start();
