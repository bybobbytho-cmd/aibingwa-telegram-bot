const GAMMA_BASE = "https://gamma-api.polymarket.com";

function toQueryString(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) usp.append(k, String(item));
    } else {
      usp.set(k, String(v));
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function gammaGet(path, params) {
  const url = `${GAMMA_BASE}${path}${toQueryString(params)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gamma API error ${res.status} for ${url} :: ${body.slice(0, 250)}`);
  }
  return res.json();
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizePrices(m) {
  const outcomesRaw = m?.outcomes;
  const outcomePricesRaw = m?.outcomePrices;

  let outcomes = [];
  let prices = [];

  try {
    outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : JSON.parse(outcomesRaw || "[]");
  } catch {
    outcomes = [];
  }

  try {
    prices = Array.isArray(outcomePricesRaw) ? outcomePricesRaw : JSON.parse(outcomePricesRaw || "[]");
  } catch {
    prices = [];
  }

  return { outcomes, prices };
}

function marketUrl(m) {
  const slug = m?.slug;
  return slug ? `https://polymarket.com/market/${slug}` : null;
}

// ✅ Live-ish filter: only exclude if explicitly not-live
function isLiveMarket(m) {
  const archived = m?.archived;
  const restricted = m?.restricted;
  const closed = m?.closed;
  const active = m?.active;

  if (archived === true) return false;
  if (restricted === true) return false;
  if (closed === true) return false;
  if (active === false) return false;
  return true;
}

// --- Core: Public search returns EVENTS, not guaranteed markets. ---
// We must:
// 1) /public-search -> event ids
// 2) /events/{id} -> event with markets
async function searchEventsByText(query, { limit = 6, page = 1 } = {}) {
  // q is required in docs, and events_status can filter active events. :contentReference[oaicite:1]{index=1}
  return gammaGet("/public-search", {
    q: query,
    events_status: "active",
    limit_per_type: limit,
    page,
    search_tags: false,
    search_profiles: false,
    optimized: true,
  });
}

async function getEventById(id) {
  // list events doc shows /events and single event endpoints exist :contentReference[oaicite:2]{index=2}
  return gammaGet(`/events/${encodeURIComponent(id)}`);
}

function flattenMarketsFromEvents(events = []) {
  const markets = [];
  for (const ev of events) {
    const ms = Array.isArray(ev?.markets) ? ev.markets : [];
    for (const m of ms) {
      markets.push({
        ...m,
        eventTitle: ev?.title,
        eventId: ev?.id,
        eventSlug: ev?.slug,
        eventEndDate: ev?.endDate,
        eventActive: ev?.active,
        eventClosed: ev?.closed,
        eventArchived: ev?.archived,
        eventRestricted: ev?.restricted,
        eventVolume24hr: ev?.volume24hr,
        eventVolume: ev?.volume,
        eventLiquidity: ev?.liquidity,
      });
    }
  }
  return markets;
}

function marketRankScore(m) {
  const v24 = safeNum(m?.volume24hr) ?? safeNum(m?.eventVolume24hr) ?? 0;
  const v = safeNum(m?.volume) ?? safeNum(m?.eventVolume) ?? 0;
  const l = safeNum(m?.liquidity) ?? safeNum(m?.eventLiquidity) ?? 0;

  // Prefer 24h volume, then total volume, then liquidity
  return v24 * 1000 + v * 10 + l;
}

export async function searchActiveMarkets(query, { limit = 10 } = {}) {
  // 1) Get event IDs from search
  const payload = await searchEventsByText(query, { limit: 8, page: 1 });
  const events = Array.isArray(payload?.events) ? payload.events : [];

  if (!events.length) return [];

  // 2) Fetch full events with embedded markets
  // Keep it safe: only first N events to avoid rate limits
  const top = events.slice(0, 8);

  const fullEvents = await Promise.all(
    top.map(async (e) => {
      try {
        return await getEventById(e.id);
      } catch {
        return null;
      }
    }),
  );

  const goodEvents = fullEvents.filter(Boolean);

  // 3) Flatten markets + filter live-ish
  const markets = flattenMarketsFromEvents(goodEvents).filter(isLiveMarket);

  // 4) Sort best first
  markets.sort((a, b) => marketRankScore(b) - marketRankScore(a));

  return markets.slice(0, limit);
}

export async function getTrendingActiveMarkets({ limit = 10 } = {}) {
  // Events endpoint supports active/closed + ordering. :contentReference[oaicite:3]{index=3}
  const events = await gammaGet("/events", {
    active: true,
    closed: false,
    archived: false,
    order: "volume24hr",
    ascending: false,
    limit: 20,
    offset: 0,
  });

  const arr = Array.isArray(events) ? events : Array.isArray(events?.events) ? events.events : [];
  const markets = flattenMarketsFromEvents(arr).filter(isLiveMarket);

  markets.sort((a, b) => marketRankScore(b) - marketRankScore(a));
  return markets.slice(0, limit);
}

