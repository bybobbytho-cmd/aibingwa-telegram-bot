const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
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
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

// Gamma "event-by-slug" endpoint (this is what worked when you saw: Source: Gamma event-by-slug + CLOB midpoints)
async function gammaEventBySlug(slug) {
  // add cache-buster to reduce edge caching weirdness
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}?cache=false&_=${Date.now()}`;
  return await fetchJson(url);
}

function safeParseArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    try {
      const v = JSON.parse(x);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};

  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();

  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

// Build candidate slugs around the current window (current, previous, next)
// This is to survive indexing delays + boundary timing.
function candidateSlugs({ asset, interval }) {
  const secondsMap = { "5m": 300, "15m": 900 };
  const seconds = secondsMap[interval];
  if (!seconds) return [];

  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / seconds) * seconds;

  const tsCandidates = [
    windowStart,
    windowStart - seconds,
    windowStart + seconds,
    windowStart - 2 * seconds,
  ];

  // asset name variants (what Polymarket sometimes uses in slugs)
  const names = [];
  if (asset === "btc") names.push("btc", "bitcoin");
  else if (asset === "eth") names.push("eth", "ethereum");
  else if (asset === "sol") names.push("sol", "solana");
  else if (asset === "xrp") names.push("xrp");

  const slugs = [];
  for (const name of names) {
    for (const ts of tsCandidates) {
      slugs.push(`${name}-updown-${interval}-${ts}`);
    }
  }
  return slugs;
}

export async function resolveUpDown({ asset, interval }) {
  const triedSlugs = [];
  let lastError = null;

  const slugs = candidateSlugs({ asset, interval });

  for (const slug of slugs) {
    triedSlugs.push(slug);
    try {
      const ev = await gammaEventBySlug(slug);

      // ev should contain markets; take first market
      const markets = Array.isArray(ev?.markets) ? ev.markets : [];
      if (!markets.length) {
        lastError = "Gamma returned event without markets";
        continue;
      }

      const m = markets[0];
      const tokenIds = safeParseArray(m?.clobTokenIds);
      if (tokenIds.length < 2) {
        lastError = "Missing clobTokenIds in Gamma response";
        continue;
      }

      const [upTokenId, downTokenId] = tokenIds;

      const mids = await clobMidpoints([upTokenId, downTokenId]);
      const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
      const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

      const title = ev?.title || ev?.question || "Up/Down Market";

      return {
        found: true,
        title,
        slug,
        upTokenId,
        downTokenId,
        upMid,
        downMid,
        triedSlugs,
        lastError: null,
      };
    } catch (e) {
      const status = e?.status;
      // 404 is normal when slug isn't indexed yet
      if (status === 404) {
        lastError = `404 slug not found`;
        continue;
      }
      lastError = String(e?.message || e);
      continue;
    }
  }

  return {
    found: false,
    triedSlugs: triedSlugs.slice(0, 12),
    lastError,
  };
}
