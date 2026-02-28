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
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

function intervalToSeconds(interval) {
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  if (interval === "60m") return 3600;
  return 900;
}

function windowStartUnix(seconds, nowSec) {
  return Math.floor(nowSec / seconds) * seconds;
}

async function gammaEventBySlug(slug) {
  // IMPORTANT: this is the endpoint your screenshots showed working
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(url);
}

async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

function parseTokenIds(market) {
  const raw = market?.clobTokenIds;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

function buildSlugNames(asset) {
  // try both short + long
  if (asset === "btc") return ["btc", "bitcoin"];
  if (asset === "eth") return ["eth", "ethereum"];
  return [asset];
}

function buildSlug(assetName, interval, startTs) {
  // format that matched your working screenshot: btc-updown-5m-1772296200
  return `${assetName}-updown-${interval}-${startTs}`;
}

// Main exported function
export async function resolveUpDownViaSlug({ asset, interval }) {
  const seconds = intervalToSeconds(interval);

  // Use pure UTC unix time
  const nowSec = Math.floor(Date.now() / 1000);
  const start = windowStartUnix(seconds, nowSec);

  // Robustness: try current, previous, next window (indexing delays happen)
  const candidateStarts = [start, start - seconds, start + seconds];

  const triedSlugs = [];
  let lastError = null;

  for (const a of buildSlugNames(asset)) {
    for (const ts of candidateStarts) {
      const slug = buildSlug(a, interval, ts);
      triedSlugs.push(slug);

      try {
        const ev = await gammaEventBySlug(slug);

        // Some responses return event object, some wrap in arrays.
        const eventObj = Array.isArray(ev) ? ev[0] : ev;

        const title = eventObj?.title || eventObj?.question || slug;
        const market = Array.isArray(eventObj?.markets) ? eventObj.markets[0] : null;

        if (!market) {
          lastError = "No markets array on event";
          continue;
        }

        const tokenIds = parseTokenIds(market);
        if (tokenIds.length < 2) {
          lastError = "Missing clobTokenIds";
          continue;
        }

        const [upTokenId, downTokenId] = tokenIds;
        const mids = await clobMidpoints([upTokenId, downTokenId]);

        const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
        const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

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
        // 404 slug not found is common
        if (e?.status) {
          lastError = `${e.status} ${e.body || ""}`.slice(0, 200);
        } else {
          lastError = String(e?.message || e);
        }
      }
    }
  }

  return {
    found: false,
    triedSlugs,
    lastError,
  };
}
