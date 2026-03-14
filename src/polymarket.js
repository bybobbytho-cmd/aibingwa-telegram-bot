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

    clearTimeout(t);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    clearTimeout(t);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Gamma: event by slug (GET /events?slug=...)
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
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function extractTokenIdsFromEvent(event) {
  if (!event?.markets?.[0]) return [];
  const market = event.markets[0];
  const tokenIds = market.clobTokenIds;
  return safeParseArray(tokenIds);
}

function intervalSeconds(interval) {
  const map = { "5m": 300, "15m": 900 };
  return map[interval] || 300;
}

function candidateWindowStarts(sec) {
  const now = Math.floor(Date.now() / 1000);
  const remainder = now % sec;
  return [now - remainder - sec, now - remainder];
}

/**
 * CLOB Midpoints — robust approach:
 * 1) Try GET /midpoints?token_ids=...
 * 2) If 400, try POST /midpoints with JSON body
 * 3) If still failing, fall back to GET /midpoint per token
 *
 * Docs: GET /midpoints and POST /midpoints :contentReference[oaicite:2]{index=2}
 * Docs: GET /midpoint :contentReference[oaicite:3]{index=3}
 */
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean).map(String);
  if (!ids.length) return {};

  // Attempt 1: GET query params
  try {
    const url =
      `${CLOB_BASE}/midpoints?` +
      new URLSearchParams({ token_ids: ids.join(",") }).toString();
    const data = await fetchJson(url);
    if (data && typeof data === "object") return data;
  } catch (e) {
    // If it's not a 400, still try the other methods
    if (e?.status !== 400) {
      // continue
    }
  }

  // Attempt 2: POST body (more reliable)
  try {
    const url = `${CLOB_BASE}/midpoints`;
    const payload = ids.map((id) => ({ token_id: id }));
    const data = await fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (data && typeof data === "object") return data;
  } catch (e) {
    // continue to fallback
  }

  // Attempt 3: single midpoint calls
  const out = {};
  for (const id of ids) {
    try {
      const url =
        `${CLOB_BASE}/midpoint?` + new URLSearchParams({ token_id: id }).toString();
      const data = await fetchJson(url);
      // docs: { "mid_price": "0.45" }
      const mp = data?.mid_price ?? data?.midPrice ?? null;
      if (mp != null) out[id] = String(mp);
    } catch {
      // ignore individual failures
    }
  }
  return out;
}

export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  const sec = intervalSeconds(interval);
  const starts = candidateWindowStarts(sec);
  const errors = [];

  for (const start of starts) {
    const slug = `${asset}-updown-${interval}-${start}`;
    try {
      const event = await gammaEventBySlug(slug);
      if (!event) continue;

      const tokenIds = extractTokenIdsFromEvent(event);
      // ADDED LOGGING LINE:
      console.log('🎯 Token IDs for', slug, ':', JSON.stringify(tokenIds));

      if (tokenIds.length < 2) {
        errors.push({ slug, error: "insufficient token IDs" });
        continue;
      }

      const mids = await clobMidpoints(tokenIds);

      // mids may map tokenId -> "0.45" (string) per docs
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
        debug: { tried: starts },
      };
    } catch (e) {
      errors.push({ slug, error: e.message });
    }
  }

  return { found: false, errors, tried: starts };
}
