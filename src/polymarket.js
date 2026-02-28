const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

const INTERVAL_SECONDS = {
  "5m": 300,
  "15m": 900,
};

// Asset name variants (Polymarket can change naming)
const ASSET_VARIANTS = {
  btc: ["btc", "bitcoin"],
  eth: ["eth", "ethereum"],
  sol: ["sol", "solana"],
  xrp: ["xrp", "ripple"],
};

// ---------- HTTP util ----------
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
      const err = new Error(`HTTP ${res.status} ${url} :: ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

function safeParseArray(maybeJson) {
  if (Array.isArray(maybeJson)) return maybeJson;
  if (typeof maybeJson === "string") {
    try {
      const v = JSON.parse(maybeJson);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------- CLOB time ----------
async function clobTimeSeconds() {
  // Often returns { timestamp: <seconds> } or a raw number/string depending on version
  const data = await fetchJson(`${CLOB_BASE}/time`);
  if (typeof data === "number") return Math.floor(data);
  if (typeof data === "string") return Math.floor(Number(data));
  if (data && typeof data.timestamp === "number") return Math.floor(data.timestamp);
  if (data && typeof data.time === "number") return Math.floor(data.time);
  // fallback: system time
  return Math.floor(Date.now() / 1000);
}

// ---------- CLOB midpoints ----------
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};

  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();

  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

// ---------- Gamma event-by-slug ----------
async function gammaEventBySlug(slug) {
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  const data = await fetchJson(url);

  // Gamma sometimes returns an array, sometimes an object.
  if (Array.isArray(data)) return data[0] ?? null;
  if (data && typeof data === "object") return data;
  return null;
}

function pickTitle(ev) {
  return (
    ev?.title ||
    ev?.question ||
    ev?.slug ||
    "Up/Down Market"
  );
}

// ---------- Main resolver ----------
export async function resolveUpDownViaSlug({ asset, interval }) {
  const seconds = INTERVAL_SECONDS[interval];
  if (!seconds) {
    return { found: false, triedSlugs: [], lastError: `Unsupported interval: ${interval}` };
  }

  const variants = ASSET_VARIANTS[asset] || [asset];

  // Use CLOB time (more reliable for Polymarket timing than local clock)
  const now = await clobTimeSeconds();
  const windowStart = Math.floor(now / seconds) * seconds;

  // Try current, previous, next to handle indexing delays & boundaries
  const candidateStarts = [windowStart, windowStart - seconds, windowStart + seconds];

  const triedSlugs = [];
  let lastError = "";

  for (const ts of candidateStarts) {
    for (const name of variants) {
      const slug = `${name}-updown-${interval}-${ts}`;
      triedSlugs.unshift(slug); // newest first

      try {
        const ev = await gammaEventBySlug(slug);
        if (!ev) {
          lastError = `Gamma returned empty for slug=${slug}`;
          continue;
        }

        const markets = Array.isArray(ev.markets) ? ev.markets : [];
        const m0 = markets[0];
        const tokenIds = safeParseArray(m0?.clobTokenIds);

        if (tokenIds.length < 2) {
          lastError = `No clobTokenIds in event slug=${slug}`;
          continue;
        }

        const [upTokenId, downTokenId] = tokenIds;

        const mids = await clobMidpoints([upTokenId, downTokenId]);

        const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
        const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

        return {
          found: true,
          title: pickTitle(ev),
          slug,
          windowStart: ts,
          upTokenId,
          downTokenId,
          upMid,
          downMid,
          triedSlugs,
          lastError: "",
        };
      } catch (e) {
        // Common expected failures: 404 slug not found
        lastError = String(e?.message || e);
        continue;
      }
    }
  }

  return {
    found: false,
    windowStart,
    triedSlugs,
    lastError: lastError || "Unknown failure",
  };
}
