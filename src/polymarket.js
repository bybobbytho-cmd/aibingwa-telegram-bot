const GAMMA_BASE = "https://gamma-api.polymarket.com";

function toQueryString(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function gammaGet(path, params) {
  const url = `${GAMMA_BASE}${path}${toQueryString(params)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gamma API error ${res.status} for ${url} :: ${body.slice(0, 250)}`);
  }
  return res.json();
}

function flattenMarketsFromPublicSearch(payload) {
  const out = [];

  const events = Array.isArray(payload?.events) ? payload.events : [];
  for (const ev of events) {
    const markets = Array.isArray(ev?.markets) ? ev.markets : [];
    for (const m of markets) {
      out.push({
        ...m,
        eventTitle: ev?.title,
        eventSlug: ev?.slug,
        eventEndDate: ev?.endDate,
        eventActive: ev?.active,
        eventClosed: ev?.closed,
        eventVolume: ev?.volume,
        eventLiquidity: ev?.liquidity,
      });
    }
  }

  const topMarkets = Array.isArray(payload?.markets) ? payload.markets : [];
  for (const m of topMarkets) out.push(m);

  return out;
}

function isLiveMarket(m) {
  const active = m?.active ?? m?.eventActive;
  const closed = m?.closed ?? m?.eventClosed;
  const archived = m?.archived;
  const restricted = m?.restricted;
  return active === true && closed === false && archived !== true && restricted !== true;
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
  const slug = m?.slug || m?.eventSlug;
  if (!slug) return null;
  return `https://polymarket.com/market/${slug}`;
}

export async function searchActiveMarkets(query, { limit = 10 } = {}) {
  const payload = await gammaGet("/public-search", { q: query });
  const all = flattenMarketsFromPublicSearch(payload);
  const live = all.filter(isLiveMarket);

  live.sort((a, b) => {
    const av = safeNum(a?.volume) ?? safeNum(a?.eventVolume) ?? 0;
    const bv = safeNum(b?.volume) ?? safeNum(b?.eventVolume) ?? 0;
    const al = safeNum(a?.liquidity) ?? safeNum(a?.eventLiquidity) ?? 0;
    const bl = safeNum(b?.liquidity) ?? safeNum(b?.eventLiquidity) ?? 0;
    if (bv !== av) return bv - av;
    return bl - al;
  });

  return live.slice(0, limit);
}

export async function getTrendingActiveMarkets({ limit = 10 } = {}) {
  const payload = await gammaGet("/events", {
    active: true,
    closed: false,
    order: "volume_24hr",
    ascending: false,
    limit: Math.max(limit, 25),
    offset: 0,
  });

  const events = Array.isArray(payload) ? payload : Array.isArray(payload?.events) ? payload.events : [];

  const markets = [];
  for (const ev of events) {
    const ms = Array.isArray(ev?.markets) ? ev.markets : [];
    for (const m of ms) {
      markets.push({
        ...m,
        eventTitle: ev?.title,
        eventSlug: ev?.slug,
        eventEndDate: ev?.endDate,
        eventActive: ev?.active,
        eventClosed: ev?.closed,
        eventVolume: ev?.volume,
        eventLiquidity: ev?.liquidity,
      });
    }
  }

  const live = markets.filter(isLiveMarket);

  live.sort((a, b) => {
    const av = safeNum(a?.volume) ?? safeNum(a?.eventVolume) ?? 0;
    const bv = safeNum(b?.volume) ?? safeNum(b?.eventVolume) ?? 0;
    if (bv !== av) return bv - av;
    const al = safeNum(a?.liquidity) ?? safeNum(a?.eventLiquidity) ?? 0;
    const bl = safeNum(b?.liquidity) ?? safeNum(b?.eventLiquidity) ?? 0;
    return bl - al;
  });

  return live.slice(0, limit);
}

