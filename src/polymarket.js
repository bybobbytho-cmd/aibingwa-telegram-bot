const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

// --------- helpers ----------
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

async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};
  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();
  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

// --------- deterministic slug (KNOWN-GOOD PATH) ----------
function intervalSeconds(interval) {
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  throw new Error(`Unsupported interval: ${interval}`);
}

function windowStartNow(interval) {
  const sec = intervalSeconds(interval);
  const now = Math.floor(Date.now() / 1000);
  return Math.floor(now / sec) * sec;
}

function assetSlugNames(asset) {
  const a = String(asset).toLowerCase();
  // Keep “short” tickers first because your working slug example uses btc-...
  if (a === "btc") return ["btc", "bitcoin"];
  if (a === "eth") return ["eth", "ethereum"];
  if (a === "sol") return ["sol", "solana"];
  if (a === "xrp") return ["xrp", "ripple"];
  return [a];
}

function buildUpDownSlug(assetName, interval, ts) {
  // Observed working format from your screenshot:
  // btc-updown-5m-1772296200
  return `${assetName}-updown-${interval}-${ts}`;
}

async function gammaGetEventBySlug(slug) {
  // Official endpoint:
  // GET https://gamma-api.polymarket.com/events/slug/{slug}
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return fetchJson(url);
}

// --------- main resolver ----------
export async function resolveUpDownEventBySlug({ asset, interval }) {
  const names = assetSlugNames(asset);
  const base = windowStartNow(interval);
  const sec = intervalSeconds(interval);

  // Try current window, previous window, next window (handles indexing delays)
  const timestamps = [base, base - sec, base + sec];

  const triedSlugs = [];
  let lastError = null;

  for (const ts of timestamps) {
    for (const name of names) {
      const slug = buildUpDownSlug(name, interval, ts);
      triedSlugs.push(slug);

      try {
        const event = await gammaGetEventBySlug(slug);

        // event should have markets array
        const markets = Array.isArray(event?.markets) ? event.markets : [];
        if (!markets.length) {
          lastError = `Gamma returned event but no markets for slug=${slug}`;
          continue;
        }

        // Up/Down events typically have 1 market with 2 outcomes
        const market = markets[0];
        const tokenIds = safeParseArray(market?.clobTokenIds);

        if (tokenIds.length < 2) {
          lastError = `Missing clobTokenIds for slug=${slug}`;
          continue;
        }

        const [upTokenId, downTokenId] = tokenIds;
        const mids = await clobMidpoints([upTokenId, downTokenId]);

        const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
        const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

        return {
          found: true,
          title: event?.title || event?.name || "Up/Down Market",
          slug,
          asset,
          interval,
          upTokenId,
          downTokenId,
          upMid,
          downMid,
          source: "Gamma event-by-slug + CLOB midpoints",
        };
      } catch (e) {
        lastError = String(e?.message || e || "unknown error");
        continue;
      }
    }
  }

  return {
    found: false,
    triedSlugs,
    lastError,
  };
}

// --------- formatting ----------
export function formatUpDownMessage(res) {
  const up = res.upMid != null && Number.isFinite(res.upMid) ? `${Math.round(res.upMid * 100)}¢` : "—";
  const down = res.downMid != null && Number.isFinite(res.downMid) ? `${Math.round(res.downMid * 100)}¢` : "—";

  return [
    `📈 *${res.title}*`,
    `Slug: \`${res.slug}\``,
    "",
    `UP (mid): *${up}*`,
    `DOWN (mid): *${down}*`,
    "",
    `_Source: ${res.source}_`,
  ].join("\n");
}
