// src/polymarket.js
// Working pipeline (restored + hardened):
// CLOB /time (authoritative clock) -> build candidate slugs -> Gamma event-by-slug -> CLOB midpoints

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE = "https://clob.polymarket.com";

import fs from "node:fs";
import path from "node:path";

// ---- tiny progress log (keeps a trail without breaking anything)
const LOG_DIR = path.join(process.cwd(), "data");
const LOG_FILE = path.join(LOG_DIR, "progress.jsonl");

function logProgress(event, payload = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({ ts: new Date().toISOString(), event, ...payload }) + "\n"
    );
  } catch {
    // never crash the bot because of logging
  }
}

// -------------------
// HTTP helper (safe)
// -------------------
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
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

// -------------------
// CLOB time (truth)
// -------------------
async function clobTimeSec() {
  // Your logs already showed /time exists and works.
  const url = `${CLOB_BASE}/time`;
  const data = await fetchJson(url);

  // be flexible with formats
  if (typeof data === "number") return Math.floor(data);
  if (typeof data === "string" && /^\d+$/.test(data)) return Number(data);

  if (data && typeof data === "object") {
    const candidates = [
      data.time,
      data.server_time,
      data.serverTime,
      data.timestamp,
      data.now,
      data.current_time,
      data.currentTime,
    ].filter((x) => x != null);

    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 1_500_000_000) return Math.floor(n);
      // sometimes ms:
      if (Number.isFinite(n) && n > 1_500_000_000_000) return Math.floor(n / 1000);
    }
  }

  // fallback (should rarely happen)
  return Math.floor(Date.now() / 1000);
}

// -------------------
// CLOB midpoints
// -------------------
async function clobMidpoints(tokenIds) {
  const ids = tokenIds.filter(Boolean);
  if (!ids.length) return {};

  const url =
    `${CLOB_BASE}/midpoints?` +
    new URLSearchParams({ token_ids: ids.join(",") }).toString();

  const data = await fetchJson(url);
  return data && typeof data === "object" ? data : {};
}

// -------------------
// Gamma event-by-slug
// -------------------
async function gammaEventBySlug(slug) {
  // Docs show "Get event by slug"
  // Common path is: /events/slug/{slug}
  const url = `${GAMMA_BASE}/events/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(url);
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

function assetVariants(asset) {
  // We try symbol + common full name variants (Polymarket slugs vary)
  switch (asset) {
    case "btc":
      return ["btc", "bitcoin"];
    case "eth":
      return ["eth", "ethereum"];
    case "sol":
      return ["sol", "solana"];
    case "xrp":
      return ["xrp", "ripple"];
    default:
      return [asset];
  }
}

function intervalSeconds(interval) {
  if (interval === "5m") return 300;
  if (interval === "15m") return 900;
  if (interval === "60m") return 3600;
  return null;
}

function windowStart(nowSec, seconds) {
  return Math.floor(nowSec / seconds) * seconds;
}

// --------------------------------------
// MAIN: Up/Down resolver (restored logic)
// --------------------------------------
export async function resolveUpDownMarketAndPrice({ asset, interval }) {
  // You asked: keep what works, skip 60m for now.
  if (interval === "60m") {
    return {
      found: false,
      reason: "60m disabled for now (we’ll revisit later). Try 5m or 15m.",
      debug: { triedSlugs: [] },
    };
  }

  const seconds = intervalSeconds(interval);
  if (!seconds) {
    return {
      found: false,
      reason: "Unsupported interval",
      debug: { triedSlugs: [] },
    };
  }

  const nowSec = await clobTimeSec();
  const ws = windowStart(nowSec, seconds);

  // Try: current window AND previous window (Gamma indexing delay is real)
  const windowStarts = [ws, ws - seconds];

  const variants = assetVariants(asset);

  const triedSlugs = [];
  let lastErr = null;

  logProgress("updown_attempt", { asset, interval, nowSec, ws });

  for (const w of windowStarts) {
    for (const name of variants) {
      const slug = `${name}-updown-${interval}-${w}`;
      triedSlugs.push(slug);

      try {
        const ev = await gammaEventBySlug(slug);

        // Gamma event has markets, first market should have clobTokenIds
        const markets = Array.isArray(ev?.markets) ? ev.markets : [];
        if (!markets.length) continue;

        const tokenIds = safeParseArray(markets[0]?.clobTokenIds);
        if (tokenIds.length < 2) continue;

        const [upTokenId, downTokenId] = tokenIds;

        const mids = await clobMidpoints([upTokenId, downTokenId]);
        const upMid = mids?.[upTokenId] != null ? Number(mids[upTokenId]) : null;
        const downMid = mids?.[downTokenId] != null ? Number(mids[downTokenId]) : null;

        const title = ev?.title || ev?.question || `Up/Down ${asset.toUpperCase()} ${interval}`;

        logProgress("updown_success", {
          asset,
          interval,
          slug,
          upMid,
          downMid,
        });

        return {
          found: true,
          title,
          slug,
          upTokenId,
          downTokenId,
          upMid,
          downMid,
          meta: { nowSec, windowStart: w },
        };
      } catch (e) {
        lastErr = e;
        // keep trying candidates
      }
    }
  }

  logProgress("updown_not_found", {
    asset,
    interval,
    nowSec,
    triedSlugsCount: triedSlugs.length,
    lastErr: lastErr ? String(lastErr.message || lastErr) : null,
  });

  return {
    found: false,
    reason: "Gamma slug not found (likely indexing delay or wrong window).",
    debug: {
      nowSec,
      windowStart: ws,
      triedSlugs,
      lastError: lastErr
        ? (lastErr.body ? `${lastErr.message} :: ${lastErr.body}` : lastErr.message)
        : null,
    },
  };
}
