const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (compatible; aibingwa-telegram-bot/1.0; +https://github.com/bybobbytho-cmd/aibingwa-telegram-bot)",
      },
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 200)}`);
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

function assetAliases(asset) {
  const a = String(asset).toLowerCase();
  if (a === "btc") return ["btc", "bitcoin"];
  if (a === "eth") return ["eth", "ethereum"];
  if (a === "sol") return ["sol", "solana"];
  if (a === "xrp") return ["xrp", "ripple"];
  return [a];
}

function normalize(s) {
  return String(s || "").toLowerCase();
}

// Gamma discovery (public)
async function gammaPublicSearch(q, limitPerType = 25) {
  const url =
    `${GAMMA_BASE}/public-search?` +
    new URLSearchParams({
      q,
      limit_per_type: String(limitPerType),
      keep_closed_markets: "0",
      events_status: "active",
    }).toString();

  return fetchJson(url);
}

// CLOB live midpoints (public)
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

function looksActiveMarket(m) {
  if (!m || typeof m !== "object") return false;
  if (m.closed === true) return false;
  if (m.active === false) return false;
  return true;
}

/**
 * Stable resolver:
 * - DOES NOT guess slugs
 * - Uses Gamma public-search to discover the correct live Up/Down market
 * - Then uses CLOB midpoints for prices
 */
export async function resolveUpDownViaGammaSearch({ asset, interval }) {
  const aliases = assetAliases(asset);
  const primary = aliases[aliases.length - 1];

  // Keep these queries simple and broad.
  // We avoid strict interval-word filtering because it can eliminate valid markets.
  const intervalPhrase = interval === "5m" ? "5 minutes" : "15 minutes";

  const queries = [
    `${primary} up or down`,
    `${primary} up/down`,
    `${primary} up or down ${intervalPhrase}`,
    `${primary} higher or lower`,
    `${primary} price ${intervalPhrase}`,
    `${primary} ${interval}`,
  ];

  const topTitles = [];
  const candidates = [];

  for (const q of queries) {
    const resp = await gammaPublicSearch(q, 25);
    const markets = Array.isArray(resp?.markets) ? resp.markets : [];

    for (const m of markets) {
      const title = m?.question || m?.title || m?.slug || "Untitled";
      topTitles.push(title);

      if (!looksActiveMarket(m)) continue;

      const tokenIds = safeParseArray(m?.clobTokenIds);
      if (tokenIds.length < 2) continue;

      // Very light filtering: must look like Up/Down and include asset alias
      const blob = normalize(`${title} ${m?.slug || ""}`);
      const hasAsset = aliases.some((a) => blob.includes(normalize(a)));
      const hasUpDown = blob.includes("up") || blob.includes("down") || blob.includes("up/down") || blob.includes("up or down");
      if (!hasAsset || !hasUpDown) continue;

      candidates.push({
        title,
        slug: m?.slug || null,
        tokenIds,
      });
    }

    if (candidates.length >= 5) break;
  }

  if (!candidates.length) {
    return {
      found: false,
      reason: "No matching Up/Down markets discovered via Gamma search.",
      debug: {
        queries,
        topTitles: Array.from(new Set(topTitles)).slice(0, 12),
      },
    };
  }

  // Pick the best candidate with a gentle preference for interval text
  const want = interval === "5m" ? ["5m", "5 min", "5 minutes"] : ["15m", "15 min", "15 minutes"];
  const scored = candidates
    .map((c) => {
      const b = normalize(`${c.title} ${c.slug || ""}`);
      let s = 0;
      for (const a of aliases) if (b.includes(normalize(a))) s += 5;
      if (b.includes("up/down") || b.includes("up or down")) s += 3;
      for (const w of want) if (b.includes(normalize(w))) s += 2;
      return { ...c, score: s };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  const [upTokenId, downTokenId] = best.tokenIds;
  const mids = await clobMidpoints([upTokenId, downTokenId]);

  const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
  const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

  return {
    found: true,
    title: best.title,
    slug: best.slug,
    asset,
    interval,
    upTokenId,
    downTokenId,
    upMid,
    downMid,
    source: "Gamma search + CLOB midpoints",
  };
}

export function formatUpDownMessage(res) {
  const up = res.upMid != null && Number.isFinite(res.upMid) ? `${Math.round(res.upMid * 100)}¢` : "—";
  const down = res.downMid != null && Number.isFinite(res.downMid) ? `${Math.round(res.downMid * 100)}¢` : "—";

  return [
    `📈 *${res.title}*`,
    res.slug ? `Slug: \`${res.slug}\`` : null,
    "",
    `UP (mid): *${up}*`,
    `DOWN (mid): *${down}*`,
    "",
    `_Source: ${res.source}_`,
  ].filter(Boolean).join("\n");
}
