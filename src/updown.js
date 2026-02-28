// src/updown.js
import { fetchMarkets } from "./polymarket.js";

function scoreUpDown(question, asset, minutes) {
  const q = (question || "").toLowerCase();
  const a = asset.toLowerCase();

  let score = 0;
  if (q.includes("up or down")) score += 5;
  if (q.includes(a)) score += 5;

  // minutes matching
  if (minutes) {
    const mStr = String(minutes);
    if (q.includes(`${mStr} minute`)) score += 4;
    if (q.includes(`${mStr} minutes`)) score += 4;
    if (q.includes(`${mStr}min`)) score += 3;
  }

  // bonus if looks like a short-term market
  if (q.includes("5 minute") || q.includes("15 minute") || q.includes("60 minute")) score += 1;

  return score;
}

export async function findUpDownMarket(asset = "btc", minutes = 15) {
  // fetch broader set then pick best match
  const seed = await fetchMarkets("up or down", 30);
  let best = null;
  let bestScore = -1;

  for (const m of seed) {
    const s = scoreUpDown(m.question, asset, minutes);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }

  return { best, bestScore };
}

export function formatUpDown(result, asset, minutes) {
  if (!result?.best || result.bestScore < 5) {
    return `Couldn't find a strong Up/Down match for ${asset.toUpperCase()} ${minutes}m yet. Try /updown btc 5 or /updown eth 15`;
  }

  const m = result.best;
  const prices = Array.isArray(m.prices) ? m.prices.slice(0, 2).join(", ") : "n/a";
  return `Best match ✅\nAsset: ${asset.toUpperCase()}\nWindow: ${minutes} minutes\n\nQ: ${m.question}\nVolume: ${m.volume}\nLiquidity: ${m.liquidity}\nSlug: ${m.slug}\nPrices: ${prices}`;
}
