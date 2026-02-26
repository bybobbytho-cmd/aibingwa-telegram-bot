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

const COMMON_HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (compatible; aibingwa-telegram-bot/1.0; +https://github.com/bybobbytho-cmd/aibingwa-telegram-bot)",
};

async function fetchText(url) {
  const res = await fetch(url, { headers: { ...COMMON_HEADERS, accept: "text/plain" } });
  const t = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url} :: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return t.trim();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: COMMON_HEADERS });
  const t = await res.text().catch(() => "");
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${url} :: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(t);
  } catch {
    const err = new Error(`Invalid JSON from ${url} :: ${t.slice(0, 200)}`);
    err.status = 500;
    throw err;
  }
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

export function intervalToSeconds(intervalStr) {
  const map = { "5m": 300, "15m": 900, "60m": 3600 };
  const sec = map[String(intervalStr).toLowerCase()];
  if (!sec) throw new Error(`Unsupported interval: ${intervalStr}`);
  return sec;
}

export function buildUpDownSlug(assetName, intervalStr, tsSec) {
  return `${assetName}-updown-${intervalStr}-${tsSec}`;
}

/**
 * IMPORTANT:
 * - /time might return seconds OR milliseconds depending on implementation.
 * We normalize to seconds by:
 * - if > 1e12 => assume ms, divide by 1000
 * - else seconds
 */
export async function getClobServerTimeSec() {
  const raw = await fetchText(`${CLOB_BASE}/time`);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid CLOB /time response: "${raw}"`);
  }
  const sec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  return { raw, sec };
}

/**
 * Try both documented strategies:
 * 1) /events/slug/{slug}
 * 2) /events?slug={slug}
 */
export async function getEventBySlug(slug) {
  try {
    return await fetchJson(`${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`);
  } catch {
    const data = await fetchJson(`${GAMMA_BASE}/events${qs({ slug })}`);
    if (Array.isArray(data)) {
      if (data.length === 0) {
        const err = new Error(`Gamma returned empty array for slug=${slug}`);
        err.status = 404;
        throw err;
      }
      return data[0];
    }
    return data;
  }
}

export function extractUpDownTokenIdsFromEvent(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  if (!markets.length) return null;

  const m = markets[0];
  const tokenIds = safeArrayMaybeJson(m?.clobTokenIds);

  if (tokenIds.length < 2) return null;

  return {
    upTokenId: String(tokenIds[0]),
    downTokenId: String(tokenIds[1]),
  };
}

export async function getClobPrices(tokenIds) {
  const token_ids = tokenIds.join(",");
  return fetchJson(`${CLOB_BASE}/prices${qs({ token_ids })}`);
}

/**
 * Robust resolver:
 * - uses CLOB /time normalized seconds
 * - tries timestamps: start, start-interval, start+interval
 * - tries asset names: btc + bitcoin, eth + ethereum
 */
export async function resolveLiveUpDown(asset, intervalStr) {
  const interval = String(intervalStr).toLowerCase();
  const seconds = intervalToSeconds(interval);

  const assetLower = String(asset).toLowerCase();
  const assetNames =
    assetLower === "btc"
      ? ["btc", "bitcoin"]
      : assetLower === "eth"
        ? ["eth", "ethereum"]
        : [assetLower];

  const { raw: timeRaw, sec: serverNowSec } = await getClobServerTimeSec();
  const windowStart = Math.floor(serverNowSec / seconds) * seconds;

  const tsCandidates = [windowStart, windowStart - seconds, windowStart + seconds];

  const slugsTried = [];
  let lastErr = null;

  for (const name of assetNames) {
    for (const ts of tsCandidates) {
      const slug = buildUpDownSlug(name, interval, ts);
      slugsTried.push(slug);
      try {
        const event = await getEventBySlug(slug);
        const tokens = extractUpDownTokenIdsFromEvent(event);
        if (!tokens) throw new Error(`No clobTokenIds on event for slug=${slug}`);

        const prices = await getClobPrices([tokens.upTokenId, tokens.downTokenId]);

        const up = Number(prices?.[tokens.upTokenId]);
        const down = Number(prices?.[tokens.downTokenId]);

        return {
          ok: true,
          slug,
          title: event?.title || slug,
          upPrice: Number.isFinite(up) ? up : null,
          downPrice: Number.isFinite(down) ? down : null,
          debug: {
            timeRaw,
            serverNowSec,
            seconds,
            windowStart,
            slugsTried,
          },
        };
      } catch (e) {
        lastErr = e;
      }
    }
  }

  return {
    ok: false,
    error: lastErr?.message || "No active markets found in candidate windows",
    debug: {
      timeRaw,
      serverNowSec,
      seconds,
      windowStart,
      slugsTried,
    },
  };
}

export function formatUpDownLiveMessage(res, asset, intervalStr) {
  const interval = String(intervalStr).toLowerCase();

  if (!res?.ok) {
    return [
      `❌ Up/Down market not found yet.`,
      `Asset: ${asset.toUpperCase()} | Interval: ${interval}`,
      "",
      `CLOB /time raw: ${res?.debug?.timeRaw ?? "?"}`,
      `CLOB /time sec: ${res?.debug?.serverNowSec ?? "?"}`,
      `Computed windowStart: ${res?.debug?.windowStart ?? "?"}`,
      "",
      `Tried slugs:`,
      ...(res?.debug?.slugsTried || []).map((s) => `- ${s}`),
      "",
      `Last error: ${res?.error || "unknown"}`,
    ].join("\n");
  }

  const upPct = res.upPrice === null ? "?" : (res.upPrice * 100).toFixed(1) + "%";
  const downPct = res.downPrice === null ? "?" : (res.downPrice * 100).toFixed(1) + "%";
  const url = `https://polymarket.com/event/${res.slug}`;

  return [
    `📈 Up/Down LIVE (${asset.toUpperCase()} ${interval})`,
    res.title,
    "",
    `UP: ${upPct}`,
    `DOWN: ${downPct}`,
    "",
    url,
  ].join("\n");
}
