const CLOB_BASE = "https://clob.polymarket.com";

const COMMON_HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (compatible; aibingwa-telegram-bot/1.0; +https://github.com/bybobbytho-cmd/aibingwa-telegram-bot)",
};

function qs(params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? ?${s} : "";
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: COMMON_HEADERS });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(HTTP ${res.status} ${url} :: ${text.slice(0, 250)});
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(Invalid JSON from ${url} :: ${text.slice(0, 250)});
    err.status = 500;
    throw err;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { ...COMMON_HEADERS, accept: "text/plain" },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(HTTP ${res.status} ${url} :: ${text.slice(0, 250)});
    err.status = res.status;
    throw err;
  }
  return text.trim();
}

export function intervalToSeconds(intervalStr) {
  const map = { "5m": 300, "15m": 900, "60m": 3600 };
  const sec = map[String(intervalStr).toLowerCase()];
  if (!sec) throw new Error(Unsupported interval: ${intervalStr});
  return sec;
}

export async function getClobServerTimeSec() {
  // CLOB time endpoint exists and returns a numeric timestamp.  [oai_citation:2‡Polymarket Documentation](https://docs.polymarket.com/resources/error-codes?utm_source=chatgpt.com)
  const raw = await fetchText(${CLOB_BASE}/time);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(Invalid /time response: "${raw}");
  // normalize ms -> sec if needed
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * CLOB sampling markets:
 * GET https://clob.polymarket.com/sampling-markets
 * Response includes question, description, market_slug, end_date_iso, tokens[{token_id,outcome,price}], etc.  [oai_citation:3‡Polymarket Documentation](https://docs.polymarket.com/api-reference/markets/get-sampling-markets)
 */
export async function getSamplingMarkets(next_cursor) {
  const url = ${CLOB_BASE}/sampling-markets${qs({ next_cursor })};
  return fetchJson(url);
}

/**
 * CLOB prices endpoint exists; we use it to confirm token prices if needed.
 * (Docs show multiple market data endpoints including prices.)  [oai_citation:4‡Polymarket Documentation](https://docs.polymarket.com/resources/error-codes?utm_source=chatgpt.com)
 */
export async function getClobPrices(tokenIds) {
  const token_ids = tokenIds.join(",");
  const url = ${CLOB_BASE}/prices${qs({ token_ids })};
  return fetchJson(url);
}

function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function intervalMatchers(intervalStr) {
  const i = String(intervalStr).toLowerCase();
  if (i === "5m") {
    return [
      /5\s*min/i,
      /5\s*minute/i,
      /\b5m\b/i,
      /-5m-/i,
    ];
  }
  if (i === "15m") {
    return [
      /15\s*min/i,
      /15\s*minute/i,
      /\b15m\b/i,
      /-15m-/i,
    ];
  }
  if (i === "60m") {
    return [
      /60\s*min/i,
      /60\s*minute/i,
      /1\s*hour/i,
      /\b60m\b/i,
      /-60m-/i,
    ];
  }
  return [];
}

function assetMatchers(asset) {
  const a = String(asset).toLowerCase();
  if (a === "btc" || a === "bitcoin") return [/btc/i, /bitcoin/i];
  if (a === "eth" || a === "ethereum") return [/eth/i, /ethereum/i];
  return [new RegExp(a, "i")];
}

function looksLikeUpDown(m) {
  const q = normalizeText(m?.question);
  const d = normalizeText(m?.description);
  const s = normalizeText(m?.market_slug);

  // We want the rolling Up/Down markets
  return (
    q.includes("up") && q.includes("down") ||
    d.includes("up") && d.includes("down") ||
    s.includes("updown") ||
    q.includes("up/down") ||
    d.includes("up/down")
  );
}

function marketIsTradeable(m) {
  // sampling-markets includes these fields  [oai_citation:5‡Polymarket Documentation](https://docs.polymarket.com/api-reference/markets/get-sampling-markets)
  return (
    m?.enable_order_book === true &&
    m?.active === true &&
    m?.accepting_orders === true &&
    m?.closed !== true &&
    m?.archived !== true
  );
}

function parseIsoToSec(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function pickCurrentWindowMarket(candidates, nowSec) {
  // Prefer the soonest end_date_iso that is still in the future (the current live window).
  let best = null;
  let bestDelta = Infinity;

  for (const m of candidates) {
    const endSec = parseIsoToSec(m?.end_date_iso);
    if (!endSec) continue;
    const delta = endSec - nowSec;
    if (delta > 0 && delta < bestDelta) {
      best = m;
      bestDelta = delta;
    }
  }

  // If none are “future”, fall back to first candidate
  return best || candidates[0] || null;
}

function extractUpDownTokens(market) {
  const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
  if (tokens.length < 2) return null;

  // Best case: outcomes literally include "Up" and "Down"
  const up = tokens.find((t) => normalizeText(t?.outcome).includes("up"));
  const down = tokens.find((t) => normalizeText(t?.outcome).includes("down"));

  if (up && down) {
    return {
      upTokenId: String(up.token_id),
      downTokenId: String(down.token_id),
      upPrice: typeof up.price === "number" ? up.price : Number(up.price),
      downPrice: typeof down.price === "number" ? down.price : Number(down.price),
    };
  }

  // Fallback: use first two tokens
  return {
    upTokenId: String(tokens[0].token_id),
    downTokenId: String(tokens[1].token_id),
    upPrice: typeof tokens[0].price === "number" ? tokens[0].price : Number(tokens[0].price),
    downPrice: typeof tokens[1].price === "number" ? tokens[1].price : Number(tokens[1].price),
  };
}

/**
 * The FIX:
 * Discover Up/Down markets via CLOB sampling-markets (NOT Gamma).
 * - Pull a few pages
 * - Filter for asset + interval + up/down
 * - Pick current window via end_date_iso closest in the future
 * - Read prices from tokens or confirm via /prices
 */
export async function resolveLiveUpDown(asset, intervalStr) {
  const interval = String(intervalStr).toLowerCase();
  const nowSec = await getClobServerTimeSec();

  const assetRx = assetMatchers(asset);
  const intervalRx = intervalMatchers(interval);

  const MAX_PAGES = 6; // keep it light
  let cursor = undefined;
  let all = [];

  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await getSamplingMarkets(cursor);
    const data = Array.isArray(page?.data) ? page.data : [];
    all = all.concat(data);

    cursor = page?.next_cursor || null;
    if (!cursor) break;
  }

  // Filter aggressively
  const candidates = all.filter((m) => {
    if (!marketIsTradeable(m)) return false;
    if (!looksLikeUpDown(m)) return false;

    const blob = ${m?.question || ""} ${m?.description || ""} ${m?.market_slug || ""};
    const assetOk = assetRx.some((rx) => rx.test(blob));
    if (!assetOk) return false;

    const intervalOk = intervalRx.length
      ? intervalRx.some((rx) => rx.test(blob))
      : true;

    return intervalOk;
  });

  if (!candidates.length) {
    return {
      ok: false,
      error: No matching Up/Down markets found via CLOB sampling-markets.,
      debug: { scanned: all.length, asset: String(asset), interval },
    };
  }

  const chosen = pickCurrentWindowMarket(candidates, nowSec);
  const tokenInfo = extractUpDownTokens(chosen);

  if (!chosen || !tokenInfo) {
    return {
      ok: false,
      error: Found candidates but could not extract tokens.,
      debug: { candidates: candidates.length },
    };
  }

  // Confirm prices via /prices (sometimes token.price is fine, but this is safer)
  let upPrice = Number.isFinite(tokenInfo.upPrice) ? tokenInfo.upPrice : null;
  let downPrice = Number.isFinite(tokenInfo.downPrice) ? tokenInfo.downPrice : null;

  try {
    const prices = await getClobPrices([tokenInfo.upTokenId, tokenInfo.downTokenId]);
    const up = Number(prices?.[tokenInfo.upTokenId]);
    const down = Number(prices?.[tokenInfo.downTokenId]);
    if (Number.isFinite(up)) upPrice = up;
    if (Number.isFinite(down)) downPrice = down;
  } catch {
    // ignore; keep token snapshot prices
  }

  return {
    ok: true,
    title: chosen?.question || chosen?.description || "Up/Down",
    marketSlug: chosen?.market_slug || null,
    endDateIso: chosen?.end_date_iso || null,
    upTokenId: tokenInfo.upTokenId,
    downTokenId: tokenInfo.downTokenId,
    upPrice,
    downPrice,
  };
}

export function formatUpDownLiveMessage(res, asset, intervalStr) {
  const interval = String(intervalStr).toLowerCase();

  if (!res?.ok) {
    return [
      ❌ Up/Down not found (CLOB discovery).,
      Asset: ${String(asset).toUpperCase()} | Interval: ${interval},
      Reason: ${res?.error || "unknown"},
      res?.debug?.scanned ? Scanned: ${res.debug.scanned} markets : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const upPct = res.upPrice === null ? "?" : (res.upPrice * 100).toFixed(1) + "%";
  const downPct = res.downPrice === null ? "?" : (res.downPrice * 100).toFixed(1) + "%";

  // We may not always have a slug that matches polymarket.com/event/<slug> for these,
  // so we keep it clean and informational.
  const ends = res.endDateIso ? Ends: ${res.endDateIso} : null;

  return [
    📈 Up/Down LIVE (${String(asset).toUpperCase()} ${interval}),
    res.title,
    ends,
    "",
    UP: ${upPct},
    DOWN: ${downPct},
  ]
    .filter(Boolean)
    .join("\n");
}