export async function findBestUpDownMarket(asset, horizon) {
  const assetName = asset === "btc" ? "bitcoin" : asset === "eth" ? "ethereum" : asset;
  const horizonText = horizon === "5m" ? "5 minute" : horizon === "15m" ? "15 minute" : "60 minute";

  // Search a few relevant phrases
  const queries = [
    `${assetName} up or down ${horizonText}`,
    `${assetName} up or down`,
    `${assetName} ${horizonText}`,
    `${assetName} price ${horizonText}`,
  ];

  let candidates = [];
  for (const q of queries) {
    const ms = await searchActiveMarkets(q, { limit: 10 });
    candidates = candidates.concat(ms);
    if (candidates.length >= 30) break;
  }

  // Deduplicate
  const map = new Map();
  for (const m of candidates) {
    const key = m?.slug || m?.conditionId || m?.id;
    if (!key) continue;
    if (!map.has(key)) map.set(key, m);
  }

  const arr = [...map.values()];

  // Score: must contain asset + "up or down" + horizon if possible
  function score(m) {
    const text = `${m?.question || ""} ${m?.eventTitle || ""}`.toLowerCase();
    let s = 0;

    if (text.includes(assetName)) s += 5;
    if (text.includes("up or down") || text.includes("up/down")) s += 5;

    if (horizon === "5m" && (text.includes("5 minute") || text.includes("5m"))) s += 4;
    if (horizon === "15m" && (text.includes("15 minute") || text.includes("15m"))) s += 4;
    if (
      horizon === "60m" &&
      (text.includes("60 minute") || text.includes("60m") || text.includes("1 hour"))
    )
      s += 4;

    s += Math.min(10, Math.log10((safeNum(m?.volume24hr) ?? 0) + 1) * 4);
    s += Math.min(6, Math.log10((safeNum(m?.liquidityNum) ?? safeNum(m?.liquidity) ?? 0) + 1) * 3);
    return s;
  }

  arr.sort((a, b) => score(b) - score(a));
  return arr[0] || null;
}

export function formatMarketListMessage(query, markets) {
  const lines = [];
  lines.push(`📌 Live markets: ${query}`);
  lines.push("");

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const title = m?.question || m?.eventTitle || "Untitled market";
    const url = marketUrl(m);

    const { outcomes, prices } = normalizePrices(m);

    const priceLine =
      outcomes.length && prices.length
        ? outcomes
            .map((o, idx) => {
              const p = safeNum(prices[idx]);
              return p === null ? `${o}: ?` : `${o}: ${(p * 100).toFixed(1)}%`;
            })
            .join(" | ")
        : "Prices: (not returned)";

    const v24 = safeNum(m?.volume24hr) ?? safeNum(m?.eventVolume24hr);
    const v = safeNum(m?.volume) ?? safeNum(m?.eventVolume);
    const liq = safeNum(m?.liquidityNum) ?? safeNum(m?.liquidity) ?? safeNum(m?.eventLiquidity);

    lines.push(`${i + 1}) ${title}`);
    lines.push(`   ${priceLine}`);
    lines.push(`   Vol24h: ${v24 ?? "?"} | Vol: ${v ?? "?"} | Liq: ${liq ?? "?"}`);
    if (url) lines.push(`   ${url}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatUpDownMessage(market, asset, horizon) {
  const title = market?.question || market?.eventTitle || "Up/Down market";
  const url = marketUrl(market);

  const { outcomes, prices } = normalizePrices(market);
  const priceLine =
    outcomes.length && prices.length
      ? outcomes
          .map((o, idx) => {
            const p = safeNum(prices[idx]);
            return p === null ? `${o}: ?` : `${o}: ${(p * 100).toFixed(1)}%`;
          })
          .join(" | ")
      : "Prices: (not returned)";

  const v24 = safeNum(market?.volume24hr) ?? safeNum(market?.eventVolume24hr);
  const liq = safeNum(market?.liquidityNum) ?? safeNum(market?.liquidity) ?? safeNum(market?.eventLiquidity);

  return [
    `📈 Up/Down (${asset.toUpperCase()} ${horizon})`,
    title,
    "",
    priceLine,
    `Vol24h: ${v24 ?? "?"} | Liq: ${liq ?? "?"}`,
    url ? url : "",
  ]
    .filter(Boolean)
    .join("\n");
}
