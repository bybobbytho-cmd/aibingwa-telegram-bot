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

// Gamma: fetch event by slug (official pattern: /events?slug=...)
async function gammaEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events?` + new URLSearchParams({ slug }).toString();
  const data = await fetchJson(url);
  if (Array.isArray(data) && data.length > 0) return data[0];
  return null;
}

// CLOB: midpoint prices (public)
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
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
        const upMid = mids?.[tokenIds[0]] != null ? Number(mids[tokenIds[0]]) : null;
        const downMid = mids?.[tokenIds[1]] != null ? Number(mids[tokenIds[1]]) : null;

        return {
          found: true,
          title: event?.title || event?.question || slug,
          slug,
          upTokenId: tokenIds[0],
          downTokenId: tokenIds[1],
          upMid,
          downMid,
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
