import "dotenv/config";
import { Bot } from "grammy";

// =======================
// ENV + FLAGS
// =======================
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in env");

const bot = new Bot(token);

// Toggles you can change in Railway Variables
let AI_ENABLED = (process.env.AI_ENABLED || "off").toLowerCase() === "on";
let MODE = (process.env.MODE || "SIMULATION").toUpperCase(); // SIMULATION | LIVE (LIVE not implemented here)
let AI_PROVIDER = (process.env.AI_PROVIDER || "gemini").toLowerCase(); // gemini | openai | anthropic
let AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash";

// Simple in-memory sim wallet (resets if server restarts)
const simState = {
  cash: Number(process.env.SIM_CASH || 50), // starting bankroll
  positions: {}, // tokenId -> shares (positive = YES shares, negative could represent NO if you do that later)
  trades: [], // log of actions
};

// =======================
// POLYMARKET (FREE READ APIs)
// =======================
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

// Helper: safe fetch json
async function getJSON(url) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 300)}`);
  }
  return res.json();
}

// Get market by slug (nice for /market <slug>)
async function fetchMarketBySlug(slug) {
  // Gamma has different endpoints depending on version; this tends to work:
  // /markets?slug=...
  const url = `${GAMMA}/markets?slug=${encodeURIComponent(slug)}`;
  const data = await getJSON(url);

  // Gamma usually returns an array
  const market = Array.isArray(data) ? data[0] : (data?.markets?.[0] ?? null);
  if (!market) throw new Error("Market not found for that slug.");

  return market;
}

// Get orderbook (CLOB read, no auth)
async function fetchOrderBook(tokenId) {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  return getJSON(url);
}

// Get midpoint (simple derived from best bid/ask)
function calcMidpoint(orderbook) {
  const bestBid = Array.isArray(orderbook?.bids) && orderbook.bids.length ? Number(orderbook.bids[0].price) : null;
  const bestAsk = Array.isArray(orderbook?.asks) && orderbook.asks.length ? Number(orderbook.asks[0].price) : null;
  if (bestBid == null && bestAsk == null) return null;
  if (bestBid == null) return bestAsk;
  if (bestAsk == null) return bestBid;
  return (bestBid + bestAsk) / 2;
}

// =======================
// AI PROVIDERS
// =======================
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  const model = AI_MODEL || "gemini-1.5-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("") ||
    "No output.";
  return text.trim();
}

async function callOpenAI(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const model = AI_MODEL || "gpt-4.1-mini";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: 400,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const out =
    data?.output_text ||
    data?.output?.map(o => o?.content?.map(c => c?.text).join("")).join("") ||
    "No output.";
  return String(out).trim();
}

async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  const model = AI_MODEL || "claude-3-5-sonnet-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const out = data?.content?.map(p => p?.text).join("") || "No output.";
  return String(out).trim();
}

async function runAI(prompt) {
  if (!AI_ENABLED) return "AI: off (turn on with /ai on)";
  if (AI_PROVIDER === "gemini") return callGemini(prompt);
  if (AI_PROVIDER === "openai") return callOpenAI(prompt);
  if (AI_PROVIDER === "anthropic") return callAnthropic(prompt);
  return `Unknown AI_PROVIDER: ${AI_PROVIDER}`;
}

// =======================
// COMMANDS
// =======================
function statusText() {
  return [
    `Bot is live ✅`,
    `AI: ${AI_ENABLED ? "on" : "off"}`,
    `Provider: ${AI_PROVIDER}`,
    `Model: ${AI_MODEL}`,
    `Mode: ${MODE}`,
    `SIM cash: $${simState.cash.toFixed(2)}`,
  ].join("\n");
}

bot.command("start", async (ctx) => {
  await ctx.reply(statusText());
});

// Toggle AI
bot.command("ai", async (ctx) => {
  const arg = (ctx.message.text.split(" ")[1] || "").toLowerCase();
  if (arg === "on") AI_ENABLED = true;
  if (arg === "off") AI_ENABLED = false;
  await ctx.reply(statusText());
});

// Switch provider: /provider gemini | openai | anthropic
bot.command("provider", async (ctx) => {
  const arg = (ctx.message.text.split(" ")[1] || "").toLowerCase();
  if (["gemini", "openai", "anthropic"].includes(arg)) {
    AI_PROVIDER = arg;
    await ctx.reply(`Provider set ✅\n${statusText()}`);
  } else {
    await ctx.reply("Use: /provider gemini OR /provider openai OR /provider anthropic");
  }
});

// Switch model: /model gemini-1.5-flash
bot.command("model", async (ctx) => {
  const arg = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!arg) return ctx.reply("Use: /model <model-name>");
  AI_MODEL = arg;
  await ctx.reply(`Model set ✅\n${statusText()}`);
});

// Mode: /mode sim | live (live only a label for now)
bot.command("mode", async (ctx) => {
  const arg = (ctx.message.text.split(" ")[1] || "").toLowerCase();
  if (arg === "sim") MODE = "SIMULATION";
  if (arg === "live") MODE = "LIVE";
  await ctx.reply(statusText());
});

// Polymarket: fetch market by slug
// /market will-trump-win-2024 (example slug)
bot.command("market", async (ctx) => {
  try {
    const slug = ctx.message.text.split(" ").slice(1).join(" ").trim();
    if (!slug) return ctx.reply("Use: /market <market-slug>");

    const m = await fetchMarketBySlug(slug);

    // Many markets have outcomes; token IDs differ per outcome.
    // We’ll print basics + any token ids we can see.
    const title = m.title || m.question || "Untitled market";
    const id = m.id ?? m.marketId ?? "unknown";
    const close = m.endDate || m.end_date || m.close_time || "unknown";

    // Try common token id locations
    const tokenGuess =
      m.clobTokenId ||
      m.tokenId ||
      m.token_id ||
      m?.tokens?.[0]?.token_id ||
      m?.outcomes?.[0]?.tokenId ||
      null;

    await ctx.reply(
      [
        `📌 ${title}`,
        `ID: ${id}`,
        `Closes: ${close}`,
        tokenGuess ? `TokenID (guess): ${tokenGuess}` : `TokenID: not found in this response`,
        `Tip: if you have the tokenId, use /book <tokenId> or /price <tokenId>`,
      ].join("\n")
    );
  } catch (e) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

// CLOB orderbook: /book <tokenId>
bot.command("book", async (ctx) => {
  try {
    const tokenId = ctx.message.text.split(" ")[1];
    if (!tokenId) return ctx.reply("Use: /book <tokenId>");
    const book = await fetchOrderBook(tokenId);

    const mid = calcMidpoint(book);
    const bid = book?.bids?.[0]?.price ?? "n/a";
    const ask = book?.asks?.[0]?.price ?? "n/a";

    await ctx.reply(
      [
        `📚 Orderbook tokenId: ${tokenId}`,
        `Best bid: ${bid}`,
        `Best ask: ${ask}`,
        mid != null ? `Midpoint: ${mid.toFixed(4)}` : `Midpoint: n/a`,
      ].join("\n")
    );
  } catch (e) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Price only: /price <tokenId>
bot.command("price", async (ctx) => {
  try {
    const tokenId = ctx.message.text.split(" ")[1];
    if (!tokenId) return ctx.reply("Use: /price <tokenId>");
    const book = await fetchOrderBook(tokenId);
    const mid = calcMidpoint(book);
    if (mid == null) return ctx.reply("No bid/ask yet.");
    await ctx.reply(`Midpoint price: ${mid.toFixed(4)} for tokenId ${tokenId}`);
  } catch (e) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Analyze a token with AI using live orderbook data (free fetch + optional AI)
// /analyze <tokenId>
bot.command("analyze", async (ctx) => {
  try {
    const tokenId = ctx.message.text.split(" ")[1];
    if (!tokenId) return ctx.reply("Use: /analyze <tokenId>");

    const book = await fetchOrderBook(tokenId);
    const mid = calcMidpoint(book);

    const prompt = `
