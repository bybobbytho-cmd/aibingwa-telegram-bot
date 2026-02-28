const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// ----------------
// HTTP helper
// ----------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url} :: ${String(text).slice(0, 200)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  return data;
}

// ----------------
// Gamma search
// ----------------
async function gammaSearch(q) {
  const url =
    `${GAMMA_BASE}/public-search?` +
    new URLSearchParams({
      q,
      limit_per_type: "25",
      keep_closed_markets: "0",
      events_status: "active",
      cache: "false",
      optimized: "true",
    }).toString();

  return await fetchJson(url);
}

// ----------------
// CLOB midpoints
// ----------------
async function clobMidpoints(tokenIds) {
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: tokenIds.join(",") }).toString();

  return await fetchJson(url);
}

// ----------------
// Helpers
// ----------------
function parseTokenIds(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function assetName(asset) {
  const a = String(asset || "").toLowerCase();
  if (a === "btc") return "bitcoin";
  if (a === "eth") return "ethereum";
  if (a === "sol") return "solana";
  if (a === "xrp") return "xrp";
  return a;
}

// ---------------------------------------
// MAIN: resolve Up/Down market + prices
// - Keep Gamma search + CLOB midpoints
// - Add robustness: also parse events[].markets[]
// ---------------------------------------
export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  const name = assetName(asset);
  const intervalText = interval === "5m" ? "5 minutes" : "15 minutes";

  // Keep old style queries + add one UpDown-format query
  const queries = [
    `${name} up or down ${intervalText}`,
    `${name} higher or lower ${intervalText}`,
    `${name} price ${intervalText}`,
    `${name} updown ${interval}`,
    `${name} ${interval}`,
  ];

  const candidates = [];
  for (const q of queries) {
    const resp = await gammaSearch(q);

    // 1) Direct markets[]
    if (Array.isArray(resp?.markets)) {
      for (const m of resp.markets) {
        const tokenIds = parseTokenIds(m?.clobTokenIds);
        if (tokenIds.length >= 2) {
          candidates.push({
            title: m?.title || m?.question || m?.slug || "Untitled",
            tokenIds,
          });
        }
      }
    }

    // 2) events[].markets[]
    if (Array.isArray(resp?.events)) {
      for (const ev of resp.events) {
        if (!Array.isArray(ev?.markets)) continue;
        for (const m of ev.markets) {
          const tokenIds = parseTokenIds(m?.clobTokenIds);
          if (tokenIds.length >= 2) {
            candidates.push({
              title: m?.title || m?.question || ev?.title || "Untitled",
              tokenIds,
            });
          }
        }
      }
    }

    // If we found something, stop early (keeps behavior close to what worked)
    if (candidates.length) break;
  }

  if (!candidates.length) {
    return { found: false, debug: { queries } };
  }

  const best = candidates[0];
  const [upTokenId, downTokenId] = best.tokenIds;

  const mids = await clobMidpoints([upTokenId, downTokenId]);

  const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
  const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

  if (upMid == null || downMid == null) {
    return { found: false, debug: { queries } };
  }

  return {
    found: true,
    title: best.title,
    upMid,
    downMid,
  };
}
