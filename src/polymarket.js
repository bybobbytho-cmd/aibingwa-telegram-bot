const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ---------
// HTTP util
// ---------
async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json" },
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // keep data null
    }

    if (!res.ok) {
      const msg = `HTTP ${res.status} ${res.statusText} for ${url}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

// ----------------------
// Gamma: public-search
// ----------------------
// Docs: Gamma includes /public-search (search across events/markets/profiles). :contentReference[oaicite:2]{index=2}
async function gammaPublicSearch(q, limitPerType = 25) {
  const url =
    `${GAMMA_BASE}/public-search?` +
    new URLSearchParams({
      q,
      limit_per_type: String(limitPerType),
      // keep_closed_markets=0 helps avoid resolved junk
      keep_closed_markets: "0",
      // events_status helps keep results current
      events_status: "active",
    }).toString();

  return await fetchJson(url);
}

// ----------------------
// Gamma: active events
// ----------------------
// Docs recommend /events?active=true&closed=false for active markets. :contentReference[oaicite:3]{index=3}
export async function getTrendingMarkets(limit = 8) {
  const url =
    `${GAMMA_BASE}/events?` +
    new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(Math.max(limit, 20)),
    }).toString();

  const events = await fetchJson(url);
  if (!Array.isArray(events)) return [];

  // Flatten event->markets and pick a few “best looking”
  const out = [];
  for (const ev of events) {
    const title = ev?.title || ev?.question || ev?.slug || "Untitled";
    // Sometimes events contain markets array
    const markets = Array.isArray(ev?.markets) ? ev.markets : [];
    if (markets.length) {
      // Use event title for output
      out.push({ title });
    } else {
      out.push({ title });
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// ----------------------
// CLOB: midpoints
// ----------------------
// Midpoints are public and don’t need BUY/SELL side. :contentReference[oaicite:4]{index=4}
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};

  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();

  const data = await fetchJson(url);
  // response is typically an object keyed by token_id
  return data && typeof data === "object" ? data : {};
}

// ----------------------
// Helpers: parsing Gamma
// ----------------------
function safeParseArray(maybeJson) {
  if (Array.isArray(maybeJson)) return maybeJson;
  if (typeof maybeJson === "string") {
    try {
      const v = JSON.parse(maybeJson);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeTitle(x) {
  const s = String(x ?? "").trim();
  return s.length ? s : "Untitled";
}

function looksActiveMarket(m) {
  // Gamma fields vary; do best-effort.
  if (!m || typeof m !== "object") return false;

  // Common patterns
  if (m.closed === true) return false;
  if (m.active === false) return false;

  // If enableOrderBook exists, prefer those markets for Up/Down since we need token ids
  if (m.enableOrderBook === false) return false;

  return true;
}

// ----------------------
// Public: /markets query
// ----------------------
export async function searchMarkets(query, limit = 8) {
  const resp = await gammaPublicSearch(query, 25);

  // Gamma public-search usually returns: { events: [...], markets: [...], profiles: [...] }
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  const events = Array.isArray(resp?.events) ? resp.events : [];

  // Collect market-like objects
  const collected = [];

  // Prefer explicit markets array if present
  for (const m of markets) {
    const title = normalizeTitle(m?.question || m?.title || m?.slug);
    const volume = m?.volume ?? m?.volume24hr ?? m?.liquidity ?? null;

    // Sometimes Gamma market contains outcomePrices; take midpoint-ish
    const prices = safeParseArray(m?.outcomePrices);
    const priceMid = prices.length ? Number(prices[0]) : null;

    collected.push({ title, volume, priceMid });
  }

  // Fallback: flatten event->markets
  if (!collected.length) {
    for (const ev of events) {
      const evTitle = normalizeTitle(ev?.title || ev?.question || ev?.slug);
      const ms = Array.isArray(ev?.markets) ? ev.markets : [];
      for (const m of ms) {
        const title = normalizeTitle(m?.question || m?.title || evTitle);
        const volume = m?.volume ?? ev?.volume ?? null;
        const prices = safeParseArray(m?.outcomePrices);
        const priceMid = prices.length ? Number(prices[0]) : null;
        collected.push({ title, volume, priceMid });
      }
    }
  }

  // Keep only somewhat meaningful items
  const cleaned = collected
    .filter((x) => x.title && x.title !== "Untitled")
    .slice(0, Math.max(limit, 8));

  return cleaned.slice(0, limit);
}

// -------------------------------------------
// Up/Down discovery: Gamma search -> CLOB mid
// -------------------------------------------
//
// Key point: Do NOT guess slugs. Use Gamma /public-search to discover the right market,
// then read real-time prices from CLOB midpoints (public). :contentReference[oaicite:5]{index=5}
export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  const assetName = asset === "btc" ? "bitcoin" : asset === "eth" ? "ethereum" : asset;

  // Multiple queries because Polymarket naming changes often.
  const intervalText =
    interval === "5m" ? "5 minutes" : interval === "15m" ? "15 minutes" : "1 hour";

  const queries = [
    `${assetName} up or down ${intervalText}`,
    `${assetName} up/down ${intervalText}`,
    `${assetName} in ${intervalText}`,
    `${assetName} price ${intervalText}`,
    `${assetName} ${interval}`,
  ];

  // Run searches and collect candidate markets
  const candidates = [];
  const topTitles = [];

  for (const q of queries) {
    const resp = await gammaPublicSearch(q, 25);
    const markets = Array.isArray(resp?.markets) ? resp.markets : [];

    for (const m of markets) {
      const title = normalizeTitle(m?.question || m?.title || m?.slug);
      topTitles.push(title);

      if (!looksActiveMarket(m)) continue;

      // We NEED token IDs for CLOB pricing.
      const tokenIds = safeParseArray(m?.clobTokenIds);
      if (tokenIds.length < 2) continue;

      candidates.push({
        title,
        raw: m,
        tokenIds,
      });
    }

    // If we got a solid set, break early
    if (candidates.length >= 5) break;
  }

  // Pick the “best” candidate by simple scoring
  const scored = candidates
    .map((c) => {
      const t = c.title.toLowerCase();
      let score = 0;

      if (t.includes(assetName)) score += 5;
      if (t.includes("up") || t.includes("down") || t.includes("up/down")) score += 3;
      if (t.includes("minute") || t.includes("hour") || t.includes(interval)) score += 2;

      // prefer orderbook enabled markets if present
      if (c.raw?.enableOrderBook === true) score += 1;

      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (!best) {
    return {
      found: false,
      debug: {
        queries,
        topTitles: Array.from(new Set(topTitles)).slice(0, 10),
      },
    };
  }

  // Get midpoint prices from CLOB
  const [upTokenId, downTokenId] = best.tokenIds;
  const mids = await clobMidpoints([upTokenId, downTokenId]);

  const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
  const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

  return {
    found: true,
    title: best.title,
    upTokenId,
    downTokenId,
    upMid,
    downMid,
  };
}
