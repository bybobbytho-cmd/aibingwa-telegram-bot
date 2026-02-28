const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ---------
// HTTP util
// ---------
async function fetchJson(url, opts) {
  const timeoutMs = (opts && opts.timeoutMs) ? opts.timeoutMs : 12000;
  const controller = new AbortController();
  const t = setTimeout(function () {
    try { controller.abort(); } catch (_) {}
  }, timeoutMs);

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
    } catch (_) {}

    if (!res.ok) {
      const err = new Error("HTTP " + res.status + " for " + url + " :: " + text.slice(0, 200));
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
async function gammaPublicSearch(q, limitPerType) {
  const limit = limitPerType || 25;
  const url =
    GAMMA_BASE +
    "/public-search?" +
    new URLSearchParams({
      q: q,
      limit_per_type: String(limit),
      keep_closed_markets: "0",
      events_status: "active",
    }).toString();

  return await fetchJson(url);
}

// ----------------------
// Gamma: active events
// ----------------------
export async function getTrendingMarkets(limit) {
  const lim = limit || 8;
  const url =
    GAMMA_BASE +
    "/events?" +
    new URLSearchParams({
      active: "true",
      closed: "false",
      limit: String(Math.max(lim, 20)),
    }).toString();

  const events = await fetchJson(url);
  if (!Array.isArray(events)) return [];

  const out = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const title = ev && (ev.title || ev.question || ev.slug) ? (ev.title || ev.question || ev.slug) : "Untitled";
    out.push({ title: title });
    if (out.length >= lim) break;
  }
  return out.slice(0, lim);
}

// ----------------------
// CLOB: midpoints
// ----------------------
async function clobMidpoints(tokenIds) {
  const ids = [];
  for (let i = 0; i < tokenIds.length; i++) {
    if (tokenIds[i]) ids.push(tokenIds[i]);
  }
  if (!ids.length) return {};

  const url =
    CLOB_BASE +
    "/midpoints?" +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();

  const data = await fetchJson(url);
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
    } catch (_) {
      return [];
    }
  }
  return [];
}

function normalizeTitle(x) {
  const s = String(x || "").trim();
  return s.length ? s : "Untitled";
}

function looksActiveMarket(m) {
  if (!m || typeof m !== "object") return false;
  if (m.closed === true) return false;
  if (m.active === false) return false;
  if (m.enableOrderBook === false) return false;
  return true;
}

function aliasesForAsset(asset) {
  const a = String(asset || "").toLowerCase();
  if (a === "btc") return ["btc", "bitcoin"];
  if (a === "eth") return ["eth", "ethereum"];
  if (a === "sol") return ["sol", "solana"];
  if (a === "xrp") return ["xrp", "ripple"];
  return [a];
}

// ----------------------
// Public: /markets query
// ----------------------
export async function searchMarkets(query, limit) {
  const lim = limit || 8;
  const resp = await gammaPublicSearch(query, 25);

  const markets = Array.isArray(resp && resp.markets ? resp.markets : null) ? resp.markets : [];
  const events = Array.isArray(resp && resp.events ? resp.events : null) ? resp.events : [];

  const collected = [];

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const title = normalizeTitle(m && (m.question || m.title || m.slug) ? (m.question || m.title || m.slug) : "Untitled");
    const volume = (m && (m.volume != null || m.volume24hr != null || m.liquidity != null))
      ? (m.volume != null ? m.volume : (m.volume24hr != null ? m.volume24hr : m.liquidity))
      : null;

    const prices = safeParseArray(m ? m.outcomePrices : null);
    const priceMid = prices.length ? Number(prices[0]) : null;

    collected.push({ title: title, volume: volume, priceMid: priceMid });
  }

  if (!collected.length) {
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      const evTitle = normalizeTitle(ev && (ev.title || ev.question || ev.slug) ? (ev.title || ev.question || ev.slug) : "Untitled");
      const ms = Array.isArray(ev && ev.markets ? ev.markets : null) ? ev.markets : [];
      for (let j = 0; j < ms.length; j++) {
        const m = ms[j];
        const title = normalizeTitle(m && (m.question || m.title) ? (m.question || m.title) : evTitle);
        const volume = (m && m.volume != null) ? m.volume : (ev && ev.volume != null ? ev.volume : null);
        const prices = safeParseArray(m ? m.outcomePrices : null);
        const priceMid = prices.length ? Number(prices[0]) : null;
        collected.push({ title: title, volume: volume, priceMid: priceMid });
      }
    }
  }

  const cleaned = collected.filter((x) => x && x.title && x.title !== "Untitled");
  return cleaned.slice(0, lim);
}

