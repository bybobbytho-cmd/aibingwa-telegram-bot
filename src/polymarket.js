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
      const err = new Error(`HTTP ${res.status} ${url} :: ${text.slice(0, 250)}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

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

async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
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

function normalize(s) {
  return String(s || "").toLowerCase();
}

function assetAliases(asset) {
  const a = String(asset).toLowerCase();
  if (a === "btc") return ["btc", "bitcoin"];
  if (a === "eth") return ["eth", "ethereum"];
  if (a === "sol") return ["sol", "solana"];
  if (a === "xrp") return ["xrp", "ripple"];
  return [a];
}

function intervalAliases(interval) {
  const i = String(interval).toLowerCase();
  if (i === "5m") return ["5m", "5 min", "5 mins", "5 minutes", "in 5 minutes"];
  if (i === "15m") return ["15m", "15 min", "15 mins", "15 minutes", "in 15 minutes", "quarter hour"];
  if (i === "60m") return ["60m", "60 min", "60 mins", "60 minutes", "1 hour", "in 1 hour", "1h", "hour", "hourly", "next hour"];
  return [i];
}

function looksActiveMarket(m) {
  if (!m || typeof m !== "object") return false;
  if (m.closed === true) return false;
  if (m.active === false) return false;
  if (m.enableOrderBook === false) return false;
  return true;
}

function scoreMarketTitle(title, asset, interval) {
  const t = normalize(title);
  const aliasesA = assetAliases(asset);
  const aliasesI = intervalAliases(interval);

  let score = 0;

  for (const a of aliasesA) if (t.includes(a)) score += 6;

  if (t.includes("up") || t.includes("down") || t.includes("up/down") || t.includes("up or down")) score += 4;

  for (const x of aliasesI) if (t.includes(normalize(x))) score += 3;

  if (t.includes("higher") || t.includes("lower")) score += 2;

  return score;
}

function pickBestCandidate(candidates, asset, interval) {
  const scored = candidates
    .map((c) => ({ ...c, score: scoreMarketTitle(c.title, asset, interval) }))
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  const aliasesA = assetAliases(asset);
  const aliasesI = intervalAliases(interval);

  const intervalPhrase =
    interval === "5m" ? "5 minutes" : interval === "15m" ? "15 minutes" : "1 hour";

  const baseName = aliasesA[aliasesA.length - 1];

  const queries = [
    `${baseName} up or down ${intervalPhrase}`,
    `${baseName} up/down ${intervalPhrase}`,
    `${baseName} higher or lower ${intervalPhrase}`,
    `${baseName} price direction ${intervalPhrase}`,
    `${baseName} ${interval}`,
    interval === "60m" ? `${baseName} hourly up or down` : null,
    interval === "60m" ? `${baseName} 1h up or down` : null,
  ].filter(Boolean);

  const candidates = [];
  const topTitles = [];

  for (const q of queries) {
    const resp = await gammaPublicSearch(q, 25);
    const markets = Array.isArray(resp?.markets) ? resp.markets : [];

    for (const m of markets) {
      const title = m?.question || m?.title || m?.slug || "Untitled";
      topTitles.push(title);

      if (!looksActiveMarket(m)) continue;

      const tokenIds = safeParseArray(m?.clobTokenIds);
      if (tokenIds.length < 2) continue;

      const blob = normalize(`${title} ${m?.slug || ""}`);

      const assetOk = aliasesA.some((a2) => blob.includes(normalize(a2)));
      if (!assetOk) continue;

      const intervalOk = aliasesI.some((i2) => blob.includes(normalize(i2)));
      if (!intervalOk) continue;

      const upDownOk =
        blob.includes("up") || blob.includes("down") || blob.includes("up/down") || blob.includes("up or down");
      if (!upDownOk) continue;

      candidates.push({
        title,
        slug: m?.slug || null,
        tokenIds,
      });
    }

    if (candidates.length >= 6) break;
  }

  const best = pickBestCandidate(candidates, asset, interval);

  if (!best) {
    return {
      found: false,
      reason: "No matching Up/Down markets discovered via Gamma search.",
      debug: {
        queries,
        topTitles: Array.from(new Set(topTitles)).slice(0, 12),
      },
    };
  }

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
    source: "Gamma discovery + CLOB midpoints",
  };
}

export function formatUpDownMessage(res) {
  const up = res.upMid != null && Number.isFinite(res.upMid) ? `${Math.round(res.upMid * 100)}¢` : "—";
  const down = res.downMid != null && Number.isFinite(res.downMid) ? `${Math.round(res.downMid * 100)}¢` : "—";

  const lines = [
    `📈 *${res.title}*`,
    res.slug ? `Slug: \`${res.slug}\`` : null,
    "",
    `UP (mid): *${up}*`,
    `DOWN (mid): *${down}*`,
    "",
    `_Source: ${res.source}_`,
  ].filter(Boolean);

  return lines.join("\n");
}