export async function findBestUpDownMarket(asset, horizon) {
  const assetName = asset === "btc" ? "Bitcoin" : asset === "eth" ? "Ethereum" : asset;
  const horizonText = horizon === "5m" ? "5 minute" : horizon === "15m" ? "15 minute" : "60 minute";

  const queries = [
    `${assetName} up or down ${horizonText}`,
    `${assetName} up/down ${horizon}`,
    `${assetName} ${horizonText} up`,
    `${assetName} ${horizonText} down`,
  ];

  let candidates = [];
  for (const q of queries) {
    const payload = await gammaGet("/public-search", { q });
    const markets = flattenMarketsFromPublicSearch(payload).filter(isLiveMarket);
    candidates = candidates.concat(markets);
    if (candidates.length >= 25) break;
  }

  const uniqueBySlug = new Map();
  for (const m of candidates) {
    const key = m?.slug || m?.conditionId || m?.id;
    if (!key) continue;
    if (!uniqueBySlug.has(key)) uniqueBySlug.set(key, m);
  }

  const unique = [...uniqueBySlug.values()];

  function score(m) {
    const text = `${m?.question || ""} ${m?.title || ""} ${m?.eventTitle || ""}`.toLowerCase();
    let s = 0;

    if (text.includes(assetName.toLowerCase())) s += 4;

    if (horizon === "5m" && (text.includes("5 minute") || text.includes("5-minute") || text.includes("5m"))) s += 4;
    if (horizon === "15m" && (text.includes("15 minute") || text.includes("15-minute") || text.includes("15m"))) s += 4;
    if (
      horizon === "60m" &&
      (text.includes("60 minute") || text.includes("60-minute") || text.includes("60m") || text.includes("1 hour") || text.includes("one hour"))
    )
      s += 4;

    if (text.includes("up or down") || text.includes("up/down")) s += 3;

    const v = safeNum(m?.volume) ?? safeNum(m?.eventVolume) ?? 0;
    const l = safeNum(m?.liquidity) ?? safeNum(m?.eventLiquidity) ?? 0;
    s += Math.min(3, Math.log10(v + 1));
    s += Math.min(3, Math.log10(l + 1));

    return s;
  }

  unique.sort((a, b) => score(b) - score(a));
  return unique[0] || null;
}

export function formatMarketListMessage(query, markets) {
  const lines = [];
  lines.push(`📌 Live markets for: ${query}`);
  lines.push("");

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const { outcomes, prices } = normalizePrices(m);

    const title = m?.question || m?.title || m?.eventTitle || "Untitled market";
    const url = marketUrl(m);

    const vol = safeNum(m?.volume) ?? safeNum(m?.eventVolume);
    const liq = safeNum(m?.liquidity) ?? safeNum(m?.eventLiquidity);

    const priceLine =
      outcomes.length && prices.length
        ? outcomes
            .map((o, idx) => {
              const p = safeNum(prices[idx]);
              return p === null ? `${o}: ?` : `${o}: ${(p * 100).toFixed(1)}%`;
            })
            .join(" | ")
        : "Prices: (not available in this response)";

    lines.push(`${i + 1}) ${title}`);
    lines.push(`   ${priceLine}`);
    lines.push(`   Vol: ${vol ?? "?"} | Liq: ${liq ?? "?"}`);
    if (url) lines.push(`   ${url}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatUpDownMessage(market, asset, horizon) {
  const { outcomes, prices } = normalizePrices(market);

  const title = market?.question || market?.title || market?.eventTitle || "Up/Down market";
  const url = marketUrl(market);

  const vol = safeNum(market?.volume) ?? safeNum(market?.eventVolume);
  const liq = safeNum(market?.liquidity) ?? safeNum(market?.eventLiquidity);

  const priceLine =
    outcomes.length && prices.length
      ? outcomes
          .map((o, idx) => {
            const p = safeNum(prices[idx]);
            return p === null ? `${o}: ?` : `${o}: ${(p * 100).toFixed(1)}%`;
          })
          .join(" | ")
      : "Prices: (not available in this response)";

  return [
    `📈 Up/Down (${asset.toUpperCase()} ${horizon})`,
    title,
    "",
    priceLine,
    `Vol: ${vol ?? "?"} | Liq: ${liq ?? "?"}`,
    url ? url : "",
  ]
    .filter(Boolean)
    .join("\n");
}