// -------------------------------------------
// Up/Down discovery: Gamma search -> CLOB mid
// -------------------------------------------
export async function resolveUpDownMarketAndPrice(params) {
  const asset = params && params.asset ? params.asset : "";
  const interval = params && params.interval ? params.interval : "";

  const aliases = aliasesForAsset(asset);

  const intervalText =
    interval === "5m" ? "5 minutes" :
    interval === "15m" ? "15 minutes" :
    interval;

  // Broad queries. We discover the actual market first.
  const queries = [
    aliases[0] + " up or down " + intervalText,
    aliases[0] + " up/down " + intervalText,
    aliases[0] + " higher or lower " + intervalText,
    aliases[0] + " price " + intervalText,
    aliases[0] + " " + interval,
  ];

  const candidates = [];
  const topTitles = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const resp = await gammaPublicSearch(q, 25);
    const markets = Array.isArray(resp && resp.markets ? resp.markets : null) ? resp.markets : [];

    for (let i = 0; i < markets.length; i++) {
      const m = markets[i];
      const title = normalizeTitle(m && (m.question || m.title || m.slug) ? (m.question || m.title || m.slug) : "Untitled");
      topTitles.push(title);

      if (!looksActiveMarket(m)) continue;

      const tokenIds = safeParseArray(m ? m.clobTokenIds : null);
      if (!tokenIds || tokenIds.length < 2) continue;

      candidates.push({
        title: title,
        slug: m && m.slug ? m.slug : null,
        raw: m,
        tokenIds: tokenIds,
      });
    }

    if (candidates.length >= 6) break;
  }

  if (!candidates.length) {
    return {
      found: false,
      debug: {
        queries: queries,
        topTitles: Array.from(new Set(topTitles)).slice(0, 10),
      },
    };
  }

  // Score candidates lightly
  const scored = candidates.map((c) => {
    const t = String(c.title || "").toLowerCase();
    const s = (c.slug ? String(c.slug).toLowerCase() : "");
    const blob = t + " " + s;

    let score = 0;
    for (let k = 0; k < aliases.length; k++) {
      if (blob.indexOf(String(aliases[k]).toLowerCase()) >= 0) score += 5;
    }
    if (blob.indexOf("up") >= 0 || blob.indexOf("down") >= 0 || blob.indexOf("up/down") >= 0) score += 3;
    if (blob.indexOf(interval) >= 0 || blob.indexOf("minute") >= 0 || blob.indexOf("hour") >= 0) score += 1;
    if (c.raw && c.raw.enableOrderBook === true) score += 1;

    c.score = score;
    return c;
  }).sort((a, b) => (b.score || 0) - (a.score || 0));

  const best = scored[0];
  const upTokenId = best.tokenIds[0];
  const downTokenId = best.tokenIds[1];

  const mids = await clobMidpoints([upTokenId, downTokenId]);

  const upMid = (mids && mids[upTokenId] != null) ? Number(mids[upTokenId]) : null;
  const downMid = (mids && mids[downTokenId] != null) ? Number(mids[downTokenId]) : null;

  return {
    found: true,
    title: best.title,
    slug: best.slug,
    upTokenId: upTokenId,
    downTokenId: downTokenId,
    upMid: upMid,
    downMid: downMid,
  };
}