You are helping me test a Polymarket strategy in SIMULATION mode.
Given this orderbook snapshot JSON and midpoint, give:
1) a quick read of spread/liquidity,
2) a cautious suggestion (BUY/WAIT) for a tiny test size,
3) what to log next.

TokenId: ${tokenId}
Midpoint: ${mid ?? "n/a"}
Orderbook JSON:
${JSON.stringify(book).slice(0, 6000)}
`.trim();

    const out = await runAI(prompt);
    await ctx.reply(out);
  } catch (e) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Simple sim trade log (does NOT place real trades)
// /simbuy <tokenId> <usd>
bot.command("simbuy", async (ctx) => {
  try {
    const parts = ctx.message.text.split(" ").filter(Boolean);
    const tokenId = parts[1];
    const usdStr = parts[2];

    if (!tokenId || !usdStr) return ctx.reply("Use: /simbuy <tokenId> <usd>");

    const usd = Number(usdStr);
    if (!Number.isFinite(usd) || usd <= 0) return ctx.reply("USD must be a positive number.");
    if (usd > simState.cash) return ctx.reply(`Not enough SIM cash. You have $${simState.cash.toFixed(2)}.`);

    const book = await fetchOrderBook(tokenId);
    const mid = calcMidpoint(book);
    if (mid == null) return ctx.reply("No bid/ask yet, cannot simulate a fill.");

    const shares = usd / mid; // simple fill at midpoint (rough sim)
    simState.cash -= usd;
    simState.positions[tokenId] = (simState.positions[tokenId] || 0) + shares;

    const trade = { ts: new Date().toISOString(), side: "BUY", tokenId, usd, price: mid, shares };
    simState.trades.push(trade);

    // log to Railway logs too
    console.log("SIM_TRADE", trade);

    await ctx.reply(
      [
        `✅ SIM BUY`,
        `tokenId: ${tokenId}`,
        `price(mid): ${mid.toFixed(4)}`,
        `usd: $${usd.toFixed(2)}`,
        `shares: ${shares.toFixed(4)}`,
        `cash left: $${simState.cash.toFixed(2)}`,
      ].join("\n")
    );
  } catch (e) {
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Report sim state
bot.command("report", async (ctx) => {
  const posLines = Object.entries(simState.positions).map(([k, v]) => `${k}: ${Number(v).toFixed(4)} shares`);
  await ctx.reply(
    [
      `📊 SIM REPORT`,
      `Cash: $${simState.cash.toFixed(2)}`,
      `Positions:`,
      posLines.length ? posLines.join("\n") : "(none)",
      `Trades logged: ${simState.trades.length}`,
      `Tip: open Railway Logs and search "SIM_TRADE" to copy your trade history.`,
    ].join("\n")
  );
});

// Default chat text → simple help (keeps it predictable, avoids burning AI accidentally)
bot.on("message:text", async (ctx) => {
  const txt = ctx.message.text.trim();
  if (txt.startsWith("/")) return; // ignore unknown slash commands

  await ctx.reply(
    [
      `Commands:`,
      `/start`,
      `/ai on | /ai off`,
      `/provider gemini | openai | anthropic`,
      `/model <model-name>`,
      `/mode sim | /mode live`,
      `/market <slug>`,
      `/book <tokenId>`,
      `/price <tokenId>`,
      `/analyze <tokenId> (uses AI only if AI is on)`,
      `/simbuy <tokenId> <usd>`,
      `/report`,
    ].join("\n")
  );
});

bot.start();
console.log("Bot running ✅");
