const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

function qs(params = {}) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${url} :: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { accept: "text/plain" } });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${url} :: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

function safeArrayMaybeJson(v) {
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

/**
 * Uses CLOB /time so our window math matches Polymarket server time.
 * Docs: GET https://clob.polymarket.com/time :contentReference[oaicite:3]{index=3}
 */
export async function getClobServerTimeSec() {
  const txt = await getText(`${CLOB_BASE}/time`);
  const n = Number(txt);
  if (!Number.isFinite(n)) throw new Error(`Invalid /time response: ${txt}`);
  return n;
}

export function intervalToSeconds(intervalStr) {
  const map = { "5m": 300, "15m": 900, "60m": 3600 };
  const sec = map[String(intervalStr).toLowerCase()];
  if (!sec) throw new Error(`Unsupported interval: ${intervalStr}`);
  return sec;
}

export function buildUpDownSlug(asset, intervalStr, windowStartSec) {
  const a = String(asset).toLowerCase(); // btc or eth
  const i = String(intervalStr).toLowerCase(); // 5m, 15m, 60m
  return `${a}-updown-${i}-${windowStartSec}`;
}

export async function getEventBySlug(slug) {
  // Docs: GET /events/slug/{slug} :contentReference[oaicite:4]{index=4}
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return getJson(url);
}

/**
 * Extract token IDs for Up/Down from Gamma event object.
 * Typically: event.markets[0].clobTokenIds => ["<UP_TOKEN_ID>", "<DOWN_TOKEN_ID>"] (array or JSON string)
 */
export function extractUpDownTokenIdsFromEvent(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  if (!markets.length) return null;

  // Up/Down events typically have one market with 2 outcomes
  const m = markets[0];
  const tokenIds = safeArrayMaybeJson(m?.clobTokenIds);

  if (tokenIds.length < 2) return null;

  return {
    upTokenId: String(tokenIds[0]),
    downTokenId: String(tokenIds[1]),
    market: m,
  };
}

export async function getClobPrices(tokenIds) {
  // Docs: GET /prices (multiple token IDs) :contentReference[oaicite:5]{index=5}
  // Most deployments accept comma-separated token_ids.
  const token_ids = tokenIds.join(",");
  const url = `${CLOB_BASE}/prices${qs({ token_ids })}`;
  return getJson(url); // returns map: { [tokenId]: price }
}

/**
 * The deterministic pipeline:
 * 1) get CLOB server time
 * 2) compute window start
 * 3) build slug (btc-updown-15m-<ts>)
 * 4) fetch Gamma event by slug
 * 5) extract clobTokenIds
 * 6) fetch live odds from CLOB /prices
 *
 * Resilience:
 * - if exact window isn’t ready (race at boundary), try previous window
 */
export async function resolveLiveUpDown(asset, intervalStr) {
  const assetNorm = String(asset).toLowerCase(); // btc / eth
  const seconds = intervalToSeconds(intervalStr);

  const serverNow = await getClobServerTimeSec();
  const windowStart = Math.floor(serverNow / seconds) * seconds;

  const candidates = [
    buildUpDownSlug(assetNorm, intervalStr, windowStart),
    buildUpDownSlug(assetNorm, intervalStr, windowStart - seconds), // fallback if boundary not indexed yet
  ];

  let lastErr = null;

  for (const slug of candidates) {
    try {
      const event = await getEventBySlug(slug);
      const extracted = extractUpDownTokenIdsFromEvent(event);
      if (!extracted) {
        throw new Error(`Event found but clobTokenIds missing for slug=${slug}`);
      }

      const { upTokenId, downTokenId } = extracted;
      const prices = await getClobPrices([upTokenId, downTokenId]);

      const up = Number(prices?.[upTokenId]);
      const down = Number(prices?.[downTokenId]);

      return {
        ok: true,
        slug,
        title: event?.title || event?.ticker || slug,
        upTokenId,
        downTokenId,
        upPrice: Number.isFinite(up) ? up : null, // 0..1
        downPrice: Number.isFinite(down) ? down : null, // 0..1
        event,
      };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  return {
    ok: false,
    error: lastErr?.message || "Failed to resolve Up/Down market",
    debug: { asset: assetNorm, intervalStr, tried: candidates },
  };
}

// Simple formatter (no Markdown needed)
export function formatUpDownLiveMessage(res, asset, intervalStr) {
  if (!res?.ok) {
    return [
      `❌ Up/Down market not found yet.`,
      `Asset: ${asset.toUpperCase()} | Interval: ${intervalStr}`,
      `Tried: ${res?.debug?.tried?.join(" , ") || "?"}`,
      `Tip: if you run this on the exact boundary, try again in ~10 seconds.`,
    ].join("\n");
  }

  const upPct = res.upPrice === null ? "?" : (res.upPrice * 100).toFixed(1) + "%";
  const downPct = res.downPrice === null ? "?" : (res.downPrice * 100).toFixed(1) + "%";

  const url = `https://polymarket.com/event/${res.slug}`;

  return [
    `📈 Up/Down LIVE (${asset.toUpperCase()} ${intervalStr})`,
    res.title,
    "",
    `UP: ${upPct}`,
    `DOWN: ${downPct}`,
    "",
    url,
  ].join("\n");
}
