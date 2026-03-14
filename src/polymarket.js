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
 * Robust midpoint fetcher with retries and order book fallback.
 */
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean).map(String);
  if (ids.length < 2) return {};

  const maxAttempts = 5;
  const delayMs = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1) GET /midpoints
    try {
      const url = `${CLOB_BASE}/midpoints?` + new URLSearchParams({ token_ids: ids.join(",") }).toString();
      const data = await fetchJson(url, { timeoutMs: 5000 });
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        return data;
      }
    } catch (e) {
      console.log(`GET attempt ${attempt} failed:`, e.message);
    }

    // 2) POST /midpoints
    try {
      const url = `${CLOB_BASE}/midpoints`;
      const payload = ids.map((id) => ({ token_id: id }));
      const data = await fetchJson(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: 5000,
      });
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        return data;
      }
    } catch (e) {
      console.log(`POST attempt ${attempt} failed:`, e.message);
    }

    // 3) Individual GET /midpoint
    const out = {};
    let individualSuccess = false;
    for (const id of ids) {
      try {
        const url = `${CLOB_BASE}/midpoint?` + new URLSearchParams({ token_id: id }).toString();
        const data = await fetchJson(url, { timeoutMs: 5000 });
        const mp = data?.mid_price ?? data?.midPrice ?? null;
        if (mp != null) {
          out[id] = String(mp);
          individualSuccess = true;
        }
      } catch (e) {
        console.log(`Individual GET for ${id} attempt ${attempt} failed:`, e.message);
      }
    }
    if (individualSuccess) return out;

    // 4) Fallback: order book
    const bookResult = {};
    let bookSuccess = false;
    for (const id of ids) {
      try {
        const url = `${CLOB_BASE}/book?` + new URLSearchParams({ token_id: id }).toString();
        const data = await fetchJson(url, { timeoutMs: 5000 });
        const bids = data.bids || [];
        const asks = data.asks || [];
        if (bids.length > 0 && asks.length > 0) {
          const midpoint = (parseFloat(bids[0].price) + parseFloat(asks[0].price)) / 2;
          bookResult[id] = String(midpoint);
          bookSuccess = true;
        } else if (bids.length > 0) {
          bookResult[id] = bids[0].price;
          bookSuccess = true;
        } else if (asks.length > 0) {
          bookResult[id] = asks[0].price;
          bookSuccess = true;
        }
      } catch (e) {
        console.log(`Order book for ${id} attempt ${attempt} failed:`, e.message);
      }
    }
    if (bookSuccess) return bookResult;

    // Wait before next attempt
    if (attempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return {}; // All attempts failed
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
      if (tokenIds.length < 2) {
        errors.push({ slug, error: "insufficient token IDs" });
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
