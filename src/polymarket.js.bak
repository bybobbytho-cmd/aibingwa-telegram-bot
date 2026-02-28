const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// --------------------
// HTTP utils
// --------------------
async function fetchText(url, { method = "GET", headers = {}, body, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, text };
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  let data = null;
  try {
    data = r.text ? JSON.parse(r.text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
    err.status = r.status;
    err.body = r.text;
    throw err;
  }
  return data;
}

// --------------------
// Gamma endpoints
// --------------------

// Get event by slug: /events/slug/{slug} :contentReference[oaicite:2]{index=2}
async function gammaEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(url, { timeoutMs: 12000 });
}

// Simple discovery for /markets (keep it basic + stable)
export async function searchMarkets(query, limit = 8) {
  const url =
    `${GAMMA_BASE}/events?` +
    new URLSearchParams({
      search: query,
      active: "true",
      closed: "false",
      limit: String(Math.max(limit, 10)),
    }).toString();

  const events = await fetchJson(url);
  if (!Array.isArray(events)) return [];

  const out = [];
  for (const ev of events) {
    const title = (ev?.title || ev?.question || ev?.slug || "Untitled").trim();
    out.push({ title, volume: ev?.volume ?? null, priceMid: null });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

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

  const out = [];
  for (const ev of events) {
    const title = (ev?.title || ev?.question || ev?.slug || "Untitled").trim();
    out.push({ title });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// --------------------
// CLOB endpoints
// --------------------

// CLOB server time: GET /time :contentReference[oaicite:3]{index=3}
async function clobServerTimeSec() {
  const url = `${CLOB_BASE}/time`;
  const r = await fetchText(url, { timeoutMs: 8000 });
  if (!r.ok) throw new Error(`CLOB /time failed: HTTP ${r.status}`);
  const n = Number(String(r.text).trim());
  if (!Number.isFinite(n)) throw new Error(`CLOB /time returned non-number: ${r.text}`);
  return n;
}

// Midpoints: POST /midpoints (request body) :contentReference[oaicite:4]{index=4}
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};

  const url = `${CLOB_BASE}/midpoints`;
  const body = JSON.stringify({ token_ids: ids });

  const data = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body,
    timeoutMs: 12000,
  });

  return data && typeof data === "object" ? data : {};
}

// --------------------
// Up/Down slug resolver
// --------------------
const INTERVAL_SECONDS = {
  "5m": 300,
  "15m": 900,
};

const ASSET_ALIASES = {
  btc: ["btc", "bitcoin"],
  eth: ["eth", "ethereum"],
  sol: ["sol", "solana"],
  xrp: ["xrp", "ripple"],
};

function floorToWindowStart(sec, windowSizeSec) {
  return Math.floor(sec / windowSizeSec) * windowSizeSec;
}

function parseTokenIdsFromMarket(market) {
  const raw = market?.clobTokenIds;
  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }

  return [];
}

function pickBestMarketFromEvent(ev) {
  const markets = Array.isArray(ev?.markets) ? ev.markets : [];
  if (!markets.length) return null;

  // Up/Down should have 2 outcomes and clobTokenIds present
  for (const m of markets) {
    const ids = parseTokenIdsFromMarket(m);
    if (ids.length >= 2) return m;
  }
  return null;
}

/**
 * Resolve Up/Down using deterministic slugs:
 * - use CLOB server time to sync
 * - try current, previous, next window
 * - try asset aliases (btc/bitcoin, eth/ethereum, etc)
 * - fetch Gamma event-by-slug (reliable when slug exists) :contentReference[oaicite:5]{index=5}
 * - then fetch CLOB midpoints for token IDs :contentReference[oaicite:6]{index=6}
 */
export async function resolveUpDownBySlug({ asset, interval }) {
  const windowSize = INTERVAL_SECONDS[interval];
  if (!windowSize) {
    return {
      found: false,
      triedSlugs: [],
      lastError: `Unsupported interval: ${interval} (supported: 5m, 15m)`,
    };
  }

  const aliases = ASSET_ALIASES[asset] ?? [asset];
  const nowSec = await clobServerTimeSec();
  const windowStart = floorToWindowStart(nowSec, windowSize);

  // Try: current, previous, next window (handles indexing delay + boundary)
  const candidates = [windowStart, windowStart - windowSize, windowStart + windowSize];

  const triedSlugs = [];
  let lastError = null;

  for (const ts of candidates) {
    for (const a of aliases) {
      const slug = `${a}-updown-${interval}-${ts}`;
      triedSlugs.push(slug);

      try {
        const ev = await gammaEventBySlug(slug);
        const market = pickBestMarketFromEvent(ev);
        if (!market) {
          lastError = `No markets/tokenIds inside Gamma event for slug=${slug}`;
          continue;
        }

        const tokenIds = parseTokenIdsFromMarket(market);
        if (tokenIds.length < 2) {
          lastError = `Gamma market missing tokenIds for slug=${slug}`;
          continue;
        }

        const [upTokenId, downTokenId] = tokenIds;
        const mids = await clobMidpoints([upTokenId, downTokenId]);

        const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
        const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

        const title = (ev?.title || ev?.question || slug).trim();

        return {
          found: true,
          slug,
          title,
          upTokenId,
          downTokenId,
          upMid,
          downMid,
        };
      } catch (e) {
        // Common failure is 404 slug not found (market window not indexed yet)
        const msg = e?.body ? String(e.body).slice(0, 180) : e?.message;
        lastError = msg || "unknown error";
        continue;
      }
    }
  }

  return {
    found: false,
    triedSlugs: triedSlugs.slice(0, 10), // keep output short
    lastError,
  };
}
