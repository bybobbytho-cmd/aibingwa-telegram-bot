// src/polymarket.js
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

async function fetchJson(url, { timeoutMs = 12000, method = "GET", headers = {}, body = null } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: { accept: "application/json", ...headers },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

async function gammaEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events?` + new URLSearchParams({ slug }).toString();
  const data = await fetchJson(url);
  if (Array.isArray(data) && data.length > 0) return data[0];
  return null;
}

function safeParseArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const x = JSON.parse(v);
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }
  return [];
}

function intervalSeconds(interval) {
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  if (interval === "60m") return 3600;
  throw new Error(`Unsupported interval: ${interval}`);
}

function candidateWindowStarts(sec) {
  const now = Math.floor(Date.now() / 1000);
  const cur = Math.floor(now / sec) * sec;
  return [cur, cur - sec, cur + sec];
}

function assetNames(asset) {
  if (asset === "btc") return ["btc", "bitcoin"];
  if (asset === "eth") return ["eth", "ethereum"];
  return [asset];
}

function buildSlug(name, interval, windowStart) {
  return `${name}-updown-${interval}-${windowStart}`;
}

function extractTokenIdsFromEvent(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  if (!markets.length) return [];

  const m = markets[0];
  if (Array.isArray(m?.tokens) && m.tokens.length >= 2) {
    const ids = m.tokens.map((t) => t?.token_id).filter(Boolean);
    if (ids.length >= 2) return ids.slice(0, 2);
  }

  const clobIds = safeParseArray(m?.clobTokenIds);
  if (clobIds.length >= 2) return clobIds.slice(0, 2);

  return [];
}

async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean).map(String);
  if (!ids.length) return {};

  try {
    const url = `${CLOB_BASE}/midpoints?` + new URLSearchParams({ token_ids: ids.join(",") }).toString();
    const data = await fetchJson(url);
    if (data && typeof data === "object") return data;
  } catch (e) {}

  try {
    const url = `${CLOB_BASE}/midpoints`;
    const payload = ids.map((id) => ({ token_id: id }));
    const data = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (data && typeof data === "object") return data;
  } catch (e) {}

  const out = {};
  for (const id of ids) {
    try {
      const url = `${CLOB_BASE}/midpoint?` + new URLSearchParams({ token_id: id }).toString();
      const data = await fetchJson(url);
      const mp = data?.mid_price ?? data?.midPrice ?? null;
      if (mp != null) out[id] = String(mp);
    } catch {}
  }
  return out;
}

export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  const sec = intervalSeconds(interval);
  const starts = candidateWindowStarts(sec);
  const names = assetNames(asset);

  const tried = [];
  let lastErr = null;

  for (const ws of starts) {
    for (const name of names) {
      const slug = buildSlug(name, interval, ws);
      tried.push(slug);

      try {
        const event = await gammaEventBySlug(slug);
        if (!event) continue;

        const tokenIds = extractTokenIdsFromEvent(event);
        if (tokenIds.length < 2) {
          lastErr = new Error(`Event found but token IDs missing for slug=${slug}`);
          continue;
        }

        const mids = await clobMidpoints(tokenIds);
        const upRaw = mids?.[tokenIds[0]] ?? null;
        const downRaw = mids?.[tokenIds[1]] ?? null;

        const upMid = upRaw != null ? Number(upRaw) : null;
        const downMid = downRaw != null ? Number(downRaw) : null;

        return {
          found: true,
          title: event?.title || event?.question || slug,
          slug,
          upTokenId: String(tokenIds[0]),
          downTokenId: String(tokenIds[1]),
          upMid: Number.isFinite(upMid) ? upMid : null,
          downMid: Number.isFinite(downMid) ? downMid : null,
          debug: { tried },
        };
      } catch (e) {
        lastErr = e;
      }
    }
  }

  return {
    found: false,
    debug: {
      tried,
      lastError: lastErr
        ? {
            message: lastErr.message,
            status: lastErr.status,
            bodySnippet: typeof lastErr.body === "string" ? lastErr.body.slice(0, 200) : null,
          }
        : null,
    },
  };
}

export async function searchMarketsBasic(query, limit = 8) {
  const url = `${GAMMA_BASE}/markets?` + new URLSearchParams({
    active: "true",
    closed: "false",
    limit: "200",
    offset: "0",
  }).toString();

  const markets = await fetchJson(url);
  if (!Array.isArray(markets)) return [];

  const q = String(query || "").toLowerCase();
  return markets
    .map((m) => ({
      title: m?.question || m?.title || m?.slug || "Untitled",
      volume: m?.volumeNum ?? m?.volume ?? null,
      liquidity: m?.liquidityNum ?? m?.liquidity ?? null,
      slug: m?.slug,
    }))
    .filter((m) => String(m.title).toLowerCase().includes(q))
    .slice(0, limit);
}
